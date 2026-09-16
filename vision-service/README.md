# PARAKH OpenCV Vision Service

This service provides calibrated visual measurements for package-declaration inspection.

## ₹10 coin calibration

The service uses an Indian ₹10 coin as a physical reference with a documented diameter of **27 mm**. OpenCV detects the circular reference using Hough-circle detection and derives pixels-per-millimetre from the detected diameter.

```text
Package image
    ↓
Detect ₹10 coin
    ↓
27 mm reference
    ↓
Pixels / mm calibration
    ↓
Crop OCR declaration bounding box
    ↓
Connected-component glyph estimation
    ↓
Measured text height in mm
    ↓
Rules Engine Rule 7
```

## Rule 7 relationship

The current Rule 7 requirement is based on the **area of the principal display panel**, not package weight. The OpenCV measurement therefore reports physical text height, while the Rules Engine determines the required minimum height from the principal-display-panel area.

Current table implemented in the Rules Engine:

| Principal display panel area | Normal | Blown/formed/molded |
|---|---:|---:|
| A ≤ 50 cm² | 1.0 mm | 2.0 mm |
| 50 < A ≤ 100 cm² | 1.5 mm | 3.0 mm |
| 100 < A ≤ 500 cm² | 2.5 mm | 4.0 mm |
| 500 < A ≤ 2500 cm² | 4.0 mm | 6.0 mm |
| A > 2500 cm² | 6.0 mm | 6.0 mm |

The service does not independently make a legal decision. It supplies calibrated visual evidence to the deterministic Rules Engine.

## Start

```powershell
cd vision-service
python -m venv .venv
.\.venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8082
```

Health endpoint:

```text
http://localhost:8082/health
```

Measurement endpoint:

```text
POST /api/vision/font-size
```

Inputs:

- `images`: one or more package images
- `targets`: JSON array of OCR declaration targets with `field`, `imageIndex`, `text`, and `boundingBox`
- `principal_display_panel_area_cm2`: measured/declared principal display panel area
- `surface_type`: `normal` or `formed`

## Important limitation

Coin calibration establishes image scale. A ₹10 coin does not itself establish the area of the principal display panel. That panel area must come from a reliable visual measurement or officer-provided value. The final legal compliance finding remains the Rules Engine/officer workflow.
