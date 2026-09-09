# PARAKH UI/UX Specification

## 1. UX goal

PARAKH is an inspection-focused interface for field and desktop use. Important actions, uncertainty, evidence, and compliance state should be immediately understandable.

## 2. Platform

One responsive application serves phone, tablet, laptop, and desktop. Layout adapts rather than creating separate products.

## 3. Navigation

The current UI uses a persistent desktop sidebar and compact responsive navigation on smaller screens. Primary destinations include Dashboard, Scan, Shops, Products, History, and Reports, with E-commerce, Profile, and authorized Admin areas.

## 4. Themes

The application supports light, dark, dark-gradient, gradient, and rainbow themes. Themes affect backgrounds, surfaces, text, borders, inputs, sidebar, accents, and shadows. Dark themes must maintain strong contrast across major inspection pages.

## 5. Dashboard

The dashboard uses real stored inspection data and can show inspection trends, totals, violations, compliance information, recent inspections, product hierarchy, highest-violation shop, highest-violation brand, highest-violation rule, and quick actions.

## 6. Scan workflow

The core inspection workflow is:

`Capture/Upload → RapidOCR → Extraction → Semantic interpretation → DataKart verification → Evidence Confidence → Visual Screening → Rules/Findings → Officer Review → Registration`

The Scan experience supports multiple package images, image removal, editable extracted fields, source/evidence information, uncertainty states, visual screening, compliance findings, and manual violations.

## 7. Field verification states

Field verification should communicate the DataKart result without relying on color alone:

```text
✓  MATCH       Registered DataKart value agrees with the extracted field.
✕  MISMATCH    Registered DataKart value disagrees with the extracted field.
?  UNVERIFIED  DataKart could not establish a usable reference for the field.
```

## 8. Evidence Confidence display

The interface should present Evidence Confidence as an evidence-strength indicator rather than as a probability or legal-certainty score.

Current weighting:

```text
DataKart agreement  50%
Gemini confidence   30%
RapidOCR confidence 20%
```

Where a source is unavailable, remaining available weights are renormalized.

The UI may show the final score together with source contributions so an inspector can understand why a field received its score.

## 9. Visual inspection

The scan result can show assistive readability, placement, declaration detection, text-region, and relative-size signals. Approximate measurements must be labeled as estimates unless reliable calibration exists.

## 10. Evidence interaction

When source geometry is available, the interface should be able to identify the source image and bounding box associated with an extracted field. Field corrections should not erase the original evidence metadata.

## 11. Product hierarchy

`Category → Subcategory → Product Type → Brand → Product → Pack Size / Variant` must remain visually obvious and navigable.

## 12. Shops

Shops use real stored data. Listing/detail views expose inspection and product history. Safe deletions can update optimistically without a full page reload.

## 13. Reports and history

History supports inspection search/filtering and evidence review. Reports should distinguish:

- extracted information
- Evidence Confidence and registry verification
- Rules Engine findings
- officer decisions

## 14. Admin

Admin pages use the same design system while exposing additional platform controls, rules, users, products, inspections, and analytics.

## 15. Performance

Use loading states where useful, short-lived GET caching, mutation-triggered invalidation, bounded provider waits, and targeted UI updates. Avoid unnecessary page remounts/refetches.

## 16. Accessibility

Maintain strong contrast, touch targets, keyboard access, clear labels, non-color-only status communication, actionable errors, and reduced-motion support.

## 17. Visual direction

Professional, precise, modern, restrained, and information-dense. Animations should be short and purposeful.