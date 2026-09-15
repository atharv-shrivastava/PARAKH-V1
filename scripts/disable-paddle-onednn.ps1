$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$file = Join-Path $root "ocr-service\main.py"

if (-not (Test-Path $file)) { throw "ocr-service/main.py not found: $file" }

$text = Get-Content -Raw -Path $file

$oldEnv = 'os.environ.setdefault("ORT_INTER_OP_NUM_THREADS", "1")'
$newEnv = @'
os.environ.setdefault("ORT_INTER_OP_NUM_THREADS", "1")
# PaddlePaddle 3.x CPU inference can hit an upstream PIR/oneDNN conversion bug
# on Windows. Keep PaddleOCR as primary, but force the stable non-oneDNN CPU path.
os.environ.setdefault("FLAGS_use_mkldnn", "0")
'@

if ($text.Contains($oldEnv) -and -not $text.Contains('os.environ.setdefault("FLAGS_use_mkldnn", "0")')) {
  $text = $text.Replace($oldEnv, $newEnv.TrimEnd("`r", "`n"))
}

$oldConfig = '        "device": PADDLE_DEVICE,\n    }'
$newConfig = '        "device": PADDLE_DEVICE,\n        "enable_mkldnn": False,\n    }'

if ($text.Contains($oldConfig)) {
  $text = $text.Replace($oldConfig, $newConfig)
} elseif (-not $text.Contains('"enable_mkldnn": False')) {
  throw "Could not find Paddle configuration block in ocr-service/main.py"
}

# Windows PowerShell 5.1 compatible UTF-8 without BOM.
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($file, $text, $utf8NoBom)

Write-Host "Patched PaddleOCR CPU runtime: oneDNN disabled for Windows stability."
