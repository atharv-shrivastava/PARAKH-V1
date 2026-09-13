import {
  buildSemanticPrompt,
  normalizeSemanticResult,
  parseJsonContent,
} from "./semanticPackageCommon.js";
import { preprocessImagesForAI } from "./imagePreprocessor.js";

export async function interpretPackageWithGrok({ images = [], detections = [], rawText = "", categoryOptions = [], signal } = {}) {
  const apiKey = process.env.XAI_API_KEY || "";
  const model = process.env.GROK_SEMANTIC_MODEL || "grok-4.6";

  if (!apiKey) {
    return { enabled: false, provider: "grok", model, reason: "XAI_API_KEY is not configured." };
  }
  if (!images.length) {
    return { enabled: false, provider: "grok", model, reason: "No package images supplied." };
  }

  const prompt = buildSemanticPrompt({ detections, rawText, categoryOptions });
  const preparedImages = await preprocessImagesForAI(images);
  const content = [
    { type: "text", text: `${prompt}\n\nYou are the independent second semantic verifier. Inspect the prepared image directly. Do not trust an OCR string merely because it looks plausible. Recheck every digit in MRP, quantity, dates, batch/lot codes, phone numbers, email addresses, FSSAI/license identifiers and GTIN-like numbers. Keep manufacturer, packer, marketer and importer roles separate. When image evidence is insufficient or two plausible readings remain, use status=ambiguous or unreadable instead of guessing.` },
    ...preparedImages.map(({ base64, mediaType }) => ({
      type: "image_url",
      image_url: { url: `data:${mediaType};base64,${base64}` },
    })),
  ];

  try {
    if (signal?.aborted) throw new DOMException("The request was aborted.", "AbortError");
    const startedAt = Date.now();
    const response = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: "You are an independent package-label evidence verifier for PARAKH V1. Inspect supplied images directly. Return valid JSON only. Never invent missing package text. Preserve printed legal names, addresses, numbers, dates and identifiers exactly. Do not assess legal compliance." },
          { role: "user", content },
        ],
        temperature: 0,
        max_tokens: 2600,
      }),
      signal,
    });
    const elapsedMs = Date.now() - startedAt;
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const reason = data?.error?.message || data?.error || `Grok API returned HTTP ${response.status}.`;
      throw Object.assign(new Error(reason), { statusCode: response.status });
    }
    const output = data?.choices?.[0]?.message?.content;
    const parsed = parseJsonContent(output, { recoverTruncated: true });
    const normalized = normalizeSemanticResult(parsed, categoryOptions);
    return { enabled: true, provider: "grok", model, fields: normalized.fields, suggestedCategory: normalized.suggestedCategory, timingMs: elapsedMs };
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    return { enabled: false, provider: "grok", model, reason: error?.message || "Grok semantic interpretation failed.", statusCode: error?.statusCode ?? null };
  }
}
