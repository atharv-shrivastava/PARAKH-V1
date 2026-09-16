# PARAKH

**Packaged Article Regulatory Assessment & Knowledge Hub**

**SIH Problem Statement: 26034**

PARAKH is an AI-assisted inspection and compliance platform for packaged commodities in India, designed around the **Legal Metrology Act, 2009** and the **Legal Metrology (Packaged Commodities) Rules, 2011**.

## What PARAKH does

PARAKH helps an authorized inspector move from package evidence to a reviewable compliance record:

```text
Capture / Upload Package Images
        ↓
Image Validation + Processing
        ↓
RapidOCR + Spatial Evidence
        ↓
Field Reconciliation
        ↓
Gemini Multimodal Interpretation
        ↓
GTIN / DataKart Reference Evidence
        ↓
Field-Level Evidence Fusion
        ↓
Product / Category Classification
        ↓
Legal Metrology Rules Engine
        ↓
Visual Screening / Measurement Checks
        ↓
Human Verification
        ↓
Inspection + Batch Intelligence
        ↓
Final Compliance Report
```

OCR and AI provide evidence and interpretation. The deterministic Rules Engine evaluates configured requirements, while the authorized officer reviews uncertain/conflicting findings and records the final inspection decision.

## Detailed feature documentation

The complete feature-level inventory is maintained in [`docs/FEATURE_CATALOG.md`](docs/FEATURE_CATALOG.md).

It documents not only the headline features but also the smaller implementation details, including:

- React/Vite UI and responsive behavior
- navigation, themes, forms, loading/error/empty states
- multi-image inspection and image handling
- Sharp image processing
- RapidOCR configuration and failure handling
- OCR bounding boxes and evidence localization
- Gemini semantic extraction
- evidence fusion and verification states
- GTIN/DataKart verification and fallback behavior
- product/category hierarchy and final-category selection
- deterministic Legal Metrology rule evaluation
- Rule 23 officer assessment
- OpenCV visual-processing extensions
- font-size analysis and physical-reference calibration work
- human-in-the-loop verification
- dynamic Compliance Intelligence graphs
- combined analytics filters
- dynamically changing counters and graph datasets
- manufacturer analytics
- batch safety alerts
- shops and inspection history
- product registration
- e-commerce inspection
- multilingual reports/UI
- administration and role-aware access
- API responsibilities
- Prisma/PostgreSQL persistence
- validation, caching, error handling, security, and performance behavior

## Current technology

### Frontend

- React 19
- Vite
- React Router
- JSX/JavaScript
- Responsive CSS and centralized theme system
- Light, dark, gradient, and palette variants
- Dynamic dashboard and Compliance Intelligence visualizations
- Client-side report generation where used

### Backend

- Node.js
- Express 5
- REST APIs
- Multer for image uploads
- Sharp for image processing
- Prisma 7
- PostgreSQL
- Role-aware authentication and authorization
- Zod validation where configured

### OCR / AI / visual processing

- RapidOCR primary OCR service
- Gemini multimodal semantic interpretation
- GTIN/DataKart reference verification
- OpenCV visual-processing extensions in feature branches
- OCR geometry and visual evidence processing

### Reporting

- jsPDF where used for report generation

## OpenCV work

PARAKH has dedicated OpenCV feature branches for visual inspection and measurement work:

```text
feat/opencv-font-size-rules
feat/opencv-10rs-coin-calibration
feat/opencv-package-background-separation
```

These branches cover work such as OCR bounding-box based text-height analysis, font-size related checks, physical-reference calibration experiments, and package/background separation.

The `main` branch is the authority for merged functionality. Feature-branch work must not be represented as deployed production functionality until merged and verified.

## Compliance Intelligence

Stored inspections feed the intelligence layer. Current filters include:

```text
Manufacturer | Product | GTIN | Batch | Violation
City / District | State | Date range | Verified only
```

The dashboard can display dynamic visualizations for inspection trends, violation types, affected batches, severity, geography, and manufacturer violation rates.

Filters are data-driven: changing the selected filters changes the inspection population used for aggregation, which updates the displayed counters, graph datasets, tables, and related analytics.

## Batch Safety Network

Batch incidents are handled separately from ordinary product-level compliance:

```text
Incident reported
      ↓
Administrative verification
      ↓
Verified batch alert
      ↓
Warning for product + exact batch
```

AI does not autonomously declare a batch defective or activate a verified safety alert.

## Evidence confidence

Current V1 evidence fusion uses the following weights when all sources are available:

```text
50% DataKart agreement
30% Gemini semantic confidence
20% RapidOCR evidence confidence
```

Unavailable sources are omitted and the remaining weights are renormalized.

This is an engineering evidence-fusion indicator, not a calibrated probability and not legal certainty.

## Product hierarchy

PARAKH uses a flexible category tree with a practical user-facing hierarchy and final-category selection:

```text
Food → Ready-to-Eat → Biscuits [Final]
```

Administrators can manage global category definitions separately from ordinary product registration.

## Local development services

Run each service in a separate PowerShell terminal.

### 1. Rules Engine

```powershell
cd C:\parakh-copy\rules-engine
pnpm install
pnpm run build
pnpm start
```

### 2. OCR Service

```powershell
cd C:\parakh-copy\ocr-service
.\venv\Scripts\Activate.ps1
python -m uvicorn main:app --host 0.0.0.0 --port 8081
```

RapidOCR is the primary OCR service.

### 3. Backend API

```powershell
cd C:\parakh-copy\backend
pnpm install
pnpm run dev
```

Or:

```powershell
pnpm start
```

### 4. Frontend

```powershell
cd C:\parakh-copy\frontend
pnpm install
pnpm run dev
```

The Vite frontend normally runs on `http://localhost:5173`.

## Repository documentation

- `README.md` — product overview and local startup
- `PROJECT_SPEC.md` — functional specification
- `ARCHITECTURE.md` — technical architecture and service boundaries
- `docs/FEATURE_CATALOG.md` — exhaustive feature-level documentation, including small UI/UX and engineering features
- `DATABASE_SCHEMA.md` — logical data model
- `COMPLIANCE_ENGINE.md` — Legal Metrology rule architecture
- `API_SPEC.md` — API contract and endpoint groups
- `UI_UX_SPEC.md` — interface requirements
- `DEVELOPMENT_RULES.md` — engineering rules
- `ROADMAP.md` — planned work

The working source code is authoritative for the exact implementation state of every feature.

## Prototype boundary

PARAKH is an SIH-oriented working prototype. It is not a claim of national-scale deployment or complete statutory coverage. Context-dependent legal decisions and physical measurements can require authorized officer verification.
