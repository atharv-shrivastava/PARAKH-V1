# PARAKH V1 Feature Catalog

> **SIH Problem Statement 26034**  
> This document is the detailed feature-level inventory for PARAKH V1. It intentionally documents small interaction and engineering features in addition to the major AI, OCR, compliance, analytics, and inspection workflows.

## 1. Product scope

PARAKH is an AI-assisted inspection and compliance platform for packaged commodities under the Legal Metrology Act, 2009 and the Legal Metrology (Packaged Commodities) Rules, 2011.

The platform separates evidence extraction, semantic interpretation, reference verification, deterministic rule evaluation, officer review, reporting, and compliance intelligence.

The governing principle is:

```text
AI / OCR = evidence and assistance
Rules Engine = deterministic configured evaluation
Officer = human verification and final inspection authority
```

---

## 2. End-to-end inspection flow

```text
Login
  ↓
Dashboard / Shop selection
  ↓
Capture or upload one or more package images
  ↓
Image validation + preprocessing
  ↓
RapidOCR
  ↓
OCR text + confidence + geometry
  ↓
Deterministic field reconciliation
  ↓
Gemini multimodal interpretation
  ↓
Structured declaration fields
  ↓
GTIN / DataKart reference lookup when available
  ↓
Field-level evidence fusion
  ↓
Product/category classification
  ↓
Legal Metrology Rules Engine
  ↓
Visual screening / measurement checks
  ↓
Officer review
  ↓
Accept / edit / reject / add manual violation
  ↓
Register or save inspection
  ↓
History / product / shop updates
  ↓
Report generation
  ↓
Analytics + batch intelligence
```

---

## 3. Frontend platform

### Core frontend

- React 19
- Vite development/build tooling
- React Router navigation
- JSX/JavaScript application code
- Shared CSS and theme infrastructure
- Responsive layouts for phone, tablet, laptop, and desktop
- Reusable page and form components
- Persistent desktop navigation/sidebar
- Compact responsive navigation on smaller screens
- Route-level page rendering
- Loading states
- Empty states
- Error states
- Success/error feedback and user notifications where implemented
- Form validation and controlled inputs
- Editable structured inspection fields

### Navigation areas

The application contains functional areas for:

- Dashboard
- Scan
- Shops
- Products
- History
- Reports
- E-commerce inspection
- Profile
- Administration
- Compliance Intelligence
- Batch Safety

Authorized areas are protected by role-aware access.

### Theme system

Supported visual variants include:

- Light
- Dark
- Dark-gradient
- Gradient
- Rainbow/palette variants

Theme changes affect application surfaces, backgrounds, text, borders, inputs, sidebar, accents, and shadows rather than changing only one page.

### Responsive behavior

The interface adapts to:

- mobile width
- tablet width
- laptop/desktop width

Inspection actions and evidence remain usable without requiring a separate mobile application.

---

## 4. Scan and package capture

### Image input

The scan workflow supports:

- Package image upload
- Multiple package images
- Image preview
- Image removal before processing
- Separate barcode/GTIN image input where supported
- Editable inspection fields after extraction
- Source/evidence visibility

### Upload handling

The backend uses Multer for multipart image uploads and validates incoming files before processing.

### Multiple-image inspection

Multiple images are treated as complementary evidence for the inspection rather than requiring every declaration to appear in a single photograph.

The intended evidence relationship is:

```text
Image 1 ─┐
Image 2 ─┼──> OCR / semantic evidence
Image 3 ─┘             ↓
                  merged inspection evidence
                           ↓
                    field reconciliation
```

A field may retain information about the source image and evidence geometry when that information is available.

---

## 5. Image processing

PARAKH uses image-processing steps to improve machine readability before OCR and to support visual inspection.

### Current image-processing responsibilities

- Image decoding/validation
- Resolution and size handling
- Image normalization
- Contrast/sharpness preprocessing where configured
- OCR-oriented preprocessing
- Package image preparation
- Temporary image handling
- Conversion between service-compatible image representations

