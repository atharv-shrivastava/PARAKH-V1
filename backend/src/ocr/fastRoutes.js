import "dotenv/config";
import express from "express";
import multer from "multer";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { authenticate } from "../middleware/auth.js";
import { getOcrConfig } from "./config.js";
import { repairNumericFields } from "./numericFieldRepair.js";
import { interpretPackageWithGemini } from "./geminiPackageInterpreter.js";
import { interpretPackageWithGrok } from "./grokPackageInterpreter.js";
import { reconcileSemanticResults } from "./semanticConsensus.js";
import { applyEvidenceConfidence } from "./evidenceConfidence.js";
import { interpretOcrFields } from "./ocrFieldInterpreter.js";
import { normalizeLegalMetrologyFields } from "./legalMetrologyRegex.js";

const router = express.Router();
const config = getOcrConfig();
const allowedTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, config.tempDir),
  filename: (_req, file, cb) => cb(null, `parakh-fast-ocr-${crypto.randomUUID()}${path.extname(file.originalname)}`),
});
const upload = multer({
  storage,
  fileFilter: (_req, file, cb) => allowedTypes.has(file.mimetype)
    ? cb(null, true)
    : cb(Object.assign(new Error("Only JPEG, PNG and WebP images are supported."), { code: "OCR_UNSUPPORTED_FORMAT", statusCode: 415 })),
  limits: { files: config.maxImages + 1, fileSize: config.maxImageSizeBytes },
});

function ext(mediaType) { return mediaType === "image/png" ? "png" : mediaType === "image/webp" ? "webp" : "jpg"; }
function text(value) { return String(value ?? "").replace(/\s+/g, " ").trim(); }
function normalizeComparable(value) { return text(value).normalize("NFKC").toLowerCase().replace(/[₹$€£]/g, "").replace(/[^\p{L}\p{N}@.+-]+/gu, " ").replace(/\s+/g, " ").trim(); }
function numberTokens(value) { return (text(value).replace(/,/g, "").match(/\d+(?:\.\d+)?/g) || []); }
function looksLikeDate(value) { return /^(?:\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}|\d{1,2}[\/-]\d{2,4}|(?:19|20)\d{2}|\d{2}[\/-]\d{2})$/.test(text(value)); }

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;
const MOBILE_RE = /(?:\+?91[\s-]?)?[6-9]\d{9}\b/;
const TOLL_FREE_RE = /\b1\d{2,3}[\s-]?\d{6,8}\b/;

function normalizeEvidence(data) {
  const raw = Array.isArray(data?.result?.declarationEvidence) ? data.result.declarationEvidence : [];
  const nonEmpty = raw.filter((item) => text(item?.text));
  const evidence = nonEmpty.map((item, index) => {
    const serviceIndex = Number(item?.imageIndex);
    return {
      id: String(item?.id ?? `rapid-evidence-${index}`),
      evidenceIndex: index,
      imageIndex: Number.isFinite(serviceIndex) && serviceIndex >= 1 ? serviceIndex - 1 : 0,
      text: text(item?.text),
      confidence: Math.max(0, Math.min(1, Number(item?.confidence) || 0)),
      boundingBox: item?.boundingBox || null,
      imageWidth: Number(item?.imageWidth || 0) || null,
      imageHeight: Number(item?.imageHeight || 0) || null,
    };
  });
  return { evidence, rawText: text(data?.result?.rawText) || evidence.map((item) => item.text).join("\n") };
}

async function readImages(files) {
  return Promise.all(files.map(async (file) => ({ base64: (await fs.readFile(file.path)).toString("base64"), mediaType: file.mimetype })));
}

