import { GoogleGenAI } from "@google/genai";
import {
  buildSemanticPrompt,
  buildSemanticSchema,
  normalizeSemanticResult,
  parseJsonContent,
} from "./semanticPackageCommon.js";
import { interpretOcrFields } from "./ocrFieldInterpreter.js";
import { repairNumericFields } from "./numericFieldRepair.js";
import { interpretPackageWithGrok } from "./grokPackageInterpreter.js";

const OCR_PRIORITY_FIELDS = new Set([
  "mrp",
  "netQuantity",
  "unit",
  "dateOfManufacture",
  "dateOfPacking",
  "bestBefore",
  "expiryDate",
  "batchNumber",
  "consumerCarePhone",
  "consumerCareEmail",
  "fssaiLicenseNumber",
  "barcode",
]);

function hasValue(field) {
  return field?.status === "found" && String(field?.value ?? "").trim() !== "";
}

function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function comparable(value) {
  return normalizeText(value)
    .toLocaleLowerCase()
    .replace(/[₹$€£]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function numericComparable(key, value) {
  const text = normalizeText(value);
  if (["mrp", "netQuantity", "barcode"].includes(key)) return (text.match(/\d+(?:\.\d+)?/g) || []).join("|");
  return null;
}

function similarValue(key, left, right) {
  const a = comparable(left);
  const b = comparable(right);
  if (!a || !b) return false;
  if (a === b) return true;

  const na = numericComparable(key, left);
  const nb = numericComparable(key, right);
  if (na && nb) return na === nb;

  if (a.includes(b) || b.includes(a)) return true;
  const at = new Set(a.split(/\s+/).filter((token) => token.length > 1));
  const bt = new Set(b.split(/\s+/).filter((token) => token.length > 1));
  if (!at.size || !bt.size) return false;
  const overlap = [...at].filter((token) => bt.has(token)).length / Math.max(at.size, bt.size);
  return overlap >= 0.8;
}

function mergeDeterministicEvidence(geminiFields, detections, rawText) {
  const deterministic = repairNumericFields(interpretOcrFields({ detections, rawText })?.fields || {}, detections, rawText);
  const merged = {};

  for (const [key, geminiField] of Object.entries(geminiFields || {})) {
    const localField = deterministic[key];
    const aiFound = hasValue(geminiField);
    const localFound = hasValue(localField);

    if (!localFound) {
      merged[key] = geminiField;
      continue;
    }

    if (!aiFound) {
      merged[key] = {
        ...localField,
        displayValue: geminiField?.displayValue || localField?.value || "",
        verification: "deterministic-ocr-fallback",
        source: "GEMINI_SEMANTIC_PLUS_LOCAL_OCR",
      };
      continue;
    }

    const localHasGeometry = Boolean(localField?.evidence?.length && localField?.evidence?.some?.((item) => item?.boundingBox));
    const localConfidence = Number(localField?.confidence || 0);
    const aiConfidence = Number(geminiField?.confidence || 0);

    if (OCR_PRIORITY_FIELDS.has(key) && localHasGeometry && localConfidence >= aiConfidence) {
      merged[key] = {
        ...localField,
        displayValue: geminiField?.displayValue || localField?.value || "",
        verification: "deterministic-ocr-priority",
        source: "GEMINI_SEMANTIC_PLUS_LOCAL_OCR",
      };
      continue;
    }

    merged[key] = {
      ...geminiField,
      displayValue: geminiField?.displayValue || geminiField?.value || localField?.value || "",
      raw: geminiField?.raw || localField?.raw || null,
      evidence: geminiField?.evidence || localField?.raw || localField?.evidence?.[0]?.text || null,
      imageIndex: Number.isInteger(geminiField?.imageIndex) ? geminiField.imageIndex : localField?.imageIndex,
      evidenceIndex: Number.isInteger(geminiField?.evidenceIndex) ? geminiField.evidenceIndex : localField?.evidenceIndex,
      verification: "semantic-confirmed-by-local-ocr",
      source: "GEMINI_SEMANTIC_PLUS_LOCAL_OCR",
    };
  }

  return merged;
}

function voteField(key, observations) {
  const valid = observations.filter((item) => hasValue(item.field));
  if (!valid.length) {
    const ambiguous = observations.filter((item) => item.field?.status === "ambiguous").length;
    const unreadable = observations.filter((item) => item.field?.status === "unreadable").length;
    return {
      value: null,
      raw: null,
      evidence: null,
      confidence: 0,
      status: ambiguous >= 2 ? "ambiguous" : unreadable >= 2 ? "unreadable" : "absent",
      verification: "confidence-voting-no-value",
      source: "GEMINI_GROK_OCR_CONSENSUS",
      votes: observations.map((item) => ({ provider: item.provider, value: item.field?.value ?? null, status: item.field?.status ?? "absent", confidence: Number(item.field?.confidence || 0) })),
    };
  }

  const groups = [];
  for (const observation of valid) {
    let group = groups.find((candidate) => similarValue(key, candidate[0].field.value, observation.field.value));
    if (!group) groups.push([observation]);
    else group.push(observation);
  }

  const scored = groups.map((group) => {
    const modelWeight = group.reduce((sum, item) => sum + Number(item.field.confidence || 0) * item.weight, 0);
    const agreementBonus = group.length >= 2 ? 0.16 : 0;
    const geometryBonus = group.some((item) => item.provider === "rapidocr" && item.hasGeometry) ? 0.08 : 0;
    const score = modelWeight + agreementBonus + geometryBonus;
    return { group, score };
  }).sort((a, b) => b.score - a.score);

  const winner = scored[0];
  const runnerUp = scored[1];
  const enabledCount = observations.filter((item) => item.enabled).length;
  const best = [...winner.group].sort((a, b) => Number(b.field.confidence || 0) - Number(a.field.confidence || 0))[0];
  const gap = runnerUp ? winner.score - runnerUp.score : winner.score;
  const conflicting = groups.length > 1;
  const unresolvedConflict = conflicting && gap < 0.18;

  if (unresolvedConflict) {
    return {
      value: null,
      raw: winner.group.map((item) => item.field.raw || item.field.value).filter(Boolean).join(" | "),
      evidence: scored.map((entry) => entry.group.map((item) => `${item.provider}: ${item.field.evidence || item.field.value}`).join(" | ")).join(" || "),
      confidence: 0,
      status: "ambiguous",
      verification: "confidence-vote-conflict",
      source: "GEMINI_GROK_OCR_CONSENSUS",
      votes: observations.map((item) => ({ provider: item.provider, value: item.field?.value ?? null, status: item.field?.status ?? "absent", confidence: Number(item.field?.confidence || 0) })),
    };
  }

  const baseConfidence = Number(best.field.confidence || 0);
  const agreement = winner.group.length >= 2 ? 0.08 : 0;
  const evidence = winner.group.some((item) => item.provider === "rapidocr" && item.hasGeometry) ? 0.06 : 0;
  const disagreementPenalty = conflicting ? 0.08 : 0;
  const singleSourcePenalty = enabledCount === 1 ? 0.12 : 0;
  const finalConfidence = Math.max(0, Math.min(0.99, baseConfidence + agreement + evidence - disagreementPenalty - singleSourcePenalty));

  return {
    ...best.field,
    confidence: finalConfidence,
    raw: best.field.raw || best.field.value,
    evidence: best.field.evidence || best.field.raw || best.field.value,
    verification: winner.group.length >= 2 ? `confidence-vote-${winner.group.length}-source-agreement` : `confidence-vote-single-${best.provider}`,
    source: "GEMINI_GROK_OCR_CONSENSUS",
    votes: observations.map((item) => ({ provider: item.provider, value: item.field?.value ?? null, status: item.field?.status ?? "absent", confidence: Number(item.field?.confidence || 0), weight: item.weight })),
  };
}

function confidenceVote(geminiFields, grokFields, rapidFields) {
  const keys = new Set([
    ...Object.keys(geminiFields || {}),
    ...Object.keys(grokFields || {}),
    ...Object.keys(rapidFields || {}),
  ]);
  const fields = {};

  for (const key of keys) {
    const observations = [
      { provider: "gemini", field: geminiFields?.[key], weight: 1.0, enabled: true },
      { provider: "grok", field: grokFields?.[key], weight: 0.95, enabled: Boolean(grokFields) },
      { provider: "rapidocr", field: rapidFields?.[key], weight: 0.85, enabled: Boolean(rapidFields) },
    ];
    observations.forEach((item) => { item.hasGeometry = Boolean(item.field?.evidence?.some?.((e) => e?.boundingBox) || item.field?.boundingBox); });
    fields[key] = voteField(key, observations);
  }

  return fields;
}

export async function interpretPackageWithGemini({ images = [], detections = [], rawText = "", categoryOptions = [], signal } = {}) {
  const apiKey = process.env.GEMINI_API_KEY || process.env.OCR_AI_API_KEY || "";
  const model = process.env.GEMINI_SEMANTIC_MODEL || "gemini-3.7-flash";
  const useResponseSchema = String(process.env.GEMINI_USE_RESPONSE_SCHEMA || "false").toLowerCase() === "true";

  const grokStartedAt = Date.now();
  const grokPromise = interpretPackageWithGrok({ images, detections, rawText, categoryOptions, signal })
    .then((result) => {
      console.log(`[ocr:grok-semantic] DONE model=${result?.model || process.env.GROK_SEMANTIC_MODEL || "grok-4.6"} elapsed=${Date.now() - grokStartedAt}ms enabled=${Boolean(result?.enabled)}`);
      return result;
    })
    .catch((error) => {
      console.error(`[ocr:grok-semantic] FAILED reason=${error?.message || "Grok semantic interpretation failed."}`);
      return { enabled: false, provider: "grok", model: process.env.GROK_SEMANTIC_MODEL || "grok-4.6", reason: error?.message || "Grok semantic interpretation failed." };
    });

  if (!apiKey) {
    const grok = await grokPromise;
    if (grok?.enabled) {
      return {
        ...grok,
        provider: "gemini",
        model: `${model}+${grok.model || "grok"}`,
        verificationProviders: { gemini: { enabled: false, reason: "GEMINI_API_KEY is not configured." }, grok },
        verificationTiming: { geminiMs: 0, grokMs: Date.now() - grokStartedAt },
      };
    }
    console.warn(`[ocr:gemini-semantic] SKIPPED model=${model} reason=GEMINI_API_KEY is not configured.`);
    return { enabled: false, provider: "gemini", model, reason: "GEMINI_API_KEY is not configured." };
  }

  const ai = new GoogleGenAI({ apiKey });
  const prompt = buildSemanticPrompt({ detections, rawText, categoryOptions });
  const contents = [
    ...images.map(({ base64, mediaType }) => ({ inlineData: { mimeType: mediaType, data: base64 } })),
    { text: prompt },
  ];

  const request = async () => ai.models.generateContent({
    model,
    contents,
    config: {
      responseMimeType: "application/json",
      ...(useResponseSchema ? { responseSchema: buildSemanticSchema(categoryOptions) } : {}),
      thinkingConfig: { thinkingLevel: "low" },
      maxOutputTokens: 1400,
    },
  });

  try {
    if (signal?.aborted) throw new DOMException("The request was aborted.", "AbortError");

    console.log(`[ocr:gemini-semantic] START model=${model} responseSchema=${useResponseSchema}`);
    const startedAt = Date.now();
    const [geminiSettled, grok] = await Promise.all([
      request()
        .then((response) => ({ ok: true, response, elapsedMs: Date.now() - startedAt }))
        .catch((error) => ({ ok: false, error, elapsedMs: Date.now() - startedAt })),
      grokPromise,
    ]);

    const geminiElapsed = geminiSettled.elapsedMs;
    const grokElapsed = Date.now() - grokStartedAt;
    console.log(`[ocr:gemini-semantic] ${geminiSettled.ok ? "DONE" : "FAILED"} model=${model} elapsed=${geminiElapsed}ms`);

    const deterministic = repairNumericFields(interpretOcrFields({ detections, rawText })?.fields || {}, detections, rawText);
    const geminiFields = geminiSettled.ok
      ? mergeDeterministicEvidence(normalizeSemanticResult(parseJsonContent(geminiSettled.response.text || "", { recoverTruncated: true }), categoryOptions).fields, detections, rawText)
      : {};
    const grokFields = grok?.enabled ? grok.fields || {} : {};
    const votedFields = confidenceVote(geminiFields, grokFields, deterministic);
    const semanticCategory = grok?.suggestedCategory || (geminiSettled.ok ? normalizeSemanticResult(parseJsonContent(geminiSettled.response.text || "", { recoverTruncated: true }), categoryOptions).suggestedCategory : null);
    const enabledSources = [geminiSettled.ok ? "gemini" : null, grok?.enabled ? "grok" : null, Object.keys(deterministic).length ? "rapidocr" : null].filter(Boolean);

    return {
      enabled: geminiSettled.ok || Boolean(grok?.enabled),
      provider: "gemini",
      model,
      fields: votedFields,
      suggestedCategory: semanticCategory,
      timingMs: Math.max(geminiElapsed, grokElapsed),
      verificationProviders: {
        gemini: { enabled: geminiSettled.ok, model, timingMs: geminiElapsed, reason: geminiSettled.ok ? null : geminiSettled.error?.message || "Gemini failed." },
        grok: { enabled: Boolean(grok?.enabled), model: grok?.model || process.env.GROK_SEMANTIC_MODEL || "grok-4.6", timingMs: grokElapsed, reason: grok?.enabled ? null : grok?.reason || "Grok failed." },
        rapidocr: { enabled: Object.keys(deterministic).length > 0 },
      },
      verificationProvidersCount: enabledSources.length,
      verificationTiming: { geminiMs: geminiElapsed, grokMs: grokElapsed, semanticParallelMs: Math.max(geminiElapsed, grokElapsed) },
    };
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    await grokPromise;
    console.error(`[ocr:gemini-semantic] FAILED model=${model} status=${error?.status ?? "unknown"} reason=${error?.message || "Gemini semantic interpretation failed."}`, error);
    return { enabled: false, provider: "gemini", model, reason: error?.message || "Gemini semantic interpretation failed." };
  }
}
