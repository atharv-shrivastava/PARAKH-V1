import io
import json
import math
from typing import Any

import cv2
import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image

app = FastAPI(title="PARAKH OpenCV Vision Service")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:5174", "http://127.0.0.1:5174"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

RUPEE_10_COIN_DIAMETER_MM = 27.0
MIN_CALIBRATION_CONFIDENCE = 0.55


def load_cv_image(content: bytes) -> np.ndarray:
    image = Image.open(io.BytesIO(content)).convert("RGB")
    return cv2.cvtColor(np.asarray(image), cv2.COLOR_RGB2BGR)


def detect_ten_rupee_coin(image: np.ndarray) -> dict[str, Any] | None:
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (9, 9), 1.8)
    h, w = gray.shape[:2]
    min_dim = min(h, w)
    min_radius = max(5, int(min_dim * 0.008))
    max_radius = max(min_radius + 5, int(min_dim * 0.18))

    candidates: list[tuple[float, float, float, float]] = []
    for param2 in (48, 42, 36, 30, 26, 22):
        circles = cv2.HoughCircles(
            gray,
            cv2.HOUGH_GRADIENT,
            dp=1.2,
            minDist=max(30, min_dim * 0.05),
            param1=110,
            param2=param2,
            minRadius=min_radius,
            maxRadius=max_radius,
        )
        if circles is None:
            continue
        for x, y, r in np.round(circles[0]).astype(int):
            if r <= 0 or x < 0 or y < 0 or x >= w or y >= h:
                continue
            # Prefer circles with visible edge contrast and reasonable size.
            mask = np.zeros_like(gray)
            cv2.circle(mask, (int(x), int(y)), int(r), 255, 2)
            edge_score = float(np.mean(cv2.Canny(gray, 80, 160)[mask > 0])) if np.any(mask > 0) else 0.0
            candidates.append((edge_score, float(x), float(y), float(r)))
        if len(candidates) >= 8:
            break

    if not candidates:
        return None

    candidates.sort(key=lambda item: item[0], reverse=True)
    edge_score, x, y, radius = candidates[0]
    confidence = min(1.0, max(0.0, edge_score / 70.0))
    return {
        "center": {"x": round(x, 2), "y": round(y, 2)},
        "radiusPx": round(radius, 3),
        "diameterPx": round(radius * 2.0, 3),
        "diameterMm": RUPEE_10_COIN_DIAMETER_MM,
        "pixelsPerMm": round((radius * 2.0) / RUPEE_10_COIN_DIAMETER_MM, 5),
        "mmPerPixel": round(RUPEE_10_COIN_DIAMETER_MM / (radius * 2.0), 7),
        "confidence": round(confidence, 3),
        "method": "opencv_hough_circle",
    }


def crop_box(image: np.ndarray, box: dict[str, Any], padding: float = 0.08) -> tuple[np.ndarray, tuple[int, int, int, int]] | None:
    h, w = image.shape[:2]
    left = float(box.get("left", 0))
    top = float(box.get("top", 0))
    width = float(box.get("width", 0))
    height = float(box.get("height", 0))
    if width <= 0 or height <= 0:
        return None
    px = width * padding
    py = height * padding
    x1 = max(0, int(math.floor(left - px)))
    y1 = max(0, int(math.floor(top - py)))
    x2 = min(w, int(math.ceil(left + width + px)))
    y2 = min(h, int(math.ceil(top + height + py)))
    if x2 <= x1 or y2 <= y1:
        return None
    return image[y1:y2, x1:x2], (x1, y1, x2 - x1, y2 - y1)