async function runRapid(images) {
  const form = new FormData();
  const ocrUrl = process.env.NODE_ENV === "production" ? (process.env.RAPID_OCR_URL || "http://localhost:8081") : "http://localhost:8081";
  images.forEach((image, index) => form.append("images", new Blob([Buffer.from(image.base64, "base64")], { type: image.mediaType }), `parakh-${index + 1}.${ext(image.mediaType)}`));
  const startedAt = Date.now();
  let response;
  try { response = await fetch(`${ocrUrl}/api/ocr/analyze`, { method: "POST", body: form }); }
  catch (error) { throw Object.assign(new Error(`Could not reach RapidOCR: ${error.message}`), { statusCode: 502 }); }
  const responseText = await response.text();
  let data = {};
  try { data = JSON.parse(responseText); } catch {}
  if (!response.ok) throw Object.assign(new Error(data?.error || data?.detail || `RapidOCR returned HTTP ${response.status}`), { statusCode: 502 });
  return { provider: "rapidocr", model: "RapidOCR", ...normalizeEvidence(data), timingMs: Date.now() - startedAt };
}

function evidenceScore(key, field, item) {
  const candidate = normalizeComparable(item?.text);
  const value = normalizeComparable(field?.value);
  const raw = normalizeComparable(field?.raw);
  const evidence = normalizeComparable(field?.evidence);
  if (!candidate) return 0;

  if (["consumerCareEmail"].includes(key)) return EMAIL_RE.test(candidate) && value && candidate.includes(value) ? 1 : EMAIL_RE.test(candidate) && !value ? 0.8 : 0;
  if (["consumerCarePhone"].includes(key)) {
    const wanted = value.replace(/\D/g, "");
    const candidateDigits = candidate.replace(/\D/g, "");
    return wanted && candidateDigits.includes(wanted) ? 1 : MOBILE_RE.test(candidate) || TOLL_FREE_RE.test(candidate) ? 0.45 : 0;
  }
  if (["mrp", "netQuantity"].includes(key)) {
    const wanted = numberTokens(value)[0];
    if (!wanted) return 0;
    const actual = numberTokens(candidate);
    if (!actual.includes(wanted)) return 0;
    if (key === "netQuantity") {
      const hasUnit = /\b(?:mg|mcg|g|gm|kg|ml|l|ltr|cl|oz|lb|pcs?|pieces?|units?|nos)\b/i.test(candidate);
      return hasUnit ? 1 : 0.55;
    }
    if (/\b(?:m\.?r\.?p\.?|maximum\s+retail\s+price|retail\s+price)\b/i.test(candidate) || /(?:₹|rs\.?|inr)/i.test(candidate)) return 1;
    return 0.45;
  }
  if (["dateOfManufacture", "dateOfPacking", "bestBefore", "expiryDate"].includes(key)) {
    if (!looksLikeDate(value)) return 0;
    const wantedNumbers = numberTokens(value);
    const actualNumbers = numberTokens(candidate);
    const matchingNumbers = wantedNumbers.filter((n) => actualNumbers.includes(n));
    if (matchingNumbers.length >= Math.min(2, wantedNumbers.length)) return 1;
    return 0;
  }

  const variants = [value, raw, evidence].filter(Boolean);
  let best = 0;
  for (const needle of variants) {
    if (candidate === needle || candidate.includes(needle) || needle.includes(candidate)) best = Math.max(best, 1);
    const tokens = new Set(needle.split(" ").filter((token) => token.length > 1));
    if (tokens.size) {
      const matches = [...tokens].filter((token) => candidate.includes(token)).length;
      best = Math.max(best, matches / tokens.size);
    }
  }
  if (["manufacturerAddress", "packerAddress", "marketerAddress", "importerAddress"].includes(key)) best = Math.min(best, 0.92);
  return best;
}

function candidateEvidence(key, field, evidence) {
  let best = null;
  for (const item of evidence) {
    const score = evidenceScore(key, field, item);
    if (score <= 0) continue;
    if (!best || score > best.score || (score === best.score && item.confidence > best.item.confidence)) best = { item, score };
  }
  return best;
}

