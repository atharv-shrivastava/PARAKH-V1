# PARAKH

**Packaged Article Regulatory Assessment & Knowledge Hub**

PARAKH is an AI-assisted inspection and compliance platform for packaged commodities in India, designed around the **Legal Metrology Act, 2009** and the **Legal Metrology (Packaged Commodities) Rules, 2011**.

## Vision

Help inspectors examine packaged products faster, extract declaration information from package images, identify potential compliance issues, verify findings, register reusable product intelligence, and analyze inspection history.

## Core workflow

**Capture → RapidOCR → Extract → Classify → Verify → Apply Rules → Review → Register → Analyze**

AI output is advisory. The authorized inspector remains responsible for reviewing and confirming compliance findings.

## Current platform

PARAKH is a responsive web application for mobile, tablet, laptop, and desktop.

### Frontend

- React 19
- Vite
- React Router
- Responsive CSS theme system
- Light, dark, dark-gradient, gradient, and rainbow themes
- Client-side GET caching with mutation invalidation
- jsPDF where client-side report generation is used

### Backend

- Node.js
- Express 5
- REST APIs
- Multer for image uploads
- Sharp for image processing
- Prisma 7 with the PostgreSQL driver adapter
- Role-aware authentication and authorization

### Database

- PostgreSQL through Prisma for PARAKH application data
- A separate Supabase-backed **DataKart** registry is used as an external product-reference source keyed primarily by GTIN/barcode

## Current OCR and AI architecture

```text
Package image(s)
      ↓
RapidOCR service
      ↓
OCR evidence
(text + confidence + bounding box + image metadata)
      ↓
Deterministic field reconciliation
      ↓
Gemini semantic interpretation
      ↓
Semantic consensus / structured fields
      ↓
DataKart GTIN verification
      ↓
Evidence confidence fusion
      ↓
Rules Engine
      ↓
Officer review
```

RapidOCR supplies the primary machine-readable text evidence. Gemini performs semantic interpretation such as mapping package text and spatial context to structured declarations. The legal Rules Engine remains deterministic and is not replaced by AI.

Additional Cloudflare semantic providers can be enabled through configuration for broader semantic consensus, but Gemini is the default semantic provider in the current V1 path.

## Evidence confidence

PARAKH uses a weighted **Evidence Confidence** score for extracted fields:

```text
50% DataKart agreement
30% Gemini semantic confidence
20% RapidOCR evidence confidence
```

DataKart is intentionally the strongest signal because a matching registered product provides a direct reference check. When DataKart is unavailable or a field is not registered, its weight is excluded and the remaining available weights are renormalized instead of treating the missing registry as a failure.

The score is an evidence-fusion indicator, not a calibrated statistical probability and not legal certainty.

Each field can also expose verification state:

- `✓` — DataKart match
- `✕` — DataKart mismatch
- `?` — DataKart could not verify the field

## Product hierarchy

The catalogue is hierarchical and must remain intact:

**Category → Subcategory → Product Type → Brand → Product → Pack Size / Variant**

## Core modules

- Dashboard and real inspection analytics
- Multi-image package scanning
- RapidOCR extraction and evidence localization
- Gemini semantic field mapping
- Evidence confidence and uncertainty handling
- DataKart GTIN-based product verification
- Visual inspection screening
- Product/category classification
- Configurable Legal Metrology rules
- Officer review and manual violations
- Product registration
- Shop management and shop-wise history
- Inspection history and filtering
- Reports and PDF output
- E-commerce inspection
- Admin controls and platform analytics
- Theme and responsive UI system

## Compliance approach

Legal requirements belong in the compliance engine, not in the UI and not inside an LLM.

The system distinguishes between compliant results, violations, review states, and cases where the available evidence is insufficient. Findings should remain traceable to the rule, extracted value or observation, supporting evidence, and officer decision.

AI confidence is not the same as legal certainty.

## DataKart boundary

DataKart is a separate product-reference registry. PARAKH queries it using an extracted GTIN/barcode and compares returned registered values against the current inspection fields. DataKart does **not** determine Legal Metrology compliance.

## Evidence

Where available, extracted fields retain source image information, OCR text, confidence, bounding-box geometry, semantic provenance, and DataKart verification metadata.

## Security

Never commit API keys, database credentials, production secrets, private certificates, or real sensitive inspection data. Use environment variables for local and deployed configuration.

## Repository documentation

- `PROJECT_SPEC.md` — functional specification
- `ARCHITECTURE.md` — current technical architecture
- `DATABASE_SCHEMA.md` — logical data model
- `AI_MODULES.md` — OCR, semantic interpretation, and evidence confidence
- `COMPLIANCE_ENGINE.md` — Legal Metrology rule architecture
- `API_SPEC.md` — API contract and current endpoint groups
- `UI_UX_SPEC.md` — interface requirements
- `DEVELOPMENT_RULES.md` — engineering rules
- `ROADMAP.md` — planned work

The working source code is authoritative for implemented behavior.