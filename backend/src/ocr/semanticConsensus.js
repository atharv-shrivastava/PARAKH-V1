import { FIELD_KEYS, confidence, text } from "./semanticPackageCommon.js";

function comparable(value) {
  return text(value).toLocaleLowerCase().replace(/[₹$€£]/g, "").replace(/\s+/g, " ").trim();
}
function isFound(field) { return field?.status === "found" && text(field?.value) !== ""; }
function looksLikeProductCode(value) {
  const source = text(value).toUpperCase().replace(/\s+/g, ""); if (!source) return false;
  if (/^#\d{2,8}$/.test(source)) return true; if (/^[A-Z]{2,}\d{2,}[A-Z0-9]*$/.test(source) && source.length <= 20) return true; return false;
}
const EXPIRY_EVIDENCE_RE = /\b(?:expiry|expires?|exp\.?|use\s*by|best\s*before|use\s*within|shelf\s*life)\b/i;
const MANUFACTURE_EVIDENCE_RE = /\b(?:manufactur(?:e|ed|ing)?|mfg\.?|mfd\.?|date\s*of\s*(?:manufacture|mfg)|निर्माण|उत्पादन)\b/i;
const PACKING_EVIDENCE_RE = /\b(?:pack(?:ed|ing)?|pkd\.?|date\s*of\s*packing)\b/i;
function evidenceText(field) { return [field?.value, field?.raw, field?.evidence].map(text).filter(Boolean).join(" | "); }
function sanitizeDateField(key, field) {
  if (!field || typeof field !== "object" || !isFound(field)) return field; const evidence = evidenceText(field);
  if (key === "dateOfManufacture" && EXPIRY_EVIDENCE_RE.test(evidence) && !MANUFACTURE_EVIDENCE_RE.test(evidence)) return { ...field, value: null, raw: field.raw ?? evidence, evidence: field.evidence ?? evidence, confidence: 0, status: "ambiguous", verification: "rejected-expiry-as-manufacture", source: "SEMANTIC_CONSENSUS" };
  if (key === "dateOfPacking" && EXPIRY_EVIDENCE_RE.test(evidence) && !PACKING_EVIDENCE_RE.test(evidence)) return { ...field, value: null, raw: field.raw ?? evidence, evidence: field.evidence ?? evidence, confidence: 0, status: "ambiguous", verification: "rejected-expiry-as-packing-date", source: "SEMANTIC_CONSENSUS" };
  return field;
}
function sanitizeField(key, field) {
  if (!field || typeof field !== "object") return field;
  if (key === "productName" && isFound(field) && looksLikeProductCode(field.value)) return { ...field, value: null, raw: field.raw ?? text(field.value), evidence: field.evidence ?? text(field.value), confidence: 0, status: "absent", verification: "rejected-product-code", source: "SEMANTIC_CONSENSUS" };
  return sanitizeDateField(key, field);
}

const PROVIDER_RELIABILITY = { gemini: 1.0, grok: 1.0 };
const DISAGREEMENT_AUTO_ACCEPT_GAP = 0.18;

function voteField(key, providers) {
  const enabledCount = providers.filter((item) => item?.enabled).length;
  const observations = providers.filter((provider) => provider?.enabled && provider?.fields?.[key]).map((provider) => {
    const field = sanitizeField(key, provider.fields[key]); const normalized = comparable(field?.value); const weight = PROVIDER_RELIABILITY[provider.provider] ?? 0.85; const score = isFound(field) ? confidence(field.confidence) * weight : 0;
    return { provider: provider.provider, field, normalized, weight, score };
  });
  const found = observations.filter((item) => isFound(item.field));
  const votes = observations.map((item) => ({ provider: item.provider, status: item.field.status, value: item.field.value ?? null, confidence: confidence(item.field.confidence), score: Number(item.score.toFixed(4)) }));

  if (!found.length) {
    const statuses = observations.map((item) => item.field.status); const ambiguous = statuses.filter((status) => status === "ambiguous").length; const unreadable = statuses.filter((status) => status === "unreadable").length;
    return { value: null, raw: null, evidence: null, confidence: 0, status: ambiguous >= 2 ? "ambiguous" : unreadable >= 2 ? "unreadable" : "absent", verification: "consensus", source: "SEMANTIC_CONSENSUS", votes };
  }

  const groups = new Map();
  for (const item of found) { if (!item.normalized) continue; if (!groups.has(item.normalized)) groups.set(item.normalized, []); groups.get(item.normalized).push(item); }
  const rankedGroups = [...groups.values()].map((group) => ({ group, score: group.reduce((sum, item) => sum + item.score, 0), count: group.length, bestConfidence: Math.max(...group.map((item) => confidence(item.field.confidence))) })).sort((a, b) => b.score - a.score || b.count - a.count || b.bestConfidence - a.bestConfidence);
  const winner = rankedGroups[0];
  if (!winner) return { value: null, raw: null, evidence: null, confidence: 0, status: "ambiguous", verification: "conflict", source: "SEMANTIC_CONSENSUS", votes };

  const winnerField = [...winner.group].sort((a, b) => confidence(b.field.confidence) - confidence(a.field.confidence))[0].field;
  const runnerScore = rankedGroups[1]?.score ?? 0;
  const gap = winner.score - runnerScore;
  const agreement = winner.count >= 2;

  if (agreement) {
    const avgConfidence = winner.group.reduce((sum, item) => sum + confidence(item.field.confidence), 0) / winner.group.length;
    return { ...winnerField, raw: winnerField.raw ?? winnerField.value, evidence: winnerField.evidence ?? winnerField.raw ?? winnerField.value, confidence: Math.min(0.99, Math.max(confidence(winnerField.confidence), avgConfidence + 0.08)), verification: `confidence-vote-agreement-${winner.count}/${enabledCount}`, source: "SEMANTIC_CONSENSUS", votes };
  }

  if (found.length === 1) {
    return { ...winnerField, verification: "single-model", confidence: Math.min(confidence(winnerField.confidence), 0.74), source: "SEMANTIC_CONSENSUS", votes };
  }

  if (gap >= DISAGREEMENT_AUTO_ACCEPT_GAP && confidence(winnerField.confidence) >= 0.75) {
    return { ...winnerField, raw: winnerField.raw ?? winnerField.value, evidence: winnerField.evidence ?? winnerField.raw ?? winnerField.value, confidence: Math.min(0.86, confidence(winnerField.confidence) * 0.92), verification: `confidence-vote-winner-gap-${gap.toFixed(2)}`, source: "SEMANTIC_CONSENSUS", votes };
  }

  return { value: null, raw: found.map((item) => item.field.raw || item.field.value).filter(Boolean).join(" | ") || null, evidence: found.map((item) => `${item.provider}: ${item.field.evidence || item.field.value}`).join(" | "), confidence: Math.max(0, Math.min(0.49, winner.score)), status: "ambiguous", verification: `confidence-vote-conflict-gap-${gap.toFixed(2)}`, source: "SEMANTIC_CONSENSUS", votes };
}

function voteCategory(providers, categoryOptions) {
  const observations = providers.filter((provider) => provider?.enabled && provider?.suggestedCategory?.categoryId).map((provider) => ({ provider: provider.provider, category: provider.suggestedCategory, id: String(provider.suggestedCategory.categoryId), score: confidence(provider.suggestedCategory.confidence) * (PROVIDER_RELIABILITY[provider.provider] ?? 0.85) }));
  if (!observations.length) return null;
  const groups = new Map(); for (const observation of observations) { if (!groups.has(observation.id)) groups.set(observation.id, []); groups.get(observation.id).push(observation); }
  const ranked = [...groups.values()].map((group) => ({ group, score: group.reduce((sum, item) => sum + item.score, 0) })).sort((a, b) => b.score - a.score || b.group.length - a.group.length); const winning = ranked[0]; if (!winning) return null;
  const allowed = categoryOptions.find((item) => String(item.id) === winning.group[0].id); const best = [...winning.group].sort((a, b) => confidence(b.category.confidence) - confidence(a.category.confidence))[0]; const enabledCount = providers.filter((item) => item?.enabled).length;
  if (winning.group.length === 1 && enabledCount === 1) return { categoryId: allowed ? String(allowed.id) : winning.group[0].id, categoryName: allowed ? text(allowed.name) : winning.group[0].category.categoryName || null, categoryPath: allowed ? text(allowed.path) : winning.group[0].category.categoryPath || null, confidence: Math.min(confidence(best.category.confidence), 0.79), reason: "Suggested by the available semantic AI provider; verify before registration." };
  const runnerScore = ranked[1]?.score ?? 0; const gap = winning.score - runnerScore;
  if (winning.group.length < 2 && gap < DISAGREEMENT_AUTO_ACCEPT_GAP) return { categoryId: null, categoryName: null, categoryPath: null, confidence: 0, reason: "Semantic providers disagreed on category." };
  return { categoryId: allowed ? String(allowed.id) : winning.group[0].id, categoryName: allowed ? text(allowed.name) : winning.group[0].category.categoryName || null, categoryPath: allowed ? text(allowed.path) : winning.group[0].category.categoryPath || null, confidence: winning.group.length >= 2 ? confidence(best.category.confidence) : Math.min(0.84, confidence(best.category.confidence) * 0.92), reason: winning.group.length >= 2 ? `${winning.group.length} semantic providers selected the same category.` : `Confidence-weighted semantic vote selected the leading category with a ${gap.toFixed(2)} score gap.` };
}

export function reconcileSemanticResults(providers = [], categoryOptions = []) {
  const enabledProviders = providers.filter((provider) => provider?.enabled); const fields = {}; for (const key of FIELD_KEYS) fields[key] = voteField(key, providers);
  return { enabled: enabledProviders.length > 0, providerCount: enabledProviders.length, providers: providers.map((provider) => ({ provider: provider?.provider || "unknown", model: provider?.model || null, enabled: Boolean(provider?.enabled), reason: provider?.enabled ? null : provider?.reason || "Provider unavailable.", timingMs: Number(provider?.timingMs || 0) })), fields, suggestedCategory: voteCategory(providers, categoryOptions) };
}
