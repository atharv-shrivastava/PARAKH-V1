import {
  buildSemanticPrompt,
  normalizeSemanticResult,
  parseJsonContent,
} from "./semanticPackageCommon.js";
import { preprocessImagesForAI } from "./imagePreprocessor.js";

function buildGrokPrompt({ detections, rawText, categoryOptions, mode }) {
  const imageOnly = mode === "image";
  const basePrompt = buildSemanticPrompt({
    detections: imageOnly ? [] : detections,
    rawText: imageOnly ? "" : rawText,
    categoryOptions,
  });

  if (imageOnly) {
    return basePrompt + "\n\nEXTRACTION MODE: INDEPENDENT IMAGE-ONLY EXTRACTION" +
      "\n- Inspect only the original package images supplied in this request." +
      "\n- Do NOT use regex candidates, deterministic field output, DataKart, listing text, or catalog knowledge." +
      "\n- Set imageIndex=-1 and evidenceIndex=-1 because RapidOCR geometry is not part of this independent pass.";
  }

  return basePrompt + "\n\nEXTRACTION MODE: RAPIDOCR NORMALIZATION" +
    "\n- RapidOCR text and boxes are raw supporting evidence only." +
    "\n- Re-read the original image before accepting or correcting every value." +
    "\n- Do NOT consume regex-extracted candidate fields. None are supplied to you." +
    "\n- Use evidenceIndex only when it points to the actual RapidOCR detection containing the value.";
}

export async function interpretPackageWithGrok({
  images = [],
  detections = [],
  rawText = "",
  categoryOptions = [],
  signal,
  mode = "image",
} = {}) {
  const apiKey = process.env.GROQ_API_KEY || "";
  const model = process.env.GROK_SEMANTIC_MODEL || "qwen/qwen3.6-27b";
  const sourceKind = mode === "image" ? "grok_image" : "grok_ocr_normalization";

  if (!apiKey) {
    console.warn("[ocr:grok-semantic] SKIPPED provider=groq model=" + model + " mode=" + mode + " reason=GROQ_API_KEY is not configured.");
    return { enabled: false, provider: "grok", model, mode, sourceKind, reason: "GROQ_API_KEY is not configured." };
  }
  if (!images.length) {
    console.warn("[ocr:grok-semantic] SKIPPED provider=groq model=" + model + " reason=No package images supplied.");
    return { enabled: false, provider: "grok", model, mode, sourceKind, reason: "No package images supplied." };
  }

  const prompt = buildGrokPrompt({ detections, rawText, categoryOptions, mode });
  const preparedImages = await preprocessImagesForAI(images);
  const content = [
    {
      type: "text",
      text: prompt +
        "\n\nYou are the independent second semantic verifier for PARAKH V1. Inspect the original package image directly. Never invent missing package text. Preserve printed legal names, addresses, numbers, dates and identifiers exactly. Do not assess legal compliance.",
    },
    ...preparedImages.map(({ base64, mediaType }) => ({
      type: "image_url",
      image_url: { url: "data:" + mediaType + ";base64," + base64 },
    })),
  ];

  try {
    if (signal?.aborted) throw new DOMException("The request was aborted.", "AbortError");

    const startedAt = Date.now();
    console.log("[ocr:grok-semantic] START provider=groq model=" + model + " mode=" + mode + " preparedImages=" + preparedImages.length + " rawOcrProvided=" + Boolean(rawText || detections.length));
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content: "You are an independent package-label evidence verifier for PARAKH V1. Inspect supplied images directly. Return valid JSON only. Never invent missing package text. Preserve printed legal names, addresses, numbers, dates and identifiers exactly. Do not assess legal compliance.",
          },
          { role: "user", content },
        ],
        temperature: 0,
        max_completion_tokens: 2600,
        response_format: { type: "json_object" },
      }),
      signal,
    });

    const elapsedMs = Date.now() - startedAt;
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const reason = data?.error?.message || data?.error || "Groq API returned HTTP " + response.status + ".";
      throw Object.assign(new Error(reason), { statusCode: response.status });
    }

    const output = data?.choices?.[0]?.message?.content;
    const parsed = parseJsonContent(output, { recoverTruncated: true });
    const normalized = normalizeSemanticResult(parsed, categoryOptions);
    const fields = mode === "image"
      ? Object.fromEntries(Object.entries(normalized.fields).map(([key, field]) => [key, { ...field, imageIndex: -1, evidenceIndex: -1 }]))
      : normalized.fields;

    const packageAssessment = parsed?.packageAssessment && typeof parsed.packageAssessment === "object"
      ? {
          status: ["single_package", "multiple_packages", "uncertain"].includes(String(parsed.packageAssessment.status))
            ? String(parsed.packageAssessment.status)
            : "uncertain",
          confidence: Math.max(0, Math.min(1, Number(parsed.packageAssessment.confidence) || 0)),
          evidence: String(parsed.packageAssessment.evidence || "").trim(),
        }
      : { status: "uncertain", confidence: 0, evidence: "Model did not return packageAssessment." };

    console.log("[ocr:grok-semantic] DONE provider=groq model=" + model + " mode=" + mode + " elapsed=" + elapsedMs + "ms");
    return {
      enabled: true,
      provider: "grok",
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
    console.error("[ocr:grok-semantic] FAILED provider=groq model=" + model + " mode=" + mode + " status=" + (error?.statusCode ?? "unknown") + " reason=" + (error?.message || "Qwen/Groq semantic interpretation failed."), error);
    return {
      enabled: false,
      provider: "grok",
      model,
      mode,
      sourceKind,
      reason: error?.message || "Qwen/Groq semantic interpretation failed.",
      statusCode: error?.statusCode ?? null,
    };
  }
}