Sharp is used in the Node backend for image processing.

### OpenCV visual-processing extensions

PARAKH also has OpenCV feature work for measurement and visual checks. Relevant repository branches include:

- `feat/opencv-font-size-rules`
- `feat/opencv-10rs-coin-calibration`
- `feat/opencv-package-background-separation`

The OpenCV work is intended to support capabilities such as:

- OCR bounding-box based text-region measurement
- text-height estimation
- font-size related compliance checks
- physical-size calibration using a known reference such as a coin
- package/background separation
- visual-region analysis
- image geometry used by compliance checks

The repository's source branch is authoritative for whether an individual OpenCV extension has been merged into `main`. Documentation should not represent an unmerged feature branch as production functionality.

---

## 6. OCR subsystem

RapidOCR is the primary OCR service.

### OCR responsibilities

- Extract text from package images
- Return confidence information
- Return spatial/bounding-box information where available
- Provide machine-readable evidence for downstream field reconciliation
- Support multilingual/package-label text processing according to configured OCR language settings

### OCR service architecture

```text
Node backend
     ↓
RAPID_OCR_URL
     ↓
RapidOCR service
     ↓
text + confidence + geometry
     ↓
backend reconciliation
```

### OCR configuration

Relevant configuration includes:

- `RAPID_OCR_URL`
- `RAPIDOCR_LANG_TYPE`
- `RAPIDOCR_MAX_SIDE`
- `RAPIDOCR_USE_CLS`
- `RAPIDOCR_TEXT_SCORE`
- `OCR_TIMEOUT_MS`

### OCR failure handling

The application accounts for provider failures, timeouts, unavailable OCR services, malformed results, and incomplete OCR evidence. OCR failure should not silently become a legal compliance decision.

---

## 7. Deterministic field reconciliation

OCR output is not directly treated as the final structured product record.

The reconciliation layer uses available evidence such as:

- labels
- nearby values
- spatial relationships
- text similarity
- field-specific patterns
- OCR confidence
- bounding-box geometry
- source-image context

This converts raw OCR detections into structured declarations.

Examples of structured declarations include:

- manufacturer/packer/importer information
- address
- product identity
- net quantity
- MRP
- manufacturing/packing date
- consumer-care information
- batch/lot information
- other configured package declarations

---

## 8. Multimodal AI interpretation

Gemini provides semantic interpretation of package images and OCR evidence.

### AI responsibilities

- Map package text to structured compliance fields
- Interpret context and nearby labels
- Resolve semantic relationships that exact text matching cannot reliably capture
- Identify product/brand information
- Handle image-vs-OCR conflicts as evidence rather than silently choosing a value
- Represent absent, unreadable, ambiguous, or uncertain information explicitly

### Model boundary

AI does not directly produce the final legal compliance decision.

AI output is normalized and passed into the evidence and rules pipeline.

Additional semantic providers can be configured where supported. They remain evidence sources and do not replace the deterministic compliance layer.

---

## 9. Evidence fusion

PARAKH can combine multiple evidence sources at field level.

Current V1 weighting when all sources are available:

```text
DataKart agreement       50%
Gemini semantic confidence 30%
RapidOCR confidence        20%
```

Unavailable sources are omitted and the remaining available weights are renormalized.

The resulting value is called **Evidence Confidence**.

It is explicitly:

- an engineering evidence-fusion indicator
- not a calibrated statistical probability
- not legal certainty
- not an autonomous enforcement verdict

### Verification states

Fields can surface states such as:

```text
MATCH
MISMATCH
UNVERIFIED
```

Overall inspection states can include:

```text
Verified
Needs Verification
Missing
```

---

## 10. GTIN and DataKart verification

GTIN/barcode verification is an optional evidence source.

### Flow

