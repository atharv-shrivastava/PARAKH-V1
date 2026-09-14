import { FIELD_KEYS, confidence, text } from "./semanticPackageCommon.js";

const PROVIDER_WEIGHTS = {
  gemini: 0.45,
  grok: 0.45,
};
const DEFAULT_PROVIDER_WEIGHT = 0.10;

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

function providerWeight(provider) {
  return PROVIDER_WEIGHTS[String(provider || "").toLowerCase()] ?? DEFAULT_PROVIDER_WEIGHT;
}

function splitQuantity(value) {
  const match = text(value).match(/^\s*([-+]?\d+(?:\.\d+)?)\s*([a-zA-Zµμ]+|pcs?|pieces?|units?|nos)\.?\s*$/i);
  return match ? { quantity: match[1], unit: match[2] } : null;
}

function normalizeQuantityUnit(fields) {
  const next = Object.fromEntries(Object.entries(fields || {}).map(([key, field]) => [key, field && typeof field === "object" ? { ...field } : field]));
  const quantity = next.netQuantity;
  const unit = next.unit;
  if (!quantity) return next;

  const split = splitQuantity(quantity.value || quantity.raw || quantity.evidence);
  if (!split) return next;

  next.netQuantity = {
    ...quantity,
    value: split.quantity,
    displayValue: split.quantity,
    raw: quantity.raw || `${split.quantity} ${split.unit}`,
    evidence: quantity.evidence || quantity.raw || `${split.quantity} ${split.unit}`,
  };

  if (!unit || !isFound(unit) || !text(unit.value)) {
    next.unit = {
      ...(unit || {}),
      value: split.unit,
      displayValue: split.unit,
      raw: unit?.raw || `${split.quantity} ${split.unit}`,
      evidence: unit?.evidence || quantity.evidence || quantity.raw || `${split.quantity} ${split.unit}`,
      confidence: confidence(unit?.confidence ?? quantity.confidence),
      status: quantity.status || "found",
      imageIndex: Number.isInteger(unit?.imageIndex) ? unit.imageIndex : (Number.isInteger(quantity.imageIndex) ? quantity.imageIndex : -1),
      evidenceIndex: Number.isInteger(unit?.evidenceIndex) ? unit.evidenceIndex : (Number.isInteger(quantity.evidenceIndex) ? quantity.evidenceIndex : -1),
    };
  }
  return next;
}

function looksLikeProductCode(value) {
  const source = text(value).toUpperCase().replace(/\s+/g, "");
  if (!source) return false;
  if (/^#\d{2,8}$/.test(source)) return true;
  if (/^[A-Z]{2,}\d{2,}[A-Z0-9]*$/.test(source) && source.length <= 20) return true;
  return false;
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
  return field;
}

function voteField(key, providers) {
  const observations = providers
    .filter((provider) => provider?.enabled && provider?.fields?.[key])
    .map((provider) => {
      const fields = normalizeQuantityUnit(provider.fields);
      const field = sanitizeField(key, fields[key]);
      return {
        provider: provider.provider,
        weight: providerWeight(provider.provider),
        field,
        normalized: comparable(field?.value),
      };
    });

  const found = observations.filter((item) => isFound(item.field));
  const votes = observations.map((item) => ({
    provider: item.provider,
    weight: item.weight,
    status: item.field.status,
    value: item.field.value ?? null,
    confidence: confidence(item.field.confidence),
  }));

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

  const scoredGroups = [...groups.values()].map((group) => {
    const weightedVote = group.reduce((sum, item) => sum + item.weight * Math.max(0.5, confidence(item.field.confidence)), 0);
    const rawWeight = group.reduce((sum, item) => sum + item.weight, 0);
    const best = [...group].sort((a, b) => confidence(b.field.confidence) - confidence(a.field.confidence))[0];
    return { group, weightedVote, rawWeight, best };
  }).sort((a, b) => b.weightedVote - a.weightedVote || b.rawWeight - a.rawWeight || confidence(b.best?.field?.confidence) - confidence(a.best?.field?.confidence));

  const winning = scoredGroups[0];
  if (!winning) {
    return { value: null, raw: null, evidence: null, confidence: 0, status: "ambiguous", verification: "conflict", source: "SEMANTIC_CONSENSUS", votes };
  }

  const totalSemanticWeight = observations.reduce((sum, item) => sum + item.weight, 0) || 1;
  const normalizedWinningVote = winning.weightedVote / totalSemanticWeight;
  const secondVote = scoredGroups[1]?.weightedVote || 0;
  const margin = winning.weightedVote - secondVote;

  if (winning.group.length >= 2 || normalizedWinningVote >= 0.55 || margin >= 0.20) {
    const best = winning.best;
    const winningProviders = winning.group.map((item) => item.provider).join("+");
    return {
      ...best.field,
      raw: best.field.raw ?? best.field.value,
      evidence: best.field.evidence ?? best.field.raw ?? best.field.value,
      verification: `weighted-${winningProviders}`,
      confidence: Math.max(confidence(best.field.confidence), Math.min(0.98, normalizedWinningVote)),
      source: "SEMANTIC_CONSENSUS",
      votes,
    };
  }

  return {
    value: null,
    raw: found.map((item) => item.field.raw || item.field.value).filter(Boolean).join(" | ") || null,
    evidence: found.map((item) => `${item.provider}: ${item.field.evidence || item.field.value}`).join(" | "),
    confidence: 0,
    status: "ambiguous",
    verification: "weighted-conflict",
    source: "SEMANTIC_CONSENSUS",
    votes,
  };
}

function voteCategory(providers, categoryOptions) {
  const observations = providers
    .filter((provider) => provider?.enabled && provider?.suggestedCategory?.categoryId)
    .map((provider) => ({ provider: provider.provider, category: provider.suggestedCategory, id: String(provider.suggestedCategory.categoryId), weight: providerWeight(provider.provider) }));
  if (!observations.length) return null;

  const groups = new Map();
  for (const observation of observations) {
    if (!groups.has(observation.id)) groups.set(observation.id, []);
    groups.get(observation.id).push(observation);
  }

  const winning = [...groups.values()].sort((a, b) => {
    const aScore = a.reduce((sum, item) => sum + item.weight * Math.max(0.5, confidence(item.category.confidence)), 0);
    const bScore = b.reduce((sum, item) => sum + item.weight * Math.max(0.5, confidence(item.category.confidence)), 0);
    return bScore - aScore || b.length - a.length || confidence(b[0]?.category?.confidence) - confidence(a[0]?.category?.confidence);
  })[0];
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

  const ids = new Set(observations.map((item) => item.id));
  if (winning.length < 2 && ids.size > 1) {
    return { categoryId: null, categoryName: null, categoryPath: null, confidence: 0, reason: "Semantic providers disagreed on category." };
  }

  return {
    categoryId: allowed ? String(allowed.id) : winning[0].id,
    categoryName: allowed ? text(allowed.name) : winning[0].category.categoryName || null,
    categoryPath: allowed ? text(allowed.path) : winning[0].category.categoryPath || null,
    confidence: Math.min(0.98, confidence(best.category.confidence)),
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
    providerWeights: PROVIDER_WEIGHTS,
    providers: providers.map((provider) => ({ provider: provider?.provider || "unknown", model: provider?.model || null, enabled: Boolean(provider?.enabled), reason: provider?.enabled ? null : provider?.reason || "Provider unavailable." })),
    fields: normalizeQuantityUnit(fields),
    suggestedCategory: voteCategory(providers, categoryOptions),
  };
}
