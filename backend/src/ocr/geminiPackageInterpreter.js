import { GoogleGenAI } from "@google/genai";
import {
  buildSemanticPrompt,
  buildSemanticSchema,
  normalizeSemanticResult,
  parseJsonContent,
} from "./semanticPackageCommon.js";
import { interpretOcrFields } from "./ocrFieldInterpreter.js";
import { repairNumericFields } from "./numericFieldRepair.js";
import { preprocessImagesForAI } from "./imagePreprocessor.js";

function hasValue(field) {
  return field?.status === "found" && String(field?.value ?? "").trim() !== "";
}

function mergeDeterministicEvidence(geminiFields, detections, rawText) {
  const deterministic = repairNumericFields(interpretOcrFields({ detections, rawText })?.fields || {}, detections, rawText);
  const merged = {};

  for (const [key, geminiField] of Object.entries(geminiFields || {})) {
    const localField = deterministic[key];
    const aiFound = hasValue(geminiField);
    const localFound = hasValue(localField);

    if (!localFound) {
      merged[key] = geminiField;
      continue;
    }

    if (!aiFound) {
      merged[key] = {
        ...localField,
        displayValue: geminiField?.displayValue || localField?.value || "",
        verification: "deterministic-ocr-fallback",
        source: "GEMINI_SEMANTIC_PLUS_LOCAL_OCR",
      };
      continue;
    }

    // Gemini is the semantic interpreter. Local OCR supplies geometry and raw
    // evidence only; it must not replace a Gemini reading just because OCR has
    // a higher character confidence. This is especially important for numbers
    // such as 500 g vs 250, where OCR may confidently read the wrong token.
    merged[key] = {
      ...geminiField,
      displayValue: geminiField?.displayValue || geminiField?.value || localField?.value || "",
      raw: geminiField?.raw || localField?.raw || null,
      evidence: geminiField?.evidence || localField?.raw || localField?.evidence?.[0]?.text || null,
      imageIndex: Number.isInteger(geminiField?.imageIndex) ? geminiField.imageIndex : localField?.imageIndex,
      evidenceIndex: Number.isInteger(geminiField?.evidenceIndex) ? geminiField.evidenceIndex : localField?.evidenceIndex,
      verification: "semantic-confirmed-by-local-ocr",
      source: "GEMINI_SEMANTIC_PLUS_LOCAL_OCR",
    };
  }

  return merged;
}

const RICH_PACKAGE_EXTRACTION_PROMPT = `

RICH PACKAGE EXTRACTION CONTRACT
In addition to the canonical Legal Metrology fields, inspect the package for all other visible consumer-facing information. Return it under a top-level JSON key named "package_details".

Use this exact structure:
{
  "product_identification": {
    "brand_name": "String or null",
    "product_name": "String or null",
    "net_weight_or_volume": "String or null",
    "barcode_number": "String or null"
  },
  "pricing_and_dates": {
    "mrp": "String or null",
    "unit_price": "String or null",
    "date_of_manufacture_or_packing": "String or null",
    "expiry_or_use_by_date": "String or null",
    "batch_number": "String or null"
  },
  "manufacturer_and_support": {
    "marketed_by": "String or null",
    "manufactured_by": "String or null",
    "manufacturing_licenses": ["Array of visible strings"] or null,
    "customer_care": {
      "phone": "String or null",
      "email": "String or null",
      "website": "String or null",
      "address": "String or null"
    }
  },
  "product_details": {
    "ingredients": ["Array of visible strings"] or null,
    "nutritional_information": {"visible label": "visible value"} or null,
    "claims_and_benefits": ["Array of visible strings"] or null,
    "usage_or_storage_instructions": ["Array of visible strings"] or null
  },
  "uncategorized_text": "Any other prominent visible text or null"
}

STRICT RICH EXTRACTION RULES:
1. Only transcribe text explicitly visible in the supplied image(s). Never guess, infer, search, or fill from product databases.
2. Preserve spelling, punctuation, numbers, units, symbols, dates, licence identifiers, URLs, emails and phone digits exactly as printed whenever readable.
3. Do not merge unrelated text blocks. Keep manufacturer, marketer, customer-care and address blocks distinct.
4. For nutritional_information, copy the visible label/value pairs as printed. Do not calculate calories, percentages, serving sizes or nutrient values that are not explicitly visible.
5. For ingredients, preserve the visible sequence and wording as closely as possible. Do not add standard ingredients from product knowledge.
6. For claims_and_benefits, extract printed marketing/benefit statements only. Do not judge whether the claims are true.
7. For usage_or_storage_instructions, extract printed preparation, usage, handling, storage and warning instructions only.
8. For manufacturing_licenses, include visible licence/registration identifiers such as FSSAI, licence numbers or other regulatory IDs, but do not relabel unrelated numbers as licences.
9. If a field is not visible or is too blurry to read reliably, return null for that field. Never invent partial text.
10. Multilingual text: preserve the original text. You may append a short English translation in parentheses only when the original wording remains intact and the translation is unambiguous.
11. IMPORTANT: net_weight_or_volume may contain the human-readable combined text such as "500 g". The canonical downstream fields netQuantity and unit MUST remain separate.
12. Do not output compliance findings, legal conclusions or inferred violations inside package_details.
`;

