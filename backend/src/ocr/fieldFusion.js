import { FIELD_KEYS, confidence, text } from "./semanticPackageCommon.js";

const SOURCE_WEIGHTS = {
  gemini_image: 0.92,
  gemini_ocr_normalization: 0.82,
  grok_image: 0.88,
  deterministic_regex: 0.62,
};

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
    return match ? match[0] : raw.toLowerCase().replace(/\b(?:mrp|maximum retail price|retail price|rs\.?|inr)\b/g, "").trim();
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
  return Number(SOURCE_WEIGHTS[source?.sourceKind] ?? 0.50);
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

function fuseField(key, sources) {
  const observations = [];
  for (const source of sources) {
    if (!source?.enabled || !source?.fields?.[key]) continue;
    observations.push(summarizeObservation(key, source, source.fields[key]));
  }

  const found = observations.filter((item) => item.normalizedValue && item.status === "found");
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
      fusion: { observations, agreementCount: 0, conflict: false, winnerSource: null },
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
      weightedSupport: members.reduce((sum, member) => sum + member.weightedSupport, 0),
      maxConfidence: Math.max(...members.map((member) => member.confidence)),
    }))
    .sort((a, b) => b.weightedSupport - a.weightedSupport || b.members.length - a.members.length || b.maxConfidence - a.maxConfidence);

  const winner = rankedGroups[0];
  const runnerUp = rankedGroups[1] || null;
  const agreementCount = winner.members.length;
  const conflict = rankedGroups.length > 1;

  const bestMember = [...winner.members].sort(
    (a, b) => b.confidence - a.confidence || b.weightedSupport - a.weightedSupport,
  )[0];

  const margin = runnerUp ? winner.weightedSupport - runnerUp.weightedSupport : Infinity;
  const strongLoneWinner = agreementCount === 1 && (!runnerUp || (margin >= 0.20 && bestMember.confidence >= 0.75));
  const conflictingButSupported = agreementCount >= 2 && (!runnerUp || margin >= 0.10);

  if (conflict && !strongLoneWinner && !conflictingButSupported) {
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
        margin: Number.isFinite(margin) ? Number(margin.toFixed(4)) : null,
        winnerSource: null,
        candidates: rankedGroups.slice(0, 3).map((group) => ({
          value: group.members[0]?.value ?? null,
          support: Number(group.weightedSupport.toFixed(4)),
          sources: group.members.map((member) => member.source),
        })),
      },
    };
  }

  const agreementBoost = agreementCount >= 3 ? 0.14 : agreementCount === 2 ? 0.08 : 0;
  const conflictAdjustment = conflict && agreementCount === 1 ? 0.05 : 0;
  const fusedConfidence = Math.min(
    0.99,
    Math.max(0, bestMember.confidence + agreementBoost - conflictAdjustment),
  );

  const winningSource = sources.find(
    (source) => source?.enabled && source?.fields?.[key] && canonicalValue(key, source.fields[key].value) === winner.normalizedValue,
  );
  const winningField = winningSource?.fields?.[key] || null;

  return {
    ...(winningField || {}),
    value: bestMember.value,
    displayValue: winningField?.displayValue || bestMember.value,
    raw: winningField?.raw ?? bestMember.value,
    evidence: winningField?.evidence ?? bestMember.evidence ?? bestMember.value,
    confidence: Number(fusedConfidence.toFixed(3)),
    status: "found",
    source: "FIELD_FUSION",
    verification:
      agreementCount >= 2
        ? "agreement-" + agreementCount + "-sources"
        : conflict
          ? "strongest-supported-candidate"
          : "single-supported-source",
    fusion: {
      observations,
      agreementCount,
      conflict,
      margin: Number.isFinite(margin) ? Number(margin.toFixed(4)) : null,
      winnerSource: bestMember.source,
      candidateSources: winner.members.map((member) => member.source),
    },
  };
}

export function fuseFieldSources(sources = [], categoryKeys = FIELD_KEYS) {
  const output = {};
  for (const key of categoryKeys) output[key] = fuseField(key, sources);
  return output;
}

export { SOURCE_WEIGHTS, canonicalValue };
