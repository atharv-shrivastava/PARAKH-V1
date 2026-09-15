import {
  buildSemanticPrompt,
  normalizeSemanticResult,
  parseJsonContent,
} from "./semanticPackageCommon.js";
import { interpretOcrFields } from "./ocrFieldInterpreter.js";
import { repairNumericFields } from "./numericFieldRepair.js";
import { preprocessImagesForAI } from "./imagePreprocessor.js";

function buildNormalizedOcrCandidates(detections, rawText) {
  const deterministic = repairNumericFields(
    interpretOcrFields({ detections, rawText })?.fields || {},
    detections,
    rawText,
  );
  return Object.fromEntries(Object.entries(deterministic || {}).map(([key, field]) => [key, {
    value: String(field?.value ?? "").replace(/\s+/g, " ").trim(),
    raw: String(field?.raw ?? "").replace(/\s+/g, " ").trim(),
    evidence: String(field?.evidence ?? "").replace(/\s+/g, " ").trim(),
    status: field?.status || "absent",
    confidence: Number(field?.confidence || 0),
    imageIndex: Number.isInteger(field?.imageIndex) ? field.imageIndex : -1,
    evidenceIndex: Number.isInteger(field?.evidenceIndex) ? field.evidenceIndex : -1,
  }]));
}

export async function interpretPackageWithGrok({ images = [], detections = [], rawText = "", categoryOptions = [], signal } = {}) {
  const apiKey = process.env.XAI_API_KEY || "";
  const model = process.env.GROK_SEMANTIC_MODEL || "grok-4.6";

  if (!apiKey) {
    return { enabled: false, provider: "grok", model, reason: "XAI_API_KEY is not configured." };
  }
  if (!images.length) {
    return { enabled: false, provider: "grok", model, reason: "No package images supplied." };
  }

  const regexCandidates = buildNormalizedOcrCandidates(detections, rawText);
  const prompt = `${buildSemanticPrompt({ detections, rawText, categoryOptions })}\n\nREGEX-NORMALIZED OCR CANDIDATES\nThese are deterministic, format-checked candidate fields derived from the supplied OCR text. They are evidence hints only. Recheck them against the package image and return the normalized value only when the image supports it.\n${JSON.stringify(regexCandidates)}`;
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
    console.log(`[ocr:grok-semantic] START model=${model} preparedImages=${preparedImages.length} regexCandidates=${Object.keys(regexCandidates).length}`);
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
    const packageAssessment = parsed?.packageAssessment && typeof parsed.packageAssessment === "object"
      ? {
          status: ["single_package", "multiple_packages", "uncertain"].includes(String(parsed.packageAssessment.status)) ? String(parsed.packageAssessment.status) : "uncertain",
          confidence: Math.max(0, Math.min(1, Number(parsed.packageAssessment.confidence) || 0)),
          evidence: String(parsed.packageAssessment.evidence || "").trim(),
        }
      : { status: "uncertain", confidence: 0, evidence: "Model did not return packageAssessment." };
    return { enabled: true, provider: "grok", model, fields: normalized.fields, suggestedCategory: normalized.suggestedCategory, packageAssessment, timingMs: elapsedMs };
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    return { enabled: false, provider: "grok", model, reason: error?.message || "Grok semantic interpretation failed.", statusCode: error?.statusCode ?? null };
  }
}
