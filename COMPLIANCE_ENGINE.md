# PARAKH Legal Metrology Compliance Engine

## 1. Purpose

The Compliance Engine is PARAKH's legal/business-rule layer. It evaluates structured inspection information against configured Legal Metrology requirements.

It is intentionally separate from OCR, semantic AI, reference verification, analytics, visual preprocessing, and the user interface.

## 2. Legal scope

The implementation is intended around the **Legal Metrology Act, 2009** and the **Legal Metrology (Packaged Commodities) Rules, 2011**, together with official requirements and amendments adopted into PARAKH's configured rule set.

Every implemented legal requirement should retain an identifiable source/reference and version information.

## 3. Current architecture

```text
Package images
      ↓
RapidOCR
      ↓
Structured declarations + bounding boxes
      ↑
Gemini / semantic interpretation
      ↓
GTIN / DataKart reference verification
      ↓
Evidence confidence
      ↓
OpenCV calibrated visual evidence where applicable
      ↓
Applicable compliance rules
      ↓
Deterministic rule evaluation
      ↓
Findings
      ↓
Officer review
```

The OCR, AI, registry and computer-vision layers provide evidence and interpretation. The compliance engine performs the legal-rule evaluation.

## 4. Rule representation

The database stores configurable rules as `ComplianceRule` records with fields including:

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

The JSON definition carries machine-readable validation/configuration data where required.

## 5. Administration

Authorized administrators can create and manage compliance rules from the admin interface. Built-in rules and administrator-created rules can coexist.

Rule changes should be versioned or otherwise traceable so historical inspection decisions are not silently reinterpreted.

## 6. Rule separation

Legal decisions must not be hidden inside an LLM prompt or React component.

```text
OCR / semantic interpretation
        ↓
Structured field values
        ↓
Visual measurements where applicable
        ↓
Configured compliance rules
        ↓
Deterministic validation
        ↓
Finding + evidence
        ↓
Officer decision
```

## 7. Rule 7 font-size workflow

PARAKH now connects the OpenCV vision service to the Rule 7 evaluator.

```text
Package image
    ↓
OpenCV detects Indian ₹10 coin
    ↓
27 mm reference calibrates image scale
    ↓
OCR bounding box identifies declaration region
    ↓
OpenCV estimates glyph height
    ↓
Physical height in mm
    ↓
Rule 7 evaluator
    ↓
PASS / VIOLATION / UNABLE_TO_VERIFY
```

The **current Rule 7 table is based on principal display panel area**, not package weight. The ₹10 coin is only the physical calibration reference.

Current minimum height table:

| Principal display panel area | Normal | Blown / formed / molded |
|---|---:|---:|
| A ≤ 50 cm² | 1.0 mm | 2.0 mm |
| 50 < A ≤ 100 cm² | 1.5 mm | 3.0 mm |
| 100 < A ≤ 500 cm² | 2.5 mm | 4.0 mm |
| 500 < A ≤ 2500 cm² | 4.0 mm | 6.0 mm |
| A > 2500 cm² | 6.0 mm | 6.0 mm |

The engine also uses the available width-to-height signal for the one-third minimum described in the Rules.

### Rule 7 evidence contract

The backend supplies:

```text
visual.principalDisplayPanelAreaCm2
visual.surfaceType
visual.rule7FontSizeMeasurements[]
visual.fontSizeCalibrationReference
```

If the display-panel area, coin calibration or declaration bounding box cannot be established reliably, the finding is `UNABLE_TO_VERIFY` rather than an invented violation.

## 8. Result states

The application supports compliance outcomes such as:

- compliant
- violation
- needs manual verification
- unable to determine
- not applicable where supported by rule logic

The UI also exposes field-level verification states such as **Verified / Needs Verification / Missing**. These are evidence states and must not be confused with the legal result itself.

## 9. Evidence confidence vs legal result

The field-level **Evidence Confidence** score is calculated separately from legal compliance.

Current weighting when the relevant sources are available:

```text
50% DataKart agreement
30% Gemini confidence
20% RapidOCR confidence
```

Unavailable sources are omitted and the remaining weights are renormalized.

This score describes the strength of supporting extraction/reference evidence. It does not decide whether the package is legally compliant.

A field can have high evidence confidence and still produce a violation because the extracted value itself violates a configured rule.

## 10. DataKart role

DataKart is a separate product-reference registry. A GTIN/barcode can be used to retrieve registered product data, which is compared against extracted inspection fields.

A DataKart match strengthens evidence for a field. A mismatch identifies reference disagreement. An unavailable/unregistered reference does not itself create a legal violation.

The Rules Engine remains the only layer responsible for configured Legal Metrology compliance evaluation.

## 11. Deterministic checks

Use deterministic backend logic for checks such as:

- required declaration presence
- numeric/value validation
- category applicability
- configured field requirements
- exact structural/legal conditions
- configured thresholds
- Rule 7 calibrated font-size measurement
- rule-specific conditions represented in the rule definition

Use semantic AI when semantic interpretation is actually required, not as a replacement for deterministic legal validation.

## 12. Uncertainty

Some photographic evidence cannot establish compliance conclusively. Examples include unclear placement, poor image quality, insufficient information for physical measurement, ambiguous text, missing declarations, unreliable calibration, and context-dependent legal conditions.

These cases should result in a review state rather than fabricated certainty.

## 13. Evidence traceability

A finding should be traceable to:

1. inspection/product
2. applicable rule
3. extracted value or officer observation
4. supporting package evidence where available
5. explanation
6. confidence/verification state
7. officer decision

## 14. Manual officer violations

The scan workflow supports manual violation entry in addition to automated rule findings.

Manual entries remain distinguishable from automated detections and are stored with the inspection outcome.

## 15. Human-in-the-loop

The intended flow is:

```text
RapidOCR + Gemini
      ↓
Structured fields + evidence
      ↓
Reference verification where available
      ↓
OpenCV visual evidence where applicable
      ↓
Rules evaluation
      ↓
Inspector reviews uncertain/conflicting evidence
      ↓
Correct / accept / reject / add manual violation
      ↓
Complete inspection / report
```

Human verification is also required for reported serious batch incidents before a `BatchAlert` becomes active across the platform.

## 16. Compliance Intelligence boundary

The Rules Engine produces inspection findings. Those findings are later aggregated by the analytics layer into Compliance Intelligence.

The intelligence layer can analyze:

- violation types
- violation severity
- manufacturers
- products
- affected batches
- geographic distribution
- inspection trends

Analytics do not change the underlying legal rule decision.

## 17. Batch Safety boundary

A batch incident is a separate operational workflow from ordinary rule violations.

```text
Batch incident reported
        ↓
Authorized review
        ↓
Verified batch alert
        ↓
Platform warning for exact product + batch
```

A batch alert is not a substitute for a Legal Metrology finding, and AI must not autonomously declare a batch defective.

## 18. Testing

Rules should be tested independently of the UI with valid, invalid, missing, ambiguous and not-applicable cases where relevant.

Rule 7 should additionally be tested with different display-panel areas, normal/formed surfaces, sufficient/insufficient calibrated heights, width-to-height failures, missing coin calibration, and missing panel-area evidence.

Batch incident verification and analytics aggregation should also be tested against realistic inspection records.

## 19. Important limitation

PARAKH is inspection decision support. OCR, AI, reference verification, OpenCV measurements, evidence confidence, analytics and Rules Engine outputs are aids to the authorized officer and do not by themselves constitute a final legal determination.
