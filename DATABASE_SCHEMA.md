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
 └──< ComplianceRule
```

## User

Fields include `id`, `name`, `email`, `passwordHash`, `role`, and timestamps.

## Session

Stores authenticated session tokens, user ownership, expiry, and creation time.

## Shop

Current fields include `id`, `name`, address/location fields, `sourceType`, optional `ownerId`, and timestamps. Inspections reference shops.

## Category

Categories are a self-referencing tree through `parentId`. Current fields include `name`, `slug`, `isSystem`, `sourceType`, `ownerId`, and `isFinalProductType`.

The application hierarchy is:

`Category → Subcategory → Product Type → Brand → Product → Pack Size / Variant`

The current database stores the hierarchy primarily through categories and product records rather than requiring separate Brand/ProductVariant tables.

## Product

Current fields include product/brand names, description, OCR data, net quantity/unit, MRP, barcode, image URL(s), compliance status/reason, source type/URL/site name, owner, category, and timestamps.

## Scan

Stores scan id, image URL, OCR text, status, creation time, and owning worker/user. A scan can be linked to one inspection.

## Inspection

Stores status, notes, inspection time, worker/user, shop, product, and optional unique scan link. Indexes support common shop/product/user/time queries.

## ComplianceRule

Current rule records contain:

- ruleId
- ruleCode
- ruleNumber
- subclause
- title
- description
- category
- defaultSeverity
- enabled
- isBuiltin
- definition JSON
- createdById
- timestamps

## OCR/AI evidence storage boundary

The current Prisma schema is intentionally simpler than a fully normalized evidence database. OCR/AI metadata commonly travels inside application JSON/result structures.

A structured field can carry OCR evidence information such as:

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

PARAKH queries DataKart using an extracted GTIN/barcode and compares the registered product fields with the current inspection fields. DataKart does not store PARAKH inspection events and does not determine Legal Metrology compliance.

The registry is an external verification source used by the evidence-confidence layer.

## Evidence confidence

The current field-level evidence score uses:

```text
50% DataKart agreement
30% Gemini semantic confidence
20% RapidOCR evidence confidence
```

Unavailable sources are omitted and the remaining weights are renormalized.

This score is an evidence-fusion indicator, not a database fact representing legal certainty.

## Indexing

The current schema includes indexes for category hierarchy, ownership, shops, products, brand/product names, barcode, compliance status, source type, inspection relationships, timestamps, and rules.

## Migrations

Use **Prisma migrations**, not Alembic.

## Data integrity

Preserve inspection history and catalogue relationships. Apply ownership and authorization rules at the application layer and relational constraints at the database layer.

## Analytics

Dashboard analytics are calculated from real stored inspection records rather than manually maintained counters.
