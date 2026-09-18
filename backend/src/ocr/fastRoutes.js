import "dotenv/config";
import express from "express";
import multer from "multer";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { authenticate } from "../middleware/auth.js";
import { getOcrConfig } from "./config.js";
import { repairNumericFields } from "./numericFieldRepair.js";
import { interpretOcrFields } from "./ocrFieldInterpreter.js";
import { fuseFieldSources } from "./fieldFusion.js";
import { interpretPackageWithGemini } from "./geminiPackageInterpreter.js";
import { interpretPackageWithGrok } from "./grokPackageInterpreter.js";
import { reconcileSemanticResults } from "./semanticConsensus.js";
import { applyEvidenceConfidence } from "./evidenceConfidence.js";

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
  const evidence = raw.map((item, index) => {
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
  }).filter((item) => item.text);
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
    if (/\b(?:m\.?r\.?p\.?|maximum\s+retail\s+price|retail\s+price)\b/i.test(candidate) || /(?:\u20B9|rs\.?|inr)/i.test(candidate)) return 1;
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

function runDeterministicExtraction(rapid) {
  const startedAt = Date.now();
  const parsed = interpretOcrFields({
    detections: rapid.evidence,
    rawText: rapid.rawText,
  });
  const fields = repairNumericFields(parsed?.fields || {}, rapid.evidence, rapid.rawText);
  return {
    enabled: true,
    provider: "regex/raw-ocr",
    model: "deterministic OCR field interpreter",
    sourceKind: "deterministic_regex",
    fields,
    suggestedCategory: null,
    packageAssessment: null,
    timingMs: Date.now() - startedAt,
  };
}

