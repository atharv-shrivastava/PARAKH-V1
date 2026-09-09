# PARAKH Technical Architecture

## 1. Architecture goals

PARAKH separates presentation, API/business logic, OCR/AI processing, evidence verification, compliance rules, persistence, reporting, and analytics.

AI is an assistive layer. It is not the legal source of truth.

## 2. Current high-level architecture

```text
┌─────────────────────────────────────────────────────────────┐
│                         PARAKH CLIENT                       │
│ React + Vite + React Router                                │
│ Dashboard | Scan | Shops | Products | History | Reports    │
│ E-commerce | Admin | Responsive themes                     │
└───────────────────────────────┬─────────────────────────────┘
                                │ REST / JSON / multipart
                                ▼
┌─────────────────────────────────────────────────────────────┐
│                     NODE + EXPRESS BACKEND                  │
│ Auth | Products | Shops | Categories | Inspections         │
│ OCR orchestration | Evidence confidence | Rules | Reports  │
└───────────────┬────────────────┬────────────────────────────┘
                │                │
                ▼                ▼
        ┌───────────────┐   ┌──────────────────────────────┐
        │ PostgreSQL    │   │ OCR / AI / verification      │
        │ via Prisma    │   │ RapidOCR → Gemini → DataKart│
        └───────────────┘   └──────────────┬───────────────┘
                                          │
                                          ▼
                               ┌────────────────────────┐
                               │ Evidence confidence    │
                               │ 50% DataKart           │
                               │ 30% Gemini             │
                               │ 20% RapidOCR           │
                               └────────────┬───────────┘
                                            │
                                            ▼
                               ┌────────────────────────┐
                               │ Compliance Rules Engine │
                               │ deterministic checks    │
                               └────────────┬───────────┘
                                            │
                                            ▼
                                     Officer review
```

## 3. Frontend architecture

The current client uses React 19, Vite, React Router, JSX/JavaScript, shared CSS/theme infrastructure, responsive layouts, session-level GET caching, mutation-triggered invalidation, and jsPDF where used.

The Scan page supports multi-image capture/upload, OCR result review, editable fields, visual screening, compliance findings, manual violation entry, and product registration.

## 4. Backend architecture

The backend uses Node.js, Express 5, ES modules, Multer, Sharp, Prisma 7, and PostgreSQL.

Route groups include:

```text
/api/auth
/api/categories
/api/products
/api/shops
/api/rules
/api/admin
/api/analytics
/api/translate
/api/products/ecommerce-ocr
/api/ocr
```

The backend owns authentication, authorization, persistence, OCR/semantic orchestration, evidence processing, rule evaluation, and data APIs.

## 5. OCR and semantic pipeline

The current fast analysis route is:

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
Semantic consensus / structured result
      ↓
DataKart GTIN verification
      ↓
Evidence confidence fusion
      ↓
Rules Engine
      ↓
Officer review
```

Additional Cloudflare semantic providers can be enabled with configuration. They are optional and do not replace RapidOCR or the Rules Engine.

## 6. RapidOCR service

RapidOCR is the primary OCR/detection service. The backend sends package images to the configured `RAPID_OCR_URL` and receives OCR text, confidence, and geometry where available.

Relevant environment variables include:

```text
RAPID_OCR_URL
RAPIDOCR_LANG_TYPE
RAPIDOCR_MAX_SIDE
RAPIDOCR_USE_CLS
RAPIDOCR_TEXT_SCORE
OCR_TIMEOUT_MS
```

The default local endpoint is `http://localhost:8081`.

## 7. Deterministic field reconciliation

The reconciliation layer converts OCR detections into structured declarations. It uses labels, spatial relationships, text similarity, field-specific patterns, OCR confidence, and bounding-box geometry.

A resolved field can retain an `evidenceIndex`, source image, evidence text, bounding box, and OCR confidence.

## 8. Gemini semantic layer

Gemini interprets package images and OCR evidence to solve semantic mapping problems such as assigning nearby text/value pairs to the correct declaration field and understanding product/brand identity.

Its field confidence contributes to Evidence Confidence when Gemini successfully supplies semantic output.

## 9. DataKart verification layer

DataKart is an external product-reference registry maintained separately from the PARAKH PostgreSQL application database.

The backend uses an extracted GTIN/barcode to query the active DataKart product and compare registered values with the current inspection fields.

DataKart is a verification source, not the legal decision-maker.

## 10. Evidence confidence architecture

Each structured field can receive a fused Evidence Confidence score.

```text
DataKart agreement       50%
Gemini confidence        30%
RapidOCR confidence      20%
```

DataKart match = `1.0` for that component.
DataKart mismatch = `0.0` for that component.
DataKart field unavailable/unregistered = component omitted and the remaining source weights are renormalized.

The result is explicitly an evidence-fusion indicator, not a calibrated probability and not a statement of legal certainty.

Each field can also expose:

```text
MATCH       → ✓
MISMATCH    → ✕
UNVERIFIED  → ?
```

## 11. Evidence model

Evidence can include OCR text, confidence, source image, bounding box, image dimensions, semantic provenance, registered DataKart value, verification state, and final Evidence Confidence.

This supports explainability and officer review.

## 12. Product classification

Classification combines catalogue hierarchy, OCR-derived product/brand information, semantic suggestions, and officer confirmation.

The canonical hierarchy remains:

`Category → Subcategory → Product Type → Brand → Product → Pack Size / Variant`

## 13. Compliance Engine boundary

```text
Structured field values
        +
Configured legal rules
        ↓
Deterministic evaluation
        ↓
Finding
        ↓
Officer verification
```

Legal requirements must remain in the compliance/rules layer. They must not be encoded as hidden LLM decisions or scattered through React components.

## 14. Human-in-the-loop

The intended review path is:

```text
RapidOCR + Gemini
      ↓
Field + Evidence Confidence
      ↓
DataKart verification
      ↓
Rules evaluation
      ↓
Inspector reviews uncertain/conflicting evidence
      ↓
Correct / accept / reject / add manual violation
      ↓
Register / complete inspection
```

## 15. Database architecture

PARAKH application data is stored in PostgreSQL through Prisma. OCR/AI evidence and inspection metadata currently travel partly inside application JSON structures rather than requiring a dedicated database table for every evidence concept.

DataKart remains external to the application database.

## 16. Performance and failure handling

Independent external providers should use bounded waits where practical. The backend records provider/model timing and failure information. OCR, semantic, DataKart, database, upload, and report failures must be handled without exposing secrets or stack traces to the user.

## 17. Scalability path

The current implementation is a modular monolith with external/local OCR and semantic services.

A future scale-out path can move OCR/AI work into queue-backed workers without changing the conceptual pipeline.

## 18. Security

Never commit secrets. Validate uploads server-side. Authenticate protected APIs. Authorize role-sensitive operations. Keep DataKart credentials in environment variables. Never expose database service-role credentials to the browser.

## 19. Documentation authority

The source code is authoritative for implemented behavior. This document describes the current architecture, while `ROADMAP.md` records future work.