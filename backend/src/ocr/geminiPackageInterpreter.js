import { GoogleGenAI } from "@google/genai";
import {
  buildSemanticPrompt,
  buildSemanticSchema,
  normalizeSemanticResult,
  parseJsonContent,
} from "./semanticPackageCommon.js";

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
    return { enabled: true, provider: "gemini", model, fields: normalized.fields, suggestedCategory: normalized.suggestedCategory };
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    console.error(`[ocr:gemini-semantic] FAILED model=${model} status=${error?.status ?? "unknown"} reason=${error?.message || "Gemini semantic interpretation failed."}`, error);
    return { enabled: false, provider: "gemini", model, reason: error?.message || "Gemini semantic interpretation failed." };
  }
}
