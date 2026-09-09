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

function verificationStateForMissing(observations) {
  if (!observations.length) return "MISSING";
  const statuses = observations.map((item) => String(item.field?.status || "").toLowerCase());
  if (statuses.some((status) => status === "ambiguous" || status === "unreadable")) return "NEED_VERIFICATION";
  return statuses.every((status) => status === "absent") ? "MISSING" : "NEED_VERIFICATION";
}

// Manufacturing/batch/inkjet codes are frequently short alphanumeric strings.
// Do not let them become product names simply because a semantic model selected them.
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

function calculateAgreementConfidence(winningGroup, enabledCount) {
  if (!winningGroup?.length || !enabledCount) return 0;
  const agreement = winningGroup.length / enabledCount;
  const modelConfidence = winningGroup.reduce((sum, item) => sum + confidence(item.field?.confidence), 0) / winningGroup.length;
  // Agreement is intentionally the dominant signal. The remaining weight is
  // each participating model's own confidence, so this remains evidence-based
  // rather than presenting a raw model confidence as system confidence.
  return Math.max(0, Math.min(1, agreement * 0.7 + modelConfidence * 0.3));
}

function voteField(key, providers) {
  const enabledProviders = providers.filter((provider) => provider?.enabled);
  const observations = enabledProviders
    .filter((provider) => provider?.fields?.[key])
    .map((provider) => {
      const field = sanitizeField(key, provider.fields[key]);
      return {
        provider: provider.provider,
        model: provider.model || null,
        field,
        normalized: comparable(field?.value),
      };
    });

  const found = observations.filter((item) => isFound(item.field));
  const votes = observations.map((item) => ({
    provider: item.provider,
    model: item.model,
    status: item.field?.status || "absent",
    value: item.field?.value ?? null,
    confidence: Math.round(confidence(item.field?.confidence) * 100),
  }));

  if (!found.length) {
    const verificationStatus = verificationStateForMissing(observations);
    return {
      value: null,
      raw: null,
      evidence: null,
      confidence: 0,
      verificationConfidence: 0,
      status: verificationStatus === "MISSING" ? "absent" : "ambiguous",
      verificationStatus,
      verification: verificationStatus,
      source: "SEMANTIC_CONSENSUS",
      votes,
    };
  }

  const groups = new Map();
  for (const item of found) {
    if (!item.normalized) continue;
    if (!groups.has(item.normalized)) groups.set(item.normalized, []);
    groups.get(item.normalized).push(item);
  }

  let winningGroup = null;
  for (const group of groups.values()) {
    if (!winningGroup || group.length > winningGroup.length) winningGroup = group;
  }

  if (winningGroup?.length >= 2) {
    const calculatedConfidence = calculateAgreementConfidence(winningGroup, enabledProviders.length);
    const verificationStatus = calculatedConfidence >= 0.85 && winningGroup.length === enabledProviders.length
      ? "VERIFIED"
      : "NEED_VERIFICATION";
    const best = [...winningGroup].sort((a, b) => confidence(b.field?.confidence) - confidence(a.field?.confidence))[0];
    return {
      ...best.field,
      raw: best.field.raw ?? best.field.value,
      evidence: best.field.evidence ?? best.field.raw ?? best.field.value,
      confidence: calculatedConfidence,
      verificationConfidence: Math.round(calculatedConfidence * 100),
      status: best.field.status || "found",
      verificationStatus,
      verification: `agreement-${winningGroup.length}/${enabledProviders.length}`,
      source: "SEMANTIC_CONSENSUS",
      votes,
    };
  }

  if (found.length === 1) {
    const only = found[0];
    const calculatedConfidence = Math.min(0.74, confidence(only.field?.confidence) * 0.7 + (1 / Math.max(1, enabledProviders.length)) * 0.3);
    return {
      ...only.field,
      verificationConfidence: Math.round(calculatedConfidence * 100),
      confidence: calculatedConfidence,
      verificationStatus: "NEED_VERIFICATION",
      verification: "single-model",
      source: "SEMANTIC_CONSENSUS",
      votes,
    };
  }

  const fallbackConfidence = Math.round((winningGroup?.length || 1) / Math.max(1, enabledProviders.length) * 60);
  return {
    value: null,
    raw: found.map((item) => item.field.raw || item.field.value).filter(Boolean).join(" | ") || null,
    evidence: found.map((item) => `${item.provider}: ${item.field.evidence || item.field.value}`).join(" | "),
    confidence: fallbackConfidence / 100,
    verificationConfidence: fallbackConfidence,
    status: "ambiguous",
    verificationStatus: "NEED_VERIFICATION",
    verification: "conflict",
    source: "SEMANTIC_CONSENSUS",
    votes,
  };
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
    providers: providers.map((provider) => ({
      provider: provider?.provider || "unknown",
      model: provider?.model || null,
      enabled: Boolean(provider?.enabled),
      reason: provider?.enabled ? null : provider?.reason || "Provider unavailable.",
    })),
    fields,
    suggestedCategory: voteCategory(providers, categoryOptions),
  };
}
