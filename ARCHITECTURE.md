# PARAKH Technical Architecture

## 1. Architecture goals

PARAKH separates the presentation layer, API/business logic, OCR/AI processing, evidence verification, compliance rules, persistence, reporting, analytics, and batch-safety workflows.

AI is an assistive layer. It is not the legal source of truth.

## 2. Current high-level architecture

```text
┌──────────────────────────────────────────────────────────────────┐
│                         PARAKH CLIENT                            │
│ React + Vite + React Router                                     │
│ Dashboard | Scan | Shops | Products | History | Reports         │
│ E-commerce | Admin | Compliance Intelligence | Batch Safety    │
│ Responsive theme system                                         │
└───────────────────────────────┬──────────────────────────────────┘
                                │ REST / JSON / multipart
                                ▼
┌──────────────────────────────────────────────────────────────────┐
│                     NODE + EXPRESS BACKEND                       │
│ Auth | Products | Shops | Categories | Inspections              │
│ OCR orchestration | Evidence verification | Rules | Reports    │
│ Analytics | Batch incidents | Batch alerts                     │
└───────────────┬────────────────┬───────────────────────┬─────────┘
                │                │                       │
                ▼                ▼                       ▼
        ┌───────────────┐  ┌──────────────────────┐ ┌─────────────────┐
        │ PostgreSQL    │  │ OCR / AI / reference │ │ Analytics +     │
        │ via Prisma 7  │  │ RapidOCR → Gemini    │ │ Batch Safety    │
        │               │  │       → DataKart    │ │                 │
        └───────────────┘  └──────────┬───────────┘ └────────┬────────┘
                                     │                      │
                                     ▼                      ▼
                              Evidence confidence    Human/admin review
                                     │                      │
                                     └──────────┬───────────┘
                                                ▼
                                      Legal Rules Engine
                                                │
                                                ▼
                                      Inspection / Report
```

## 3. Frontend architecture

The current client uses React 19, Vite, React Router, JSX/JavaScript, shared CSS/theme infrastructure, responsive layouts, and session-level GET caching with mutation invalidation where implemented.

The main inspection flow supports:

- multi-image capture/upload
- OCR result review
- editable structured fields
- spatial/evidence information where available
- multimodal semantic analysis
- GTIN/reference verification
- compliance findings
- confidence/verification states
- manual violation entry
- human review
- product registration

Additional application areas include Compliance Intelligence, Batch Safety, global category administration, compliance-rule administration, and e-commerce inspection.

## 4. Backend architecture

The backend uses Node.js, Express 5, ES modules, Multer, Sharp, Prisma 7, and PostgreSQL.

The route surface includes authentication, products, categories, shops, inspections, OCR, rules, administration, analytics, and batch-safety operations.

Important analytics endpoints include:

```text
/api/analytics/dashboard
/api/analytics/intelligence
```

Batch-safety operations are exposed through:

```text
/api/batch-alerts
/api/batch-alerts/incidents
/api/batch-alerts/incidents/:id/verify
/api/batch-alerts/:id/resolve
```

## 5. Current inspection / AI pipeline

```text
Package image(s)
      ↓
RapidOCR + image processing
      ↓
OCR evidence
(text + confidence + bounding box where available)
      ↓
Deterministic field reconciliation
      ↓
Gemini multimodal semantic interpretation
      ↓
Structured compliance fields
      ↓
GTIN / DataKart reference verification
      ↓
Evidence confidence fusion
      ↓
Legal Metrology Rules Engine
      ↓
Human verification
      ↓
Inspection + report + intelligence update
```

RapidOCR supplies primary machine-readable text evidence. Gemini maps content and spatial context to structured declarations. DataKart can provide reference evidence when a GTIN/barcode can be matched. The legal Rules Engine performs deterministic compliance evaluation.

Additional semantic providers may be configurable where supported, but they are optional and do not replace RapidOCR or the Rules Engine.

## 6. RapidOCR service

RapidOCR is the primary OCR service. The backend sends package images to the configured `RAPID_OCR_URL` and can receive OCR text, confidence and geometry.

Relevant configuration includes:

```text
RAPID_OCR_URL
RAPIDOCR_LANG_TYPE
RAPIDOCR_MAX_SIDE
RAPIDOCR_USE_CLS
RAPIDOCR_TEXT_SCORE
OCR_TIMEOUT_MS
```

The default local OCR endpoint is `http://localhost:8081` when configured that way.

## 7. Field reconciliation and spatial reasoning

The reconciliation layer converts OCR detections into structured declarations using labels, spatial relationships, text similarity, field-specific patterns, OCR confidence, and bounding-box geometry.

A resolved field can retain source-image information, evidence text, bounding-box geometry, and OCR confidence. This allows context such as a label/value relationship to be reviewed instead of relying only on exact keyword matches.

