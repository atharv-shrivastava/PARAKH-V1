# PARAKH Technical Architecture

**SIH Problem Statement: 26034**

## 1. Architecture goals

PARAKH separates presentation, API/business logic, image processing, OCR, semantic interpretation, evidence verification, compliance rules, persistence, reporting, analytics, and batch-safety workflows.

The architectural boundary is intentional:

```text
OCR / Computer Vision → extract and measure evidence
AI / semantic layer   → interpret evidence
DataKart / GTIN       → provide reference evidence
Rules Engine           → deterministic configured evaluation
Officer                → human verification and final inspection decision
```

## 2. Current high-level architecture

```text
┌─────────────────────────────────────────────────────────────────────────┐
│                              PARAKH CLIENT                              │
│ React + Vite + React Router                                             │
│ Dashboard | Scan | Shops | Products | History | Reports                │
│ E-commerce | Admin | Intelligence | Batch Safety                       │
│ Responsive themes + dynamic filters + data-driven graphs               │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │ REST / JSON / multipart
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         NODE + EXPRESS BACKEND                          │
│ Auth | Products | Shops | Categories | Inspections                     │
│ Uploads | Sharp | OCR orchestration | Evidence | Rules | Reports      │
│ Analytics | Batch incidents | Batch alerts                            │
└──────────────┬─────────────────────┬─────────────────────┬──────────────┘
               │                     │                     │
               ▼                     ▼                     ▼
       ┌──────────────┐     ┌──────────────────────┐  ┌─────────────────┐
       │ PostgreSQL   │     │ OCR / AI / reference │  │ Analytics +     │
       │ via Prisma 7 │     │ RapidOCR → Gemini    │  │ Batch Safety    │
       │              │     │ → GTIN/DataKart      │  │                 │
       └──────────────┘     └───────────┬──────────┘  └────────┬────────┘
                                        │                      │
                                        ▼                      ▼
                                Evidence confidence     Human/admin review
                                        │                      │
                                        └──────────┬───────────┘
                                                   ▼
                                         Legal Rules Engine
                                                   │
                                                   ▼
                                      Inspection / Report / Intelligence
```

## 3. Frontend architecture

The client uses React 19, Vite, React Router, JSX/JavaScript, shared CSS/theme infrastructure, responsive layouts, and targeted GET caching with mutation invalidation where implemented.

Major interface areas include:

- Dashboard
- Scan
- Shops
- Products
- History
- Reports
- E-commerce
- Profile
- Administration
- Compliance Intelligence
- Batch Safety

The inspection flow supports multi-image capture/upload, image preview/removal, editable extracted fields, evidence/source information, semantic analysis, GTIN verification, compliance findings, manual violations, officer review, and registration/save.

## 4. Responsive UI and navigation

The application adapts to mobile, tablet, laptop, and desktop layouts.

The desktop interface uses a persistent sidebar while smaller layouts use compact navigation. Theme infrastructure supports light, dark, gradient, dark-gradient, and palette variants.

The UI includes normal application states such as loading, empty, validation, success, and error states. The inspection interface is designed to expose uncertainty and evidence instead of presenting AI output as an unquestionable answer.

## 5. Scan and image-input architecture

```text
Package image(s)
      ↓
Upload validation
      ↓
Image preprocessing
      ↓
RapidOCR / visual processing
      ↓
OCR evidence + geometry
      ↓
Field reconciliation
      ↓
Gemini semantic interpretation
      ↓
Structured fields
```

Multiple images can contribute complementary evidence to one inspection. Images can be removed before processing, and barcode/GTIN imagery can be supplied separately where supported.

## 6. Image processing and OpenCV

The Node backend uses Sharp for image processing. PARAKH also has dedicated OpenCV feature work for visual measurement and package-image analysis.

Relevant feature branches are:

```text
feat/opencv-font-size-rules
feat/opencv-10rs-coin-calibration
feat/opencv-package-background-separation
```

The OpenCV work includes:

- OCR bounding-box based text-region measurement
- text-height estimation
- font-size related compliance analysis
- known-object physical-size calibration experiments
- package/background separation
- visual-region analysis
- image geometry for compliance checks

The repository's merged `main` branch is authoritative for current released functionality. OpenCV feature-branch capabilities should be described as integrated only after their code is merged and verified.

## 7. RapidOCR service

