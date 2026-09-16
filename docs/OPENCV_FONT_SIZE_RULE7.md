# OpenCV ₹10 Coin Calibration + Rule 7 Font-Size Inspection

## Purpose

PARAKH uses a known physical reference to convert image pixels into approximate millimetres for declaration-height inspection.

The current Rule 7 requirement is based on the **area of the principal display panel**, not package weight. The ₹10 coin is the calibration reference; it is not the legal threshold itself.

## Workflow

```text
Package image
    ↓
OpenCV detects ₹10 coin
    ↓
Coin diameter = 27 mm reference
    ↓
Pixels/mm calibration
    ↓
OCR supplies declaration bounding boxes
    ↓
OpenCV crops each declaration region
    ↓
Connected-component glyph estimation
    ↓
Measured letter/numeral height in mm
    ↓
Rules Engine receives visual.rule7FontSizeMeasurements
    ↓
Rule 7 selects required height from principal-display-panel area
    ↓
PASS / VIOLATION / UNABLE_TO_VERIFY
```

## Calibration

Reference:

```text
Indian ₹10 coin
Reference diameter = 27 mm
```

For a detected coin of diameter `D_px`:

```text
pixelsPerMm = D_px / 27
mmPerPixel = 27 / D_px
```

For a measured glyph height of `H_px`:

```text
heightMm = H_px × mmPerPixel
```

## Current Rule 7 minimums

| Principal display panel area | Normal surface | Blown / formed / molded surface |
|---|---:|---:|
| A ≤ 50 cm² | 1.0 mm | 2.0 mm |
| 50 < A ≤ 100 cm² | 1.5 mm | 3.0 mm |
| 100 < A ≤ 500 cm² | 2.5 mm | 4.0 mm |
| 500 < A ≤ 2500 cm² | 4.0 mm | 6.0 mm |
| A > 2500 cm² | 6.0 mm | 6.0 mm |

The engine also checks the available width-to-height signal against the one-third minimum described in the Rules.

## Data contract

The backend sends these visual fields to the Rules Engine:

```json
{
  "principalDisplayPanelAreaCm2": 120,
  "surfaceType": "normal",
  "rule7FontSizeMeasurements": [
    {
      "field": "mrp",
      "imageIndex": 0,
      "measuredHeightMm": 2.7,
      "widthHeightRatio": 0.45,
      "calibrationConfidence": 0.88
    }
  ],
  "fontSizeCalibrationReference": {
    "object": "Indian ₹10 coin",
    "diameterMm": 27
  }
}
```

## Backend endpoint

```text
POST /api/vision/font-size-compliance
```

Multipart fields:

- `images`
- `ocr` — structured OCR/semantic result JSON
- `principalDisplayPanelAreaCm2`
- `surfaceType`
- normal inspection metadata such as `inspectionId` and `productId`

The endpoint runs the OpenCV vision service first and then submits the resulting visual evidence to the Rules Engine.

## Services

### OpenCV service

```text
vision-service/
```

Default:

```text
http://localhost:8082
```

### Rules Engine

```text
rules-engine/
```

Default:

```text
http://localhost:8090
```

### Backend configuration

```text
OPENCV_VISION_URL=http://localhost:8082
RULES_ENGINE_URL=http://localhost:8090
```

## Important limitations

Coin calibration only establishes image scale. It does not determine the principal display panel area. That area must come from a reliable measurement or officer-provided value.

A photo can also fail to provide sufficient evidence because of blur, glare, perspective, an occluded coin, overlapping graphics, merged characters, or an unreliable OCR bounding box. Such cases remain `UNABLE_TO_VERIFY` rather than being converted into a legal violation automatically.

This is inspection decision support. The calibrated visual result is evidence for the deterministic Rules Engine and officer review.
