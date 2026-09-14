import {
  buildSemanticPrompt,
  normalizeSemanticResult,
  parseJsonContent,
} from "./semanticPackageCommon.js";
import { preprocessImagesForAI } from "./imagePreprocessor.js";

const RICH_PACKAGE_EXTRACTION_PROMPT = `

RICH PACKAGE EXTRACTION:
Besides the canonical Legal Metrology fields, inspect every visible package detail and return a top-level "package_details" object using this structure:
{
  "product_identification": {"brand_name": "String or null", "product_name": "String or null", "net_weight_or_volume": "String or null", "barcode_number": "String or null"},
  "pricing_and_dates": {"mrp": "String or null", "unit_price": "String or null", "date_of_manufacture_or_packing": "String or null", "expiry_or_use_by_date": "String or null", "batch_number": "String or null"},
  "manufacturer_and_support": {"marketed_by": "String or null", "manufactured_by": "String or null", "manufacturing_licenses": ["visible strings"] or null, "customer_care": {"phone": "String or null", "email": "String or null", "website": "String or null", "address": "String or null"}},
  "product_details": {"ingredients": ["visible strings"] or null, "nutritional_information": {"visible label": "visible value"} or null, "claims_and_benefits": ["visible strings"] or null, "usage_or_storage_instructions": ["visible strings"] or null},
  "uncategorized_text": "other prominent visible text or null"
}

RICH EXTRACTION RULES:
- Only transcribe text explicitly visible in the supplied image(s). Never guess, infer, search, or use product databases.
- Preserve original spelling, punctuation, numbers, units, symbols, dates, licence IDs, URLs, emails and phone digits.
- Return null when a requested rich field is not visible or cannot be read reliably.
- Do not merge unrelated text blocks or different legal entities.
- Ingredients and nutrition must be copied from the image. Never add standard ingredients or calculate nutrient values.
- Claims/benefits and usage/storage instructions must be printed package text only, without judging their truth.
- Manufacturing licenses means visible licence/registration identifiers only.
- Multilingual text: preserve the original; add a short English translation in parentheses only when unambiguous.
- net_weight_or_volume may be the human-readable combined value such as "500 g", but canonical downstream netQuantity and unit MUST stay separate.
- Do not put compliance conclusions inside package_details.
`;

export async function interpretPackageWithGrok({ images = [], detections = [], rawText = "", categoryOptions = [], signal } = {}) {
  const apiKey = process.env.XAI_API_KEY || "";
  const model = process.env.GROK_SEMANTIC_MODEL || "grok-4.6";

  if (!apiKey) {
    return { enabled: false, provider: "grok", model, reason: "XAI_API_KEY is not configured." };
  }
  if (!images.length) {
    return { enabled: false, provider: "grok", model, reason: "No package images supplied." };
  }

  const prompt = `${buildSemanticPrompt({ detections, rawText, categoryOptions })}${RICH_PACKAGE_EXTRACTION_PROMPT}`;
  const preparedImages = await preprocessImagesForAI(images);
  const content = [
    { type: "text", text: `${prompt}\n\nYou are the independent second semantic verifier. Inspect the prepared image directly. Do not trust an OCR string merely because it looks plausible. Recheck every digit in MRP, quantity, dates, batch/lot codes, phone numbers, email addresses, FSSAI/license identifiers and GTIN-like numbers. Keep manufacturer, packer, marketer and importer roles separate. When image evidence is insufficient or two plausible readings remain, use status=ambiguous or unreadable instead of guessing. Return package_details only from visible image evidence.` },
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
        max_tokens: 3200,
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
    return { enabled: true, provider: "grok", model, fields: normalized.fields, suggestedCategory: normalized.suggestedCategory, packageDetails: parsed?.package_details || null, timingMs: elapsedMs };
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    return { enabled: false, provider: "grok", model, reason: error?.message || "Grok semantic interpretation failed.", statusCode: error?.statusCode ?? null };
  }
}
