import { GoogleGenAI } from "@google/genai";
import {
  buildSemanticPrompt,
  buildSemanticSchema,
  normalizeSemanticResult,
  parseJsonContent,
} from "./semanticPackageCommon.js";
import { interpretOcrFields } from "./ocrFieldInterpreter.js";

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
  const deterministic = interpretOcrFields({ detections, rawText })?.fields || {};
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

    // Numeric/regulatory fields benefit from exact OCR anchoring. Gemini remains
    // the semantic interpreter, but it should not replace a directly detected
    // MRP, quantity, date, batch, FSSAI or contact value with "absent" or a
    // weaker guess. Prefer the local value when it has stronger deterministic
    // confidence and a concrete OCR evidence box.
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

    // Keep Gemini semantics, but attach deterministic evidence when both
    // providers independently found the field. This gives downstream evidence
    // validation something concrete to match against.
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

  const request = async (withSchema) => ai.models.generateContent({
    model,
    contents,
    config: {
      responseMimeType: "application/json",
      ...(withSchema ? { responseSchema: buildSemanticSchema(categoryOptions) } : {}),
      thinkingConfig: { thinkingLevel: "low" },
      maxOutputTokens: 1800,
    },
  });

  try {
    if (signal?.aborted) throw new DOMException("The request was aborted.", "AbortError");

    let response;
    try {
      response = await request(true);
    } catch (error) {
      // A 400 here is commonly a request/schema validation failure. Retry with
      // JSON MIME enforcement but without the structured schema, then validate
      // the returned object ourselves. This keeps semantic mapping alive while
      // remaining compatible with Gemini API schema restrictions.
      if (Number(error?.status) !== 400) throw error;
      console.warn(`[ocr:gemini-semantic] Structured schema rejected; retrying JSON-only model=${model}`);
      response = await request(false);
    }

    const parsed = parseJsonContent(response.text || "", { recoverTruncated: true });
    const normalized = normalizeSemanticResult(parsed, categoryOptions);
    const mergedFields = mergeDeterministicEvidence(normalized.fields, detections, rawText);
    return { enabled: true, provider: "gemini", model, fields: mergedFields, suggestedCategory: normalized.suggestedCategory };
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    console.error(`[ocr:gemini-semantic] FAILED model=${model} status=${error?.status ?? "unknown"} reason=${error?.message || "Gemini semantic interpretation failed."}`, error);
    return { enabled: false, provider: "gemini", model, reason: error?.message || "Gemini semantic interpretation failed." };
  }
}
