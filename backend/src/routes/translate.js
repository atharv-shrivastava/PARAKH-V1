import express from "express";
import { authenticate } from "../middleware/auth.js";

const router = express.Router();
const TRANSLATION_MODEL = "@cf/meta/m2m100-1.2b";
const GEMINI_TRANSLATION_MODEL = process.env.GEMINI_TRANSLATION_MODEL || process.env.GEMINI_SEMANTIC_MODEL || "gemini-3.7-flash";

const LANGUAGE_CODES = {
  en: "en", hi: "hi", bn: "bn", mr: "mr", gu: "gu", ta: "ta", te: "te", kn: "kn", ml: "ml", pa: "pa", or: "or", as: "as", ur: "ur",
};

const LANGUAGE_NAMES = {
  en: "English", hi: "Hindi", bn: "Bengali", mr: "Marathi", gu: "Gujarati", ta: "Tamil", te: "Telugu", kn: "Kannada", ml: "Malayalam", pa: "Punjabi", or: "Odia", as: "Assamese", ur: "Urdu",
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

function identityMap(texts) {
  return Object.fromEntries(texts.map((text) => [text, text]));
}

function parseJsonPayload(value) {
  const source = String(value || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  try { return JSON.parse(source); } catch { return null; }
}

async function translateWithGemini(texts, targetLang) {
  const apiKey = process.env.GEMINI_API_KEY || process.env.OCR_AI_API_KEY || "";
  if (!apiKey) return { translations: identityMap(texts), failures: texts.map((text) => ({ text, error: "Gemini translation is not configured." })) };

  const targetName = LANGUAGE_NAMES[targetLang] || targetLang;
  const items = texts.map((text, index) => ({ id: index + 1, text }));
  const prompt = [
    `Translate each UI/product string into ${targetName}.`,
    "Detect the source language of each string automatically.",
    "Preserve numbers, dates, units, barcodes, GTINs, emails, URLs, licence identifiers and product codes exactly.",
    "Do not translate the brand name PARAKH.",
    "Do not add explanations.",
    'Return only JSON in this exact shape: {"translations":[{"id":1,"text":"translated text"}]}',
    JSON.stringify(items),
  ].join("\n");

  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_TRANSLATION_MODEL)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0, responseMimeType: "application/json" } }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error?.message || `Gemini translation failed (${response.status}).`);
    const raw = data?.candidates?.[0]?.content?.parts?.map((part) => part?.text || "").join("") || "";
    const parsed = parseJsonPayload(raw);
    const translations = identityMap(texts);
    const failures = [];
    const rows = Array.isArray(parsed?.translations) ? parsed.translations : [];
    for (const row of rows) {
      const id = Number(row?.id);
      const text = typeof row?.text === "string" ? row.text.trim() : "";
      if (!Number.isInteger(id) || id < 1 || id > texts.length || !text) continue;
      translations[items[id - 1].text] = text;
    }
    for (const text of texts) if (translations[text] === text && text.trim()) failures.push({ text, error: "Gemini did not return a translated value." });
    return { translations, failures };
  } catch (error) {
    return { translations: identityMap(texts), failures: texts.map((text) => ({ text, error: error?.message || "Gemini translation failed." })) };
  }
}

router.use(authenticate);

router.post("/", async (req, res) => {
  const target = String(req.body?.target || "en").trim().toLowerCase();
  const requestedSource = String(req.body?.source || "auto").trim().toLowerCase();
  const texts = Array.isArray(req.body?.texts)
    ? req.body.texts.map((value) => String(value ?? "").trim()).filter(Boolean).slice(0, 80)
    : [];

  if (!texts.length || target === "en") return res.json({ translations: identityMap(texts) });

  const targetLang = LANGUAGE_CODES[target];
  if (!targetLang) return res.json({ translations: identityMap(texts), fallback: true, reason: "Unsupported translation language." });

  const apiToken = process.env.CLOUDFLARE_API_TOKEN || process.env.CLOUDFLARE_AUTH_TOKEN || process.env.CLOUDFLARE_API_KEY || "";
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || "";
  const translations = {};
  const failures = [];

  async function translateOne(text) {
    if (!apiToken || !accountId) return;
    try {
      const source = requestedSource === "auto" || !LANGUAGE_CODES[requestedSource] ? detectSourceLanguage(text) : requestedSource;
      if (source === targetLang) { translations[text] = text; return; }
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
      failures.push({ text, error: error?.message || "Translation failed." });
    }
  }

  for (let offset = 0; offset < texts.length; offset += 12) await Promise.all(texts.slice(offset, offset + 12).map(translateOne));

  const missing = texts.filter((text) => typeof translations[text] !== "string");
  if (missing.length) {
    const gemini = await translateWithGemini(missing, targetLang);
    Object.assign(translations, gemini.translations);
    failures.push(...gemini.failures);
  }

  for (const text of texts) if (typeof translations[text] !== "string") translations[text] = text;

  res.json({
    translations,
    model: missing.length && (!apiToken || !accountId) ? GEMINI_TRANSLATION_MODEL : TRANSLATION_MODEL,
    detectedSources: requestedSource === "auto" ? Object.fromEntries(texts.map((text) => [text, detectSourceLanguage(text)])) : undefined,
    fallback: failures.length > 0,
    failures: failures.length ? failures : undefined,
  });
});

export default router;