function regexEvidence(pattern, evidence) {
  for (const item of evidence) {
    const match = text(item.text).match(pattern);
    if (match) return { value: match[0].trim(), item };
  }
  return null;
}

function regexRepairFields(fields, evidence, rawText) {
  const next = Object.fromEntries(Object.entries(fields || {}).map(([key, field]) => [key, { ...(field || {}) }]));
  const fallbackEvidence = [{ text: rawText, confidence: 0.65, imageIndex: 0, evidenceIndex: -1 }];

  const emailCandidate = regexEvidence(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i, evidence) || regexEvidence(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i, fallbackEvidence);
  const currentEmail = text(next.consumerCareEmail?.value);
  if (!EMAIL_RE.test(currentEmail) && emailCandidate) {
    next.consumerCareEmail = { ...(next.consumerCareEmail || {}), value: emailCandidate.value, displayValue: emailCandidate.value, raw: emailCandidate.item.text, evidence: emailCandidate.item.text, confidence: Math.max(Number(next.consumerCareEmail?.confidence || 0), Number(emailCandidate.item.confidence || 0) * 0.92), status: "found", imageIndex: Number.isInteger(emailCandidate.item.imageIndex) ? emailCandidate.item.imageIndex : 0, evidenceIndex: Number.isInteger(emailCandidate.item.evidenceIndex) ? emailCandidate.item.evidenceIndex : -1, boundingBox: emailCandidate.item.boundingBox || null, imageWidth: emailCandidate.item.imageWidth || null, imageHeight: emailCandidate.item.imageHeight || null, source: "REGEX_OCR_REPAIR", verification: "email-format-validated" };
  } else if (currentEmail && !EMAIL_RE.test(currentEmail)) {
    next.consumerCareEmail = { ...(next.consumerCareEmail || {}), value: null, displayValue: "", status: "ambiguous", verification: "rejected-invalid-email" };
  }

  const currentPhone = text(next.consumerCarePhone?.value);
  const phoneCandidate = regexEvidence(MOBILE_RE, evidence) || regexEvidence(TOLL_FREE_RE, evidence) || regexEvidence(MOBILE_RE, fallbackEvidence) || regexEvidence(TOLL_FREE_RE, fallbackEvidence);
  if ((!currentPhone || (!MOBILE_RE.test(currentPhone) && !TOLL_FREE_RE.test(currentPhone))) && phoneCandidate) {
    next.consumerCarePhone = { ...(next.consumerCarePhone || {}), value: phoneCandidate.value, displayValue: phoneCandidate.value, raw: phoneCandidate.item.text, evidence: phoneCandidate.item.text, confidence: Math.max(Number(next.consumerCarePhone?.confidence || 0), Number(phoneCandidate.item.confidence || 0) * 0.92), status: "found", imageIndex: Number.isInteger(phoneCandidate.item.imageIndex) ? phoneCandidate.item.imageIndex : 0, evidenceIndex: Number.isInteger(phoneCandidate.item.evidenceIndex) ? phoneCandidate.item.evidenceIndex : -1, boundingBox: phoneCandidate.item.boundingBox || null, imageWidth: phoneCandidate.item.imageWidth || null, imageHeight: phoneCandidate.item.imageHeight || null, source: "REGEX_OCR_REPAIR", verification: "phone-format-validated" };
  }

  const numericRepaired = repairNumericFields(next, evidence, rawText);
  next.netQuantity = numericRepaired.netQuantity || next.netQuantity;
  next.unit = numericRepaired.unit || next.unit;
  next.mrp = numericRepaired.mrp || next.mrp;
  return next;
}

