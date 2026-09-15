$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$file = Join-Path $root "ocr-service\main.py"
if (-not (Test-Path $file)) { throw "ocr-service/main.py not found: $file" }

$text = Get-Content -Raw -Path $file

$start = $text.IndexOf("async def paddle_analyze(items: list[tuple[bytes, str]], language: str):")
$end = $text.IndexOf("\n\nasync def rapid_fallback", $start)
if ($start -lt 0 -or $end -lt 0) { throw "Could not locate paddle_analyze function in ocr-service/main.py" }

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

    engine = _get_paddle(language)
    images = [np.asarray(item[0]) for item in prepared]
    image_count = len(images)
    if not images:
        return {
            "provider": "paddleocr",
            "model": "PaddleOCR 3.7.0",
            "language": normalize_language(language),
            "timingMs": 0,
            "engineTimingMs": 0,
            "result": {"declarationEvidence": [], "rawText": "", "warnings": [], "unreadableFields": [], "needsReview": True},
        }

    batch_started = time.monotonic()
    batch_results = list(await asyncio.to_thread(lambda: engine.predict(images, batch_size=image_count)))
    batch_elapsed = round((time.monotonic() - batch_started) * 1000)

    def safe_sequence(value):
        if value is None:
            return []
        if isinstance(value, np.ndarray):
            return value.tolist()
        try:
            return list(value)
        except TypeError:
            return [value]

    def parse_result(result, image_index):
        data = _json_dict(result)
        raw_texts = data.get("rec_texts")
        raw_scores = data.get("rec_scores")
        raw_boxes = data.get("rec_boxes")
        if raw_boxes is None:
            raw_boxes = data.get("dt_polys")
        texts = safe_sequence(raw_texts)
        scores = safe_sequence(raw_scores)
        boxes = safe_sequence(raw_boxes)
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
                "imageWidth": prepared[image_index][1],
                "imageHeight": prepared[image_index][2],
            }
            if index < len(boxes):
                rect = _box_to_rect(boxes[index], prepared[image_index][3], prepared[image_index][1], prepared[image_index][2])
                if rect:
                    entry["boundingBox"] = rect
            entries.append(entry)
        return entries

    all_entries = []
    per_image_results = []
    for image_index in range(image_count):
        result = batch_results[image_index] if image_index < len(batch_results) else None
        entries = parse_result(result, image_index) if result is not None else []
        first_quality = quality(entries)
        if first_quality < 0.55:
            enhanced = np.asarray(enhanced_image(prepared[image_index][0]))
            retry_started = time.monotonic()
            retry_results = list(await asyncio.to_thread(lambda source=enhanced: engine.predict(source)))
            retry_entries = extract_paddle(retry_results, image_index, prepared[image_index][3], prepared[image_index][1], prepared[image_index][2])
            if quality(retry_entries) > first_quality:
                entries = retry_entries
        all_entries.extend(entries)
        per_image_results.append((image_index, len(entries), first_quality))

    all_entries = dedupe_entries(all_entries)
    total_ms = round((time.monotonic() - started) * 1000)
    for image_index, entry_count, first_quality in per_image_results:
        print(f"[ocr:paddle] image={image_index + 1} lang={normalize_language(language)} size={prepared[image_index][1]}x{prepared[image_index][2]} entries={entry_count} batch={batch_elapsed}ms quality={first_quality:.3f}")

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

$text = $text.Substring(0, $start) + $replacement.TrimEnd("`r", "`n") + $text.Substring($end)

# Make Paddle result parsing safe for NumPy arrays wherever the helper is reused.
$oldTexts = '    texts = data.get("rec_texts") or data.get("rec_text") or []'
$newTexts = '    texts = data.get("rec_texts")\n    if texts is None:\n        texts = data.get("rec_text")\n    if texts is None:\n        texts = []'
if ($text.Contains($oldTexts)) {
    $text = $text.Replace($oldTexts, $newTexts)
}
$oldScores = '    scores = data.get("rec_scores") or data.get("rec_scores") or []'
$newScores = '    scores = data.get("rec_scores")\n    if scores is None:\n        scores = []'
if ($text.Contains($oldScores)) {
    $text = $text.Replace($oldScores, $newScores)
}
$oldBoxes = '    boxes = data.get("rec_boxes") or data.get("dt_polys") or []'
$newBoxes = '    boxes = data.get("rec_boxes")\n    if boxes is None:\n        boxes = data.get("dt_polys")\n    if boxes is None:\n        boxes = []'
if ($text.Contains($oldBoxes)) {
    $text = $text.Replace($oldBoxes, $newBoxes)
}

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($file, $text, $utf8NoBom)

& (Join-Path $root "ocr-service\.venv\Scripts\python.exe") -m py_compile $file
if ($LASTEXITCODE -ne 0) { throw "Python syntax validation failed for ocr-service/main.py" }

Write-Host "Paddle OCR now submits all package images in one batch with batch_size=image_count."