export async function interpretPackageWithGemini({ images = [], detections = [], rawText = "", categoryOptions = [], signal } = {}) {
  const apiKey = process.env.GEMINI_API_KEY || process.env.OCR_AI_API_KEY || "";
  const model = process.env.GEMINI_SEMANTIC_MODEL || "gemini-3.7-flash";
  const useResponseSchema = String(process.env.GEMINI_USE_RESPONSE_SCHEMA || "false").toLowerCase() === "true";
  if (!apiKey) {
    console.warn(`[ocr:gemini-semantic] SKIPPED model=${model} reason=GEMINI_API_KEY is not configured.`);
    return { enabled: false, provider: "gemini", model, reason: "GEMINI_API_KEY is not configured." };
  }

  const ai = new GoogleGenAI({ apiKey });
  const prompt = `${buildSemanticPrompt({ detections, rawText, categoryOptions })}${RICH_PACKAGE_EXTRACTION_PROMPT}`;
  const preparedImages = await preprocessImagesForAI(images);
  const contents = [
    ...preparedImages.map(({ base64, mediaType }) => ({ inlineData: { mimeType: mediaType, data: base64 } })),
    { text: prompt },
  ];

  const request = async () => ai.models.generateContent({
    model,
    contents,
    config: {
      responseMimeType: "application/json",
      ...(useResponseSchema ? { responseSchema: buildSemanticSchema(categoryOptions) } : {}),
      thinkingConfig: { thinkingLevel: "low" },
      maxOutputTokens: 3200,
      temperature: 0,
    },
  });

  try {
    if (signal?.aborted) throw new DOMException("The request was aborted.", "AbortError");

    console.log(`[ocr:gemini-semantic] START model=${model} preparedImages=${preparedImages.length}`);
    const startedAt = Date.now();
    const response = await request();
    const elapsedMs = Date.now() - startedAt;
    console.log(`[ocr:gemini-semantic] DONE model=${model} elapsed=${elapsedMs}ms`);

    const parsed = parseJsonContent(response.text || "", { recoverTruncated: true });
    const normalized = normalizeSemanticResult(parsed, categoryOptions);
    const mergedFields = mergeDeterministicEvidence(normalized.fields, detections, rawText);
    return {
      enabled: true,
      provider: "gemini",
      model,
      fields: mergedFields,
      suggestedCategory: normalized.suggestedCategory,
      packageDetails: parsed?.package_details || null,
      timingMs: elapsedMs,
    };
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    console.error(`[ocr:gemini-semantic] FAILED model=${model} status=${error?.status ?? "unknown"} reason=${error?.message || "Gemini semantic interpretation failed."}`, error);
    return { enabled: false, provider: "gemini", model, reason: error?.message || "Gemini semantic interpretation failed." };
  }
}