function resolveEvidenceForFields(fields, evidence) {
  return Object.fromEntries(Object.entries(fields || {}).map(([key, field]) => {
    if (!field) return [key, field];

    const providedIndex = Number.isInteger(field.evidenceIndex) ? field.evidenceIndex : -1;
    const provided = providedIndex >= 0 && evidence[providedIndex] ? evidence[providedIndex] : null;

    // Geometry is ONLY trusted when the semantic provider explicitly points
    // to the OCR detection that contains the actual value.
    const providedScore = provided && field.status === "found"
      ? evidenceScore(key, field, provided)
      : 0;

    let item = providedScore >= 0.75 ? provided : null;
    let matchedScore = item ? providedScore : 0;

    // Safe fallback: exact normalized evidence-text match only.
    // Do NOT use fuzzy token overlap here because it can attach an unrelated
    // OCR rectangle containing a shared number such as 100, 229, 2026, etc.
    if (!item && field.status === "found") {
      const wanted = [
        normalizeComparable(field.evidence),
        normalizeComparable(field.raw),
        normalizeComparable(field.value),
      ].filter(Boolean);

      for (const candidate of evidence) {
        const candidateText = normalizeComparable(candidate.text);
        if (!candidateText || !wanted.includes(candidateText)) continue;

        item = candidate;
        matchedScore = 1;
        break;
      }
    }

    if (!item) {
      // Preserve semantic evidence even when OCR geometry cannot be trusted.
      return [key, {
        ...field,
        boundingBox: null,
        imageWidth: field.imageWidth || null,
        imageHeight: field.imageHeight || null,
        verification: field.verification || "semantic-evidence-without-ocr-geometry",
      }];
    }

    const confidenceMultiplier =
      matchedScore >= 0.9 ? 1 :
      matchedScore >= 0.75 ? 0.95 :
      matchedScore >= 0.5 ? 0.82 : 0.65;

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
      confidence: Math.round(
        Math.max(0, Math.min(1, Number(field.confidence || 0) * confidenceMultiplier)) * 1000
      ) / 1000,
      verification: matchedScore >= 0.75
        ? (field.verification || "ocr-evidence-confirmed")
        : "ocr-evidence-weak",
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

function buildDeclarationEvidence(fields) {
  const map = {
    productName: "PRODUCT_NAME",
    manufacturer: "MANUFACTURER",
    manufacturerAddress: "ADDRESS",
    packer: "PACKER",
    packerAddress: "ADDRESS",
    importer: "IMPORTER",
    importerAddress: "ADDRESS",
    netQuantity: "NET_QUANTITY",
    mrp: "MRP",
    dateOfManufacture: "DATE_OF_MANUFACTURE",
    dateOfPacking: "DATE_OF_PACKING",
    bestBefore: "BEST_BEFORE",
    expiryDate: "EXPIRY_DATE",
    consumerCarePhone: "CONSUMER_CARE",
    consumerCareEmail: "CONSUMER_CARE",
  };

  return Object.entries(fields || {}).flatMap(([key, field]) => {
    if (!map[key] || !field) return [];

    const status = String(field.status || "").toLowerCase();
    if (!["found", "absent", "unreadable", "ambiguous"].includes(status)) return [];

    const value = text(field.value);
    const evidenceText = text(field.evidence || field.raw || field.value);

    return [{
      id: `semantic-${key}`,
      imageIndex: Number.isInteger(field.imageIndex) ? field.imageIndex : 0,
      type: map[key],
      text: evidenceText,
      value: value || null,
      confidence: Number(field.confidence || 0),
      source: "IMAGE_INSPECTION",
      evidenceIndex: Number.isInteger(field.evidenceIndex) ? field.evidenceIndex : -1,
      boundingBox: field.boundingBox || null,
      imageWidth: field.imageWidth || null,
      imageHeight: field.imageHeight || null,
      verification: field.verification || null,

      // This is critical:
      // the rules engine can now distinguish explicit semantic ABSENCE
      // from "no extractor evidence was available".
      metadata: {
        declarationStatus: status,
        semanticSource: field.source || "SEMANTIC_CONSENSUS",
        ocrGeometryVerified: Boolean(field.boundingBox),
      },
    }];
  });
}

async function runSemanticImageProviders({ images, categoryOptions, signal }) {
  const startedAt = Date.now();
  const providers = [
    { name: "gemini", sourceKind: "gemini_image", fn: interpretPackageWithGemini, mode: "image" },
    { name: "grok", sourceKind: "grok_image", fn: interpretPackageWithGrok, mode: "image" },
  ];

  const settled = await Promise.all(providers.map(async ({ name, sourceKind, fn, mode }) => {
    const providerStarted = Date.now();
    try {
      const result = await fn({
        images,
        categoryOptions,
        signal,
        mode,
      });
      return {
        ...result,
        provider: result?.provider || name,
        sourceKind: result?.sourceKind || sourceKind,
        timingMs: result?.timingMs ?? Date.now() - providerStarted,
      };
    } catch (error) {
      return {
        enabled: false,
        provider: name,
        model: null,
        mode,
        sourceKind,
        reason: error?.message || (name + " provider failed."),
        timingMs: Date.now() - providerStarted,
      };
    }
  }));

  return {
    providers: settled,
    timingMs: Date.now() - startedAt,
  };
}

function buildPackageConsistency(providers) {
  const assessments = providers
    .filter((provider) => provider?.enabled && provider?.packageAssessment)
    .map((provider) => ({ provider: provider.provider, mode: provider.mode, ...provider.packageAssessment }));
  const assessmentGroups = new Map();

  for (const item of assessments) {
    if (!assessmentGroups.has(item.status)) assessmentGroups.set(item.status, []);
    assessmentGroups.get(item.status).push(item);
  }

  const ranked = [...assessmentGroups.entries()]
    .sort((a, b) =>
      b[1].length - a[1].length ||
      Math.max(...b[1].map((item) => Number(item.confidence) || 0)) -
      Math.max(...a[1].map((item) => Number(item.confidence) || 0))
    );

  const topAssessment = ranked[0];
  return topAssessment && topAssessment[1].length >= 2
    ? {
        status: topAssessment[0],
        confidence: Math.max(...topAssessment[1].map((item) => Number(item.confidence) || 0)),
        providers: assessments,
        evidence: topAssessment[1].map((item) => item.provider + ": " + item.evidence).join(" | "),
      }
    : {
        status: "uncertain",
        confidence: 0,
        providers: assessments,
        evidence: assessments.length
          ? assessments.map((item) => item.provider + ": " + item.status + " " + item.evidence).join(" | ")
          : "No package consistency assessment returned.",
      };
}

async function runSemanticFusion({ images, rapid, categoryOptions, signal, imageProviders, imageSemanticTimingMs }) {
  const startedAt = Date.now();
  const geminiNormalizationStartedAt = Date.now();
  let geminiNormalization;

  try {
    geminiNormalization = await interpretPackageWithGemini({
      images,
      detections: rapid.evidence,
      rawText: rapid.rawText,
      categoryOptions,
      signal,
      mode: "ocr_normalization",
    });
  } catch (error) {
    geminiNormalization = {
      enabled: false,
      provider: "gemini",
      model: null,
      mode: "ocr_normalization",
      sourceKind: "gemini_ocr_normalization",
      reason: error?.message || "Gemini OCR normalization failed.",
    };
  }

  geminiNormalization = {
    ...geminiNormalization,
    timingMs: geminiNormalization?.timingMs ?? Date.now() - geminiNormalizationStartedAt,
    sourceKind: geminiNormalization?.sourceKind || "gemini_ocr_normalization",
  };

  const deterministic = runDeterministicExtraction(rapid);
  const sources = [...imageProviders, geminiNormalization, deterministic];
  const imageConsensus = reconcileSemanticResults(imageProviders, categoryOptions);
  const fusedFields = fuseFieldSources(sources);

  const enabledAiProviders = sources
    .filter((source) => source?.enabled && source?.sourceKind !== "deterministic_regex")
    .map((source) => String(source.provider || "unknown"));
  const providerCount = new Set(enabledAiProviders).size;

  const providers = sources
    .filter((source) => source?.sourceKind !== "deterministic_regex")
    .map((source) => ({
      provider: source?.provider || "unknown",
      model: source?.model || null,
      mode: source?.mode || null,
      sourceKind: source?.sourceKind || "unknown",
      enabled: Boolean(source?.enabled),
      reason: source?.enabled ? null : source?.reason || "Provider unavailable.",
      timingMs: source?.timingMs || 0,
    }));

  const postRapidMs = Date.now() - startedAt;
  return {
    enabled: providerCount > 0,
    providerCount,
    providers,
    fields: fusedFields,
    suggestedCategory: imageConsensus.suggestedCategory,
    packageConsistency: buildPackageConsistency(imageProviders),
    timingMs: postRapidMs,
    timing: {
      geminiImageMs: imageProviders.find((item) => item.sourceKind === "gemini_image")?.timingMs || 0,
      grokImageMs: imageProviders.find((item) => item.sourceKind === "grok_image")?.timingMs || 0,
      geminiOcrNormalizationMs: geminiNormalization.timingMs || 0,
      deterministicRegexMs: deterministic.timingMs || 0,
      imageParallelMs: imageSemanticTimingMs,
      postRapidMs,
    },
  };
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
    const imageSemanticPromise = runSemanticImageProviders({ images, categoryOptions, signal: undefined });
    const rapidPromise = runRapid(images);
    const [rapid, imageSemantic] = await Promise.all([rapidPromise, imageSemanticPromise]);
    const semantic = await runSemanticFusion({
      images,
      rapid,
      categoryOptions,
      signal: undefined,
      imageProviders: imageSemantic.providers,
      imageSemanticTimingMs: imageSemantic.timingMs,
    });
    const validated = validateFieldFormats(semantic.fields);
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
      aiSemantic: { providerCount: semantic.providerCount, providers: semantic.providers, suggestedCategory: semantic.suggestedCategory || null, packageConsistency: semantic.packageConsistency || null },
      suggestedCategory: semantic.suggestedCategory || null,
      warnings: semantic.providerCount < 2 ? ["Only one semantic AI provider was available; review single-provider findings carefully."] : [],
      needsReview: semantic.packageConsistency?.status !== "single_package" || Object.values(fields).some((field) => field?.status === "ambiguous" || field?.status === "unreadable" || (field?.status === "found" && Number(field?.confidence || 0) < 0.6)),
      packageConsistency: semantic.packageConsistency || { status: "uncertain", confidence: 0, providers: [], evidence: "Package consistency could not be established." },
    };
    const finalResult = await applyEvidenceConfidence(structured, { barcodeImageProvided: Boolean(barcodeFile) });
    const totalMs = Date.now() - startedAt;
    console.log(
      "[ocr:fast] images=" + packageFiles.length +
      " evidence=" + rapid.evidence.length +
      " rapid=" + rapid.timingMs + "ms" +
      " imageSemanticParallel=" + (semantic.timing?.imageParallelMs || 0) + "ms" +
      " geminiImage=" + (semantic.timing?.geminiImageMs || 0) + "ms" +
      " grokImage=" + (semantic.timing?.grokImageMs || 0) + "ms" +
      " geminiOcrNormalization=" + (semantic.timing?.geminiOcrNormalizationMs || 0) + "ms" +
      " deterministicRegex=" + (semantic.timing?.deterministicRegexMs || 0) + "ms" +
      " providers=" + semantic.providerCount +
      " package=" + (semantic.packageConsistency?.status || "uncertain") +
      " total=" + totalMs + "ms" +
      " imageRapidParallel=true"
    );
    return res.json({
      result: finalResult,
      provider: "rapidocr",
      model: "RapidOCR",
      detectionProvider: "rapidocr",
      detectionProviders: ["rapidocr"],
      rawText: rapid.rawText,
      semantic: {
        provider: "consensus",
        providers: semantic.providers,
        providerCount: semantic.providerCount,
        enabled: semantic.enabled,
      },
      aiSuggestedCategory: semantic.suggestedCategory || null,
      aiSemanticEnabled: semantic.enabled,
      aiSemanticError: semantic.enabled
        ? null
        : semantic.providers.map((item) => item.provider + ": " + (item.reason || "unavailable")).join(" | "),
      timing: {
        uploadMs: 0,
        rapidMs: rapid.timingMs,
        imageSemanticMs: semantic.timing?.imageParallelMs || 0,
        geminiImageMs: semantic.timing?.geminiImageMs || 0,
        grokImageMs: semantic.timing?.grokImageMs || 0,
        geminiOcrNormalizationMs: semantic.timing?.geminiOcrNormalizationMs || 0,
        deterministicRegexMs: semantic.timing?.deterministicRegexMs || 0,
        semanticMs: semantic.timing?.postRapidMs || semantic.timingMs,
        totalMs,
        parallelMs: Math.max(rapid.timingMs, semantic.timing?.imageParallelMs || 0) + (semantic.timing?.postRapidMs || 0),
      },
    });
  } catch (error) {
    console.error("[ocr:fast]", error);
    return res.status(error.statusCode || 502).json({ error: { code: error.code || "OCR_FAST_ERROR", message: error.message || "Fast OCR analysis failed." } });
  } finally {
    await Promise.all(allFiles.map((file) => fs.unlink(file.path).catch(() => {})));
  }
}

router.post("/analyze", authenticate, upload.fields([{ name: "images", maxCount: config.maxImages }, { name: "barcodeImage", maxCount: 1 }]), analyze);

export default router;
