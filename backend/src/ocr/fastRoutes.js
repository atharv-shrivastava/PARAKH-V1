import "dotenv/config";
import express from "express";
import multer from "multer";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { authenticate } from "../middleware/auth.js";
import { analyzeFontSize } from "./fontSizeAnalyzer.js";
import { verifyPackageImageConsistency } from "./imageConsistencyVerifier.js";
import { interpretPackageWithGemini } from "./geminiPackageInterpreter.js";
import { interpretPackageWithGrok } from "./grokPackageInterpreter.js";
import { interpretOcrFields } from "./ocrFieldInterpreter.js";

const router = express.Router();
router.use(authenticate);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: Number(process.env.OCR_MAX_IMAGES_PER_REQUEST || 6),
    fileSize: Number(process.env.OCR_MAX_IMAGE_SIZE_BYTES || 8 * 1024 * 1024),
  },
});

function parseJson(value, fallback = {}) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string" || !value.trim()) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

async function writeTempImages(files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "parakh-ocr-"));
  const paths = [];
  try {
    for (const [index, file] of (files || []).entries()) {
      const extension = file.mimetype === "image/png" ? ".png" : file.mimetype === "image/webp" ? ".webp" : ".jpg";
      const target = path.join(dir, `${index}-${crypto.randomUUID()}${extension}`);
      await fs.writeFile(target, file.buffer);
      paths.push(target);
    }
    return { dir, paths };
  } catch (error) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function callRapidOcr({ files, categoryOptions }) {
  const baseUrl = String(process.env.RAPIDOCR_URL || process.env.PADDLE_OCR_URL || "http://localhost:8081").replace(/\/$/, "");
  const endpoint = process.env.RAPIDOCR_ANALYZE_PATH || "/api/ocr/analyze";
  const form = new FormData();
  for (const file of files || []) {
    form.append("images", new Blob([file.buffer], { type: file.mimetype || "image/jpeg" }), file.originalname || "package.jpg");
  }
  form.append("categoryOptions", JSON.stringify(categoryOptions || []));

  const response = await fetch(`${baseUrl}${endpoint}`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(Number(process.env.RAPIDOCR_TIMEOUT_MS || 30000)),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error?.message || body?.error || body?.message || `RapidOCR service failed (${response.status}).`);
  if (!body?.result) throw new Error("RapidOCR service returned no structured result.");
  return body;
}

function attachFontSizeAnalysis(result, fontSizeAnalysis) {
  return {
    ...(result && typeof result === "object" ? result : {}),
    fontSizeAnalysis,
  };
}

function imagePayload(files) {
  return (files || []).map((file) => ({
    base64: file.buffer.toString("base64"),
    mediaType: file.mimetype || "image/jpeg",
  }));
}

const ORIGINAL_EXTRACTION_INSTRUCTION = "Perform a flawless, granular OCR extraction on this product packet label. Your sole objective is to capture and classify text for an automated Legal Metrology Rule Engine. Do not assess compliance, do not summarize, and do not omit any words. Extract the exact strings verbatim as they appear on the package, preserving all units (g, kg, ml), symbols (₹, Rs.), punctuation, prefixes, and suffixes. If a component is missing from the packaging, leave its string empty. If the label contains a specific block of text like Consumer Care, extract the entire block into the 'full_raw_text' field, and then break down its individual substrings into the nested fields.";

function buildAiRawText(rawText, regexFields) {
  return [
    rawText,
    "",
    "REGEX / DETERMINISTIC OCR STRUCTURE (supporting evidence only; do not treat as unquestionable truth):",
    JSON.stringify(regexFields || {}, null, 2),
    "",
    "ORIGINAL EXTRACTION INSTRUCTION:",
    ORIGINAL_EXTRACTION_INSTRUCTION,
  ].join("\n");
}

function fieldFound(field) {
  return field?.status === "found" && String(field?.value ?? "").trim() !== "";
}