function resolveEvidenceForFields(fields, evidence) {
  return Object.fromEntries(Object.entries(fields || {}).map(([key, field]) => {
    if (!field || field.status !== "found") return [key, field];
    const providedIndex = Number.isInteger(field.evidenceIndex) ? field.evidenceIndex : -1;
    const provided = providedIndex >= 0 && evidence[providedIndex] ? evidence[providedIndex] : null;
    const providedScore = provided ? evidenceScore(key, field, provided) : 0;
    const best = candidateEvidence(key, field, evidence);
    const item = providedScore >= 0.75 ? provided : best?.item || provided;
    const matchedScore = item === provided ? providedScore : best?.score || 0;
    if (!item) return [key, field];
    const confidenceMultiplier = matchedScore >= 0.9 ? 1 : matchedScore >= 0.75 ? 0.95 : matchedScore >= 0.5 ? 0.82 : 0.65;
    return [key, {
      ...field,
      evidence: item.text,
      imageIndex: item.imageIndex,
      evidenceIndex: item.evidenceIndex,
      boundingBox: item.boundingBox || null,
      imageWidth: item.imageWidth || null,
      imageHeight: item.imageHeight || null,
      rapidOcrConfidence: item.confidence,
      ocrEvidenceQuality: matchedScore,
      confidence: Math.round(Math.max(0, Math.min(1, Number(field.confidence || 0) * confidenceMultiplier)) * 1000) / 1000,
      verification: matchedScore >= 0.75 ? (field.verification || "ocr-evidence-confirmed") : "ocr-evidence-weak",
    }];
  }));
}

function validateFieldFormats(fields) {
  const next = Object.fromEntries(Object.entries(fields || {}).map(([key, field]) => [key, { ...(field || {}) }]));
  const email = text(next.consumerCareEmail?.value), phone = text(next.consumerCarePhone?.value);
  if (email && !EMAIL_RE.test(email)) next.consumerCareEmail = { ...next.consumerCareEmail, value: null, displayValue: "", status: "ambiguous", verification: "rejected-invalid-email" };
  if (phone && !MOBILE_RE.test(phone) && !TOLL_FREE_RE.test(phone)) next.consumerCarePhone = { ...next.consumerCarePhone, value: null, displayValue: "", status: "ambiguous", verification: "rejected-invalid-phone" };
  const barcode = text(next.barcode?.value).replace(/\D/g, "");
  if (barcode && ![8, 12, 13, 14].includes(barcode.length)) next.barcode = { ...next.barcode, value: null, displayValue: "", status: "ambiguous", verification: "rejected-invalid-gtin" };
  return next;
}

function attachEvidence(fields, evidence) {
  const output = {};
  for (const [key, field] of Object.entries(resolveEvidenceForFields(fields, evidence))) {
    const index = Number.isInteger(field?.evidenceIndex) ? field.evidenceIndex : -1, item = index >= 0 ? evidence[index] : null;
    output[key] = { ...(field || {}), value: field?.value ?? null, raw: field?.raw ?? field?.evidence ?? null, evidence: item?.text || field?.evidence || field?.raw || null, ...(item ? { imageIndex: item.imageIndex, evidenceIndex: item.evidenceIndex, boundingBox: item.boundingBox, imageWidth: item.imageWidth, imageHeight: item.imageHeight, rapidOcrConfidence: item.confidence } : {}) };
  }
  return output;
}


function fieldHasValue(field) {
  return Boolean(field && field.status === "found" && text(field.value));
}

function comparableFieldValue(key, field) {
  const value = normalizeComparable(field?.value ?? field?.displayValue ?? field?.raw ?? "");
  if (!value) return "";
  if (["mrp", "netQuantity"].includes(key)) {
    const numbers = numberTokens(value);
    if (numbers.length) return numbers.join("|");
  }
  return value;
}

function fieldsAgree(key, a, b) {
  const left = comparableFieldValue(key, a);
  const right = comparableFieldValue(key, b);
  if (!left || !right) return false;
  if (left === right) return true;
  if (["mrp", "netQuantity", "unit", "batchNumber", "consumerCarePhone", "consumerCareEmail", "fssaiLicenseNumber", "barcode"].includes(key)) {
    return false;
  }
  return left.includes(right) || right.includes(left);
}

