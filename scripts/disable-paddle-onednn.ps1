$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$file = Join-Path $root "ocr-service\main.py"

if (-not (Test-Path $file)) { throw "ocr-service/main.py not found: $file" }

$text = Get-Content -Raw -Path $file

# PaddlePaddle 3.x CPU inference can hit an upstream PIR/oneDNN conversion bug
# on Windows. Disable oneDNN before importing PaddleOCR and explicitly disable it
# in the PaddleOCR runtime configuration.
$envMarker = 'os.environ.setdefault("ORT_INTER_OP_NUM_THREADS", "1")'
if (-not $text.Contains('os.environ.setdefault("FLAGS_use_mkldnn", "0")')) {
  if (-not $text.Contains($envMarker)) {
    throw "Could not find OCR environment configuration block in ocr-service/main.py"
  }
  $text = $text.Replace(
    $envMarker,
    $envMarker + "`r`n" +
      '# PaddlePaddle 3.x CPU oneDNN/PIR workaround for Windows.' + "`r`n" +
      'os.environ.setdefault("FLAGS_use_mkldnn", "0")'
  )
}

if (-not $text.Contains('"enable_mkldnn": False')) {
  # Insert immediately after the existing device entry regardless of CRLF/LF style.
  $pattern = '(?m)(\s*"device"\s*:\s*PADDLE_DEVICE\s*,\s*)\r?\n(\s*\})'
  $replacement = '$1`r`n        "enable_mkldnn": False,$2'
  $updated = [regex]::Replace($text, $pattern, $replacement, 1)
  if ($updated -eq $text) {
    throw "Could not locate Paddle config device entry in ocr-service/main.py"
  }
  $text = $updated
}

# Windows PowerShell 5.1 compatible UTF-8 without BOM.
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($file, $text, $utf8NoBom)

Write-Host "Patched PaddleOCR CPU runtime: oneDNN disabled for Windows stability."