def estimate_glyph_height(crop: np.ndarray) -> dict[str, Any]:
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (3, 3), 0)
    binary = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, 31, 9)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (2, 2))
    binary = cv2.morphologyEx(binary, cv2.MORPH_OPEN, kernel)
    n_labels, _labels, stats, _centroids = cv2.connectedComponentsWithStats(binary, connectivity=8)

    heights: list[float] = []
    widths: list[float] = []
    areas: list[float] = []
    crop_h, crop_w = gray.shape[:2]
    for idx in range(1, n_labels):
        x, y, w, h, area = stats[idx]
        if h < 2 or w < 1 or area < 4:
            continue
        if h > crop_h * 0.90 or w > crop_w * 0.80:
            continue
        if area < max(4, (w * h) * 0.04):
            continue
        heights.append(float(h))
        widths.append(float(w))
        areas.append(float(area))

    if not heights:
        return {"glyphHeightPx": None, "medianComponentWidthPx": None, "componentCount": 0, "method": "connected_components"}

    # A trimmed upper-half median is more stable than taking the tallest component,
    # which can accidentally select punctuation, a border, or a merged blob.
    heights_sorted = sorted(heights)
    start = max(0, len(heights_sorted) // 2 - 2)
    robust = heights_sorted[start:]
    glyph_height = float(np.median(robust))
    median_width = float(np.median(widths))
    return {
        "glyphHeightPx": round(glyph_height, 3),
        "medianComponentWidthPx": round(median_width, 3),
        "componentCount": len(heights),
        "method": "connected_components",
    }


def required_height_mm(panel_area_cm2: float, formed: bool) -> float:
    if panel_area_cm2 <= 50:
        return 2.0 if formed else 1.0
    if panel_area_cm2 <= 100:
        return 3.0 if formed else 1.5
    if panel_area_cm2 <= 500:
        return 4.0 if formed else 2.5
    if panel_area_cm2 <= 2500:
        return 6.0 if formed else 4.0
    return 6.0


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "parakh-opencv-vision", "engine": "OpenCV"}


@app.post("/api/vision/font-size")
async def font_size(
    images: list[UploadFile] = File(...),
    targets: str = Form("[]"),
    principal_display_panel_area_cm2: float | None = Form(None),
    surface_type: str = Form("normal"),
):
    if not images:
        raise HTTPException(status_code=400, detail="At least one package image is required.")
    try:
        target_items = json.loads(targets)
        if not isinstance(target_items, list):
            raise ValueError("targets must be an array")
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid targets JSON: {exc}") from exc

    target_images: list[np.ndarray] = []
    for upload in images[:6]:
        target_images.append(load_cv_image(await upload.read()))

    measurements: list[dict[str, Any]] = []
    calibration_results: list[dict[str, Any]] = []
    formed = surface_type.lower() in {"formed", "blown", "molded", "embossed", "perforated"}

    for image_index, image in enumerate(target_images):
        coin = detect_ten_rupee_coin(image)
        calibration_results.append({"imageIndex": image_index, "coin": coin})
        if coin is None or coin["confidence"] < MIN_CALIBRATION_CONFIDENCE:
            continue
        mm_per_pixel = coin["mmPerPixel"]
        for target in target_items:
            if int(target.get("imageIndex", 0)) != image_index:
                continue
            cropped = crop_box(image, target.get("boundingBox") or {})
            if cropped is None:
                continue
            crop, crop_box_xywh = cropped
            estimate = estimate_glyph_height(crop)
            if estimate["glyphHeightPx"] is None:
                continue
            glyph_mm = estimate["glyphHeightPx"] * mm_per_pixel
            width_height_ratio = None
            if estimate["medianComponentWidthPx"] and estimate["glyphHeightPx"]:
                width_height_ratio = estimate["medianComponentWidthPx"] / estimate["glyphHeightPx"]
            measurements.append({
                "field": str(target.get("field", "unknown")),
                "imageIndex": image_index,
                "text": str(target.get("text", "")),
                "measuredHeightMm": round(glyph_mm, 3),
                "widthHeightRatio": round(width_height_ratio, 3) if width_height_ratio is not None else None,
                "coinDiameterPx": coin["diameterPx"],
                "coinDiameterMm": coin["diameterMm"],
                "pixelsPerMm": coin["pixelsPerMm"],
                "calibrationConfidence": coin["confidence"],
                "cropBox": {"left": crop_box_xywh[0], "top": crop_box_xywh[1], "width": crop_box_xywh[2], "height": crop_box_xywh[3]},
                "measurementMethod": "opencv_coin_calibration_plus_connected_components",
            })

    overall_confidence = max((item.get("calibrationConfidence", 0) for item in measurements), default=0.0)
    return {
        "provider": "opencv",
        "model": "OpenCV",
        "calibrationReference": {
            "object": "Indian ₹10 coin",
            "diameterMm": RUPEE_10_COIN_DIAMETER_MM,
            "confidence": round(overall_confidence, 3),
        },
        "principalDisplayPanelAreaCm2": principal_display_panel_area_cm2,
        "surfaceType": "formed" if formed else "normal",
        "measurements": measurements,
        "warnings": [] if measurements else ["Could not establish a usable ₹10 coin calibration and text measurement from the supplied image(s)."],
        "needsReview": not bool(measurements) or overall_confidence < 0.70,
    }