function prepareDeterministicOcrFields(rapid) {
  const interpreted = interpretOcrFields({
    detections: rapid.evidence,
    rawText: rapid.rawText,
  });
  const repaired = repairNumericFields(
    interpreted?.fields || {},
    rapid.evidence,
    rapid.rawText,
  );
  return normalizeLegalMetrologyFields({
    ...repaired,
    rawText: rapid.rawText,
    declarationEvidence: rapid.evidence,
  });
}

function withSelectedSource(field, source, extra = {}) {
  if (!field) return field;
  return {
    ...field,
    source,
    ...extra,
  };
}

function mergeFieldSources({ consensusFields = {}, providerResults = [], ocrFields = {} }) {
  const gemini = providerResults.find((provider) => provider?.enabled && String(provider.provider).toLowerCase() === "gemini")?.fields || {};
  const grok = providerResults.find((provider) => provider?.enabled && String(provider.provider).toLowerCase() === "grok")?.fields || {};
  const output = {};

  const allKeys = new Set([
    ...Object.keys(consensusFields || {}),
    ...Object.keys(gemini || {}),
    ...Object.keys(grok || {}),
    ...Object.keys(ocrFields || {}),
  ]);

  for (const key of allKeys) {
    const consensus = consensusFields?.[key];
    const geminiField = gemini?.[key];
    const grokField = grok?.[key];
    const ocrField = ocrFields?.[key];

    if (fieldHasValue(consensus)) {
      const crossChecked = fieldHasValue(ocrField) && fieldsAgree(key, consensus, ocrField);
      const selected = crossChecked
        ? {
            ...consensus,
            confidence: Math.min(
              0.98,
              Math.max(
                Number(consensus.confidence || 0),
                Number(consensus.confidence || 0) * 0.78 + Number(ocrField.confidence || 0) * 0.22,
              ),
            ),
            raw: consensus.raw || ocrField.raw || ocrField.value,
            evidence: consensus.evidence || ocrField.evidence || ocrField.raw || ocrField.value,
            imageIndex: Number.isInteger(consensus.imageIndex) ? consensus.imageIndex : ocrField.imageIndex,
            evidenceIndex: Number.isInteger(consensus.evidenceIndex) ? consensus.evidenceIndex : ocrField.evidenceIndex,
          }
        : consensus;
      output[key] = withSelectedSource(
        selected,
        crossChecked ? "SEMANTIC_CONSENSUS_OCR_CROSSCHECK" : (consensus.source || "SEMANTIC_CONSENSUS"),
        crossChecked ? { verification: "semantic-consensus-confirmed-by-ocr" } : {},
      );
      continue;
    }

    if (fieldHasValue(geminiField)) {
      const crossChecked = fieldHasValue(ocrField) && fieldsAgree(key, geminiField, ocrField);
      const confidence = crossChecked
        ? Math.min(
            0.96,
            Math.max(
              Number(geminiField.confidence || 0),
              Number(geminiField.confidence || 0) * 0.76 + Number(ocrField.confidence || 0) * 0.24 + 0.04,
            ),
          )
        : Number(geminiField.confidence || 0);

      output[key] = withSelectedSource(
        {
          ...geminiField,
          confidence,
          raw: geminiField.raw || ocrField?.raw || ocrField?.value || null,
          evidence: geminiField.evidence || ocrField?.evidence || ocrField?.raw || ocrField?.value || null,
          imageIndex: Number.isInteger(geminiField.imageIndex) ? geminiField.imageIndex : ocrField?.imageIndex,
          evidenceIndex: Number.isInteger(geminiField.evidenceIndex) ? geminiField.evidenceIndex : ocrField?.evidenceIndex,
        },
        crossChecked ? "GEMINI_OCR_CROSSCHECK" : "GEMINI_FALLBACK",
        crossChecked ? { verification: "gemini-confirmed-by-ocr" } : { verification: geminiField.verification || "gemini-fallback" },
      );
      continue;
    }

    if (fieldHasValue(grokField)) {
      output[key] = withSelectedSource(
        grokField,
        "GROK_FALLBACK",
        { verification: grokField.verification || "grok-fallback" },
      );
      continue;
    }

    if (fieldHasValue(ocrField)) {
      output[key] = withSelectedSource(
        ocrField,
        "OCR_REGEX_FALLBACK",
        { verification: ocrField.verification || "ocr-regex-fallback" },
      );
      continue;
    }

    output[key] = consensus || geminiField || grokField || ocrField;
  }

  return output;
}

