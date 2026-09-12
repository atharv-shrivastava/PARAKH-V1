import { FIELD_KEYS, confidence, text } from "./semanticPackageCommon.js";

function comparable(value) {
  return text(value)
    .toLocaleLowerCase()
    .replace(/[₹$€£]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isFound(field) {
  return field?.status === "found" && text(field?.value) !== "";
}

function looksLikeProductCode(value) {
  const source = text(value).toUpperCase().replace(/\s+/g, "");
  if (!source) return false;
  if (/^#\d{2,8}$/.test(source)) return true;
  if (/^[A-Z]{2,}\d{2,}[A-Z0-9]*$/.test(source) && source.length <= 20) return true;
  return false;
}

const EXPIRY_EVIDENCE_RE = /\b(?:expiry|expires?|exp\.?|use\s*by|best\s*before|use\s*within|shelf\s*life)\b/i;
const MANUFACTURE_EVIDENCE_RE = /\b(?:manufactur(?:e|ed|ing)?|mfg\.?|mfd\.?|date\s*of\s*(?:manufacture|mfg)|निर्माण|उत्पादन)\b/i;
const PACKING_EVIDENCE_RE = /\b(?:pack(?:ed|ing)?|pkd\.?|date\s*of\s*packing)\b/i;

function evidenceText(field) {
  return [field?.value, field?.raw, field?.evidence].map(text).filter(Boolean).join(" | ");
}

function sanitizeDateField(key, field) {
  if (!field || typeof field !== "object" || !isFound(field)) return field;
  const evidence = evidenceText(field);

  if (key === "dateOfManufacture" && EXPIRY_EVIDENCE_RE.test(evidence) && !MANUFACTURE_EVIDENCE_RE.test(evidence)) {
    return {
      ...field,
      value: null,
      raw: field.raw ?? evidence,
      evidence: field.evidence ?? evidence,
      confidence: 0,
      status: "ambiguous",
      verification: "rejected-expiry-as-manufacture",
      source: "SEMANTIC_CONSENSUS",
    };
  }

  if (key === "dateOfPacking" && EXPIRY_EVIDENCE_RE.test(evidence) && !PACKING_EVIDENCE_RE.test(evidence)) {
    return {
      ...field,
      value: null,
      raw: field.raw ?? evidence,
      evidence: field.evidence ?? evidence,
      confidence: 0,
      status: "ambiguous",
      verification: "rejected-expiry-as-packing-date",
      source: "SEMANTIC_CONSENSUS",
    };
  }

  return field;
}

function sanitizeField(key, field) {
  if (!field || typeof field !== "object") return field;
  if (key === "productName" && isFound(field) && looksLikeProductCode(field.value)) {
    return {
      ...field,
      value: null,
      raw: field.raw ?? text(field.value),
      evidence: field.evidence ?? text(field.value),
      confidence: 0,
      status: "absent",
      verification: "rejected-product-code",
      source: "SEMANTIC_CONSENSUS",
    };
  }
  return sanitizeDateField(key, field);
}

function voteField(key, providers) {
  const observations = providers
    .filter((provider) => provider?.enabled && provider?.fields?.[key])
    .map((provider) => {
      const field = sanitizeField(key, provider.fields[key]);
      return {
        provider: provider.provider,
        field,
        normalized: comparable(field?.value),
      };
    });

  const found = observations.filter((item) => isFound(item.field));
  const votes = observations.map((item) => ({ provider: item.provider, status: item.field.status, value: item.field.value ?? null }));

  if (!found.length) {
    const statuses = observations.map((item) => item.field.status);
    const ambiguous = statuses.filter((status) => status === "ambiguous").length;
    const unreadable = statuses.filter((status) => status === "unreadable").length;
    return { value: null, raw: null, evidence: null, confidence: 0, status: ambiguous >= 2 ? "ambiguous" : unreadable >= 2 ? "unreadable" : "absent", verification: "consensus", source: "SEMANTIC_CONSENSUS", votes };
  }

  const groups = new Map();
  for (const item of found) {
    if (!item.normalized) continue;
    if (!groups.has(item.normalized)) groups.set(item.normalized, []);
    groups.get(item.normalized).push(item);
  }

  let winningGroup = null;
  for (const group of groups.values()) if (!winningGroup || group.length > winningGroup.length) winningGroup = group;

  if (winningGroup?.length >= 2) {
    const best = [...winningGroup].sort((a, b) => confidence(b.field.confidence) - confidence(a.field.confidence))[0];
    return { ...best.field, raw: best.field.raw ?? best.field.value, evidence: best.field.evidence ?? best.field.raw ?? best.field.value, verification: `majority-${winningGroup.length}/${providers.filter((item) => item?.enabled).length}`, source: "SEMANTIC_CONSENSUS", votes };
  }

  if (found.length === 1) {
    const only = found[0];
    return { ...only.field, verification: "single-model", confidence: Math.min(confidence(only.field.confidence), 0.74), source: "SEMANTIC_CONSENSUS", votes };
  }

  return { value: null, raw: found.map((item) => item.field.raw || item.field.value).filter(Boolean).join(" | ") || null, evidence: found.map((item) => `${item.provider}: ${item.field.evidence || item.field.value}`).join(" | "), confidence: 0, status: "ambiguous", verification: "conflict", source: "SEMANTIC_CONSENSUS", votes };
}

function voteCategory(providers, categoryOptions) {
  const observations = providers
    .filter((provider) => provider?.enabled && provider?.suggestedCategory?.categoryId)
    .map((provider) => ({ provider: provider.provider, category: provider.suggestedCategory, id: String(provider.suggestedCategory.categoryId) }));
  if (!observations.length) return null;

  const groups = new Map();
  for (const observation of observations) {
    if (!groups.has(observation.id)) groups.set(observation.id, []);
    groups.get(observation.id).push(observation);
  }

  const winning = [...groups.values()].sort((a, b) => b.length - a.length || confidence(b[0]?.category?.confidence) - confidence(a[0]?.category?.confidence))[0];
  if (!winning) return null;

  const allowed = categoryOptions.find((item) => String(item.id) === winning[0].id);
  const best = [...winning].sort((a, b) => confidence(b.category.confidence) - confidence(a.category.confidence))[0];
  const enabledCount = providers.filter((item) => item?.enabled).length;

  if (winning.length === 1 && enabledCount === 1) {
    return {
      categoryId: allowed ? String(allowed.id) : winning[0].id,
      categoryName: allowed ? text(allowed.name) : winning[0].category.categoryName || null,
      categoryPath: allowed ? text(allowed.path) : winning[0].category.categoryPath || null,
      confidence: Math.min(confidence(best.category.confidence), 0.79),
      reason: "Suggested by the available semantic AI provider; verify before registration.",
    };
  }

  if (winning.length < 2) {
    return { categoryId: null, categoryName: null, categoryPath: null, confidence: 0, reason: "Semantic providers disagreed on category." };
  }

  return {
    categoryId: allowed ? String(allowed.id) : winning[0].id,
    categoryName: allowed ? text(allowed.name) : winning[0].category.categoryName || null,
    categoryPath: allowed ? text(allowed.path) : winning[0].category.categoryPath || null,
    confidence: confidence(best.category.confidence),
    reason: `${winning.length} semantic providers selected the same category.`,
  };
}

export function reconcileSemanticResults(providers = [], categoryOptions = []) {
  const enabledProviders = providers.filter((provider) => provider?.enabled);
  const fields = {};
  for (const key of FIELD_KEYS) fields[key] = voteField(key, providers);
  return {
    enabled: enabledProviders.length > 0,
    providerCount: enabledProviders.length,
    providers: providers.map((provider) => ({ provider: provider?.provider || "unknown", model: provider?.model || null, enabled: Boolean(provider?.enabled), reason: provider?.enabled ? null : provider?.reason || "Provider unavailable." })),
    fields,
    suggestedCategory: voteCategory(providers, categoryOptions),
  };
}
