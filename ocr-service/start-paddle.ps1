$ErrorActionPreference = "Stop"

if (-not (Test-Path ".venv\Scripts\python.exe")) {
  py -3.13 -m venv .venv
}

& .\.venv\Scripts\python.exe -m pip install --upgrade pip
& .\.venv\Scripts\python.exe -m pip install -r requirements-paddle.txt
& .\.venv\Scripts\python.exe -m uvicorn main:app --host 0.0.0.0 --port 8081
