# PARAKH Project Specification

## Identity
**PARAKH — Packaged Article Regulatory Assessment & Knowledge Hub**  
SIH Problem Statement: **26034**

## Purpose
PARAKH assists inspectors in examining packaged commodities, extracting declarations, classifying products, verifying product information, evaluating applicable Legal Metrology requirements, recording officer decisions, and building reusable inspection intelligence.

## Core principle
AI assists; the authorized officer verifies. PARAKH must not present an AI prediction, registry match, or confidence score as a final legal determination.

## Current workflow

```text
Login
 ↓
Select/Add Shop
 ↓
Capture / Upload package images
 ↓
RapidOCR
 ↓
Deterministic field reconciliation
 ↓
Gemini semantic interpretation
 ↓
Structured result
 ↓
GTIN → DataKart reference verification
 ↓
Evidence Confidence
 ↓
Classification
 ↓
Rules / compliance evaluation
 ↓
Officer review, correction, or manual violation
 ↓
Register / save
 ↓
History + shop/product updates
 ↓
Reports + analytics
```

## Evidence confidence model

The current V1 field-confidence model uses a weighted evidence fusion:

```text
50% DataKart agreement
30% Gemini semantic confidence
20% RapidOCR evidence confidence
```

DataKart is the major signal because it provides a reference comparison against registered product information. If DataKart or an individual registered field is unavailable, its component is excluded and the remaining weights are renormalized.

The result is called **Evidence Confidence**. It is an engineering evidence-fusion indicator, not a statistically calibrated probability and not legal certainty.

Fields also carry a verification state:

```text
✓ MATCH
✕ MISMATCH
? UNVERIFIED
```

## Product hierarchy

`Category → Subcategory → Product Type → Brand → Product → Pack Size / Variant`

The hierarchy is fundamental and must not be replaced by a flat catalogue.

## Current modules

- Authentication and role-aware access
- Dashboard with real inspection analytics
- Multi-image product scanning
- RapidOCR extraction and evidence localization
- Deterministic field reconciliation
- Gemini semantic interpretation
- Optional additional semantic providers
- DataKart GTIN-based product verification
- Evidence confidence and uncertainty handling
- Visual screening
- Product/category hierarchy and suggestions
- Manual and automated compliance findings
- Product registration
- Shops and shop history
- Inspection history
- Reports/PDF output
- E-commerce inspection
- Administration
- Responsive themed UI
- Client GET caching and mutation invalidation

## Current technology

### Frontend
React 19, Vite, React Router, JSX/JavaScript, responsive CSS/theme system, jsPDF where used.

### Backend
Node.js, Express 5, ES modules, Multer, Sharp, Prisma 7, PostgreSQL driver adapter.

### OCR/AI/verification
RapidOCR service, deterministic field reconciliation, Gemini semantic interpretation, optional Cloudflare semantic providers, and separate DataKart reference verification.

## Data boundary

PARAKH application data is stored in its PostgreSQL/Prisma database. DataKart is maintained separately as a product-reference registry and is queried for GTIN-based verification. DataKart does not own PARAKH inspections and does not produce legal compliance verdicts.

## Legal boundary

Rules belong to the configurable compliance layer. RapidOCR extracts text evidence; semantic AI interprets fields; DataKart provides reference verification; the Rules Engine evaluates configured requirements; the officer verifies the final result.

## Prototype boundary

This is an SIH-oriented working prototype. The goal is a reliable end-to-end inspection vertical slice, not a claim of national-scale deployment or complete legal coverage. Exact statutory measurements and context-dependent legal decisions may require officer verification.