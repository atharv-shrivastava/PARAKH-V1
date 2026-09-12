import express from "express";
import { authenticate } from "../middleware/auth.js";

const router = express.Router();
const TRANSLATION_MODEL = "@cf/meta/m2m100-1.2b";

const LANGUAGE_CODES = {
  en: "en",
  hi: "hi",
  bn: "bn",
  mr: "mr",
  gu: "gu",
  ta: "ta",
  te: "te",
  kn: "kn",
  ml: "ml",
  pa: "pa",
  or: "or",
  as: "as",
  ur: "ur",
};

function detectSourceLanguage(value) {
  const text = String(value || "");
  if (/[\u0A00-\u0A7F]/u.test(text)) return "pa";
  if (/[\u0980-\u09FF]/u.test(text)) return "bn";
  if (/[\u0A80-\u0AFF]/u.test(text)) return "gu";
  if (/[\u0B00-\u0B7F]/u.test(text)) return /[\u0C00-\u0C7F]/u.test(text) ? "te" : "or";
  if (/[\u0B80-\u0BFF]/u.test(text)) return "ta";
  if (/[\u0C00-\u0C7F]/u.test(text)) return "te";
  if (/[\u0C80-\u0CFF]/u.test(text)) return "kn";
  if (/[\u0D00-\u0D7F]/u.test(text)) return "ml";
  if (/[\u0900-\u097F]/u.test(text)) return /[ळय़]/u.test(text) ? "mr" : "hi";
  if (/[\u0600-\u06FF]/u.test(text)) return "ur";
  return "en";
}

router.use(authenticate);

router.post("/", async (req, res) => {
  const target = String(req.body?.target || "en").trim().toLowerCase();
  const requestedSource = String(req.body?.source || "auto").trim().toLowerCase();
  const texts = Array.isArray(req.body?.texts)
    ? req.body.texts.map((value) => String(value ?? "").trim()).filter(Boolean).slice(0, 80)
    : [];

  if (!texts.length || target === "en") {
    return res.json({ translations: Object.fromEntries(texts.map((text) => [text, text])) });
  }

  const targetLang = LANGUAGE_CODES[target];
  if (!targetLang) {
    return res.json({ translations: Object.fromEntries(texts.map((text) => [text, text])), fallback: true, reason: "Unsupported translation language." });
  }

  const apiToken = process.env.CLOUDFLARE_API_TOKEN || process.env.CLOUDFLARE_AUTH_TOKEN || process.env.CLOUDFLARE_API_KEY || "";
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || "";
  if (!apiToken || !accountId) {
    return res.json({ translations: Object.fromEntries(texts.map((text) => [text, text])), fallback: true, reason: "Cloudflare translation is not configured." });
  }

  const translations = {};
  const failures = [];

  async function translateOne(text) {
    try {
      const source = requestedSource === "auto" || !LANGUAGE_CODES[requestedSource]
        ? detectSourceLanguage(text)
        : requestedSource;
      if (source === targetLang) {
        translations[text] = text;
        return;
      }
      const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/${TRANSLATION_MODEL}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ text, source_lang: source, target_lang: targetLang }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data?.success === false) throw new Error(data?.errors?.map((item) => item?.message).filter(Boolean).join("; ") || `Translation failed (${response.status}).`);
      const value = data?.result?.translated_text ?? data?.result?.response?.translated_text ?? data?.translated_text;
      if (!value || typeof value !== "string") throw new Error("Translation response did not contain translated_text.");
      translations[text] = value;
    } catch (error) {
      translations[text] = text;
      failures.push({ text, error: error?.message || "Translation failed." });
    }
  }

  for (let offset = 0; offset < texts.length; offset += 12) {
    await Promise.all(texts.slice(offset, offset + 12).map(translateOne));
  }

  res.json({ translations, model: TRANSLATION_MODEL, detectedSources: requestedSource === "auto" ? Object.fromEntries(texts.map((text) => [text, detectSourceLanguage(text)])) : undefined, fallback: failures.length > 0, failures: failures.length ? failures : undefined });
});

export default router;