```text
GTIN / barcode
     ↓
DataKart reference lookup
     ↓
registered product information
     ↓
compare with package evidence
     ↓
field-level evidence contribution
```

### Important boundary

DataKart does not determine Legal Metrology compliance.

It provides product-reference evidence that can be compared with current package information. The deterministic rules layer remains separate.

### Failure / unavailable-reference behavior

If no GTIN is available, the registry has no matching product, or the reference provider is unavailable, inspection can continue using available image, OCR, and semantic evidence.

---

## 11. Product hierarchy

PARAKH uses a flexible category tree instead of a flat product list.

The practical user-facing hierarchy can be represented as:

```text
Category
  → Subcategory
    → Product Type
      → Final Category / Product
```

Where the data model supports deeper catalogue relationships, product/brand/variant information can be associated with the hierarchy.

### Category UI behavior

- Dynamic category selection
- Child-category loading/selection
- Final-category designation
- Category cards/forms
- Reusable category definitions
- Admin-managed global categories
- Product registration against selected hierarchy
- Suggestions based on available catalogue structure

Example:

```text
Food
 └── Ready-to-Eat
      └── Biscuits [Final]
```

---

## 12. Legal Metrology Rules Engine

The Rules Engine is deterministic and separate from OCR and AI.

### Input

- Structured extracted fields
- Product/category context
- Configured compliance rules
- Visual/measurement results where applicable
- Officer-provided information where required

### Processing

```text
Structured evidence
       +
Configured rule definitions
       ↓
Deterministic evaluation
       ↓
Rule finding
       ↓
Violation / pass / missing / needs-review state
```

### Rule responsibilities

The compliance layer can evaluate configured requirements covering areas such as:

- required declarations
- manufacturer/packer/importer details
- address information
- net quantity
- MRP
- date declarations
- consumer-care information
- batch/lot information
- formatting/measurement-related requirements
- Rule 23 visual assessment inputs
- missing or conflicting declarations

### Configurable rules

Authorized administrators can manage `ComplianceRule` definitions from the administrative layer.

Legal requirements are therefore kept in the compliance layer rather than hidden inside an LLM prompt or React component.

---

## 13. Visual screening and measurement

The inspection UI can expose assistive visual checks for:

- declaration readability
- placement
- detected text regions
- relative size
- visual evidence
- spatial placement
- font-size related signals

Where a physical reference is required, the measurement must use an appropriate calibration mechanism. Uncalibrated pixel measurements are estimates and should not be presented as statutory physical measurements.

OpenCV feature work includes font-size analysis, physical-reference calibration experiments, and package/background separation.

---

## 14. Human-in-the-loop verification

PARAKH is designed around officer verification.

### Officer workflow

```text
Machine evidence
      ↓
Confidence / uncertainty
      ↓
Rules evaluation
      ↓
Officer review
      ↓
Accept / edit / reject
      ↓
Manual violation if required
      ↓
Final inspection record
```

The review interface supports:

- editable extracted values
- evidence/source review
- uncertainty review
- conflicting-value review
- manual violation entry
- Rule 23 officer assessment
- acceptance/correction/rejection
- final registration/save

AI does not autonomously turn uncertain evidence into a legal enforcement action.

---

## 15. Dashboard

The dashboard uses stored inspection information to surface operational summaries.

Possible dashboard information includes:

- total inspections
- inspection trends
- compliance information
- violation summaries
- recent inspections
- product/category information
- highest-violation shop
- highest-violation brand
- highest-violation rule
- quick actions

The dashboard is data-backed rather than a static mockup.

---

## 16. Compliance Intelligence

The Compliance Intelligence layer converts stored inspections into aggregated operational information.

### Filters

The intelligence interface supports filtering dimensions such as:

- Manufacturer
- Product
- GTIN
- Batch
- Violation type
- City/district
- State
- Date range
- Verified-only status

Filters can be combined.

### Dynamic analytics behavior

