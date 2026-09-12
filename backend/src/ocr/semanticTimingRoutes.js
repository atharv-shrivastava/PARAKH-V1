import "dotenv/config";
import express from "express";
import multer from "multer";
import { authenticate } from "../middleware/auth.js";
import { interpretPackageWithGemini } from "./geminiPackageInterpreter.js";
import { interpretPackageWithGrok } from "./grokPackageInterpreter.js";

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 8, fileSize: 15 * 1024 * 1024 },
});

function toImages(files = []) {
  return files.map((file) => ({
    base64: file.buffer.toString("base64"),
    mediaType: file.mimetype,
  }));
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

router.post("/semantic-timing", authenticate, upload.array("images", 8), async (req, res) => {
  const images = toImages(req.files || []);
  const detections = parseJson(req.body?.detections, []);
  const rawText = String(req.body?.rawText || "");
  const categoryOptions = parseJson(req.body?.categoryOptions, []);

  if (!images.length) {
    return res.status(400).json({
      error: {
        code: "SEMANTIC_TIMING_NO_IMAGES",
        message: "Upload at least one package image.",
      },
    });
  }

  const providers = [
    {
      name: "gemini",
      run: () => interpretPackageWithGemini({ images, detections, rawText, categoryOptions }),
    },
    {
      name: "grok",
      run: () => interpretPackageWithGrok({ images, detections, rawText, categoryOptions }),
    },
  ];

  const startedAt = Date.now();
  const settled = await Promise.all(providers.map(async ({ name, run }) => {
    const providerStartedAt = Date.now();
    try {
      const result = await run();
      return {
        ...result,
        provider: result?.provider || name,
        timingMs: Date.now() - providerStartedAt,
      };
    } catch (error) {
      return {
        enabled: false,
        provider: name,
        reason: error?.message || `${name} failed.`,
        timingMs: Date.now() - providerStartedAt,
      };
    }
  }));

  const totalMs = Date.now() - startedAt;
  const timing = Object.fromEntries(settled.map((item) => [item.provider, item.timingMs]));
  const geminiMs = timing.gemini ?? 0;
  const grokMs = timing.grok ?? 0;

  console.log(
    `[semantic-timing] gemini=${geminiMs}ms grok=${grokMs}ms totalParallel=${totalMs}ms images=${images.length}`,
  );

  return res.json({
    timing: {
      geminiMs,
      grokMs,
      totalParallelMs: totalMs,
      fasterProvider: geminiMs > 0 && grokMs > 0 ? (geminiMs <= grokMs ? "gemini" : "grok") : null,
      differenceMs: geminiMs > 0 && grokMs > 0 ? Math.abs(geminiMs - grokMs) : null,
    },
    providers: settled.map(({ provider, model, enabled, reason, timingMs }) => ({
      provider,
      model: model || null,
      enabled: Boolean(enabled),
      timingMs,
      reason: reason || null,
    })),
  });
});

export default router;
