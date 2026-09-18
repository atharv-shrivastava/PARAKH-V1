import { FIELD_KEYS, confidence, text } from "./semanticPackageCommon.js";

const SOURCE_WEIGHTS = {
  gemini_image: 1.0,
  deterministic_regex: 0.75,
};

const SOURCE_PRIORITY = [
  "gemini_image",
  "deterministic_regex",
];

const DATE_FIELDS = new Set(["dateOfManufacture", "dateOfPacking", "bestBefore", "expiryDate"]);
const PHONE_FIELDS = new Set(["consumerCarePhone"]);
const DIGIT_FIELDS = new Set(["fssaiLicenseNumber", "barcode"]);
const CURRENCY_FIELDS = new Set(["mrp"]);
const QUANTITY_FIELDS = new Set(["netQuantity"]);

const GEMINI_MIN_CONFLICT_CONFIDENCE = 0.70;
const AGREEMENT_BOOST = 0.08;

function normalizeWhitespace(value) {
  return text(value).normalize("NFKC").replace(/\s+/g, " ").trim();
}

function canonicalValue(key, value) {
  const raw = normalizeWhitespace(value);
  if (!raw) return "";

  if (PHONE_FIELDS.has(key) || DIGIT_FIELDS.has(key)) {
    return raw.replace(/\D/g, "");
  }

  if (CURRENCY_FIELDS.has(key)) {
    const match = raw.replace(/,/g, "").match(/\d+(?:\.\d+)?/);
    return match ? match[0] : raw
      .toLowerCase()
      .replace(/\b(?:mrp|maximum retail price|retail price|rs\.?|inr)\b/g, "")
      .trim();
  }

  if (QUANTITY_FIELDS.has(key)) {
    const match = raw.toLowerCase().replace(/,/g, "").match(/\d+(?:\.\d+)?\s*[a-z]+/);
    if (match) return match[0].replace(/\s+/g, "");
  }

  if (DATE_FIELDS.has(key)) {
    const parts = raw.split(/[.\/_-]+/).filter(Boolean);
    if (parts.length >= 2 && parts.every((part) => /^\d+$/.test(part))) {
      return parts.map((part) => String(Number(part))).join("/");
    }
  }

  return raw
    .toLocaleLowerCase()
    .replace(/[₹$€£]/g, "")
    .replace(/[^\p{L}\p{N}@.+%-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sourceWeight(source) {
  return Number(SOURCE_WEIGHTS[source?.sourceKind] ?? 0.5);
}

function sourceLabel(source) {
  if (source?.sourceId) return source.sourceId;
  if (source?.sourceKind === "gemini_image") return "gemini-image";
  if (source?.sourceKind === "deterministic_regex") return "regex/raw-ocr";
  return source?.provider || "unknown";
}

function summarizeObservation(key, source, field) {
  const confidenceValue = confidence(field?.confidence);
  return {
    source: sourceLabel(source),
    sourceKind: source?.sourceKind || "unknown",
    value: field?.value ?? null,
    normalizedValue: canonicalValue(key, field?.value),
    status: field?.status || "absent",
    confidence: confidenceValue,
    weightedSupport: Number((sourceWeight(source) * confidenceValue).toFixed(4)),
    evidence: field?.evidence ?? field?.raw ?? null,
    imageIndex: Number.isInteger(field?.imageIndex) ? field.imageIndex : -1,
    evidenceIndex: Number.isInteger(field?.evidenceIndex) ? field.evidenceIndex : -1,
  };
}

function statusWhenEmpty(fields) {
  const statuses = fields.map((field) => field?.status);
  if (statuses.includes("ambiguous")) return "ambiguous";
  if (statuses.includes("unreadable")) return "unreadable";
  return "absent";
}

function findSourceField(sources, key, normalizedValue) {
  const source = sources.find(
    (item) =>
      item?.enabled &&
      item?.fields?.[key] &&
      canonicalValue(key, item.fields[key].value) === normalizedValue,
  );
  return source?.fields?.[key] || null;
}

function buildFoundResult(field, winner, verification, fusion) {
  return {
    ...(field || {}),
    value: winner.value,
    displayValue: field?.displayValue || winner.value,
    raw: field?.raw ?? winner.value,
    evidence: field?.evidence ?? winner.evidence ?? winner.value,
    confidence: Number(Math.min(0.99, Math.max(0, winner.confidence)).toFixed(3)),
    status: "found",
    source: "FIELD_FUSION",
    verification,
    fusion,
  };
}

function fuseField(key, sources) {
  const observations = [];
  for (const source of sources) {
    if (!source?.enabled || !source?.fields?.[key]) continue;
    observations.push(summarizeObservation(key, source, source.fields[key]));
  }

  // Source selection is based on whether a usable VALUE exists, not on confidence
  // or status. Confidence describes certainty; it must never decide whether a
  // Gemini value gets discarded. Gemini is primary, regex is fallback only.
  const found = observations.filter((item) => item.normalizedValue);

  if (!found.length) {
    return {
      value: null,
      displayValue: "",
      raw: null,
      evidence: null,
      confidence: 0,
      status: statusWhenEmpty(observations),
      source: "FIELD_FUSION",
      verification: "no-supported-value",
      fusion: {
        observations,
        agreementCount: 0,
        conflict: false,
        winnerSource: null,
        fallbackUsed: false,
      },
    };
  }

  const gemini = found.find((item) => item.sourceKind === "gemini_image");
  const regex = found.find((item) => item.sourceKind === "deterministic_regex");

  // Gemini is the independent visual reading. Regex is OCR-derived
  // corroboration, not an equal independent vote.
  if (gemini && regex) {
    if (gemini.normalizedValue === regex.normalizedValue) {
      const agreementConfidence = Math.min(
        0.99,
        Math.max(gemini.confidence, regex.confidence) + AGREEMENT_BOOST,
      );
      const winningField = findSourceField(sources, key, gemini.normalizedValue);

      return buildFoundResult(
        winningField,
        { ...gemini, confidence: agreementConfidence },
        "agreement-2-sources",
        {
          observations,
          agreementCount: 2,
          conflict: false,
          winnerSource: "gemini-image",
          candidateSources: ["gemini-image", "regex/raw-ocr"],
          fusionMethod: "independent-visual-plus-ocr-corroboration",
          fallbackUsed: false,
        },
      );
    }

    // Direct visual evidence has priority when Gemini is sufficiently
    // confident. The disagreement is retained for audit/review instead of
    // letting a single OCR-derived regex value overwrite the image reading.
    if (gemini.confidence >= GEMINI_MIN_CONFLICT_CONFIDENCE) {
      const winningField = findSourceField(sources, key, gemini.normalizedValue);
      return buildFoundResult(
        winningField,
        gemini,
        "gemini-visual-priority-conflict-with-ocr",
        {
          observations,
          agreementCount: 1,
          conflict: true,
          winnerSource: "gemini-image",
          candidateSources: ["gemini-image", "regex/raw-ocr"],
          fusionMethod: "visual-priority-with-ocr-conflict",
          regexCandidate: regex.value,
          regexConfidence: regex.confidence,
          fallbackUsed: false,
        },
      );
    }

    // Gemini still wins whenever it supplied a value. A disagreement is retained
    // as audit provenance, but regex does not replace the visual extraction merely
    // because Gemini confidence is lower.
    const winningField = findSourceField(sources, key, gemini.normalizedValue);
    return buildFoundResult(
      winningField,
      gemini,
      "gemini-visual-priority-conflict-with-ocr",
      {
        observations,
        agreementCount: 1,
        conflict: true,
        winnerSource: "gemini-image",
        candidateSources: ["gemini-image", "regex/raw-ocr"],
        fusionMethod: "visual-primary-with-ocr-conflict",
        regexCandidate: regex.value,
        regexConfidence: regex.confidence,
        fallbackUsed: false,
      },
    );
  }

  // Gemini value exists by itself: use it directly.
  if (gemini) {
    const winningField = findSourceField(sources, key, gemini.normalizedValue);
    return buildFoundResult(
      winningField,
      gemini,
      "gemini-visual-extraction",
      {
        observations,
        agreementCount: 1,
        conflict: false,
        winnerSource: "gemini-image",
        candidateSources: ["gemini-image"],
        fusionMethod: "visual-primary",
        fallbackUsed: false,
      },
    );
  }

  // Regex is the fallback only when Gemini has no usable value.
  if (regex) {
    const winningField = findSourceField(sources, key, regex.normalizedValue);
    return buildFoundResult(
      winningField,
      regex,
      "regex-fallback-no-gemini-value",
      {
        observations,
        agreementCount: 1,
        conflict: false,
        winnerSource: "regex/raw-ocr",
        candidateSources: ["regex/raw-ocr"],
        fusionMethod: "ocr-fallback",
        fallbackUsed: true,
        fallbackOrder: SOURCE_PRIORITY,
      },
    );
  }

  return {
    value: null,
    displayValue: "",
    raw: null,
    evidence: null,
    confidence: 0,
    status: statusWhenEmpty(observations),
    source: "FIELD_FUSION",
    verification: "no-supported-value",
    fusion: {
      observations,
      agreementCount: 0,
      conflict: false,
      winnerSource: null,
      fallbackUsed: false,
    },
  };
}

export function fuseFieldSources(sources = [], categoryKeys = FIELD_KEYS) {
  const output = {};
  for (const key of categoryKeys) output[key] = fuseField(key, sources);

  // Keep quantity and unit as separate structured fields in the public result.
  // This is normalization only; it does not select a source or use confidence.
  const quantity = text(output.netQuantity?.value || "");
  const unit = text(output.unit?.value || "");
  const match = quantity.match(/^([0-9]+(?:[.,][0-9]+)?)\\s*([a-zA-Zµμ%]+)$/);
  if (match) {
    const numericValue = match[1].replace(/,/g, "");
    output.netQuantity = {
      ...output.netQuantity,
      value: numericValue,
      displayValue: numericValue,
    };
    if (!unit) {
      output.unit = {
        ...(output.unit || {}),
        value: match[2],
        displayValue: match[2],
        raw: output.netQuantity.raw || quantity,
        evidence: output.netQuantity.evidence || quantity,
        confidence: output.netQuantity.confidence || 0,
        status: "found",
        source: "FIELD_FUSION",
        verification: output.netQuantity.verification || "quantity-unit-split",
      };
    }
  }

  return output;
}

export { SOURCE_WEIGHTS, SOURCE_PRIORITY, canonicalValue, GEMINI_MIN_CONFLICT_CONFIDENCE };
