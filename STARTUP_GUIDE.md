# PARAKH V1 Local Startup Guide

This guide starts the complete PARAKH V1 local stack: the deterministic Rules Engine, Node backend, RapidOCR service, and React frontend.

## Prerequisites

Install:

- Node.js 20+
- npm
- Python 3.10+ recommended for the OCR service
- Git
- PostgreSQL/Supabase connection configured for the backend

Make sure the required `.env` files and API keys are present before starting services.

## 1. Rules Engine

The Rules Engine is a separate TypeScript service under `rules-engine/`. Its package defines `start` as a build followed by `node dist/src/server.js` and requires Node 20+. 

Open Terminal 1:

```powershell
cd C:\parakh-copy\rules-engine
npm install
npm start
```

For a build + test check instead:

```powershell
cd C:\parakh-copy\rules-engine
npm install
npm run check
```

## 2. RapidOCR / OCR Service

The OCR service runs on port `8081` and is used by the PARAKH V1 backend for package image OCR/analysis.

Open Terminal 2:

```powershell
cd C:\parakh-copy\ocr-service
.\venv\Scripts\Activate.ps1
python -m uvicorn main:app --host 0.0.0.0 --port 8081
```

If PowerShell blocks script activation, use:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\venv\Scripts\Activate.ps1
```

If the virtual environment does not exist yet:

```powershell
cd C:\parakh-copy\ocr-service
python -m venv venv
.\venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

Use the OCR service health/root endpoint in a browser or API client to confirm it is listening on port 8081.

## 3. PARAKH Node Backend

The backend is the main API server. It runs on port `5000` and exposes authentication, products, categories, DataKart, OCR proxy/integration, and compliance evaluation routes.

Open Terminal 3:

```powershell
cd C:\parakh-copy\backend
npm install
npx prisma generate
npx prisma migrate deploy
npm start
```

The backend start script runs Prisma migrations before starting `src/server.js`.

Expected local backend URL:

```text
http://localhost:5000
```

Health check:

```text
http://localhost:5000/health
```

## 4. React Frontend

Open Terminal 4:

```powershell
cd C:\parakh-copy\frontend
npm install
npm run dev
```

Vite normally prints the local URL in the terminal, commonly:

```text
http://localhost:5173
```

## 5. Recommended Startup Order

Start services in this order:

1. Rules Engine
2. OCR / RapidOCR service
3. PARAKH backend
4. React frontend

This avoids the backend trying to call a service that has not started yet. Civilization has somehow survived without this information being obvious, so here it is.

## 6. Quick Copy-Paste Startup Commands

### Terminal 1: Rules Engine

```powershell
cd C:\parakh-copy\rules-engine
npm install
npm start
```

### Terminal 2: OCR

```powershell
cd C:\parakh-copy\ocr-service
.\venv\Scripts\Activate.ps1
python -m uvicorn main:app --host 0.0.0.0 --port 8081
```

### Terminal 3: Backend

```powershell
cd C:\parakh-copy\backend
npm install
npx prisma generate
npx prisma migrate deploy
npm start
```

### Terminal 4: Frontend

```powershell
cd C:\parakh-copy\frontend
npm install
npm run dev
```

## 7. First-Time Setup Only

Do not reinstall dependencies every time you start PARAKH V1. For the first setup:

```powershell
cd C:\parakh-copy\rules-engine
npm install

cd ..\ocr-service
python -m venv venv
.\venv\Scripts\Activate.ps1
pip install -r requirements.txt

cd ..\backend
npm install
npx prisma generate
npx prisma migrate deploy

cd ..\frontend
npm install
```

After that, normal startup only needs the service start commands from Section 6.

## 8. Environment Configuration

Backend environment variables are documented in:

```text
backend/.env.example
```

Keep secrets out of Git. Configure values such as the database connection, Gemini/xAI credentials, DataKart settings, and OCR service URL in the local environment as required by the current build.

## 9. Core Local Service URLs

```text
Frontend:       http://localhost:5173
Backend:        http://localhost:5000
Backend health: http://localhost:5000/health
OCR service:    http://localhost:8081
```

The backend mounts OCR-related API routes under `/api/ocr` and communicates with the separate OCR service as configured by the project.

## 10. Common Problems

### PowerShell will not activate the OCR virtual environment

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\venv\Scripts\Activate.ps1
```

### Prisma client is out of date

```powershell
cd C:\parakh-copy\backend
npx prisma generate
```

### Database schema is not applied

```powershell
cd C:\parakh-copy\backend
npx prisma migrate deploy
```

### OCR connection fails

Check that Terminal 2 is still running and that the OCR service is listening on port `8081`.

### Frontend cannot reach backend

Check that the backend is running on port `5000` and that the frontend API configuration points to the correct backend URL.

### Rules Engine fails to start

Check Node version:

```powershell
node --version
```

The Rules Engine requires Node 20 or newer.

## 11. Stopping Services

Press `Ctrl+C` in each terminal.

For the OCR virtual environment, deactivation is optional:

```powershell
deactivate
```

## 12. Clean Dependency Reinstall

Use this only when dependencies are corrupted or lockfiles changed:

```powershell
cd C:\parakh-copy\rules-engine
Remove-Item -Recurse -Force node_modules
npm install

cd ..\backend
Remove-Item -Recurse -Force node_modules
npm install
npx prisma generate

cd ..\frontend
Remove-Item -Recurse -Force node_modules
npm install
```

For the OCR service:

```powershell
cd C:\parakh-copy\ocr-service
.\venv\Scripts\Activate.ps1
pip install -r requirements.txt --upgrade
```
