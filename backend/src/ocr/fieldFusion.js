import { FIELD_KEYS, confidence, text } from "./semanticPackageCommon.js";

const SOURCE_WEIGHTS = {
  gemini_image: 1,
  gemini_ocr_normalization: 0.9,
  deterministic_regex: 0.8,
  grok_image: 0.7,
};

const SOURCE_PRIORITY = [
  "gemini_image",
  "gemini_ocr_normalization",
  "deterministic_regex",
];

const DATE_FIELDS = new Set(["dateOfManufacture", "dateOfPacking", "bestBefore", "expiryDate"]);
const PHONE_FIELDS = new Set(["consumerCarePhone"]);
const DIGIT_FIELDS = new Set(["fssaiLicenseNumber", "barcode"]);
const CURRENCY_FIELDS = new Set(["mrp"]);
const QUANTITY_FIELDS = new Set(["netQuantity"]);

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

function sourceRank(sourceKind) {
  const index = SOURCE_PRIORITY.indexOf(sourceKind);
  return index === -1 ? SOURCE_PRIORITY.length : index;
}

function sourceLabel(source) {
  if (source?.sourceId) return source.sourceId;
  if (source?.sourceKind === "gemini_image") return "gemini-image";
  if (source?.sourceKind === "gemini_ocr_normalization") return "gemini-ocr-normalization";
  if (source?.sourceKind === "grok_image") return "grok-image";
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

function pickFallbackObservation(observations) {
  for (const sourceKind of SOURCE_PRIORITY) {
    const candidate = observations
      .filter((item) => item.sourceKind === sourceKind && item.normalizedValue && item.status === "found")
      .sort((a, b) => b.confidence - a.confidence)[0];
    if (candidate) return candidate;
  }
  return null;
}

function buildFoundResult(winningField, winner, verification, fusion) {
  return {
    ...(winningField || {}),
    value: winner.value,
    displayValue: winningField?.displayValue || winner.value,
    raw: winningField?.raw ?? winner.value,
    evidence: winningField?.evidence ?? winner.evidence ?? winner.value,
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

  const found = observations.filter((item) => item.normalizedValue && item.status === "found");

  // Nothing usable from any source: the field stays empty.
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

  const groups = new Map();
  for (const observation of found) {
    if (!groups.has(observation.normalizedValue)) groups.set(observation.normalizedValue, []);
    groups.get(observation.normalizedValue).push(observation);
  }

  const rankedGroups = [...groups.entries()]
    .map(([normalizedValue, members]) => ({
      normalizedValue,
      members,
      agreementCount: members.length,
      voteSupport: members.reduce((sum, member) => sum + member.confidence, 0),
      weightedSupport: members.reduce((sum, member) => sum + member.weightedSupport, 0),
      maxConfidence: Math.max(...members.map((member) => member.confidence)),
      bestPriority: Math.min(...members.map((member) => sourceRank(member.sourceKind))),
    }))
    .sort((a, b) =>
      b.agreementCount - a.agreementCount ||
      b.voteSupport - a.voteSupport ||
      b.weightedSupport - a.weightedSupport ||
      a.bestPriority - b.bestPriority ||
      b.maxConfidence - a.maxConfidence
    );

  const winnerGroup = rankedGroups[0];
  const runnerUp = rankedGroups[1] || null;
  const conflict = rankedGroups.length > 1;
  const agreementCount = winnerGroup.agreementCount;

  const bestMember = [...winnerGroup.members].sort(
    (a, b) =>
      b.confidence - a.confidence ||
      sourceRank(a.sourceKind) - sourceRank(b.sourceKind),
  )[0];

  // Two or three agreeing sources form the normal vote winner.
  const consensusWinner = agreementCount >= 2;

  // A single source can still win when it is genuinely high-confidence.
  // This prevents a strong Gemini reading from being displaced merely because
  // regex found a different pattern in the raw OCR.
  const runnerConfidence = runnerUp?.maxConfidence ?? 0;
  const highConfidenceWinner =
    agreementCount === 1 &&
    bestMember.confidence >= 0.85 &&
    (runnerConfidence === 0 || bestMember.confidence - runnerConfidence >= 0.10);

  if (consensusWinner || highConfidenceWinner) {
    const agreementBoost = agreementCount >= 3 ? 0.10 : agreementCount === 2 ? 0.06 : 0;
    const winningConfidence = Math.min(0.99, bestMember.confidence + agreementBoost);

    const winningSource = sources.find(
      (source) =>
        source?.enabled &&
        source?.fields?.[key] &&
        canonicalValue(key, source.fields[key].value) === winnerGroup.normalizedValue,
    );
    const winningField = winningSource?.fields?.[key] || null;

    return buildFoundResult(
      winningField,
      { ...bestMember, confidence: winningConfidence },
      agreementCount >= 2
        ? "agreement-" + agreementCount + "-sources"
        : conflict
          ? "high-confidence-single-source"
          : "single-supported-source",
      {
        observations,
        agreementCount,
        conflict,
        winnerSource: bestMember.source,
        candidateSources: winnerGroup.members.map((member) => member.source),
        voteSupport: Number(winnerGroup.voteSupport.toFixed(4)),
        margin: runnerUp
          ? Number((winnerGroup.voteSupport - runnerUp.voteSupport).toFixed(4))
          : null,
        fallbackUsed: false,
        fallbackOrder: SOURCE_PRIORITY,
      },
    );
  }

  // If there is only one usable source and it did not clear the high-confidence
  // threshold, fill the field using the explicit fallback order:
  // Gemini image -> Gemini raw-OCR normalization -> regex/raw-OCR.
  // This is deliberately not applied to genuine multi-source conflicts.
  if (!conflict) {
    const fallback = pickFallbackObservation(found);
    if (fallback) {
      const fallbackSource = sources.find(
        (source) =>
          source?.enabled &&
          source?.fields?.[key] &&
          canonicalValue(key, source.fields[key].value) === fallback.normalizedValue,
      );
      const fallbackField = fallbackSource?.fields?.[key] || null;

      return buildFoundResult(
        fallbackField,
        fallback,
        "fallback-priority",
        {
          observations,
          agreementCount,
          conflict: false,
          winnerSource: fallback.source,
          candidateSources: [fallback.source],
          voteSupport: Number(fallback.confidence.toFixed(4)),
          margin: null,
          fallbackUsed: true,
          fallbackOrder: SOURCE_PRIORITY,
        },
      );
    }
  }

  // A true unresolved conflict must stay unresolved. Do not silently pick a
  // lower-priority source just to make the UI look complete.
  return {
    value: null,
    displayValue: "",
    raw: rankedGroups
      .slice(0, 3)
      .flatMap((group) => group.members.map((member) => member.source + ": " + member.value))
      .join(" | "),
    evidence: rankedGroups
      .slice(0, 3)
      .flatMap((group) => group.members.map((member) => member.source + ": " + (member.evidence || member.value)))
      .join(" | "),
    confidence: 0,
    status: "ambiguous",
    source: "FIELD_FUSION",
    verification: "conflicting-evidence",
    fusion: {
      observations,
      agreementCount,
      conflict: true,
      winnerSource: null,
      winnerCandidate: bestMember.value,
      winnerConfidence: bestMember.confidence,
      fallbackUsed: false,
      fallbackOrder: SOURCE_PRIORITY,
      candidates: rankedGroups.slice(0, 3).map((group) => ({
        value: group.members[0]?.value ?? null,
        support: Number(group.voteSupport.toFixed(4)),
        sources: group.members.map((member) => member.source),
      })),
    },
  };
}

export function fuseFieldSources(sources = [], categoryKeys = FIELD_KEYS) {
  const output = {};
  for (const key of categoryKeys) output[key] = fuseField(key, sources);
  return output;
}

export { SOURCE_WEIGHTS, SOURCE_PRIORITY, canonicalValue };
