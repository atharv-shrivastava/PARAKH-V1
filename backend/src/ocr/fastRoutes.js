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
function normalizeComparable(value) { return text(value).toLowerCase().replace(/[^a-z0-9@.+-]+/g, " ").replace(/\s+/g, " ").trim(); }

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

function candidateEvidence(field, evidence) {
  const raw = [field?.value, field?.raw, field?.evidence].map(normalizeComparable).filter(Boolean);
  if (!raw.length) return null;
  let best = null;
  for (const item of evidence) {
    const candidate = normalizeComparable(item.text);
    if (!candidate) continue;
    const exact = raw.some((needle) => candidate === needle || candidate.includes(needle) || needle.includes(candidate));
    const tokenOverlap = raw.reduce((score, needle) => {
      const tokens = new Set(needle.split(" ").filter((token) => token.length > 1));
      const matches = [...tokens].filter((token) => candidate.includes(token)).length;
      return Math.max(score, tokens.size ? matches / tokens.size : 0);
    }, 0);
    const score = exact ? 1 : tokenOverlap;
    if (!best || score > best.score || (score === best.score && item.confidence > best.item.confidence)) best = { item, score };
  }
  return best?.score >= 0.5 ? best.item : null;
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
    next.consumerCareEmail = {
      ...(next.consumerCareEmail || {}), value: emailCandidate.value, displayValue: emailCandidate.value,
      raw: emailCandidate.item.text, evidence: emailCandidate.item.text,
      confidence: Math.max(Number(next.consumerCareEmail?.confidence || 0), Number(emailCandidate.item.confidence || 0) * 0.92), status: "found",
      imageIndex: Number.isInteger(emailCandidate.item.imageIndex) ? emailCandidate.item.imageIndex : 0,
      evidenceIndex: Number.isInteger(emailCandidate.item.evidenceIndex) ? emailCandidate.item.evidenceIndex : -1,
      boundingBox: emailCandidate.item.boundingBox || null, imageWidth: emailCandidate.item.imageWidth || null, imageHeight: emailCandidate.item.imageHeight || null,
      source: "REGEX_OCR_REPAIR", verification: "email-format-validated",
    };
  } else if (currentEmail && !EMAIL_RE.test(currentEmail)) {
    next.consumerCareEmail = { ...(next.consumerCareEmail || {}), value: null, displayValue: "", status: "ambiguous", verification: "rejected-invalid-email" };
  }

  const currentPhone = text(next.consumerCarePhone?.value);
  const phoneCandidate = regexEvidence(MOBILE_RE, evidence) || regexEvidence(TOLL_FREE_RE, evidence) || regexEvidence(MOBILE_RE, fallbackEvidence) || regexEvidence(TOLL_FREE_RE, fallbackEvidence);
  if (currentPhone && !MOBILE_RE.test(currentPhone) && !TOLL_FREE_RE.test(currentPhone) && phoneCandidate) {
    next.consumerCarePhone = {
      ...(next.consumerCarePhone || {}), value: phoneCandidate.value, displayValue: phoneCandidate.value,
      raw: phoneCandidate.item.text, evidence: phoneCandidate.item.text,
      confidence: Math.max(Number(next.consumerCarePhone?.confidence || 0), Number(phoneCandidate.item.confidence || 0) * 0.92), status: "found",
      imageIndex: Number.isInteger(phoneCandidate.item.imageIndex) ? phoneCandidate.item.imageIndex : 0,
      evidenceIndex: Number.isInteger(phoneCandidate.item.evidenceIndex) ? phoneCandidate.item.evidenceIndex : -1,
      boundingBox: phoneCandidate.item.boundingBox || null, imageWidth: phoneCandidate.item.imageWidth || null, imageHeight: phoneCandidate.item.imageHeight || null,
      source: "REGEX_OCR_REPAIR", verification: "phone-format-validated",
    };
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
    const provided = Number.isInteger(field.evidenceIndex) && evidence[field.evidenceIndex] ? evidence[field.evidenceIndex] : null;
    const item = provided || candidateEvidence(field, evidence);
    if (!item) return [key, field];
    return [key, { ...field, evidence: item.text, imageIndex: item.imageIndex, evidenceIndex: item.evidenceIndex, boundingBox: item.boundingBox || null, imageWidth: item.imageWidth || null, imageHeight: item.imageHeight || null, rapidOcrConfidence: item.confidence }];
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
  return { ...consensus, timingMs: Date.now() - startedAt, timing: Object.fromEntries(settled.map((provider) => [provider.provider, provider.timingMs || 0])) };
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
    const repaired = regexRepairFields(semantic.fields, rapid.evidence, rapid.rawText);
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
