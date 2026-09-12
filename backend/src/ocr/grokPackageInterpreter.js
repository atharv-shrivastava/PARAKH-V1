import {
  buildSemanticPrompt,
  normalizeSemanticResult,
  parseJsonContent,
} from "./semanticPackageCommon.js";

export async function interpretPackageWithGrok({ images = [], detections = [], rawText = "", categoryOptions = [], signal } = {}) {
  const apiKey = process.env.XAI_API_KEY || "";
  const model = process.env.GROK_SEMANTIC_MODEL || "grok-4.6";

  if (!apiKey) {
    return {
      enabled: false,
      provider: "grok",
      model,
      reason: "XAI_API_KEY is not configured.",
    };
  }

  if (!images.length) {
    return {
      enabled: false,
      provider: "grok",
      model,
      reason: "No package images supplied.",
    };
  }

  const prompt = buildSemanticPrompt({ detections, rawText, categoryOptions });
  const content = [
    { type: "text", text: prompt },
    ...images.map(({ base64, mediaType }) => ({
      type: "image_url",
      image_url: { url: `data:${mediaType};base64,${base64}` },
    })),
  ];

  try {
    if (signal?.aborted) throw new DOMException("The request was aborted.", "AbortError");

    const response = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: "Return compact valid JSON only. No markdown or commentary." },
          { role: "user", content },
        ],
        temperature: 0,
        max_tokens: 1800,
      }),
      signal,
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const reason = data?.error?.message || data?.error || `Grok API returned HTTP ${response.status}.`;
      throw Object.assign(new Error(reason), { statusCode: response.status });
    }

    const output = data?.choices?.[0]?.message?.content;
    const parsed = parseJsonContent(output, { recoverTruncated: true });
    const normalized = normalizeSemanticResult(parsed, categoryOptions);

    return {
      enabled: true,
      provider: "grok",
      model,
      fields: normalized.fields,
      suggestedCategory: normalized.suggestedCategory,
    };
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    return {
      enabled: false,
      provider: "grok",
      model,
      reason: error?.message || "Grok semantic interpretation failed.",
      statusCode: error?.statusCode ?? null,
    };
  }
}
