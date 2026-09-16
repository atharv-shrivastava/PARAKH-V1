# PARAKH V1 Future Scope

**SIH Problem Statement 26034**

This document describes capabilities that are intended for later versions of PARAKH. They must be presented as future scope unless they are implemented and verified in the current source tree.

## 1. Offline-first inspection

The long-term goal is for an officer to continue inspection work when connectivity is unavailable or unreliable.

Potential architecture:

```text
Online
  ↓
Sync product/category/rule snapshots
  ↓
Offline local store
  ↓
Capture inspection
  ↓
Queue processing/sync
  ↓
Reconnect
  ↓
Upload + reconcile
  ↓
Server confirmation
```

Possible capabilities:

- offline package-photo capture
- encrypted local inspection drafts
- offline product/category cache
- offline compliance-rule snapshot
- offline validation using the last approved rule version
- queued uploads
- resumable synchronization
- retry queues
- conflict detection
- conflict-resolution workflow
- synchronization status indicators
- local evidence retention until successful sync

Offline mode should not silently use stale legal rules. Each locally cached rule set should carry a rule/version timestamp and synchronization status.

## 2. GTIN and authoritative product data

The current product-reference architecture treats GTIN/DataKart as an evidence source. Future work can integrate official or authorized government/industry registries where APIs and data-sharing arrangements permit.

Potential improvements:

- official GTIN registry connectivity
- stronger barcode validation
- product-reference versioning
- registry freshness timestamps
- provenance for every reference value
- reference conflict handling
- product-reference synchronization
- registry outage resilience
- cached reference data for field use

The reference registry should remain separate from the Legal Metrology decision layer.

## 3. Government and regulatory integrations

Future PARAKH versions could integrate authorized government systems for:

- legal metrology officer records
- official manufacturer/packer/importer information
- authorized product registries
- enforcement case records
- approved geographical hierarchies
- regulatory updates
- notices/alerts
- inspection synchronization

Integration is contingent on official APIs, data-sharing permissions, security requirements, and operational approval.

## 4. Rule versioning and regulatory updates

Future rule management can move from basic configurable records toward versioned regulatory packages.

Possible features:

- effective date
- supersession date
- rule version
- source notification/reference
- draft/approved/retired states
- approval workflow
- rule change audit history
- automatic update distribution to connected/offline devices
- historical inspection evaluation against the rule version that was active at inspection time

## 5. Stronger computer vision

OpenCV-based work can be extended into a more complete visual-compliance subsystem.

Potential capabilities:

- stronger text-height estimation
- physical-size calibration
- reference-object detection
- perspective correction
- package/background segmentation
- region-of-interest extraction
- declaration placement detection
- layout consistency checks
- print-quality/readability signals
- logo/brand region identification
- front/back/side panel matching
- package geometry assistance

Any statutory physical measurement should use validated calibration rather than raw pixels alone.

## 6. Stronger OCR and multilingual recognition

Future OCR improvements can include:

- improved Indian-language recognition
- mixed-language package handling
- better curved/small/low-contrast text recognition
- handwriting/marking recognition where relevant
- specialized packaged-goods OCR models
- offline OCR deployment
- OCR model versioning
- benchmark suites across Indian packaged commodities
- domain-specific OCR post-processing

## 7. Multi-model evidence verification

PARAKH can expand from the current evidence architecture into explicit multi-model agreement analysis.

Potential future pipeline:

```text
RapidOCR
Gemini
Grok / other model
Vision model(s)
Registry evidence
Visual measurements
      ↓
Field-level evidence graph
      ↓
Agreement / disagreement analysis
      ↓
Confidence + provenance
      ↓
Rules Engine
      ↓
Officer review
```

Future systems can retain which model produced which candidate value rather than storing only the final reconciled value.

## 8. Evidence provenance

Future versions can give every important inspection field a traceable evidence chain:

```text
Final field
  ↓
Rule finding
  ↓
Structured value
  ↓
Evidence sources
  ├── OCR result
  ├── image region
  ├── model output
  ├── registry reference
  └── officer edit
```

Possible provenance fields:

- source image ID
- bounding box
- OCR engine/version
- AI model/version
- prompt/schema version
- registry record/version
- rule/version
- officer modification timestamp
- final reviewer identity

## 9. Review queues and officer workflow

Future operational workflows can include:

- officer assignment
- district/state assignment
- pending-review queue
- escalation queue
- low-confidence queue
- conflicting-evidence queue
- overdue-review queue
- priority/severity sorting
- reassignment
- supervisory review
- review history

## 10. State and district intelligence

The current system can analyze stored inspection geography. Future versions can expand this into jurisdiction-aware intelligence.

Potential capabilities:

- official state/district hierarchy
- officer jurisdiction filtering
- district-level trends
- state-level trends
- geographic heatmaps
- inspection coverage
- violation density
- manufacturer distribution
- product/category distribution
- time-series comparison
- jurisdiction-specific dashboards

## 11. Manufacturer and product intelligence

Future analytics can expand beyond descriptive violation rates.

Potential capabilities:

- historical compliance trends
- repeat issue tracking
- manufacturer/product risk indicators
- batch recurrence patterns
- product-family relationships
- category-specific trends
- inspection frequency analysis
- anomaly detection
- evidence-backed alerts

These should remain analytics indicators and should not be presented as autonomous legal judgments.

## 12. Batch Safety Network expansion

Future batch intelligence can include:

- cross-district batch propagation
- manufacturer notification workflows
- alert subscriptions
- officer acknowledgement
- batch recall workflow integration where authorized
- affected-inspection discovery
- evidence packet generation
- resolution reason tracking
- expiration/review dates
- notification audit history

## 13. Production asynchronous processing

At larger scale, the modular prototype can move expensive OCR/AI work into asynchronous workers.

Possible architecture:

```text
API
 ↓
Job queue
 ├── OCR worker
 ├── Vision worker
 ├── AI worker
 ├── Registry worker
 └── Report worker
        ↓
Result store
        ↓
API / dashboard
```

Possible benefits:

- parallel processing
- retryable jobs
- provider-specific queues
- workload isolation
- horizontal scaling
- better long-running job handling

## 14. Media and storage improvements

Future deployments may use dedicated object storage for:

- original inspection images
- processed images
- evidence crops
- generated reports
- exports

The application should preserve lifecycle policies, access controls, encryption, and retention rules appropriate to inspection data.

## 15. Enterprise security

Production deployments can add:

- stronger role hierarchy
- state/district scoped permissions
- organization/department tenancy
- audit logs
- key rotation
- device/session management
- stronger secret management
- configurable retention
- encryption policies
- security monitoring
- incident response workflows

## 16. Accessibility and multilingual expansion

Future iterations can improve:

- full interface localization
- more Indian languages
- screen-reader support
- keyboard navigation
- reduced-motion options
- larger touch targets
- improved contrast modes
- accessible report layouts
- language-specific OCR/model selection

## 17. Testing and evaluation infrastructure

Future engineering work can establish formal evaluation datasets for:

- OCR accuracy
- field extraction accuracy
- GTIN reconciliation
- rule-engine correctness
- visual measurement accuracy
- model disagreement handling
- end-to-end inspection accuracy
- processing latency
- offline synchronization correctness

The evaluation system should distinguish model accuracy from legal correctness and officer decision consistency.

## 18. Knowledge graph and regulatory intelligence

Future PARAKH versions can connect:

```text
Product
Manufacturer
GTIN
Batch
Category
Rule
Violation
Inspection
Officer
Location
```

A knowledge graph can support relationships and retrieval such as:

- which batches were associated with a product
- which rules produced a finding
- which categories have repeated issues
- which inspections observed a batch
- which manufacturer/product combinations recur across jurisdictions

A retrieval layer can help officers find the relevant rule text and supporting evidence without replacing the formal rules engine.

## 19. Data export and interoperability

Future interoperability can include:

- CSV export
- structured JSON export
- official case-management integration
- report bundles
- evidence packages
- audit exports
- API integrations
- bulk import for authorized product/reference data

## 20. Deployment and observability

Future production infrastructure can add:

- centralized logs
- request tracing
- provider latency metrics
- OCR quality metrics
- queue depth metrics
- database monitoring
- uptime monitoring
- alerting
- automated deployments
- environment promotion
- backup/recovery procedures

## 21. Important boundary

Future scope is not current implementation.

For presentations and documentation, use explicit labels such as:

- Implemented
- Feature branch / experimental
- Prototype limitation
- Planned

Do not present a proposed offline workflow, official GTIN integration, government integration, or advanced model capability as already deployed unless it exists in the verified source tree.
