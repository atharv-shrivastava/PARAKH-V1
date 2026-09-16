# PARAKH V1 Repository Code Guide

**SIH Problem Statement 26034**

This document is the code-oriented map of PARAKH V1. It describes the major source areas, service boundaries, responsibilities, important feature groups, and the small supporting behaviors that make the application work.

The exact source tree remains authoritative. This guide should be updated when routes, components, services, models, configuration, or workflows change.

## 1. Application layers

```text
Frontend
   ↓
Backend API
   ├── PostgreSQL / Prisma
   ├── OCR service
   ├── Semantic AI providers
   ├── GTIN / DataKart reference service
   ├── Rules Engine
   └── Reporting / analytics / batch safety
```

## 2. Frontend code responsibilities

The frontend contains the user-facing inspection application and supporting administrative/analytics interfaces.

### Core frontend areas

- application bootstrap and global styles
- routing and protected routes
- reusable UI primitives
- layout shell and responsive sidebar/navigation
- theme management
- dashboard
- scan/inspection workflow
- package image selection and previews
- editable extracted fields
- evidence/confidence display
- visual screening controls
- product registration
- category hierarchy selection
- shops
- inspection history
- reports
- e-commerce inspection
- Compliance Intelligence
- Batch Safety
- profile/session views
- administrative screens

### Small frontend behaviors

The frontend also handles details such as:

- image preview/removal
- form state management
- field editing
- validation messages
- loading indicators
- empty states
- error states
- conditional controls based on role/state
- filter controls
- search controls
- date-range controls
- table state
- graph state
- responsive navigation
- theme-dependent styling
- targeted refreshes after mutations
- short-lived GET caching where implemented
- cache invalidation after writes
- status badges
- evidence-state indicators
- source/evidence views
- confirmation UI for destructive actions where implemented

## 3. Backend code responsibilities

The Node.js + Express backend is the orchestration and application-logic layer.

### Major responsibility groups

- authentication/session handling
- authorization
- request validation
- multipart upload handling
- image processing with Sharp
- OCR service orchestration
- semantic provider orchestration
- field reconciliation
- GTIN/DataKart lookup
- product/category operations
- shop operations
- inspection lifecycle
- compliance evaluation integration
- officer review operations
- batch incident and alert operations
- analytics aggregation
- report data preparation
- administration
- error handling and response normalization

### Backend boundary

The backend orchestrates external/local services. It is not itself synonymous with the OCR service or the Rules Engine.

## 4. OCR service

The OCR service is a separate Python service used by the backend.

### Responsibilities

- receive package images
- run RapidOCR
- return text evidence
- return confidence where available
- return geometry/bounding boxes where available
- expose OCR configuration
- enforce service-level timeouts/limits where configured

### Failure paths

The OCR service must allow the backend to distinguish unavailable service, timeout, malformed response, low-confidence result, and normal successful OCR.

## 5. Semantic AI services

Semantic processing is separated from deterministic compliance evaluation.

### Responsibilities

- interpret package context
- map evidence into structured fields
- resolve contextual relationships
- identify product/brand details
- surface uncertainty
- provide model confidence/evidence where available

### Multi-provider architecture

The application can use the configured semantic providers independently. Model disagreement is evidence for review, not an instruction to silently select whichever output looks nicer.

## 6. Image-processing layer

Sharp is used in the Node backend for image preparation and processing.

Image-processing responsibilities can include:

- input decoding
- validation
- resizing/size limiting
- contrast/sharpness preparation
- OCR-oriented normalization
- conversion into service-compatible representations
- temporary processing data

### OpenCV extensions

The repository contains separate OpenCV work for:

- font-size/text-height analysis
- known-object calibration experiments
- package/background separation
- geometry-driven visual checks

Current feature branches include:

```text
feat/opencv-font-size-rules
feat/opencv-10rs-coin-calibration
feat/opencv-package-background-separation
```

These branches are distinct from the merged `main` branch until their work is integrated.

## 7. Field reconciliation

The reconciliation layer converts raw OCR/AI evidence into structured inspection fields.

It can use:

- label matching
- value matching
- spatial proximity
- bounding boxes
- OCR confidence
- text similarity
- field-specific patterns
- source image context

This layer is important because raw OCR is text evidence, not a database record.

## 8. Evidence model

Evidence can originate from:

- OCR
- semantic AI
- GTIN/DataKart reference data
- image/visual processing
- officer-entered corrections
- manual inspection inputs

Field-level evidence can preserve source information, confidence, and verification state where the current implementation supports it.

## 9. Rules Engine integration

The Rules Engine receives structured information and evaluates configured Legal Metrology requirements.

The backend is responsible for passing the correct structured context to the engine and storing/returning its findings.

The engine remains separate from model prompting and OCR.

## 10. Product and category code

The catalogue supports hierarchical product classification rather than one flat list.

UI and backend responsibilities include:

- category selection
- child-category relationships
- final-category designation
- global category administration
- product registration
- product/category association
- pack/variant information
- manufacturer/brand information

## 11. Shops and inspection lifecycle

The application manages the relationship among inspection source/shop, product, and inspection record.

Typical lifecycle:

```text
Select or register shop
        ↓
Create inspection
        ↓
Process package evidence
        ↓
Review findings
        ↓
Save/register inspection
        ↓
History / analytics / reports
```

## 12. Compliance Intelligence code path

The analytics layer turns stored inspection records into aggregated datasets.

Typical dimensions include:

- manufacturer
- product
- GTIN
- batch
- violation
- city/district
- state
- date range
- verification status

The graph data should be derived from the same filtered population used by the corresponding summary metrics where the UI requires that relationship.

## 13. Dynamic filters and graphs

A filter is not merely visual decoration. The selected state changes the data query/aggregation inputs.

```text
User changes filter
        ↓
Filter state changes
        ↓
Analytics query/aggregation changes
        ↓
Counters change
        ↓
Graph datasets change
        ↓
Charts/tables re-render
```

This applies to combined filters as supported by the current implementation.

## 14. Batch Safety code path

Batch safety separates ordinary product inspection from incident/alert workflows.

```text
Incident report
      ↓
Administrative verification
      ↓
Verified alert
      ↓
Product + batch warning
      ↓
Resolution
```

The system should preserve exact product/batch identity when an alert is verified.

## 15. Administration code path

Administrative features include or are intended to include:

- role/access management
- compliance rule management
- global category management
- product management
- inspection management
- analytics management
- batch incident review
- batch alert verification
- batch alert resolution
- operational oversight

Admin actions require backend authorization. Frontend visibility is not the security boundary.

## 16. Database and Prisma

Prisma provides the application data-access layer over PostgreSQL.

Core business entities documented in the current project include:

- User
- Session
- Shop
- Category
- Product
- Scan
- Inspection
- ComplianceRule
- BatchIncidentReport
- BatchAlert

Relationships allow the system to connect products, shops, inspections, categories, rules, batches, incidents, and users.

## 17. Validation

Validation exists at multiple levels:

```text
Transport/schema validation
        ↓
Application validation
        ↓
Reference/evidence checks
        ↓
Rules Engine validation
        ↓
Officer review
```

Zod is used where configured for request/data validation.

## 18. Reporting

The report layer assembles inspection state into human-readable outputs.

It can include:

- inspection metadata
- extracted values
- evidence/verification information
- rule findings
- violations
- officer decisions
- batch/product information
- compliance status

PDF generation is supported through the current report implementation where used.

## 19. Configuration

Configuration should be externalized through environment variables.

Examples include:

```text
RAPID_OCR_URL
RAPIDOCR_LANG_TYPE
RAPIDOCR_MAX_SIDE
RAPIDOCR_USE_CLS
RAPIDOCR_TEXT_SCORE
OCR_TIMEOUT_MS
```

Additional API/database/provider credentials should remain environment-managed and must not be committed as secrets.

## 20. Error handling

Important failure classes include:

- invalid upload
- unsupported file
- image processing failure
- OCR service failure
- OCR timeout
- semantic provider failure
- malformed AI response
- GTIN lookup failure
- reference unavailable
- database failure
- authorization failure
- validation failure
- low-confidence evidence
- conflicting evidence
- empty analytics result

User-facing failure should remain understandable without exposing credentials or raw production stack traces.

## 21. Repository truth

This document describes the code architecture at a feature/service level. It does not replace the source files.

When preparing judging material, distinguish clearly between:

- code already merged into `main`
- code available in a feature branch
- prototype-only behavior
- documented future scope

That distinction keeps the technical story accurate.
