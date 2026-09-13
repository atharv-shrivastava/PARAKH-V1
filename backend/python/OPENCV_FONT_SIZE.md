# OpenCV font-size measurement

PARAKH V1 now adds an OpenCV-assisted font-size screening step to the `/api/ocr/analyze` response.

## Runtime dependency

From `backend/python`:

```bash
python -m pip install -r requirements-font-size.txt
```

The runtime uses `opencv-python-headless` and `numpy`.

## Flow

```text
Package images
  -> RapidOCR
  -> OCR text + bounding boxes
  -> OpenCV text-height measurement
  -> fontSizeAnalysis
  -> /api/ocr/evaluate-structured
  -> Rules Engine evidence
```

The OpenCV module measures visible text height in pixels. A physical millimetre value is emitted only when a per-image `pixelsPerMm` calibration is supplied to `/api/ocr/analyze`.

This prevents a phone photograph from being treated as though it contains a magical built-in ruler. Without calibration, the measurement is marked `NEEDS_CALIBRATION` and is not emitted as legal measurement evidence.

## Rules Engine payload

Calibrated measurements are added as evidence with:

```json
{
  "field": "visual.fontSize",
  "normalizedValue": 1.8,
  "unit": "mm",
  "source": "OPENCV"
}
```

The same measurements are included under `visualFlags.fontSize` for rule implementations that want the complete geometry/provenance object.

The Rules Engine remains responsible for deciding whether a measured value satisfies a configured statutory threshold. The OpenCV module does not hard-code legal limits.

## Calibration example

```text
pixelsPerMm={"0":12.5,"1":11.8}
```

For image 0, a detected text height of 22.5 px becomes 1.8 mm.
