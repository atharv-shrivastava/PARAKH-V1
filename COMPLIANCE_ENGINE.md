# PARAKH Legal Metrology Compliance Engine

## 1. Purpose

The Compliance Engine is PARAKH's legal/business-rule layer. It evaluates structured inspection information against configured Legal Metrology requirements.

It is intentionally separate from OCR, semantic AI, and DataKart verification.

## 2. Legal scope

The implementation is intended around the Legal Metrology Act, 2009 and the Legal Metrology (Packaged Commodities) Rules, 2011, together with the official requirements and amendments adopted into PARAKH's configured rule set.

Every implemented legal requirement should retain an identifiable source/reference and version information.

## 3. Current architecture

```text
Package images
      ↓
RapidOCR
      ↓
Structured declarations
      ↑
Gemini semantic interpretation
      ↓
DataKart GTIN reference verification
      ↓
Evidence confidence
      ↓
Applicable compliance rules
      ↓
Rule evaluation
      ↓
Findings
      ↓
Officer review
```

The OCR/AI/registry layers provide evidence and interpretation. The compliance engine performs the legal-rule evaluation.

## 4. Rule representation

The current database stores configurable rules as `ComplianceRule` records with fields including:

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

The JSON definition carries machine-readable validation/configuration data where required.

## 5. Rule separation

Legal decisions must not be hidden inside an LLM prompt or React component.

```text
OCR / semantic interpretation
        ↓
Structured field values
        ↓
Configured compliance rules
        ↓
Deterministic validation
        ↓
Finding + evidence
        ↓
Officer decision
```

## 6. Result states

The application supports compliance outcomes such as:

- compliant
- violation
- needs manual verification
- unable to determine
- not applicable where supported by rule logic

Exact stored status values remain implementation-defined by the running Rules Engine.

## 7. Evidence confidence vs legal result

The field-level **Evidence Confidence** score is calculated separately from legal compliance.

Current weighting:

```text
50% DataKart agreement
30% Gemini confidence
20% RapidOCR confidence
```

This score describes the strength of supporting extraction/reference evidence. It does not decide whether the package is legally compliant.

For example, a field can have high Evidence Confidence while still causing a legal violation because the extracted value itself violates a configured rule.

## 8. DataKart role

DataKart is a separate product-reference registry. A GTIN/barcode is used to retrieve registered product data, which is compared against extracted inspection fields.

A DataKart `MATCH` strengthens evidence for that field. A `MISMATCH` flags reference disagreement. An unavailable or unregistered field is shown as unverified and does not itself create a legal violation.

The Rules Engine remains the only layer responsible for configured Legal Metrology compliance evaluation.

## 9. Deterministic checks

Use deterministic backend logic for checks such as:

- required declaration presence
- numeric/value validation
- category applicability
- configured field requirements
- exact structural/legal conditions
- rule-specific thresholds where formally configured

Use semantic AI only when semantic interpretation is actually required.

## 10. Uncertainty

Some photographic evidence cannot establish compliance conclusively.

Examples include unclear placement, poor image quality, insufficient scale for physical measurement, missing declarations, ambiguous text, and context-dependent legal conditions.

These cases should lead to review rather than fabricated certainty.

## 11. Evidence traceability

A finding should be traceable to:

1. inspection/product
2. applicable rule
3. extracted value or officer observation
4. supporting package evidence where available
5. explanation
6. officer decision

## 12. Manual officer violations

The scan workflow supports manual violation entry in addition to automated rule findings.

Manual entries remain distinguishable from automated detections and are stored with the inspection outcome.

## 13. Versioning

When a legal requirement changes, create a new rule/version configuration rather than silently changing the interpretation of historical inspections.

## 14. Administration

Built-in rules and administrator-created rules can coexist. Rule creation/editing must require appropriate authorization.

## 15. Testing

Rules should be tested independently of the UI with valid, invalid, missing, ambiguous, and not-applicable cases where relevant.

## 16. Important limitation

PARAKH is inspection decision support. OCR, AI, DataKart verification, and Rules Engine outputs are aids to the authorized officer and do not by themselves constitute a final legal determination.