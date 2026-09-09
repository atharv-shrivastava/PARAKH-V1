import {
  buildSemanticPrompt,
  normalizeSemanticResult,
  parseJsonContent,
} from "./semanticPackageCommon.js";

function combineSignals(signal, timeoutMs = 30000) {
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), timeoutMs);
  if (signal && typeof AbortSignal?.any === "function") {
    return { signal: AbortSignal.any([signal, timeoutController.signal]), cleanup: () => clearTimeout(timeoutId) };
  }
  return { signal: timeoutController.signal, cleanup: () => clearTimeout(timeoutId) };
}

export async function interpretPackageWithQwen({ images = [], detections = [], rawText = "", categoryOptions = [], signal } = {}) {
  const baseUrl = String(process.env.QWEN_OLLAMA_URL || "").replace(/\/+$/, "");
  const model = process.env.QWEN_OLLAMA_MODEL || "qwen2.5vl:3b";

  if (!baseUrl) {
    return {
      enabled: false,
      provider: "qwen-ollama",
      model,
      reason: "QWEN_OLLAMA_URL is not configured.",
    };
  }

  if (!images.length) {
    return {
      enabled: false,
      provider: "qwen-ollama",
      model,
      reason: "No package images supplied.",
    };
  }

  const prompt = buildSemanticPrompt({ detections, rawText, categoryOptions });
  const request = combineSignals(signal, Number(process.env.QWEN_OLLAMA_TIMEOUT_MS || 30000));

  try {
    if (request.signal?.aborted) throw new DOMException("The request was aborted.", "AbortError");

    // Send the ORIGINAL package images to Qwen. Do not send only OCR text or a
    // derived contact sheet: Qwen is an independent multimodal verifier.
    const body = {
      model,
      messages: [{
        role: "user",
        content: prompt,
        images: images.map(({ base64 }) => base64),
      }],
      stream: false,
      format: "json",
      options: {
        temperature: 0,
        num_predict: 1800,
      },
    };

    const response = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: request.signal,
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data?.error || data?.message || `Ollama Qwen request failed (${response.status}).`);
    }

    const content = data?.message?.content || data?.response || "";
    const parsed = parseJsonContent(content, { recoverTruncated: true });
    const normalized = normalizeSemanticResult(parsed, categoryOptions);

    return {
      enabled: true,
      provider: "qwen-ollama",
      model,
      fields: normalized.fields,
      suggestedCategory: normalized.suggestedCategory,
    };
  } catch (error) {
    if (error?.name === "AbortError") {
      return {
        enabled: false,
        provider: "qwen-ollama",
        model,
        reason: "Qwen/Ollama request timed out or was aborted.",
      };
    }
    console.error(`[ocr:qwen-ollama-semantic] FAILED model=${model} reason=${error?.message || "Qwen semantic interpretation failed."}`);
    return {
      enabled: false,
      provider: "qwen-ollama",
      model,
      reason: error?.message || "Qwen semantic interpretation failed.",
    };
  } finally {
    request.cleanup();
  }
}
