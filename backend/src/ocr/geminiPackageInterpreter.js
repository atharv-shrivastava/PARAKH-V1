import { GoogleGenAI } from "@google/genai";
import {
  buildSemanticPrompt,
  buildSemanticSchema,
  normalizeSemanticResult,
  parseJsonContent,
} from "./semanticPackageCommon.js";
import { preprocessImagesForAI } from "./imagePreprocessor.js";

function buildGeminiPrompt({ mode, detections, rawText, categoryOptions }) {
  const imageOnly = mode === "image";
  const basePrompt = buildSemanticPrompt({
    detections: imageOnly ? [] : detections,
    rawText: imageOnly ? "" : rawText,
    categoryOptions,
  });

  if (imageOnly) {
    return basePrompt + "\n\nEXTRACTION MODE: INDEPENDENT IMAGE-ONLY EXTRACTION" +
      "\n- This is an independent visual extraction pass." +
      "\n- The only package evidence available to you is the original image set above." +
      "\n- Do NOT rely on regex output, deterministic parser output, DataKart, listing metadata, product catalog knowledge, or inferred product records." +
      "\n- Read every declaration directly from the package image." +
      "\n- Because no RapidOCR geometry was supplied in this pass, set imageIndex=-1 and evidenceIndex=-1 for every field." +
      "\n- A field that cannot be read from the image must be absent, unreadable, or ambiguous rather than guessed." +
      "\n- DATE ROLE DISAMBIGUATION IS MANDATORY:" +
      "\n  * Return four independent date roles: dateOfManufacture, dateOfPacking, bestBefore, and expiryDate." +
      "\n  * NEVER copy, mirror, or reuse one printed date across multiple roles. Each role needs its own visible label/context." +
      "\n  * If the package has only one date and its role is unclear, put that date in NONE of the role fields and mark the affected role absent/ambiguous." +
      "\n  * A bare date such as 03/26 is NOT evidence that it is an expiry date." +
      "\n  * Assign manufacturing date only with context such as manufactured on, MFD, MFG, manufacture date, or an equivalent label." +
      "\n  * Assign packing date only with context such as packed on, packing date, PKD, date of packing, or an equivalent label." +
      "\n  * Assign expiry only with context such as expiry, EXP, expires, use by, or an equivalent label." +
      "\n  * Assign best-before only with context such as best before, use within, shelf life, or an equivalent label. A duration such as \'24 months from packing\' is NOT an expiry date." +
      "\n  * If several different dates are printed, return each one only in the role supported by its own label/group." +
      "\n  * If the same date is deliberately printed for two legally distinct roles, return it twice only when BOTH labels are visibly present and independently support both roles." +
      "\n  * Preserve the exact printed date format in each returned field value."
  }

  return basePrompt + "\n\nEXTRACTION MODE: RAPIDOCR NORMALIZATION WITH VISUAL RECHECK" +
    "\n- The original package images remain the primary source." +
    "\n- RapidOCR text and bounding boxes supplied above are raw OCR evidence only." +
    "\n- Re-read the corresponding image regions and normalize/correct the raw OCR text when the image supports a correction." +
    "\n- Do NOT use or request regex-extracted candidate fields. There are none in this pass." +
    "\n- Do NOT invent missing declarations from product knowledge, external listings, DataKart, or statutory expectations." +
    "\n- Preserve evidenceIndex as the index of the actual RapidOCR detection containing the value. Use -1 when no trustworthy OCR detection matches the normalized value.";
}

function normalizeImageOnlyFields(fields) {
  return Object.fromEntries(Object.entries(fields || {}).map(([key, field]) => [key, {
    ...(field || {}),
    imageIndex: -1,
    evidenceIndex: -1,
  }]));
}

export async function interpretPackageWithGemini({
  images = [],
  detections = [],
  rawText = "",
  categoryOptions = [],
  signal,
  mode = "image",
} = {}) {
  const apiKey = process.env.GEMINI_API_KEY || process.env.OCR_AI_API_KEY || "";
  const model = process.env.GEMINI_SEMANTIC_MODEL || "gemini-3.7-flash";
  const useResponseSchema = String(process.env.GEMINI_USE_RESPONSE_SCHEMA || "false").toLowerCase() === "true";
  const sourceKind = mode === "image" ? "gemini_image" : "gemini_ocr_normalization";

  if (!apiKey) {
    console.warn("[ocr:gemini-semantic] SKIPPED model=" + model + " mode=" + mode + " reason=GEMINI_API_KEY is not configured.");
    return { enabled: false, provider: "gemini", model, mode, sourceKind, reason: "GEMINI_API_KEY is not configured." };
  }

  const ai = new GoogleGenAI({ apiKey });
  const prompt = buildGeminiPrompt({ mode, detections, rawText, categoryOptions });
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
      maxOutputTokens: 2600,
      temperature: 0,
    },
  });

  try {
    if (signal?.aborted) throw new DOMException("The request was aborted.", "AbortError");

    const startedAt = Date.now();
    console.log("[ocr:gemini-semantic] START model=" + model + " mode=" + mode + " preparedImages=" + preparedImages.length + " rawOcrProvided=" + Boolean(rawText || detections.length));
    const response = await request();
    const elapsedMs = Date.now() - startedAt;
    console.log("[ocr:gemini-semantic] DONE model=" + model + " mode=" + mode + " elapsed=" + elapsedMs + "ms");

    const parsed = parseJsonContent(response.text || "", { recoverTruncated: true });
    const normalized = normalizeSemanticResult(parsed, categoryOptions);
    const fields = mode === "image" ? normalizeImageOnlyFields(normalized.fields) : normalized.fields;
    const packageAssessment = parsed?.packageAssessment && typeof parsed.packageAssessment === "object"
      ? {
          status: ["single_package", "multiple_packages", "uncertain"].includes(String(parsed.packageAssessment.status))
            ? String(parsed.packageAssessment.status)
            : "uncertain",
          confidence: Math.max(0, Math.min(1, Number(parsed.packageAssessment.confidence) || 0)),
          evidence: String(parsed.packageAssessment.evidence || "").trim(),
        }
      : { status: "uncertain", confidence: 0, evidence: "Model did not return packageAssessment." };

    return {
      enabled: true,
      provider: "gemini",
      model,
      mode,
      sourceKind,
      fields,
      suggestedCategory: normalized.suggestedCategory,
      packageAssessment,
      timingMs: elapsedMs,
    };
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    console.error("[ocr:gemini-semantic] FAILED model=" + model + " mode=" + mode + " status=" + (error?.status ?? "unknown") + " reason=" + (error?.message || "Gemini semantic interpretation failed."), error);
    return {
      enabled: false,
      provider: "gemini",
      model,
      mode,
      sourceKind,
      reason: error?.message || "Gemini semantic interpretation failed.",
    };
  }
}
