# PARAKH Development Roadmap

## Current status

PARAKH is a working SIH prototype with a responsive UI, real database-backed products/shops/inspections, product hierarchy, RapidOCR scanning, semantic interpretation, DataKart reference verification, evidence-confidence fusion, compliance workflow, reports, analytics, caching, and administrative functionality.

## Implemented

- React/Vite responsive frontend
- Node/Express backend
- Prisma/PostgreSQL persistence
- Authentication and role-aware access
- Product/category hierarchy
- Shop management and inspection history
- Multi-image scanning
- RapidOCR integration
- Deterministic OCR field reconciliation
- Gemini semantic interpretation
- Optional Cloudflare semantic providers
- Semantic consensus support
- DataKart GTIN-based product-reference verification
- 50/30/20 DataKart/Gemini/RapidOCR Evidence Confidence model
- Match/mismatch/unverified verification states
- Visual inspection screening
- Editable extraction results
- Manual violation entry
- Product registration
- Real-data dashboard analytics
- Inspection trends
- Highest-violation shop/brand/rule analytics
- Reports/PDF support
- E-commerce inspection workflow
- Responsive navigation
- Light/dark/gradient/rainbow themes
- Client GET caching
- Mutation-triggered cache invalidation
- Optimistic deletion for selected operations
- Backend provider/model failure logging

## Next priorities

### 1. Evidence experience
- Render Evidence Confidence source contributions clearly in the Scan UI
- Render `✓ / ✕ / ?` verification states consistently beside extracted fields
- Stronger field-to-image highlighting
- Better bounding-box visualization
- Clearer source/evidence provenance
- Preserve original values when inspectors manually edit fields

### 2. Scan performance
- Reduce RapidOCR latency where practical
- Ensure optional semantic providers cannot unnecessarily delay a usable result
- Improve staged processing feedback
- Continue measuring provider and DataKart lookup performance

### 3. DataKart and reference verification
- Improve GTIN coverage for the prototype dataset
- Add registry synchronization/admin workflows in a future controlled service
- Add automated tests for field matching and normalization
- Track DataKart lookup failures and stale/unregistered products

### 4. Inspection/product detail
- Richer inspection record pages
- Better evidence timelines
- Stronger presentation of source, confidence, verification, and officer decisions

### 5. Compliance
- Expand representative official rules
- Improve rule applicability configuration
- Add automated rule tests
- Preserve rule source/version information
- Keep legal logic independent from AI and DataKart

### 6. Reliability
- Frontend/backend automated tests
- API integration tests
- Database performance testing
- OCR/AI/DataKart failure tests
- Mobile/browser regression testing
- Evidence-confidence edge-case tests

### 7. Deployment
- Production environment hardening
- Pooled database configuration
- RapidOCR deployment strategy
- DataKart service configuration and monitoring
- Structured logging and provider health metrics

## Future scope

- State-level administrative controls with central oversight
- Broader government/reference-data integrations where legally and technically available
- Larger reference datasets
- Calibrated confidence evaluation against labeled inspection data
- Background job queues for OCR/AI at larger scale
- Audit-grade evidence and verification storage

## Priority principle

Protect the end-to-end path:

```text
Scan → RapidOCR → Extract → Gemini → DataKart → Evidence Confidence → Rules → Review → Register → History → Analytics/Report
```

New features should not destabilize this vertical slice.