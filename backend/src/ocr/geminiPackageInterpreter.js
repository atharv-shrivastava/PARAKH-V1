import { GoogleGenAI } from "@google/genai";
import {
  buildSemanticPrompt,
  buildSemanticSchema,
  normalizeSemanticResult,
  parseJsonContent,
} from "./semanticPackageCommon.js";
import { interpretOcrFields } from "./ocrFieldInterpreter.js";
import { repairNumericFields } from "./numericFieldRepair.js";

const OCR_PRIORITY_FIELDS = new Set([
  "mrp",
  "netQuantity",
  "unit",
  "dateOfManufacture",
  "dateOfPacking",
  "bestBefore",
  "expiryDate",
  "batchNumber",
  "consumerCarePhone",
  "consumerCareEmail",
  "fssaiLicenseNumber",
  "barcode",
]);

function hasValue(field) {
  return field?.status === "found" && String(field?.value ?? "").trim() !== "";
}

function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
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

    const localHasGeometry = Boolean(localField?.evidence?.length && localField?.evidence?.some?.((item) => item?.boundingBox));
    const localConfidence = Number(localField?.confidence || 0);
    const aiConfidence = Number(geminiField?.confidence || 0);

    if (OCR_PRIORITY_FIELDS.has(key) && localHasGeometry && localConfidence >= aiConfidence) {
      merged[key] = {
        ...localField,
        displayValue: geminiField?.displayValue || localField?.value || "",
        verification: "deterministic-ocr-priority",
        source: "GEMINI_SEMANTIC_PLUS_LOCAL_OCR",
      };
      continue;
    }

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

export async function interpretPackageWithGemini({ images = [], detections = [], rawText = "", categoryOptions = [], signal } = {}) {
  const apiKey = process.env.GEMINI_API_KEY || process.env.OCR_AI_API_KEY || "";
  const model = process.env.GEMINI_SEMANTIC_MODEL || "gemini-3.7-flash";
  const useResponseSchema = String(process.env.GEMINI_USE_RESPONSE_SCHEMA || "false").toLowerCase() === "true";
  if (!apiKey) {
    console.warn(`[ocr:gemini-semantic] SKIPPED model=${model} reason=GEMINI_API_KEY is not configured.`);
    return { enabled: false, provider: "gemini", model, reason: "GEMINI_API_KEY is not configured." };
  }
  const ai = new GoogleGenAI({ apiKey });
  const prompt = buildSemanticPrompt({ detections, rawText, categoryOptions });
  const contents = [
    ...images.map(({ base64, mediaType }) => ({ inlineData: { mimeType: mediaType, data: base64 } })),
    { text: prompt },
  ];

  const request = async () => ai.models.generateContent({
    model,
    contents,
    config: {
      responseMimeType: "application/json",
      ...(useResponseSchema ? { responseSchema: buildSemanticSchema(categoryOptions) } : {}),
      thinkingConfig: { thinkingLevel: "low" },
      maxOutputTokens: 2600,
      temperature: 0,
    },
  });

  try {
    if (signal?.aborted) throw new DOMException("The request was aborted.", "AbortError");

    console.log(`[ocr:gemini-semantic] START model=${model} fields=${Object.keys(buildSemanticSchema(categoryOptions).properties || {}).length}`);
    const startedAt = Date.now();
    const response = await request();
    const elapsedMs = Date.now() - startedAt;
    console.log(`[ocr:gemini-semantic] DONE model=${model} elapsed=${elapsedMs}ms`);

    const parsed = parseJsonContent(response.text || "", { recoverTruncated: true });
    const normalized = normalizeSemanticResult(parsed, categoryOptions);
    const mergedFields = mergeDeterministicEvidence(normalized.fields, detections, rawText);
    return { enabled: true, provider: "gemini", model, fields: mergedFields, suggestedCategory: normalized.suggestedCategory, timingMs: elapsedMs };
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    console.error(`[ocr:gemini-semantic] FAILED model=${model} status=${error?.status ?? "unknown"} reason=${error?.message || "Gemini semantic interpretation failed."}`, error);
    return { enabled: false, provider: "gemini", model, reason: error?.message || "Gemini semantic interpretation failed." };
  }
}
