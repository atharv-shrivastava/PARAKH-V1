import "dotenv/config";
import express from "express";
import multer from "multer";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { authenticate } from "../middleware/auth.js";
import { getOcrConfig } from "./config.js";
import { interpretOcrFields } from "./ocrFieldInterpreter.js";
import { interpretPackageWithGemini } from "./geminiPackageInterpreter.js";
import { interpretPackageWithCloudflare } from "./cloudflarePackageInterpreter.js";
import { reconcileSemanticResults } from "./semanticConsensus.js";

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
  limits: { files: config.maxImages, fileSize: config.maxImageSizeBytes },
});

function extension(mediaType) {
  return mediaType === "image/png" ? "png" : mediaType === "image/webp" ? "webp" : "jpg";
}

function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

async function analyzeWithRapid(images) {
  const formData = new FormData();
  const ocrUrl = process.env.NODE_ENV === "production"
    ? (process.env.RAPID_OCR_URL || process.env.PADDLE_OCR_URL || "http://localhost:8081")
    : "http://localhost:8081";
  images.forEach((image, imageIndex) => {
    const bytes = Buffer.from(image.base64, "base64");
    formData.append("images", new Blob([bytes], { type: image.mediaType }), `parakh-${imageIndex + 1}.${extension(image.mediaType)}`);
  });
  console.log("[RapidOCR] Target:", `${ocrUrl}/api/ocr/analyze`);

let response;

try {
  response = await fetch(`${ocrUrl}/api/ocr/analyze`, {
    method: "POST",
    body: formData,
  });
} catch (error) {
  console.error("[RapidOCR] Connection error:", error);

  throw Object.assign(
    new Error(`Could not reach RapidOCR: ${error.message}`),
    {
      code: "OCR_RAPID_CONNECTION_ERROR",
      statusCode: 502,
    }
  );
}

const responseText = await response.text();

console.log("[RapidOCR] HTTP status:", response.status);
console.log("[RapidOCR] Response:", responseText);

let data = {};

try {
  data = JSON.parse(responseText);
} catch {
  // RapidOCR returned non-JSON content.
}

if (!response.ok) {
  throw Object.assign(
    new Error(
      data?.error ||
      data?.message ||
      data?.detail ||
      `RapidOCR returned HTTP ${response.status}`
    ),
    {
      code: "OCR_RAPID_ERROR",
      statusCode: 502,
    }
  );
}
  const evidence = Array.isArray(data?.result?.declarationEvidence)
    ? data.result.declarationEvidence.map((item, index) => {
        const serviceImageIndex = Number(item?.imageIndex);
        return {
          id: String(item?.id ?? `rapid-evidence-${index}`),
          imageIndex: Number.isFinite(serviceImageIndex) && serviceImageIndex >= 1 ? serviceImageIndex - 1 : 0,
          text: normalizeText(item?.text),
          confidence: Math.max(0, Math.min(1, Number(item?.confidence) || 0)),
          ...(item?.boundingBox ? { boundingBox: item.boundingBox } : {}),
          ...(item?.imageWidth ? { imageWidth: Number(item.imageWidth) } : {}),
          ...(item?.imageHeight ? { imageHeight: Number(item.imageHeight) } : {}),
        };
      }).filter((item) => item.text)
    : [];
  const rawText = normalizeText(data?.result?.rawText) || evidence.map((item) => item.text).join("\n");
  return { provider: "rapidocr", model: "RapidOCR", rawText, evidence };
}

async function readImages(files) {
  return Promise.all(files.map(async (file) => ({
    base64: (await fs.readFile(file.path)).toString("base64"),
    mediaType: file.mimetype,
  })));
}

function normalizeField(field) {
  if (!field || typeof field !== "object") return { value: null, raw: null, confidence: 0, evidence: null, status: "absent" };
  const rawStatus = String(field.status || "").toLowerCase();
  const status = rawStatus === "not_detected"
    ? "absent"
    : rawStatus === "referenced_inner_pack"
      ? "ambiguous"
      : ["found", "absent", "unreadable", "ambiguous"].includes(rawStatus)
        ? rawStatus
        : field.value != null ? "found" : "absent";
  return {
    value: field.value ?? null,
    raw: field.raw ?? field.evidence ?? null,
    confidence: Math.max(0, Math.min(1, Number(field.confidence) || 0)),
    evidence: field.evidence ?? field.raw ?? null,
    status,
    ...(field.imageIndex != null ? { imageIndex: Number(field.imageIndex) } : {}),
    ...(Number.isInteger(field.evidenceIndex) ? { evidenceIndex: Number(field.evidenceIndex) } : {}),
    ...(field.boundingBox ? { boundingBox: field.boundingBox } : {}),
    ...(field.imageWidth ? { imageWidth: Number(field.imageWidth) } : {}),
    ...(field.imageHeight ? { imageHeight: Number(field.imageHeight) } : {}),
    ...(field.source ? { source: field.source } : {}),
    ...(field.verification ? { verification: field.verification } : {}),
    ...(field.votes ? { votes: field.votes } : {}),
  };
}