function buildDeclarationEvidence(fields) {
  const map = { productName: "PRODUCT_NAME", manufacturer: "MANUFACTURER", manufacturerAddress: "ADDRESS", packer: "PACKER", packerAddress: "ADDRESS", importer: "IMPORTER", importerAddress: "ADDRESS", netQuantity: "NET_QUANTITY", mrp: "MRP", dateOfManufacture: "DATE_OF_MANUFACTURE", dateOfPacking: "DATE_OF_PACKING", bestBefore: "BEST_BEFORE", expiryDate: "EXPIRY_DATE", consumerCarePhone: "CONSUMER_CARE", consumerCareEmail: "CONSUMER_CARE" };
  return Object.entries(fields || {}).flatMap(([key, field]) => {
    if (!map[key] || !field || field.status !== "found" || !field.value || !field.boundingBox) return [];
    return [{ id: `semantic-${key}`, imageIndex: Number.isInteger(field.imageIndex) ? field.imageIndex : 0, type: map[key], text: text(field.evidence || field.raw || field.value), value: text(field.value), confidence: Number(field.confidence || 0), source: field.source || "SEMANTIC_CONSENSUS", evidenceIndex: Number.isInteger(field.evidenceIndex) ? field.evidenceIndex : -1, boundingBox: field.boundingBox, imageWidth: field.imageWidth || null, imageHeight: field.imageHeight || null, verification: field.verification || null }];
  });
}

async function runSemanticProviders({ images, rapid, categoryOptions, signal }) {
  const startedAt = Date.now();
  const providers = [{ name: "gemini", fn: interpretPackageWithGemini }, { name: "grok", fn: interpretPackageWithGrok }];
  const settled = await Promise.all(providers.map(async ({ name, fn }) => {
    const providerStarted = Date.now();
    try {
      const result = await fn({ images, detections: rapid.evidence, rawText: rapid.rawText, categoryOptions, signal });
      return { ...result, provider: result?.provider || name, timingMs: result?.timingMs ?? Date.now() - providerStarted };
    } catch (error) {
      return { enabled: false, provider: name, model: null, reason: error?.message || `${name} provider failed.`, timingMs: Date.now() - providerStarted };
    }
  }));
  const consensus = reconcileSemanticResults(settled, categoryOptions);
  return { ...consensus, providerResults: settled, timingMs: Date.now() - startedAt, timing: Object.fromEntries(settled.map((provider) => [provider.provider, provider.timingMs || 0])) };
}

