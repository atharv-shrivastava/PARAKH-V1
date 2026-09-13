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

async function runSemanticMapping({ files, rapidResult, categoryOptions }) {
  const detections = Array.isArray(rapidResult?.declarationEvidence) ? rapidResult.declarationEvidence : [];
  const rawText = String(rapidResult?.rawText || "");

  const startedAt = Date.now();
  const gemini = await interpretPackageWithGemini({
    images: imagePayload(files),
    detections,
    rawText,
    categoryOptions,
    signal: AbortSignal.timeout(Number(process.env.GEMINI_SEMANTIC_TIMEOUT_MS || 30000)),
  });

  if (gemini.enabled && gemini.fields && typeof gemini.fields === "object") {
    return {
      fields: gemini.fields,
      suggestedCategory: gemini.suggestedCategory || null,
      enabled: true,
      provider: gemini.provider || "gemini",
      model: gemini.model || null,
      error: null,
      timingMs: Number(gemini.timingMs) || (Date.now() - startedAt),
    };
  }

  const deterministic = interpretOcrFields({ detections, rawText })?.fields || {};
  return {
    fields: deterministic,
    suggestedCategory: null,
    enabled: false,
    provider: "deterministic",
    model: null,
    error: gemini.reason || "Gemini semantic interpretation was unavailable.",
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
      semanticModel: semantic.model,
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
    const timingMs = Number(rapid.timingMs) || Number(rapid.engineTimingMs) || 0;
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
      semanticModel: semantic.model,
      timing: {
        rapidOcrMs: timingMs,
        semanticMs: Number(semantic.timingMs) || 0,
        totalMs: timingMs + (Number(semantic.timingMs) || 0),
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