function validateSemanticFields(fields, rapidEvidence) {
  const numericFields = new Set(["mrp", "netQuantity"]);
  const phoneLike = /^\+?[0-9 ()-]{7,20}$/;
  const emailLike = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const barcodeLike = /^[0-9]{8,14}$/;
  const dateLike = /^(?:0?[1-9]|1[0-2])[\/.-]\d{2,4}|^\d{2,4}[\/.-](?:0?[1-9]|1[0-2])$/;
  const unitLike = /^(?:g|kg|mg|ml|l|cm|mm|m|pcs?|pieces?|number|nos?)$/i;
  const validated = {};
  const warnings = [];

  for (const [key, rawField] of Object.entries(fields || {})) {
    const field = normalizeField(rawField);
    const value = field.value == null ? "" : normalizeText(field.value);

    if (field.status === "found" && !value) field.status = "absent";

    if (field.status === "found") {
      if (numericFields.has(key)) {
        const n = Number(value.replace(/[^0-9.]/g, ""));
        if (!Number.isFinite(n) || n < 0 || n > 100000000) {
          field.status = "ambiguous";
          field.value = null;
          warnings.push(key + " failed numeric validation.");
        }
      } else if (key === "unit" && !unitLike.test(value)) {
        field.status = "ambiguous";
        warnings.push("Unit value failed format validation.");
      } else if (key === "consumerCarePhone" && !phoneLike.test(value)) {
        field.status = "ambiguous";
        warnings.push("Consumer care phone failed format validation.");
      } else if (key === "consumerCareEmail" && !emailLike.test(value)) {
        field.status = "ambiguous";
        warnings.push("Consumer care email failed format validation.");
      } else if (key === "barcode" && !barcodeLike.test(value.replace(/\D/g, ""))) {
        field.status = "ambiguous";
        warnings.push("Barcode failed format validation.");
      } else if (["dateOfManufacture", "dateOfPacking", "bestBefore", "expiryDate"].includes(key) && !dateLike.test(value)) {
        field.status = "ambiguous";
        warnings.push(key + " failed date-format validation.");
      }

      if (field.confidence < 0.55) {
        field.status = "ambiguous";
        warnings.push(key + " is below the automatic acceptance confidence threshold.");
      }
    }

    const evidenceIndex = Number.isInteger(field.evidenceIndex) ? field.evidenceIndex : -1;
    const evidence = evidenceIndex >= 0 ? rapidEvidence?.[evidenceIndex] : null;
    validated[key] = {
      ...field,
      ...(evidence ? {
        evidenceIndex,
        imageIndex: Number.isInteger(field.imageIndex) ? field.imageIndex : evidence.imageIndex,
        evidence: field.evidence || evidence.text,
        boundingBox: evidence.boundingBox || null,
        imageWidth: evidence.imageWidth || null,
        imageHeight: evidence.imageHeight || null,
      } : {}),
    };
  }

  return { fields: validated, warnings };
}

function mergeSemanticFields(deterministicFields, aiFields, aiEnabled) {
  if (aiEnabled) return Object.fromEntries(Object.keys(aiFields || {}).map((key) => [key, normalizeField(aiFields[key])]));
  return Object.fromEntries(Object.entries(deterministicFields || {}).map(([key, value]) => [key, normalizeField(value)]));
}

function buildSemanticDeclarationEvidence(fields) {
  return Object.entries(fields || {}).map(([key, field], index) => {
    const normalized = normalizeField(field);
    const value = normalized.value == null ? "" : normalizeText(normalized.value);
    if (!value) return null;
    return {
      id: `semantic-${key}-${index}`,
      imageIndex: Number.isInteger(normalized.imageIndex) ? normalized.imageIndex : 0,
      type: key.toUpperCase(),
      label: key.replace(/([A-Z])/g, " $1").replace(/^./, (char) => char.toUpperCase()),
      text: value,
      value,
      confidence: normalized.confidence,
      status: normalized.status,
      source: field?.source || "SEMANTIC_CONSENSUS",
      ...(field?.verification ? { verification: field.verification } : {}),
    };
  }).filter(Boolean);
}

