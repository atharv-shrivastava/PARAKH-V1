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

OCR and AI provide evidence and interpretation. The deterministic Rules Engine evaluates configured requirements, while the authorized officer reviews uncertain or conflicting findings and records the final inspection decision.

## Documentation map

| Document | Purpose |
|---|---|
| `README.md` | Product overview, technology, local startup, and project boundaries |
| `PROJECT_SPEC.md` | Functional/project specification |
| `ARCHITECTURE.md` | Service boundaries and technical architecture |
| `docs/FEATURE_CATALOG.md` | Detailed feature inventory, including small UI, analytics, admin, and engineering behavior |
| `docs/REPOSITORY_CODE_GUIDE.md` | Code-oriented guide to frontend, backend, OCR, AI, image processing, database, analytics, reporting, validation, and configuration |
| `docs/ADMIN_AND_ROLES.md` | Administrative capabilities, officer actions, role boundaries, and future admin controls |
| `docs/FUTURE_SCOPE.md` | Offline mode, GTIN/official registry integration, regulatory updates, computer vision, scale, security, and other future work |
| `DATABASE_SCHEMA.md` | Logical database model |
| `COMPLIANCE_ENGINE.md` | Legal Metrology rule architecture |
| `API_SPEC.md` | API contract and endpoint groups |
| `UI_UX_SPEC.md` | Interface requirements |
| `DEVELOPMENT_RULES.md` | Engineering rules |
| `ROADMAP.md` | Planned milestones |

The documentation intentionally distinguishes current implementation, feature-branch work, prototype limitations, and future scope.

## Current technology

### Frontend

- React 19
- Vite
- React Router
- JSX/JavaScript
- Responsive CSS and centralized theme system
- Light, dark, gradient, and palette variants
- Data-driven dashboard and Compliance Intelligence visualizations
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
- OpenCV visual-processing work in dedicated feature branches
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

These branches cover work such as OCR bounding-box based text-height analysis, font-size related checks, physical-reference calibration experiments, package/background separation, and geometry-based visual checks.

The merged `main` branch is the authority for current functionality. Feature-branch work must not be described as merged or deployed functionality until it is actually integrated and verified.

## Compliance Intelligence

Stored inspections feed the intelligence layer. Current filters include:

```text
Manufacturer | Product | GTIN | Batch | Violation
City / District | State | Date range | Verified only
```

The dashboard can display dynamic visualizations for inspection trends, violation types, affected batches, severity, geography, and manufacturer analytics.

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
      ↓
Resolution
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

## Future scope

Future work includes offline-first inspection and synchronization, local rule/product caches, resumable uploads, conflict resolution, official/authorized GTIN and product-registry integrations, government/legal-metrology integrations where permitted, rule versioning, stronger OpenCV measurement, improved multilingual/offline OCR, multi-model evidence verification, evidence provenance, state/district intelligence, officer review queues, expanded Batch Safety workflows, asynchronous processing workers, production media storage, and stronger enterprise security/audit controls.

See [`docs/FUTURE_SCOPE.md`](docs/FUTURE_SCOPE.md) for the full roadmap and boundaries.

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

## Prototype boundary

PARAKH is an SIH-oriented working prototype. It is not a claim of national-scale production deployment or complete statutory coverage. Context-dependent legal decisions and physical measurements can require authorized officer verification.

The working source code is authoritative for the exact implementation state of every feature.
