# PARAKH RapidOCR service

Small local OCR service for package-image text detection and bounding-box extraction.

RapidOCR is the only OCR engine used by PARAKH. Package images are submitted together and processed as one image set, with per-image OCR inference running in parallel up to the configured concurrency limit.

## Start

```powershell
cd ocr-service
python -m venv .venv
.\.venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8081
```

Health check: `http://localhost:8081/health`

The service returns OCR text, confidence, image index and normalized bounding boxes. Confidence does not filter evidence; low-confidence detections remain reviewable.

## Language

Set `RAPIDOCR_LANG_TYPE` before starting the service. The default is `en`.

## Parallel image processing

`RAPIDOCR_PARALLELISM` controls the maximum number of package images inferred concurrently. The default is `4`, capped at the service maximum of `6` images per request.