function buildPresentationChecks(rapid, fields) {
  const relevant = [
    "productName", "brandName", "manufacturer", "packer", "importer",
    "netQuantity", "mrp", "dateOfManufacture", "dateOfPacking", "bestBefore",
    "expiryDate", "consumerCarePhone", "consumerCareEmail", "countryOfOrigin",
    "fssaiLicenseNumber", "batchNumber",
  ];

  const normalize = (value) => normalizeText(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const similarity = (a, b) => {
    const left = normalize(a);
    const right = normalize(b);
    if (!left || !right) return 0;
    if (left === right) return 1;
    if (left.includes(right) || right.includes(left)) return 0.92;
    const leftWords = new Set(left.split(" ").filter((x) => x.length > 2));
    const rightWords = new Set(right.split(" ").filter((x) => x.length > 2));
    const intersection = [...leftWords].filter((x) => rightWords.has(x)).length;
    return intersection / Math.max(1, Math.max(leftWords.size, rightWords.size));
  };

  const byImage = new Map();
  for (const item of rapid.evidence || []) {
    if (!item?.boundingBox) continue;
    if (!byImage.has(item.imageIndex)) byImage.set(item.imageIndex, []);
    byImage.get(item.imageIndex).push(item);
  }

  const rows = {};
  for (const key of relevant) {
    const field = normalizeField(fields?.[key]);
    const target = field.value || field.raw || field.evidence || "";
    let best = null;
    for (const item of rapid.evidence || []) {
      if (!item?.boundingBox || (Number.isInteger(field.imageIndex) && item.imageIndex !== field.imageIndex)) continue;
      const score = Math.max(
        similarity(target, item.text),
        similarity(field.raw, item.text),
        similarity(field.evidence, item.text),
      );
      if (score < 0.45) continue;
      if (!best || score > best.score || (score === best.score && item.confidence > best.item.confidence)) best = { item, score };
    }

    const box = best?.item?.boundingBox || null;
    const width = Number(best?.item?.imageWidth || 0);
    const height = Number(best?.item?.imageHeight || 0);
    const lineHeightRatio = box && height ? box.height / height : null;
    const imageKey = best?.item?.imageIndex ?? field.imageIndex ?? 0;
    const imageLines = byImage.get(imageKey) || [];
    const medianHeight = imageLines.length
      ? [...imageLines].map((x) => Number(x.boundingBox?.height || 0)).filter(Boolean).sort((a, b) => a - b)[Math.floor(imageLines.length / 2)]
      : null;
    const relativeSize = box && medianHeight ? box.height / Math.max(1, medianHeight) : null;

    let readability = "NOT_ESTABLISHED";
    if (field.status === "unreadable" || field.status === "ambiguous" || field.confidence < 0.6) readability = "REVIEW";
    else if (box && relativeSize !== null && relativeSize < 0.55) readability = "SMALL_TEXT_REVIEW";
    else if (field.value) readability = "LIKELY_READABLE";

    let fontSizeScreening = "NOT_MEASURED";
    if (box && lineHeightRatio !== null) {
      fontSizeScreening = lineHeightRatio < 0.006 ? "VERY_SMALL_REVIEW" : lineHeightRatio < 0.010 ? "SMALL_TEXT_REVIEW" : "DETECTED";
    }

    let placement = "NOT_LOCATED";
    let zone = null;
    if (box && width && height) {
      const cx = box.left + box.width / 2;
      const cy = box.top + box.height / 2;
      const horizontal = cx < width / 3 ? "LEFT" : cx > (width * 2) / 3 ? "RIGHT" : "CENTER";
      const vertical = cy < height / 3 ? "TOP" : cy > (height * 2) / 3 ? "BOTTOM" : "MIDDLE";
      zone = vertical + "-" + horizontal;
      placement = "LOCATED_FOR_REVIEW";
    }

    rows[key] = {
      field: key,
      value: field.value ?? null,
      status: field.status,
      confidence: field.confidence,
      imageIndex: best?.item?.imageIndex ?? field.imageIndex ?? null,
      readability,
      fontSizeScreening,
      placement,
      zone,
      relativeLineHeight: lineHeightRatio,
      relativeTextSize: relativeSize,
      evidenceText: best?.item?.text || field.raw || field.evidence || null,
    };
  }

  const values = Object.values(rows);
  const summary = {
    fieldsChecked: values.length,
    likelyReadable: values.filter((x) => x.readability === "LIKELY_READABLE").length,
    readabilityReview: values.filter((x) => x.readability === "REVIEW" || x.readability === "SMALL_TEXT_REVIEW").length,
    smallTextReview: values.filter((x) => x.fontSizeScreening === "SMALL_TEXT_REVIEW" || x.fontSizeScreening === "VERY_SMALL_REVIEW").length,
    located: values.filter((x) => x.placement === "LOCATED_FOR_REVIEW").length,
    notLocated: values.filter((x) => x.placement === "NOT_LOCATED").length,
  };

  return {
    disclaimer: "Visual screening is assistive. Relative text-size signals are not a calibrated statutory measurement in millimetres; final font-size and placement compliance must be verified by the inspector against the applicable commodity and display-panel requirements.",
    rows,
    summary,
  };
}

function buildStructuredResult(rapid, aiSemantic = null) {
  const reconciliation = interpretOcrFields({ detections: rapid.evidence, rawText: rapid.rawText });
  const mergedFields = mergeSemanticFields(reconciliation?.fields || {}, aiSemantic?.fields || {}, Boolean(aiSemantic?.enabled));
  const validation = validateSemanticFields(mergedFields, rapid.evidence);
  const fields = validation.fields;
  const result = {};
  for (const key of [
    "productName", "brandName", "manufacturer", "manufacturerAddress", "packer", "packerAddress",
    "marketer", "marketerAddress", "importer", "importerAddress", "netQuantity", "unit", "mrp",
    "currency", "dateOfManufacture", "dateOfPacking", "bestBefore", "expiryDate", "batchNumber",
    "consumerCarePhone", "consumerCareEmail", "countryOfOrigin", "fssaiLicenseNumber", "barcode",
  ]) result[key] = normalizeField(fields[key]);

  const rawDeclarationEvidence = rapid.evidence.filter((item) => item.text).map((item, index) => ({
    id: String(item.id || `ocr-evidence-${index}`),
    imageIndex: Number(item.imageIndex || 0),
    type: "OCR_TEXT",
    text: item.text,
    confidence: Math.max(0, Math.min(1, Number(item.confidence) || 0.55)),
    source: "rapidocr",
    boundingBox: item.boundingBox || null,
    imageWidth: item.imageWidth || null,
    imageHeight: item.imageHeight || null,
  }));
  const declarationEvidence = buildSemanticDeclarationEvidence(fields);
  const presentationChecks = buildPresentationChecks(rapid, fields);

  const warnings = [];
  if (reconciliation?.metadata?.innerPackReference) warnings.push("Package text refers to an individual/inner pack for additional batch, date, price, or related details.");
  if (!aiSemantic?.enabled) warnings.push("All remote AI semantic providers unavailable; using local deterministic field mapping only.");
  if (aiSemantic?.enabled && aiSemantic.providerCount < 3) warnings.push(`Semantic verification used ${aiSemantic.providerCount} available AI provider(s); unavailable providers did not block the scan.`);
  if (presentationChecks.summary.smallTextReview > 0) warnings.push(`Visual screening flagged ${presentationChecks.summary.smallTextReview} declaration(s) for small-text review.`);
  if (presentationChecks.summary.notLocated > 0) warnings.push(`${presentationChecks.summary.notLocated} declaration(s) could not be spatially located from OCR evidence.`);

  const needsReview = Object.values(result).some((field) => field?.status === "unreadable" || field?.status === "ambiguous" || (field?.status === "found" && Number(field.confidence || 0) < 0.6));
  return {
    ...result,
    otherDeclarations: rawDeclarationEvidence.map((item) => item.text),
    declarationEvidence,
    rawOcrEvidence: rawDeclarationEvidence,
    rawText: rapid.rawText,
    warnings,
    unreadableFields: Object.entries(result).filter(([, field]) => field?.status === "unreadable").map(([key]) => key),
    needsReview,
    semanticReconciliation: aiSemantic?.enabled ? { providerCount: aiSemantic.providerCount, providers: aiSemantic.providers } : reconciliation?.metadata || null,
    candidateEvidence: reconciliation?.candidateEvidence || {},
    aiSemantic: aiSemantic?.enabled ? { providerCount: aiSemantic.providerCount, providers: aiSemantic.providers, suggestedCategory: aiSemantic.suggestedCategory } : null,
    suggestedCategory: aiSemantic?.suggestedCategory || null,
    presentationChecks,
  };
}

async function runSemanticProviders({ images, rapid, categoryOptions }) {
  const cloudflareGemma = "@cf/google/gemma-4-26b-a4b-it";
  const cloudflareMoondream = "@cf/moondream/moondream3.1-9B-A2B";
  const providers = [
    { name: "gemini", fn: interpretPackageWithGemini, args: {} },
    { name: "cloudflare-gemma", fn: interpretPackageWithCloudflare, args: { modelOverride: cloudflareGemma, providerName: "cloudflare-gemma" } },
    { name: "cloudflare-moondream", fn: interpretPackageWithCloudflare, args: { modelOverride: cloudflareMoondream, providerName: "cloudflare-moondream" } },
  ];
  const settled = await Promise.all(providers.map(async ({ name, fn, args }) => {
    const started = Date.now();
    try {
      const providerResult = await fn({ images, detections: rapid.evidence, rawText: rapid.rawText, categoryOptions, ...args });
      return { ...providerResult, provider: providerResult?.provider || name, timingMs: Date.now() - started };
    } catch (error) {
      return { enabled: false, provider: name, model: args.modelOverride || null, reason: error?.message || `${name} semantic provider failed.`, timingMs: Date.now() - started };
    }
  }));
  const consensus = reconcileSemanticResults(settled, categoryOptions);
  return { ...consensus, timing: Object.fromEntries(settled.map((provider) => [provider.provider, provider.timingMs])) };
}

async function handleFastAnalyze(req, res, files) {
  const startedAt = Date.now();
  try {
    if (!files.length) return res.status(400).json({ error: { code: "OCR_NO_IMAGES", message: "Upload at least one package image." } });
    const images = await readImages(files);
    let categoryOptions = [];
    try { categoryOptions = JSON.parse(req.body?.categoryOptions || "[]"); if (!Array.isArray(categoryOptions)) categoryOptions = []; } catch { categoryOptions = []; }

    const uploadMs = Date.now() - startedAt;
    const rapidStart = Date.now();
    const rapid = await analyzeWithRapid(images);
    const rapidMs = Date.now() - rapidStart;
    const semanticStart = Date.now();
    const aiSemantic = await runSemanticProviders({ images, rapid, categoryOptions });
    const semanticMs = Date.now() - semanticStart;
    const result = buildStructuredResult(rapid, aiSemantic);
    const totalMs = Date.now() - startedAt;
    const parallelMs = totalMs - uploadMs;

    console.log(
      `[ocr:fast] images=${files.length} evidence=${rapid.evidence.length} rapid=${rapidMs}ms `
      + `semantic=${semanticMs}ms gemini=${aiSemantic.timing?.gemini ?? 0}ms `
      + `cloudflare-gemma=${aiSemantic.timing?.["cloudflare-gemma"] ?? 0}ms `
      + `cloudflare-moondream=${aiSemantic.timing?.["cloudflare-moondream"] ?? 0}ms `
      + `providers=${aiSemantic.providerCount} total=${totalMs}ms`,
    );

    res.json({
      result,
      provider: "rapidocr",
      model: "RapidOCR",
      detectionProvider: "rapidocr",
      detectionProviders: ["rapidocr"],
      rawText: rapid.rawText,
      semantic: aiSemantic.enabled ? { provider: "consensus", providers: aiSemantic.providers, providerCount: aiSemantic.providerCount, enabled: true } : null,
      aiSuggestedCategory: aiSemantic.suggestedCategory || null,
      aiSemanticEnabled: Boolean(aiSemantic.enabled),
      aiSemanticError: aiSemantic.enabled ? null : "No semantic AI provider was available.",
      timing: { uploadMs, rapidMs, semanticMs, geminiMs: aiSemantic.timing?.gemini ?? 0, cloudflareGemmaMs: aiSemantic.timing?.["cloudflare-gemma"] ?? 0, cloudflareMoondreamMs: aiSemantic.timing?.["cloudflare-moondream"] ?? 0, totalMs, parallelMs },
      fallbackReason: result.warnings?.find((item) => item.includes("remote AI semantic providers unavailable")) || null,
    });
  } catch (error) {
    console.error("[ocr:fast]", error);
    const status = error.statusCode || 502;
    res.status(status).json({ error: { code: error.code || "OCR_FAST_ERROR", message: error.message || "Fast OCR analysis failed." } });
  } finally {
    await Promise.all(files.map((file) => fs.unlink(file.path).catch(() => {})));
  }
}

router.post("/analyze", authenticate, upload.array("images", config.maxImages), (req, res) => handleFastAnalyze(req, res, req.files || []));

export default router;