function numericValue(value) {
  const match = String(value ?? "").replace(/,/g, "").match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

const NUMERIC_FIELDS = new Set([
  "mrp", "netQuantity", "unit", "dateOfManufacture", "dateOfPacking", "bestBefore",
  "expiryDate", "batchNumber", "consumerCarePhone", "consumerCareEmail", "fssaiLicenseNumber",
]);

function normalizeComparable(value) {
  return String(value ?? "").toLowerCase().replace(/[^\p{L}\p{N}.]+/gu, " ").replace(/\s+/g, " ").trim();
}

function valuesAgree(a, b, key) {
  if (!fieldFound(a) || !fieldFound(b)) return false;
  if (key === "mrp" || key === "netQuantity") {
    const left = numericValue(a.value);
    const right = numericValue(b.value);
    return left != null && right != null && left === right;
  }
  return normalizeComparable(a.value) === normalizeComparable(b.value);
}

function cloneField(field) {
  return field && typeof field === "object" ? { ...field } : null;
}

function reconcileAiFields({ regexFields, gemini, grok }) {
  const output = {};
  const allKeys = new Set([
    ...Object.keys(regexFields || {}),
    ...Object.keys(gemini?.fields || {}),
    ...Object.keys(grok?.fields || {}),
  ]);

  for (const key of allKeys) {
    const regex = cloneField(regexFields?.[key]);
    const g = cloneField(gemini?.fields?.[key]);
    const x = cloneField(grok?.fields?.[key]);
    const gf = fieldFound(g);
    const xf = fieldFound(x);
    const rf = fieldFound(regex);

    if (gf && xf && valuesAgree(g, x, key)) {
      const winner = Number(g.confidence || 0) >= Number(x.confidence || 0) ? g : x;
      output[key] = {
        ...winner,
        source: "GEMINI_GROK_AGREEMENT",
        verification: rf && valuesAgree(winner, regex, key) ? "AI_AGREES_WITH_REGEX_OCR" : "AI_CROSS_MODEL_AGREEMENT",
        modelAgreement: true,
      };
      continue;
    }

    if (rf && gf && xf && valuesAgree(regex, g, key) && valuesAgree(regex, x, key)) {
      output[key] = {
        ...regex,
        source: "REGEX_GEMINI_GROK_AGREEMENT",
        verification: "ALL_SOURCES_AGREE",
        modelAgreement: true,
      };
      continue;
    }

    if (rf) {
      const aiMatches = (gf && valuesAgree(regex, g, key) ? 1 : 0) + (xf && valuesAgree(regex, x, key) ? 1 : 0);
      const aiDisagreements = (gf ? (valuesAgree(regex, g, key) ? 0 : 1) : 0) + (xf ? (valuesAgree(regex, x, key) ? 0 : 1) : 0);
      if (aiMatches > 0 && aiDisagreements === 0) {
        output[key] = { ...regex, source: "REGEX_CONFIRMED_BY_AI", verification: "REGEX_AND_AI_AGREE", modelAgreement: true };
        continue;
      }
      if (NUMERIC_FIELDS.has(key) || key === "productName" || key === "brandName") {
        output[key] = { ...regex, source: "REGEX_OCR_PRIORITY", verification: aiDisagreements > 0 ? "AI_CONFLICTS_WITH_REGEX" : "DETERMINISTIC_OCR_FALLBACK", modelAgreement: false };
        continue;
      }
    }

    if (gf && xf) {
      output[key] = Number(g.confidence || 0) >= Number(x.confidence || 0) ? { ...g, source: "GEMINI_HIGHER_CONFIDENCE" } : { ...x, source: "GROK_HIGHER_CONFIDENCE" };
      continue;
    }

    if (gf) {
      output[key] = { ...g, source: "GEMINI_ONLY" };
      continue;
    }
    if (xf) {
      output[key] = { ...x, source: "GROK_ONLY" };
      continue;
    }
    if (rf) output[key] = { ...regex, source: "REGEX_OCR_FALLBACK" };
    else if (g || x || regex) output[key] = g || x || regex;
  }

  return output;
}

function chooseSuggestedCategory(geminiSuggestion, grokSuggestion, regexFields) {
  const geminiId = geminiSuggestion?.categoryId;
  const grokId = grokSuggestion?.categoryId;
  if (geminiId && grokId && String(geminiId) === String(grokId)) return geminiSuggestion;
  if (geminiSuggestion?.confidence >= (grokSuggestion?.confidence || 0)) return geminiSuggestion || grokSuggestion || null;
  return grokSuggestion || geminiSuggestion || null;
}

async function runSemanticMapping({ files, rapidResult, categoryOptions }) {
  const detections = Array.isArray(rapidResult?.declarationEvidence) ? rapidResult.declarationEvidence : [];
  const rawText = String(rapidResult?.rawText || "");
  const regexFields = interpretOcrFields({ detections, rawText })?.fields || {};
  const aiRawText = buildAiRawText(rawText, regexFields);
  const images = imagePayload(files);
  const startedAt = Date.now();

  const results = await Promise.allSettled([
    interpretPackageWithGemini({
      images,
      detections,
      rawText: aiRawText,
      categoryOptions,
      signal: AbortSignal.timeout(Number(process.env.GEMINI_SEMANTIC_TIMEOUT_MS || 30000)),
    }),
    interpretPackageWithGrok({
      images,
      detections,
      rawText: aiRawText,
      categoryOptions,
      signal: AbortSignal.timeout(Number(process.env.GROK_SEMANTIC_TIMEOUT_MS || 30000)),
    }),
  ]);

  const gemini = results[0].status === "fulfilled" ? results[0].value : { enabled: false, provider: "gemini", reason: results[0].reason?.message || "Gemini failed." };
  const grok = results[1].status === "fulfilled" ? results[1].value : { enabled: false, provider: "grok", reason: results[1].reason?.message || "Grok failed." };

  const fields = reconcileAiFields({ regexFields, gemini, grok });
  const suggestedCategory = chooseSuggestedCategory(gemini.suggestedCategory, grok.suggestedCategory, regexFields);
  const errors = [gemini, grok].filter((item) => !item?.enabled && item?.reason).map((item) => `${item.provider}: ${item.reason}`);

  return {
    fields,
    suggestedCategory,
    enabled: Boolean(gemini.enabled || grok.enabled),
    providers: {
      gemini: { enabled: Boolean(gemini.enabled), model: gemini.model || null, timingMs: Number(gemini.timingMs) || 0, error: gemini.reason || null },
      grok: { enabled: Boolean(grok.enabled), model: grok.model || null, timingMs: Number(grok.timingMs) || 0, error: grok.reason || null },
    },
    provider: gemini.enabled && grok.enabled ? "gemini+grok" : gemini.enabled ? "gemini" : grok.enabled ? "grok" : "deterministic",
    error: errors.length ? errors.join(" | ") : null,
    regexFields,
    rawTextForAi: aiRawText,
    timingMs: Date.now() - startedAt,
  };
}

router.post("/analyze", upload.array("images"), async (req, res) => {
  const files = req.files || [];
  let temp = null;
  try {
    if (!files.length) return res.status(400).json({ error: "At least one package image is required." });

    const categoryOptions = parseJson(req.body?.categoryOptions, []);
    const pixelsPerMm = parseJson(req.body?.pixelsPerMm, {});

    const imageConsistency = await verifyPackageImageConsistency({ files });
    if (imageConsistency.blocked) {
      return res.status(409).json({
        error: {
          code: "IMAGE_MISMATCH",
          message: "The uploaded package images appear to belong to different products. Remove the incorrect image(s) and upload only images of the same package.",
          imageConsistency,
        },
      });
    }

    const rapid = await callRapidOcr({ files, categoryOptions });
    const semantic = await runSemanticMapping({ files, rapidResult: rapid.result, categoryOptions });
    const semanticResult = {
      ...(rapid.result || {}),
      ...(semantic.fields || {}),
      aiSuggestedCategory: semantic.suggestedCategory,
      aiSemanticEnabled: semantic.enabled,
      aiSemanticError: semantic.error,
      semanticProvider: semantic.provider,
      semanticProviders: semantic.providers,
      regexMappedFields: semantic.regexFields,
    };

    const tempResult = await writeTempImages(files);
    temp = tempResult;

    let fontSizeAnalysis = {
      status: "NO_MEASURABLE_TEXT",
      measurements: [],
      byField: {},
      errors: [],
      engineSafe: true,
      note: "OpenCV font-size analysis did not receive usable OCR geometry.",
    };

    try {
      fontSizeAnalysis = await analyzeFontSize({
        imagePaths: temp.paths,
        ocr: semanticResult,
        pixelsPerMm,
      });
    } catch (error) {
      fontSizeAnalysis = {
        status: "ERROR",
        measurements: [],
        byField: {},
        errors: [error?.message || "OpenCV font-size analysis failed."],
        engineSafe: true,
      };
    }

    const result = attachFontSizeAnalysis(semanticResult, fontSizeAnalysis);
    const rapidMs = Number(rapid.timingMs) || Number(rapid.engineTimingMs) || 0;
    const geminiMs = Number(semantic.providers?.gemini?.timingMs) || 0;
    const grokMs = Number(semantic.providers?.grok?.timingMs) || 0;
    res.json({
      ...rapid,
      result,
      imageConsistency,
      fontSizeAnalysis,
      fontSizeProvider: "opencv",
      aiSemanticEnabled: semantic.enabled,
      aiSemanticError: semantic.error,
      aiSuggestedCategory: semantic.suggestedCategory,
      semanticProvider: semantic.provider,
      semanticProviders: semantic.providers,
      regexMappedFields: semantic.regexFields,
      timing: {
        rapidOcrMs: rapidMs,
        geminiMs,
        grokMs,
        semanticMs: Math.max(geminiMs, grokMs),
        totalMs: rapidMs + Math.max(geminiMs, grokMs),
        parallelAi: true,
      },
    });
  } catch (error) {
    console.error("[ocr:analyze]", error);
    res.status(502).json({ error: error?.message || "OCR analysis failed." });
  } finally {
    if (temp?.dir) await fs.rm(temp.dir, { recursive: true, force: true }).catch(() => {});
  }
});

export default router;
