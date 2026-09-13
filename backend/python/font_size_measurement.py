#!/usr/bin/env python3
"""Measure OCR text height using OpenCV.

Input: JSON on stdin
{
  "images": [{"path": "...", "imageIndex": 0}],
  "detections": [
    {"text": "MRP", "bbox": [x1, y1, x2, y2], "imageIndex": 0,
     "field": "mrp", "confidence": 0.97}
  ],
  "pixelsPerMm": {"0": 12.5}
}

The physical measurement is intentionally optional. A photograph has no reliable
physical scale unless the caller supplies a calibrated pixels/mm value.
"""

import json
import math
import sys
from pathlib import Path

import cv2
import numpy as np


def as_bbox(value):
    if not isinstance(value, (list, tuple)) or len(value) < 4:
        return None
    try:
        x1, y1, x2, y2 = [float(value[i]) for i in range(4)]
    except (TypeError, ValueError):
        return None
    left, right = sorted((x1, x2))
    top, bottom = sorted((y1, y2))
    if right <= left or bottom <= top:
        return None
    return [left, top, right, bottom]


def crop_box(image, bbox, pad=2):
    h, w = image.shape[:2]
    x1, y1, x2, y2 = bbox
    x1 = max(0, min(w - 1, int(math.floor(x1)) - pad))
    y1 = max(0, min(h - 1, int(math.floor(y1)) - pad))
    x2 = max(x1 + 1, min(w, int(math.ceil(x2)) + pad))
    y2 = max(y1 + 1, min(h, int(math.ceil(y2)) + pad))
    return image[y1:y2, x1:x2]


def robust_ink_height(crop):
    """Estimate visible character/line height from foreground pixels.

    OCR boxes are often line-level boxes rather than character boxes. We therefore
    use a connected-component based estimate and fall back to the OCR box height.
    """
    if crop is None or crop.size == 0:
        return None

    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY) if len(crop.shape) == 3 else crop
    if min(gray.shape[:2]) < 3:
        return None

    # Upscale small text before thresholding to make the component measurement less
    # sensitive to one-pixel strokes.
    scale = 2 if max(gray.shape[:2]) < 160 else 1
    if scale > 1:
        gray = cv2.resize(gray, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)

    gray = cv2.GaussianBlur(gray, (3, 3), 0)
    binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)[1]

    # Remove isolated speckle while keeping character strokes.
    kernel = np.ones((2, 2), np.uint8)
    binary = cv2.morphologyEx(binary, cv2.MORPH_OPEN, kernel, iterations=1)

    count, labels, stats, _ = cv2.connectedComponentsWithStats(binary, connectivity=8)
    min_area = max(2, int(binary.shape[0] * binary.shape[1] * 0.0008))
    heights = []
    for idx in range(1, count):
        x, y, width, height, area = stats[idx]
        if area < min_area:
            continue
        if height < 2 or width < 1:
            continue
        # Ignore components that are almost the entire crop. Those are usually a
        # thresholding failure, border, or logo/background region.
        if width >= binary.shape[1] * 0.98 and height >= binary.shape[0] * 0.98:
            continue
        heights.append(float(height) / scale)

    if not heights:
        return None

    heights.sort()
    median = heights[len(heights) // 2]
    # Cap outlier influence when a whole word is one connected component.
    return float(max(1.0, median))


def measure_detection(image, detection):
    bbox = as_bbox(detection.get("bbox") or detection.get("box") or detection.get("rect"))
    if not bbox:
        return None

    crop = crop_box(image, bbox)
    ink_height = robust_ink_height(crop)
    bbox_height = bbox[3] - bbox[1]
    pixel_height = float(ink_height if ink_height is not None else bbox_height)
    if pixel_height <= 0:
        return None

    result = {
        "field": detection.get("field"),
        "text": str(detection.get("text") or detection.get("value") or "").strip(),
        "imageIndex": int(detection.get("imageIndex", 0)),
        "bbox": [round(v, 2) for v in bbox],
        "pixelHeight": round(pixel_height, 3),
        "bboxHeight": round(bbox_height, 3),
        "ocrConfidence": float(detection.get("confidence") or 0),
        "measurementMethod": "opencv_connected_component" if ink_height is not None else "ocr_bbox_fallback",
    }
    return result


def main():
    payload = json.load(sys.stdin)
    image_defs = payload.get("images") or []
    detections = payload.get("detections") or []
    pixels_per_mm = payload.get("pixelsPerMm") or {}

    images = {}
    errors = []
    for item in image_defs:
        index = int(item.get("imageIndex", 0))
        path = Path(str(item.get("path") or ""))
        image = cv2.imread(str(path), cv2.IMREAD_COLOR)
        if image is None:
            errors.append(f"Unable to decode image {index}: {path}")
            continue
        images[index] = image

    measurements = []
    for detection in detections:
        index = int(detection.get("imageIndex", 0))
        image = images.get(index)
        if image is None:
            continue
        measured = measure_detection(image, detection)
        if not measured:
            continue

        ppm = pixels_per_mm.get(str(index), pixels_per_mm.get(index))
        try:
            ppm = float(ppm) if ppm is not None else None
        except (TypeError, ValueError):
            ppm = None
        if ppm and ppm > 0:
            measured["pixelsPerMm"] = ppm
            measured["physicalHeightMm"] = round(measured["pixelHeight"] / ppm, 3)
            measured["physicalMeasurementStatus"] = "CALIBRATED"
        else:
            measured["pixelsPerMm"] = None
            measured["physicalHeightMm"] = None
            measured["physicalMeasurementStatus"] = "NEEDS_CALIBRATION"

        measurements.append(measured)

    by_field = {}
    for item in measurements:
        field = item.get("field")
        if field:
            by_field.setdefault(field, []).append(item)

    print(json.dumps({
        "status": "OK" if not errors else "PARTIAL",
        "measurements": measurements,
        "byField": by_field,
        "errors": errors,
        "engineSafe": True,
        "note": "Physical millimetre values are emitted only when a valid pixels/mm calibration is supplied.",
    }))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"status": "ERROR", "error": str(exc), "measurements": [], "byField": {}, "engineSafe": True}))
        sys.exit(1)