RapidOCR is the primary OCR service. The backend sends package images to the configured `RAPID_OCR_URL` and can receive text, confidence and geometry.

Relevant configuration includes:

```text
RAPID_OCR_URL
RAPIDOCR_LANG_TYPE
RAPIDOCR_MAX_SIDE
RAPIDOCR_USE_CLS
RAPIDOCR_TEXT_SCORE
OCR_TIMEOUT_MS
```

The local OCR service can run at `http://localhost:8081` when configured that way.

Provider failures, timeouts, unavailable services, malformed OCR responses, and incomplete evidence must remain explicit processing states rather than silently becoming compliance decisions.

## 8. Field reconciliation and spatial reasoning

Raw OCR is not treated as the final structured record.

The reconciliation layer combines:

- labels
- nearby values
- spatial relationships
- text similarity
- field-specific patterns
- OCR confidence
- bounding-box geometry
- source-image context

A resolved field can retain source-image information, evidence text, bounding-box geometry, and OCR confidence where available.

This supports label/value relationships and evidence review instead of relying only on exact keyword matching.

## 9. Gemini semantic layer

Gemini interprets package images and OCR evidence for semantic tasks such as:

- mapping text to compliance fields
- identifying product and brand information
- resolving contextual labels and nearby values
- handling image-vs-OCR conflicts
- representing absent, unreadable, or ambiguous information

AI output is normalized before entering the evidence and rules pipeline. It does not directly make the final legal decision.

Additional semantic providers may be configurable where supported, but they remain evidence sources.

## 10. GTIN / DataKart verification

GTIN/barcode verification is optional.

```text
GTIN / barcode
      ↓
DataKart reference lookup
      ↓
Registered product information
      ↓
Compare with current inspection evidence
      ↓
Field-level reference contribution
```

DataKart is a product-reference registry, not the Legal Metrology decision-maker. When a reference is unavailable, inspection processing can continue with available package, OCR, and semantic evidence.

## 11. Evidence confidence

Current V1 evidence fusion uses:

```text
50% DataKart agreement
30% Gemini semantic confidence
20% RapidOCR evidence confidence
```

Unavailable sources are omitted and remaining available weights are renormalized.

The result is an evidence-fusion indicator, not a calibrated probability and not legal certainty.

Field states can include:

```text
MATCH
MISMATCH
UNVERIFIED
```

Inspection-level states can include:

```text
Verified
Needs Verification
Missing
```

## 12. Product hierarchy

PARAKH uses a flexible category tree rather than a flat catalogue.

```text
Category
  → Subcategory
    → Product Type
      → Final Category / Product
```

The UI supports dynamic category selection, child-category selection, final-category designation, category cards/forms, suggestions, and administrator-managed global category definitions.

## 13. Compliance Rules Engine

The Rules Engine is deterministic and separate from OCR and AI.

```text
Structured fields + product/category context
                    +
             configured rules
                    ↓
          deterministic evaluation
                    ↓
             rule findings
                    ↓
       human verification / decision
```

Configured requirements can cover declarations, manufacturer/packer/importer details, address, net quantity, MRP, dates, consumer-care information, batch/lot information, formatting/measurement-related checks, and Rule 23 officer assessment inputs.

Authorized administrators can manage `ComplianceRule` definitions. Legal requirements are not hidden inside an LLM prompt or scattered through the React UI.

## 14. Visual screening and measurement

The inspection layer can expose assistive checks for readability, placement, detected text regions, relative size, and visual evidence.

Physical measurements require an appropriate calibration mechanism. Uncalibrated pixel values are estimates and must not be represented as statutory physical measurements.

## 15. Human-in-the-loop

```text
OCR / AI evidence
      ↓
Confidence / uncertainty
      ↓
Reference verification
      ↓
Rules evaluation
      ↓
Officer review
      ↓
Accept / correct / reject / manual violation
      ↓
Final inspection
```

The officer can review editable values, evidence, uncertainty, conflicts, manual violations, and Rule 23 assessment information.

## 16. Compliance Intelligence architecture

Inspection records feed the analytics layer.

Supported filter dimensions include:

```text
Manufacturer | Product | GTIN | Batch | Violation type
City / District | State | Date range | Verified only
```

The dashboard is dynamic rather than a collection of static chart images:

```text
Stored inspections
      ↓
Selected filters
      ↓
Filtered population
      ↓
Aggregations
      ↓
Counters + graph datasets + tables
      ↓
Updated UI
```