async function analyze(req, res) {
  const startedAt = Date.now();
  const packageFiles = Array.isArray(req.files?.images) ? req.files.images : [];
  const barcodeFile = Array.isArray(req.files?.barcodeImage) ? req.files.barcodeImage[0] : null;
  const allFiles = [...packageFiles, ...(barcodeFile ? [barcodeFile] : [])];
  try {
    if (!packageFiles.length) return res.status(400).json({ error: { code: "OCR_NO_IMAGES", message: "Upload at least one package image." } });
    const images = await readImages(packageFiles);
    let categoryOptions = [];
    try { categoryOptions = JSON.parse(req.body?.categoryOptions || "[]"); if (!Array.isArray(categoryOptions)) categoryOptions = []; } catch { categoryOptions = []; }
    const rapid = await runRapid(images);
    const semantic = await runSemanticProviders({ images, rapid, categoryOptions, signal: undefined });
    const ocrFields = prepareDeterministicOcrFields(rapid);
    const cascadedFields = mergeFieldSources({
      consensusFields: semantic.fields,
      providerResults: semantic.providerResults,
      ocrFields,
    });
    const repaired = regexRepairFields(cascadedFields, rapid.evidence, rapid.rawText);
    const validated = validateFieldFormats(repaired);
    const fields = attachEvidence(validated, rapid.evidence);
    const submittedBarcode = text(req.body?.barcodeGtin).replace(/\D/g, "");
    if (submittedBarcode) fields.barcode = { value: submittedBarcode, displayValue: submittedBarcode, raw: submittedBarcode, evidence: submittedBarcode, confidence: 1, status: "found", source: "BARCODE_SCAN", verification: "scanner-authoritative" };
    const structured = {
      ...fields,
      declarationEvidence: buildDeclarationEvidence(fields),
      rawText: rapid.rawText,
      rawOcrEvidence: rapid.evidence,
      otherDeclarations: rapid.evidence.map((item) => item.text),
      semanticReconciliation: { providerCount: semantic.providerCount, providers: semantic.providers },
      extractionSources: { rapidOcr: ocrFields, providerResults: semantic.providerResults },
      aiSemantic: { providerCount: semantic.providerCount, providers: semantic.providers, suggestedCategory: semantic.suggestedCategory || null },
      suggestedCategory: semantic.suggestedCategory || null,
      warnings: semantic.providerCount < 2 ? ["Only one semantic AI provider was available; review single-provider findings carefully."] : [],
      needsReview: Object.values(fields).some((field) => field?.status === "ambiguous" || field?.status === "unreadable" || (field?.status === "found" && Number(field?.confidence || 0) < 0.6)),
    };
    const finalResult = await applyEvidenceConfidence(structured, { barcodeImageProvided: Boolean(barcodeFile) });
    const totalMs = Date.now() - startedAt;
    console.log(`[ocr:fast] images=${packageFiles.length} evidence=${rapid.evidence.length} rapid=${rapid.timingMs}ms semantic=${semantic.timingMs}ms gemini=${semantic.timing?.gemini || 0}ms grok=${semantic.timing?.grok || 0}ms providers=${semantic.providerCount} total=${totalMs}ms parallel=true`);
    return res.json({ result: finalResult, provider: "rapidocr", model: "RapidOCR", detectionProvider: "rapidocr", detectionProviders: ["rapidocr"], rawText: rapid.rawText, semantic: { provider: "consensus", providers: semantic.providers, providerCount: semantic.providerCount, enabled: semantic.enabled }, aiSuggestedCategory: semantic.suggestedCategory || null, aiSemanticEnabled: semantic.enabled, aiSemanticError: semantic.enabled ? null : semantic.providers.map((item) => `${item.provider}: ${item.reason || "unavailable"}`).join(" | "), timing: { uploadMs: 0, rapidMs: rapid.timingMs, semanticMs: semantic.timingMs, geminiMs: semantic.timing?.gemini || 0, grokMs: semantic.timing?.grok || 0, totalMs, parallelMs: Math.max(rapid.timingMs, semantic.timingMs) } });
  } catch (error) {
    console.error("[ocr:fast]", error);
    return res.status(error.statusCode || 502).json({ error: { code: error.code || "OCR_FAST_ERROR", message: error.message || "Fast OCR analysis failed." } });
  } finally {
    await Promise.all(allFiles.map((file) => fs.unlink(file.path).catch(() => {})));
  }
}

router.post("/analyze", authenticate, upload.fields([{ name: "images", maxCount: config.maxImages }, { name: "barcodeImage", maxCount: 1 }]), analyze);

export default router;