## 8. Gemini semantic layer

Gemini interprets package images and OCR evidence to perform semantic tasks such as:

- mapping text to compliance fields
- identifying product and brand information
- resolving contextual labels and nearby values
- interpreting package information that is not a simple exact text match

Gemini output contributes evidence for structured fields but does not directly make the final legal decision.

## 9. GTIN / DataKart verification

GTIN/barcode verification is optional. When a GTIN is available, PARAKH can query the separate DataKart product registry and compare registered values against the current inspection fields.

DataKart is a reference/evidence source, not the legal decision-maker.

When a product is not registered or GTIN verification is unavailable, inspection processing can continue with the available OCR, image and semantic evidence.

## 10. Evidence confidence

The current field-level evidence score uses available sources approximately as follows:

```text
50% DataKart agreement
30% Gemini semantic confidence
20% RapidOCR evidence confidence
```

If a source is unavailable, its contribution is omitted and the remaining available weights are renormalized.

The result is an evidence-fusion indicator, not a calibrated probability and not legal certainty.

Verification states used by the application can include:

```text
Verified
Needs Verification
Missing
```

## 11. Compliance Rules Engine

The legal/business-rule layer receives structured inspection information and evaluates configured Legal Metrology requirements.

```text
Structured field values
        +
Configured legal rules
        ↓
Deterministic evaluation
        ↓
Finding + evidence
        ↓
Human verification
```

Rules are not hidden in an LLM prompt or scattered through React components.

Authorized administrators can manage configurable `ComplianceRule` definitions from the admin interface.

## 12. Human-in-the-loop

The intended review sequence is:

```text
OCR + AI interpretation
        ↓
Field + evidence confidence
        ↓
Reference verification where available
        ↓
Rules evaluation
        ↓
Officer reviews uncertain/conflicting findings
        ↓
Accept / correct / reject / add manual violation
        ↓
Complete inspection and generate report
```

Human verification is also required before a reported batch incident becomes a verified safety alert.

## 13. Compliance Intelligence

Inspection records feed the current analytics layer.

Available filters include:

```text
Manufacturer
Product
GTIN
Batch
Violation type
City / district
State
Date range
Verified only
```

The intelligence page renders dynamic graphs for:

- inspection trend over time
- violations by city/district
- violation types
- affected batches
- violation severity
- manufacturer violation rate

It also provides manufacturer analytics and active verified batch alerts.

The intended drill-down model is:

```text
State → District → Manufacturer → Product → Batch → Inspection
```

The current implementation uses shop city as the district-like field where a dedicated district column is not yet present.

## 14. Batch Safety Network

Batch safety is modeled independently from product-level compliance.

```text
Field/admin incident report
        ↓
Administrative review
        ↓
Verified batch alert
        ↓
In-app warning for product + exact batch
```

The database uses `BatchIncidentReport` and `BatchAlert` records. A verified alert is tied to a specific product and batch combination.

AI must not autonomously activate a serious batch warning.

## 15. Product classification and category management

The catalogue uses a flexible category tree with a practical four-level user-facing structure and an explicit final-category option.

Example:

```text
Food → Ready-to-Eat → Biscuits [Final]
Food → Ready-to-Eat → Biscuits → Oreo [Final]
```

Administrators can manage global category definitions separately from normal product registration.

## 16. Database architecture

PARAKH application data is stored in PostgreSQL through Prisma 7.

Core models include:

```text
User
Session
Shop
Category
Product
Scan
Inspection
ComplianceRule
BatchIncidentReport
BatchAlert
```

Inspection records include fields supporting violation type/severity, verification state and batch association. Product records include manufacturer information and product-reference fields.

OCR/AI evidence can still travel in structured JSON/application result structures rather than requiring a normalized table for every evidence concept.

## 17. Reporting

Reports consume inspection and compliance results and can include detected fields, violations, verification status, evidence and inspection metadata.

The report layer does not replace the underlying inspection records or rules configuration.

## 18. Performance and failure handling

External OCR, semantic, reference, upload and database operations should use bounded waits and explicit error handling. User-facing responses should not expose secrets or raw stack traces.

The current architecture remains a modular monolith with external/local OCR and semantic services.

## 19. Scalability path

A future scale-out path can move OCR/AI work into queue-backed workers without changing the conceptual inspection pipeline. Compliance Intelligence can then operate over a larger inspection dataset while retaining the same product, batch and rule relationships.

## 20. Security

Never commit secrets. Validate uploads server-side. Authenticate protected APIs. Authorize role-sensitive operations. Keep DataKart credentials in environment variables. Do not expose database service-role credentials to the browser.

## 21. Documentation authority

The source code is authoritative for implemented behavior. This document describes the current technical architecture, while `ROADMAP.md` records future work.
