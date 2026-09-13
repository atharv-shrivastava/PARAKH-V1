# PARAKH

**Packaged Article Regulatory Assessment & Knowledge Hub**

PARAKH is an AI-assisted inspection and compliance platform for packaged commodities in India, designed around the **Legal Metrology Act, 2009** and the **Legal Metrology (Packaged Commodities) Rules, 2011**.

## Vision

Help inspectors examine packaged products faster, extract declaration information from package images, identify potential compliance issues, verify findings, register reusable product intelligence, and turn inspection records into connected compliance intelligence.

## Current V1 workflow

```text
Capture / Upload Package Images
        ↓
RapidOCR + Image Processing
        ↓
Multimodal AI Interpretation
        ↓
Multi-Source Verification
        ↓
Legal Metrology Rule Engine
        ↓
Compliance Assessment
        ↓
Human Verification
        ↓
Inspection + Batch Intelligence
        ↓
Final Compliance Report
```

The system supports multi-image package inspection. OCR provides text and spatial evidence, Gemini performs semantic interpretation, GTIN/DataKart can provide registered-product reference evidence, and the deterministic Rules Engine evaluates configured Legal Metrology requirements. Human review remains part of the intended decision flow.

## Local development services

Run each service in a separate PowerShell terminal.

### 1. Rules Engine

```powershell
cd C:\parakh-copy\rules-engine
pnpm install
pnpm run build
pnpm start
```

The Rules Engine runs its TypeScript build first and then starts the compiled server.

### 2. OCR Service

```powershell
cd C:\parakh-copy\ocr-service
.\venv\Scripts\Activate.ps1
python -m uvicorn main:app --host 0.0.0.0 --port 8081
```

RapidOCR is the primary OCR service used by PARAKH.

### 3. Backend API

```powershell
cd C:\parakh-copy\backend
pnpm install
pnpm run dev
```

Or for the normal start command:

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

## Current platform

PARAKH is a responsive web application for mobile, tablet, laptop, and desktop.

### Frontend

- React 19
- Vite
- React Router
- Responsive CSS and centralized theme system
- Light, dark, gradient, and palette variants
- User/admin dashboards
- Compliance Intelligence dashboard with dynamic SVG graphs
- Batch Safety Network interface
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

### Data and reference services

- PostgreSQL through Prisma for PARAKH application data
- Supabase-backed **DataKart** product reference registry as an external GTIN/barcode verification source
- RapidOCR as the primary OCR service
- Gemini as the default multimodal semantic provider

## Current OCR / AI / verification architecture

```text
Package image(s)
      ↓
RapidOCR
      ↓
OCR evidence
(text + confidence + bounding box where available)
      ↓
Field reconciliation
      ↓
Gemini semantic interpretation
      ↓
Structured compliance fields
      ↓
GTIN / DataKart verification
      ↓
Evidence confidence fusion
      ↓
Legal Metrology Rules Engine
      ↓
Human verification
```

Barcode/GTIN is optional. When a product reference is unavailable, the inspection can continue using the available package evidence and AI/OCR interpretation. External reference or web evidence must be treated as supporting evidence, not as a replacement for the legal rules layer.

## Evidence confidence

PARAKH uses an evidence-fusion score for extracted fields when the relevant sources are available:

```text
50% DataKart agreement
30% Gemini semantic confidence
20% RapidOCR evidence confidence
```

Unavailable sources are omitted and the remaining available weights are renormalized.

The score is an evidence-fusion indicator, not a calibrated statistical probability and not legal certainty.

Verification state can be surfaced as:

- `Verified`
- `Needs Verification`
- `Missing`

## Core V1 features

- Multi-image package capture/upload
- RapidOCR text extraction and spatial evidence
- Multimodal AI interpretation
- GTIN/barcode reference verification
- Deterministic Legal Metrology rule evaluation
- Confidence-based verification states
- Human-in-the-loop review and manual violations
- Product registration and category hierarchy
- Shop/source management and inspection history
- E-commerce inspection
- Compliance reports
- Admin-managed compliance rules
- Admin-managed global product categories

## Compliance Intelligence

Every stored inspection can contribute to the intelligence layer. The current intelligence view supports filters such as:

```text
Manufacturer | Product | GTIN | Batch | Violation
City / District | State | Date range | Verified only
```

The dashboard provides dynamic visualizations for inspection trends, violation types, affected batches, severity, geography, and manufacturer violation rates, plus a manufacturer analytics table.

The intended drill-down model is:

```text
State → District → Manufacturer → Product → Batch → Inspection
```

The current implementation uses shop city as the district-like geographic field where a dedicated district field is not present.

## Batch Safety Network

PARAKH supports batch-specific safety incidents rather than treating the entire product as unsafe.

Workflow:

```text
Incident reported
      ↓
Administrative verification
      ↓
Verified batch alert
      ↓
Warning visible across PARAKH
```

Supported operational states include reported/reviewed incidents and active or resolved alerts. A verified alert is attached to a specific `productId + batchNumber` pair.

AI must not autonomously declare a batch defective. Human authorization is required before an incident becomes a verified batch alert.

## Product hierarchy

PARAKH uses a flexible category tree with a practical four-level user-facing hierarchy and a final-category option. This avoids forcing unnecessary levels for products that do not need them.

Example:

```text
Food → Ready-to-Eat → Biscuits [Final]
Food → Ready-to-Eat → Biscuits → Oreo [Final]
```

Administrators can manage global category definitions separately from ordinary product registration.

## Rule management

Compliance rules are stored as configurable `ComplianceRule` records. Authorized administrators can create and manage rule definitions from the admin interface rather than hard-coding every rule into the UI.

Legal requirements remain in the deterministic compliance layer rather than being hidden inside an LLM prompt.

## Compliance approach

The OCR, AI, registry and confidence layers provide evidence and interpretation. The Legal Metrology Rules Engine performs configured rule evaluation. The officer remains responsible for reviewing uncertain, conflicting, or insufficient evidence.

AI confidence is not the same as legal certainty.

## DataKart boundary

DataKart is a separate product-reference registry. PARAKH can query it using an extracted GTIN/barcode and compare registered product values with current inspection fields.

DataKart does **not** determine Legal Metrology compliance. It is only a reference/evidence source.

## Security

Never commit API keys, database credentials, production secrets, private certificates, or real sensitive inspection data. Use environment variables for local and deployed configuration.

## Repository documentation

- `README.md` — current product and architecture overview
- `PROJECT_SPEC.md` — functional specification
- `ARCHITECTURE.md` — current technical architecture
- `DATABASE_SCHEMA.md` — logical data model
- `AI_MODULES.md` — OCR, semantic interpretation, and evidence confidence
- `COMPLIANCE_ENGINE.md` — Legal Metrology rule architecture
- `API_SPEC.md` — API contract and endpoint groups
- `UI_UX_SPEC.md` — interface requirements
- `DEVELOPMENT_RULES.md` — engineering rules
- `ROADMAP.md` — planned work

The working source code is authoritative for implemented behavior.