Graphs and counters are data-driven. Changing filters changes the underlying selected inspection population and therefore updates the displayed aggregates/visualizations.

Conceptually:

```text
Stored inspections
       ↓
Selected filters
       ↓
Filtered inspection set
       ↓
Aggregations
       ↓
Counters + graph datasets + tables
       ↓
Updated dashboard
```

### Visualizations

The intelligence layer can surface:

- inspection trend over time
- violation types
- violations by city/district
- affected batches
- violation severity
- manufacturer violation rates
- manufacturer analytics tables
- verified batch alerts

### Drill-down model

```text
State
 ↓
District / shop city
 ↓
Manufacturer
 ↓
Product
 ↓
Batch
 ↓
Inspection
```

Where a dedicated district field is unavailable, the current implementation uses shop city as the district-like geographic field.

---

## 17. Manufacturer intelligence

Manufacturer analytics use inspection history rather than AI prediction.

The documented violation-rate concept is:

```text
violated scanned products
─────────────────────────
total scanned products
```

The UI can expose manufacturer-level inspection volume and violation information for operational analysis.

Threshold-based high-risk presentation must be interpreted as an application analytics rule, not as a legal declaration that a manufacturer is unlawful.

---

## 18. Batch Safety Network

PARAKH tracks safety incidents at the exact product + batch level.

### Flow

```text
Incident reported
      ↓
Administrative review
      ↓
Verified batch alert
      ↓
Product + exact batch warning
      ↓
Resolve when appropriate
```

### Safety controls

- Batch-specific identity
- Incident reporting
- Administrative verification
- Verified alerts
- Active/resolved alert states
- Product + batch association
- In-app warning visibility
- Batch filtering/search

AI must not autonomously activate a verified batch safety alert.

---

## 19. Shops and inspection sources

The shop/source module supports:

- shop registration
- shop listing
- shop details
- shop inspection history
- product associations
- location/city information
- deletion/update workflows where authorized
- optimistic UI updates where implemented

Shop history contributes to analytics and inspection intelligence.

---

## 20. Inspection history

History supports:

- inspection listing
- inspection search
- filtering
- opening historical records
- evidence review
- compliance-result review
- batch/product relationships
- report access where available

Historical records remain distinct from new scan processing.

---

## 21. Product registration

Product registration supports:

- product name
- manufacturer/brand information
- category hierarchy selection
- pack/variant information
- GTIN/reference fields where available
- associated inspection information
- reusable product intelligence

The catalogue is separate from individual inspection events.

---

## 22. E-commerce inspection

The application contains an e-commerce inspection area for reviewing product information from online/e-commerce sources where supported.

The same general separation applies:

```text
Source information
      ↓
Evidence extraction
      ↓
Structured fields
      ↓
Rules / review
```

Online/reference information does not override the deterministic legal rules or officer review.

---

## 23. Reports

Reports can include:

- inspection metadata
- extracted declaration information
- evidence/verification information
- Rules Engine findings
- violations
- missing declarations
- officer decisions
- product/batch information
- compliance status

PDF generation is supported through the application's report layer, including client-side generation where used.

Multilingual report support can render report information in the selected/preferred language where implemented.

---

## 24. Multilingual behavior

PARAKH is designed to support multilingual inspection/report experiences.

Language-sensitive areas can include:

- dashboard labels
- inspection information
- compliance findings
- report text
- user-selected language

Translation should not change the underlying legal rule identifier or machine-readable inspection data.

---

## 25. Administration

Authorized administrative functionality includes areas for:

- users/access
- products
- inspections
- global product categories
- compliance rules
- analytics/intelligence
- batch incidents and alerts

Administrative controls are separated from ordinary inspection operations.

---

## 26. Authentication and authorization

The platform uses role-aware access controls.

Protected operations include administrative functionality and other actions that should not be available to ordinary inspection users.

The backend remains responsible for authorization. Hiding a button in React is not considered a security boundary.

---

## 27. Backend API responsibilities

