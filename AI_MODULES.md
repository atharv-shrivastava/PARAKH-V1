# PARAKH AI, OCR and Evidence Modules

## 1. AI philosophy

PARAKH uses AI where semantic interpretation is useful. Deterministic software remains responsible for deterministic validation and legal-rule evaluation.

The system must never fabricate missing declarations. Unknown or unsupported evidence remains unknown and is sent for review where necessary.

## 2. Current scanning pipeline

```text
Package image(s)
      ↓
RapidOCR
      ↓
OCR evidence + confidence + geometry
      ↓
Deterministic field reconciliation
      ↓
Gemini semantic interpretation
      ↓
Semantic consensus / structured fields
      ↓
DataKart GTIN verification
      ↓
Evidence confidence fusion
      ↓
Rules Engine
      ↓
Officer review
```

The current V1 default semantic path uses Gemini. Additional Cloudflare semantic providers can be enabled with `PARAKH_SEMANTIC_VERIFY_ALL=true`.

## 3. RapidOCR layer

RapidOCR is the primary local OCR/detection layer.

OCR evidence can contain:

- detected text
- OCR confidence
- source image index
- bounding box
- image width/height

RapidOCR provides visual text evidence. It does not decide what a declaration means legally.

## 4. Deterministic field reconciliation

The local reconciliation layer maps OCR detections to structured declaration fields using deterministic evidence rules.

It can use:

- declaration labels and anchors
- spatial proximity
- relative position
- text similarity
- quantity/date/MRP/batch/barcode patterns
- bounding-box geometry
- OCR confidence
- identity/product candidate scoring

The reconciler preserves uncertainty rather than forcing an answer when evidence is weak.

## 5. Structured fields

The current extraction model supports fields including product name, brand, manufacturer, addresses, packer, marketer, importer, net quantity, unit, MRP, currency, manufacturing/packing dates, best-before/expiry, batch number, consumer-care contact, country of origin, FSSAI license number, and barcode/GTIN.

## 6. Gemini semantic layer

Gemini receives the package images and OCR evidence to interpret semantic relationships that plain OCR cannot reliably establish by itself.

Examples include:

- deciding which nearby value represents MRP
- mapping a declaration to the correct field
- understanding product/brand identity
- using image/spatial context to distinguish related text
- suggesting a product category

Gemini confidence is retained as one component of the final evidence-confidence calculation.

Gemini is not the legal source of truth.

## 7. Semantic consensus

The backend has support for multiple semantic providers. Successful provider results can be reconciled field by field. Failed or unavailable providers do not automatically block the scan.

When enabled, Cloudflare Gemma and Cloudflare Moondream can contribute additional semantic evidence. The default V1 configuration uses Gemini as the primary semantic provider.

## 8. DataKart verification

DataKart is a separate product-reference registry. PARAKH extracts a GTIN/barcode and looks up an active registered product in DataKart.

The returned registered fields are compared against the current inspection values. DataKart verifies product-reference agreement; it does not evaluate Legal Metrology rules.

Verification states are:

- `MATCH` / `✓`: the field matches the registered DataKart value
- `MISMATCH` / `✕`: the field differs from the registered value
- `UNVERIFIED` / `?`: no registered field or no usable DataKart verification was available

## 9. Evidence confidence

PARAKH combines independent evidence sources into an **Evidence Confidence** score:

```text
50% DataKart agreement
30% Gemini semantic confidence
20% RapidOCR evidence confidence
```

DataKart has the largest weight because registered reference agreement is a direct cross-check of the extracted product information.

When a source is unavailable, its weight is removed and the remaining available weights are renormalized. A missing DataKart record therefore does not automatically mean the extracted field is wrong.

A DataKart mismatch contributes zero for that field's DataKart component while the separate verification state reports the mismatch. This makes it possible to distinguish "confident extraction but registry disagreement" from "poor OCR".

The score is an evidence-fusion indicator, not a calibrated probability and not legal certainty.

## 10. Evidence provenance

Structured fields can retain:

- OCR confidence
- semantic confidence
- source/evidence text
- source image index
- bounding box
- DataKart registered value
- DataKart verification state
- final evidence confidence

The provenance should remain available when an officer corrects or confirms a field.

## 11. Visual screening

The scanning result can include assistive screening for readability, relative text size, declaration location, and detected text regions.

These are screening signals. Exact statutory physical measurements still require appropriate verification and calibration.

## 12. Human review

Review should be triggered or encouraged when:

- OCR evidence is weak or missing
- semantic confidence is low
- semantic providers disagree
- DataKart conflicts with the extracted value
- critical declarations are missing
- placement/readability cannot be established
- image quality prevents reliable extraction
- legal applicability depends on information unavailable from the photograph

## 13. Compliance boundary

AI and OCR extract or interpret evidence. The configurable Rules Engine evaluates legal requirements from structured inputs.

```text
Package image
   ↓
RapidOCR + Gemini
   ↓
Structured field
   ↓
Evidence confidence / DataKart verification
   ↓
Rules Engine
   ↓
Finding
   ↓
Officer decision
```

No LLM should silently replace deterministic legal-rule evaluation.

## 14. Failure observability

Provider execution should record enough information to identify:

- provider
- model
- success/failure
- execution time
- failure reason

The user-facing result should stay understandable while detailed diagnostics remain in backend logs.

## 15. Evaluation metrics

Evaluate OCR accuracy, field extraction accuracy, DataKart agreement accuracy, semantic agreement, rule correctness, false positives/negatives, manual correction rate, processing time, and provider reliability separately.

## 16. Governance

Officer corrections are review data, not an instruction to silently retrain production models. Changes to OCR models, semantic providers, matching logic, or evidence weights should be documented and evaluated separately.