Therefore changing filters can change both summary counters and visualizations.

Current intelligence visualizations can include:

- inspection trends over time
- violation types
- violations by city/district
- affected batches
- severity
- manufacturer violation rates
- manufacturer analytics
- verified batch alerts

The intended drill-down relationship is:

```text
State → District / shop city → Manufacturer → Product → Batch → Inspection
```

Where a dedicated district field is unavailable, shop city is used as the district-like geographic field.

## 17. Manufacturer analytics

Manufacturer analytics use stored inspection history.

The violation-rate concept is:

```text
violated scanned products
─────────────────────────
total scanned products
```

Thresholds used for application analytics must not be represented as statutory findings or autonomous legal determinations.

## 18. Batch Safety Network

Batch safety is independent from ordinary product-level compliance.

```text
Incident report
      ↓
Administrative review
      ↓
Verified batch alert
      ↓
Product + exact batch warning
      ↓
Resolution
```

The application models incident reports and alerts separately. A verified alert is associated with a specific product and batch combination.

AI does not autonomously activate a verified batch safety alert.

## 19. Backend architecture

The backend uses Node.js, Express 5, ES modules, Multer, Sharp, Prisma 7, and PostgreSQL.

The API surface covers authentication, products, categories, shops, inspections, OCR orchestration, evidence processing, rules, administration, analytics, and batch safety.

Important analytics routes include:

```text
/api/analytics/dashboard
/api/analytics/intelligence
```

Batch safety routes include:

```text
/api/batch-alerts
/api/batch-alerts/incidents
/api/batch-alerts/incidents/:id/verify
/api/batch-alerts/:id/resolve
```

## 20. Database architecture

PostgreSQL is accessed through Prisma 7.

Core application models include:

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

These relationships support products, categories, shops, inspections, manufacturers, batches, violations, rules, users, and safety alerts.

OCR/AI evidence may travel in structured JSON/application result structures where a separate normalized evidence table is unnecessary.

## 21. Reporting

Reports consume stored inspection and compliance results and can include extracted fields, evidence/verification state, rule findings, violations, inspection metadata, product/batch information, and officer decisions.

PDF generation is supported through the application's reporting layer, including client-side generation where used.

## 22. E-commerce inspection

The application includes an e-commerce inspection area where supported.

The same boundary applies to online/reference information:

```text
Source information
      ↓
Evidence extraction
      ↓
Structured fields
      ↓
Rules / officer review
```

Online/reference information does not override the Rules Engine or officer verification.

## 23. Shops and history

The shop module supports shop registration, listing, detail views, inspection history, product associations, location/city information, and authorized update/deletion flows.

Inspection history supports listing, search/filtering, historical evidence review, compliance-result review, product/batch relationships, and report access where available.

## 24. Authentication, validation and security

The application uses role-aware authentication/authorization and server-side API protection. Zod is used where configured for request/data validation.

Security boundaries include:

- server-side upload validation
- protected administrative operations
- environment-variable secrets
- no browser exposure of database service credentials
- controlled API payloads
- no committed production secrets
- no raw sensitive inspection data in the repository

Hiding a control in React is not considered authorization.

## 25. Performance and reliability

The current architecture uses measures such as:

- short-lived GET caching where implemented
- mutation-triggered invalidation
- bounded external-provider waits
- targeted UI updates
- avoidance of unnecessary page remounts/refetches
- image preprocessing before expensive downstream processing
- modular OCR service separation

Failure states are expected for invalid images, unavailable OCR, provider timeouts, malformed AI output, missing GTIN, unavailable reference data, conflicting evidence, low confidence, database/API errors, and empty analytics results.

The system should fail into an explicit reviewable state instead of silently converting missing evidence into a positive compliance result.

## 26. Service structure

The repository is organized around:

```text
backend/
frontend/
ocr-service/
rules-engine/
semantic-service/
scripts/
```

Top-level specification files describe project requirements, architecture, database structure, API contracts, compliance logic, and UI/UX behavior.

For a feature-by-feature inventory, see `docs/FEATURE_CATALOG.md`.

## 27. Prototype boundary

PARAKH is an SIH-oriented working prototype. The source code is authoritative for exact implementation state. Feature branches must not be presented as merged production functionality, and context-dependent legal decisions or physical measurements may require authorized officer verification.