The Node.js + Express backend provides REST APIs for:

- authentication/session handling
- products
- categories
- shops
- inspections
- OCR orchestration
- semantic/evidence processing
- GTIN/reference verification
- compliance/rules operations
- administration
- analytics
- batch incidents
- batch alerts
- reports/data retrieval

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

---

## 28. Database and persistence

PostgreSQL is accessed through Prisma.

Important application entities include:

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

Stored data supports relationships among:

- users/officers
- shops
- inspections
- products
- categories
- manufacturers
- batches
- rules
- violations
- safety alerts

Structured JSON/application result structures may carry OCR/AI evidence where a fully normalized evidence table is unnecessary.

---

## 29. Validation and data integrity

Zod is used where configured for request/data validation.

Validation responsibilities include:

- request shape validation
- structured field validation
- input constraints
- server-side upload checks
- controlled API payloads

Legal compliance validation remains the responsibility of the configured Rules Engine rather than generic schema validation alone.

---

## 30. Performance behavior

The current application includes engineering measures such as:

- short-lived GET caching where implemented
- mutation-triggered cache invalidation
- bounded external-provider waits
- targeted UI updates
- avoidance of unnecessary page remounts/refetches
- image preprocessing before expensive downstream processing
- modular external OCR service

These are performance techniques, not claims of a specific benchmark unless a measured benchmark is documented separately.

---

## 31. Error and fallback behavior

The system accounts for failure or incomplete evidence from:

- invalid images
- missing images
- OCR service unavailable
- OCR timeout
- semantic provider failure
- malformed semantic output
- missing GTIN
- unavailable DataKart reference
- conflicting evidence
- low confidence
- missing declarations
- database/API failures
- empty analytics results

The key principle is fail visibly into a reviewable state rather than silently converting missing evidence into a positive compliance result.

---

## 32. Security and secrets

- API keys must remain in environment variables.
- Database credentials must not be committed.
- Production secrets must not be exposed to the browser.
- Uploads require server-side validation.
- Protected API operations require authentication/authorization.
- Raw stack traces and secrets should not be returned to users.
- Real sensitive inspection data should not be committed to the repository.

---

## 33. Repository/service structure

The current project is separated into major service/application areas:

```text
backend/
frontend/
oCR-service/
rules-engine/
semantic-service/
scripts/
```

The repository also contains top-level architecture, API, database, compliance, UI/UX, and project specification documents.

The source code is authoritative for the exact implementation state of each feature.

---

## 34. Technology map

| Layer | Technology / responsibility |
|---|---|
| UI | React 19 |
| Build | Vite |
| Routing | React Router |
| Styling | CSS/theme system |
| API | Node.js + Express 5 |
| Uploads | Multer |
| Image processing | Sharp |
| Computer vision extensions | OpenCV feature branches |
| OCR | RapidOCR |
| Semantic AI | Gemini |
| Additional semantic providers | Configurable where supported |
| Reference verification | GTIN / DataKart |
| Validation | Zod |
| ORM | Prisma 7 |
| Database | PostgreSQL |
| Authentication | Role-aware application authentication |
| Reports | jsPDF where used |

---

## 35. Feature maturity notation

For technical presentations and judging material, features should be described according to their repository state:

- **Implemented** — present in the relevant source branch and usable in the application.
- **Integrated/feature branch** — implemented in a feature branch but not necessarily merged into `main`.
- **Prototype** — working demonstration with known limitations.
- **Planned** — documented future work only.

Do not describe a planned or unmerged feature as deployed production functionality.

---

## 36. Legal and operational boundary

PARAKH is an SIH prototype intended to assist inspection workflows. AI confidence, registry matches, analytics thresholds, and automated findings are not substitutes for statutory interpretation or authorized officer decisions.

The final inspection record should preserve the distinction between:

```text
What was observed
What was extracted
What was referenced
What the rule engine evaluated
What the officer verified
```
