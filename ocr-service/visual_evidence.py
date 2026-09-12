"""Explainable visual evidence helpers inspired by VISOR's image-quality stage.

These measurements are advisory evidence only. They are never treated as legal
legibility or compliance determinations.
"""

import cv2
import numpy as np


def assess(raw: bytes) -> dict:
    image = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("Invalid image")

    height, width = image.shape[:2]
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    analysis = gray
    if max(gray.shape) > 1600:
        scale = 1600 / max(gray.shape)
        analysis = cv2.resize(gray, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)

    sharpness = float(cv2.Laplacian(analysis, cv2.CV_64F).var())
    contrast = float(analysis.std())
    warnings = []

    if min(width, height) < 600:
        warnings.append("Low resolution: capture a closer, higher-resolution view of the declaration.")
    if sharpness < 80:
        warnings.append("Low sharpness: hold the camera steady and focus on the printed text.")
    if contrast < 25:
        warnings.append("Low contrast: use even lighting and avoid glare.")

    return {
        "status": "Needs clearer evidence" if warnings else "No obvious quality warning",
        "sharpnessVariance": round(sharpness, 2),
        "contrastStddev": round(contrast, 2),
        "width": width,
        "height": height,
        "warnings": warnings,
        "method": "OpenCV Laplacian variance and grayscale contrast; longest analysis edge limited to 1600 px",
        "limitations": "Heuristic thresholds only; not OCR confidence and not a legal legibility determination.",
    }
