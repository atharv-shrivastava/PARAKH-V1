$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$file = Join-Path $root "ocr-service\main.py"
if (-not (Test-Path $file)) { throw "ocr-service/main.py not found: $file" }

$text = Get-Content -Raw -Path $file
$newLine = [Environment]::NewLine

# 1) Disable the Windows PaddlePaddle CPU oneDNN path before PaddleOCR import.
if (-not $text.Contains('os.environ.setdefault("FLAGS_use_mkldnn", "0")')) {
  $marker = 'os.environ.setdefault("ORT_INTER_OP_NUM_THREADS", "1")'
  if (-not $text.Contains($marker)) { throw "Could not find OCR environment marker." }
  $insert = $marker + $newLine + '# PaddlePaddle 3.x CPU oneDNN/PIR workaround for Windows.' + $newLine + 'os.environ.setdefault("FLAGS_use_mkldnn", "0")'
  $text = $text.Replace($marker, $insert)
}

# 2) Explicitly disable oneDNN in PaddleOCR config.
if (-not $text.Contains('"enable_mkldnn": False')) {
  $pattern = '(?m)(^[ \t]*"device"[ \t]*:[ \t]*PADDLE_DEVICE,[ \t]*)\r?$'
  $replacement = '$1' + $newLine + '        "enable_mkldnn": False,'
  $updated = [regex]::Replace($text, $pattern, $replacement, 1)
  if ($updated -eq $text) { throw "Could not locate Paddle device configuration." }
  $text = $updated
}

# 3) Make Paddle result parsing safe for NumPy arrays. Never use `array or []`.
$oldItems = @'
    items = list(result_iterable or [])
'@
$newItems = @'
    items = list(result_iterable) if result_iterable is not None else []
'@
if ($text.Contains($oldItems.TrimEnd("`r", "`n"))) {
  $text = $text.Replace($oldItems.TrimEnd("`r", "`n"), $newItems.TrimEnd("`r", "`n"))
}

$oldHelper = @'

def extract_paddle(result_iterable, image_index: int, scale: float, original_width: int, original_height: int):
'@
$newHelper = @'

def _first_present(value, *alternatives):
    if value is not None:
        return value
    for candidate in alternatives:
        if candidate is not None:
            return candidate
    return []


def extract_paddle(result_iterable, image_index: int, scale: float, original_width: int, original_height: int):
'@
if ($text.Contains($oldHelper.TrimEnd("`r", "`n")) -and -not $text.Contains('def _first_present(value, *alternatives):')) {
  $text = $text.Replace($oldHelper.TrimEnd("`r", "`n"), $newHelper.TrimEnd("`r", "`n"))
}

$oldArrays = @'
    texts = data.get("rec_texts") or data.get("rec_text") or []
    scores = data.get("rec_scores") or data.get("rec_scores") or []
    boxes = data.get("rec_boxes") or data.get("dt_polys") or []
'@
$newArrays = @'
    texts = _first_present(data.get("rec_texts"), data.get("rec_text"))
    scores = _first_present(data.get("rec_scores"))
    boxes = _first_present(data.get("rec_boxes"), data.get("dt_polys"))
'@
if ($text.Contains($oldArrays.TrimEnd("`r", "`n"))) {
  $text = $text.Replace($oldArrays.TrimEnd("`r", "`n"), $newArrays.TrimEnd("`r", "`n"))
} elseif (-not $text.Contains('texts = _first_present(data.get("rec_texts"), data.get("rec_text"))')) {
  throw "Could not locate Paddle NumPy array extraction block."
}

# 4) Run independent image inference concurrently so 3 images do not wait serially.
$oldLoop = @'
    engine = _get_paddle(language)
    all_entries = []
    engine_ms = 0
    for image, original_width, original_height, scale, image_index in prepared:
        image_started = time.monotonic()

        def infer(source):
            return extract_paddle(engine.predict(source), image_index, scale, original_width, original_height)

        entries = await asyncio.to_thread(infer, np.asarray(image))
        first_quality = quality(entries)
        if first_quality < 0.55:
            fallback_entries = await asyncio.to_thread(infer, np.asarray(enhanced_image(image)))
            if quality(fallback_entries) > first_quality:
                entries = fallback_entries
        elapsed = round((time.monotonic() - image_started) * 1000)
        engine_ms += elapsed
        all_entries.extend(entries)
        print(f"[ocr:paddle] image={image_index + 1} lang={normalize_language(language)} size={original_width}x{original_height} entries={len(entries)} engine={elapsed}ms")
'@
$newLoop = @'
    engine = _get_paddle(language)

    async def process_one(image, original_width, original_height, scale, image_index):
        image_started = time.monotonic()

        def infer(source):
            return extract_paddle(engine.predict(source), image_index, scale, original_width, original_height)

        entries = await asyncio.to_thread(infer, np.asarray(image))
        first_quality = quality(entries)
        if first_quality < 0.55:
            fallback_entries = await asyncio.to_thread(infer, np.asarray(enhanced_image(image)))
            if quality(fallback_entries) > first_quality:
                entries = fallback_entries
        elapsed = round((time.monotonic() - image_started) * 1000)
        print(f"[ocr:paddle] image={image_index + 1} lang={normalize_language(language)} size={original_width}x{original_height} entries={len(entries)} engine={elapsed}ms")
        return entries, elapsed

    batches = await asyncio.gather(*[
        process_one(image, original_width, original_height, scale, image_index)
        for image, original_width, original_height, scale, image_index in prepared
    ])
    all_entries = []
    engine_ms = 0
    for entries, elapsed in batches:
        all_entries.extend(entries)
        engine_ms += elapsed
'@
if ($text.Contains($oldLoop.TrimEnd("`r", "`n"))) {
  $text = $text.Replace($oldLoop.TrimEnd("`r", "`n"), $newLoop.TrimEnd("`r", "`n"))
}

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($file, $text, $utf8NoBom)

& (Join-Path $root "ocr-service\.venv\Scripts\python.exe") -m py_compile $file
if ($LASTEXITCODE -ne 0) { throw "Paddle OCR main.py failed Python syntax validation." }

Write-Host "Paddle runtime repaired: oneDNN disabled, NumPy-safe parsing, concurrent image OCR, syntax validated."
