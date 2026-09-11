# PARAKH Database Schema

## Current implementation

PARAKH currently uses PostgreSQL through Prisma 7 and the PostgreSQL driver adapter.

## Core relationships

```text
User ──< Session
 │
 ├──< Scan ──0..1── Inspection >── Shop
 │                         │
 │                         └── Product ── Category tree
 │
 ├──< Inspection
 ├──< Category
 ├──< Product
 ├──< Shop
 ├──< ComplianceRule
 ├──< BatchIncidentReport
 └──< BatchAlert
```

## User

Fields include `id`, `name`, `email`, `passwordHash`, `role`, email-verification fields, and timestamps.

Users can own products, shops and categories, create rules where authorized, report batch incidents, and verify/create batch alerts according to role permissions.

## Session

Stores authenticated session tokens, user ownership, expiry, and creation time.

## Shop

Current fields include `id`, `name`, address/location fields, `city`, `state`, `latitude`, `longitude`, `sourceType`, optional `ownerId`, and timestamps. Inspections reference shops.

`city` and `state` are used by the intelligence layer for geographic aggregation where available. Product records are location-filterable through their associated inspection/shop records, so a product can be found by shop, address, city, or state without duplicating location on the Product row.

## Category

Categories are a self-referencing tree through `parentId`. Current fields include `name`, `slug`, `isSystem`, `sourceType`, `ownerId`, and `isFinalProductType`.

The application supports a practical four-level user-facing category structure and an explicit final-product-type marker.

## Product

Current fields include:

- product and brand names
- `manufacturerName`
- description
- OCR/application result data
- net quantity/unit
- MRP
- barcode / GTIN
- image URL(s)
- compliance status/reason
- source type/URL/site name
- owner
- category
- timestamps

Products can have associated inspections, batch incidents and batch alerts.

### Product location filtering

Location is deliberately modeled through the real-world inspection source rather than duplicated on every Product record.

The product database can filter stored products by:

- shop name
- shop address
- city
- state

The location-aware endpoint returns the latest inspection location for each matching product, including available latitude/longitude. A product is returned when **any associated inspection** matches the requested location, allowing the same product to remain discoverable across multiple inspection locations.

## Scan

Stores scan id, image URL, OCR text, status, creation time, and owning worker/user. A scan can be linked to one inspection.

## Inspection

Current records include:

- `status`
- notes
- `violationType`
- `violationSeverity`
- `isVerified`
- `verifiedAt`
- `inspectedAt`
- worker/user
- shop
- product
- `batchNumber`
- optional unique scan link

Indexes support common worker, shop, product, batch, status, verification, severity, violation and timestamp queries.

## ComplianceRule

Current rule records contain:

- `ruleId`
- `ruleCode`
- `ruleNumber`
- `subclause`
- `title`
- `description`
- `category`
- `defaultSeverity`
- `enabled`
- `isBuiltin`
- `definition` JSON
- `createdById`
- timestamps

These records support administrator-managed compliance rules without requiring each rule to be hard-coded into the frontend.

## BatchIncidentReport

Represents a field/officer-reported incident associated with an exact product and batch.

Key fields include:

- `productId`
- `batchNumber`
- optional `inspectionId`
- `reportedById`
- title and description
- severity
- status
- evidence URL
- optional linked `batchAlertId`
- timestamps

An ordinary user can submit an incident for administrative review. Authorized admins can verify it.

## BatchAlert

Represents a verified, platform-visible batch safety warning.

Key fields include:

- `productId`
- `batchNumber`
- title/message
- severity
- status
- `createdById`
- optional `verifiedById`
- `verifiedAt`
- timestamps

The database enforces a unique product/batch pair for alerts so the warning remains tied to the exact affected batch rather than the entire product catalog entry.

## OCR/AI evidence storage boundary

The current Prisma schema is intentionally simpler than a fully normalized evidence database. OCR/AI metadata commonly travels inside application JSON/result structures.

Structured field results can carry information such as:

- source image index
- OCR confidence
- evidence text
- bounding box
- image width/height
- semantic source
- semantic confidence
- DataKart verification state
- registered reference value
- final Evidence Confidence

These properties should not be assumed to exist as standalone Prisma tables unless the current schema contains them.

## DataKart boundary

DataKart is a separate product-reference registry and is **not** part of the PARAKH PostgreSQL schema.

PARAKH can query DataKart using an extracted GTIN/barcode and compare registered product fields with current inspection fields. DataKart does not store PARAKH inspection events and does not determine Legal Metrology compliance.

## Evidence confidence

The current field-level evidence score uses available signals approximately as follows:

```text
50% DataKart agreement
30% Gemini semantic confidence
20% RapidOCR evidence confidence
```

Unavailable sources are omitted and the remaining weights are renormalized.

This score is an evidence-fusion indicator, not a database fact representing legal certainty.

## Analytics

Dashboard and Compliance Intelligence analytics are calculated from real stored inspection records rather than manually maintained counters.

The intelligence layer aggregates information such as:

- inspection trend
- violation types
- manufacturer violation rate
- affected batches
- violation severity
- geographic distribution

It also supports filtering by manufacturer, product, GTIN, batch, violation type, city/district, state, date range and verification status.

## Indexing

The current schema includes indexes for category hierarchy, ownership, shops, products, manufacturer/product names, barcode, compliance status, source type, inspection relationships, batch numbers, verification, severity, violation type, timestamps, and rule lookup fields.

## Migrations

Use **Prisma migrations**, not Alembic.

## Data integrity

Preserve inspection history, rule relationships, product/category relationships and batch incident traceability. Apply ownership and authorization rules at the application layer and relational constraints at the database layer.
