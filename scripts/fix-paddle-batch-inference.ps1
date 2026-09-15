$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$file = Join-Path $root "ocr-service\main.py"
$python = Join-Path $root "ocr-service\.venv\Scripts\python.exe"

if (-not (Test-Path $file)) { throw "ocr-service/main.py not found: $file" }
if (-not (Test-Path $python)) { throw "OCR virtualenv Python not found: $python" }

$text = Get-Content -Raw -Path $file
$pattern = '(?s)async def paddle_analyze\(.*?(?=\r?\n\r?\nasync def rapid_fallback)'
$match = [regex]::Match($text, $pattern)
if (-not $match.Success) { throw "Could not locate paddle_analyze body in ocr-service/main.py" }

$replacement = @'
async def paddle_analyze(items: list[tuple[bytes, str]], language: str):
    started = time.monotonic()
    prepared = []
    for image_index, (content, _media_type) in enumerate(items[:MAX_IMAGES]):
        try:
            image, original_width, original_height, scale = prepare_image(content)
            prepared.append((image, original_width, original_height, scale, image_index))
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"Invalid image {image_index + 1}: {exc}") from exc

    if not prepared:
        return {
            "provider": "paddleocr",
            "model": "PaddleOCR 3.7.0",
            "language": normalize_language(language),
            "timingMs": 0,
            "engineTimingMs": 0,
            "result": {
                "declarationEvidence": [],
                "rawText": "",
                "warnings": [],
                "unreadableFields": [],
                "needsReview": True,
            },
        }

    engine = _get_paddle(language)
    arrays = [np.asarray(item[0]) for item in prepared]
    image_count = len(arrays)

    def safe_sequence(value):
        if value is None:
            return []
        if isinstance(value, np.ndarray):
            return value.tolist()
        if isinstance(value, (list, tuple)):
            return list(value)
        return [value]

    def parse_result(result, image_index):
        data = _json_dict(result)
        texts = data.get("rec_texts")
        if texts is None:
            texts = data.get("rec_text")
        scores = data.get("rec_scores")
        boxes = data.get("rec_boxes")
        if boxes is None:
            boxes = data.get("dt_polys")

        texts = safe_sequence(texts)
        scores = safe_sequence(scores)
        boxes = safe_sequence(boxes)
        original_width = prepared[image_index][1]
        original_height = prepared[image_index][2]
        scale = prepared[image_index][3]

        entries = []
        for index, value in enumerate(texts):
            text_value = str(value if value is not None else "").strip()
            if not text_value:
                continue
            confidence = max(0.0, min(1.0, to_float(scores[index], 0.0) if index < len(scores) else 0.0))
            entry = {
                "imageIndex": image_index + 1,
                "type": "OCR_TEXT",
                "text": text_value,
                "confidence": confidence,
                "source": "paddleocr",
                "imageWidth": original_width,
                "imageHeight": original_height,
            }
            if index < len(boxes):
                rect = _box_to_rect(boxes[index], scale, original_width, original_height)
                if rect:
                    entry["boundingBox"] = rect
            entries.append(entry)
        return entries

    batch_started = time.monotonic()
    batch_results = list(await asyncio.to_thread(
        lambda: engine.predict(arrays, batch_size=image_count)
    ))
    batch_elapsed = round((time.monotonic() - batch_started) * 1000)

    all_entries = []
    image_stats = []
    for image_index in range(image_count):
        result = batch_results[image_index] if image_index < len(batch_results) else None
        entries = parse_result(result, image_index) if result is not None else []
        image_stats.append((image_index, len(entries), quality(entries)))
        all_entries.extend(entries)

    # One optional targeted retry for weak images. This is intentionally sequential only
    # for images that failed the first batch quality threshold, not the normal path.
    weak_images = [index for index, _count, score in image_stats if score < 0.55]
    for image_index in weak_images:
        enhanced = np.asarray(enhanced_image(prepared[image_index][0]))
        retry_results = list(await asyncio.to_thread(
            lambda source=enhanced: engine.predict([source], batch_size=1)
        ))
        retry_result = retry_results[0] if retry_results else None
        retry_entries = parse_result(retry_result, image_index) if retry_result is not None else []
        current_entries = [item for item in all_entries if item.get("imageIndex") == image_index + 1]
        if quality(retry_entries) > quality(current_entries):
            all_entries = [item for item in all_entries if item.get("imageIndex") != image_index + 1]
            all_entries.extend(retry_entries)

    all_entries = dedupe_entries(all_entries)
    total_ms = round((time.monotonic() - started) * 1000)

    for image_index in range(image_count):
        count = sum(1 for item in all_entries if item.get("imageIndex") == image_index + 1)
        print(
            f"[ocr:paddle] image={image_index + 1} "
            f"lang={normalize_language(language)} "
            f"size={prepared[image_index][1]}x{prepared[image_index][2]} "
            f"entries={count} batch={batch_elapsed}ms"
        )

    raw_text = "\n".join(item["text"] for item in all_entries).strip()
    return {
        "provider": "paddleocr",
        "model": "PaddleOCR 3.7.0",
        "language": normalize_language(language),
        "timingMs": total_ms,
        "engineTimingMs": batch_elapsed,
        "result": {
            "declarationEvidence": all_entries,
            "rawText": raw_text,
            "warnings": [],
            "unreadableFields": [],
            "needsReview": any(item["confidence"] < 0.6 for item in all_entries),
        },
    }
'@

$text = $text.Substring(0, $match.Index) + $replacement.TrimEnd("`r", "`n") + $text.Substring($match.Index + $match.Length)

# Patch the legacy helper too, because it is still used by other OCR paths.
$text = $text.Replace(
'    texts = data.get("rec_texts") or data.get("rec_text") or []',
'    texts = data.get("rec_texts")\n    if texts is None:\n        texts = data.get("rec_text")\n    if texts is None:\n        texts = []'
)
$text = $text.Replace(
'    scores = data.get("rec_scores") or data.get("rec_scores") or []',
'    scores = data.get("rec_scores")\n    if scores is None:\n        scores = []'
)
$text = $text.Replace(
'    boxes = data.get("rec_boxes") or data.get("dt_polys") or []',
'    boxes = data.get("rec_boxes")\n    if boxes is None:\n        boxes = data.get("dt_polys")\n    if boxes is None:\n        boxes = []'
)

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($file, $text, $utf8NoBom)

& $python -m py_compile $file
if ($LASTEXITCODE -ne 0) { throw "Python syntax validation failed for ocr-service/main.py" }

Write-Host "Paddle batch inference patched: all uploaded package images are submitted in one engine.predict call."