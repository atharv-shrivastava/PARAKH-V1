import sharp from "sharp";
import {
  buildSemanticPrompt,
  buildSemanticSchema,
  normalizeSemanticResult,
  parseJsonContent,
} from "./semanticPackageCommon.js";
import { interpretPackageWithQwen } from "./qwenPackageInterpreter.js";

async function buildContactSheet(images) {
  if (!images.length) return null;
  const width = 900;
  const rendered = [];
  let totalHeight = 0;
  for (const image of images) {
    const buffer = Buffer.from(image.base64, "base64");
    const output = await sharp(buffer, { failOn: "none" })
      .resize({ width, height: width, fit: "inside", withoutEnlargement: false })
      .jpeg({ quality: 70, chromaSubsampling: "4:2:0" })
      .toBuffer();
    const meta = await sharp(output).metadata();
    const height = Number(meta.height || 1);
    rendered.push({ input: output, left: 0, top: totalHeight });
    totalHeight += height + 4;
  }
  const sheet = await sharp({
    create: { width, height: Math.max(1, totalHeight), channels: 3, background: { r: 255, g: 255, b: 255 } },
  }).composite(rendered).jpeg({ quality: 70, chromaSubsampling: "4:2:0" }).toBuffer();
  return `data:image/jpeg;base64,${sheet.toString("base64")}`;
}

export async function interpretPackageWithCloudflare({
  images = [], detections = [], rawText = "", categoryOptions = [], signal,
  modelOverride = null, providerName = "cloudflare",
} = {}) {
  // Preserve the existing provider slot while using it for the requested local
  // open-source Qwen verifier whenever Ollama is configured. This lets the
  // existing Promise.all orchestration run Gemini and Qwen in parallel without
  // introducing a second semantic pipeline.
  if (providerName === "cloudflare-gemma" && process.env.QWEN_OLLAMA_URL) {
    return interpretPackageWithQwen({ images, detections, rawText, categoryOptions, signal });
  }

  const apiToken = process.env.CLOUDFLARE_API_TOKEN || process.env.CLOUDFLARE_AUTH_TOKEN || process.env.CLOUDFLARE_API_KEY || "";
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || "";
  const model = modelOverride || process.env.CLOUDFLARE_SEMANTIC_MODEL || "@cf/google/gemma-4-26b-a4b-it";
  if (!apiToken || !accountId) {
    console.warn(`[ocr:${providerName}-semantic] SKIPPED model=${model} reason=CLOUDFLARE_API_TOKEN/CLOUDFLARE_ACCOUNT_ID is not configured.`);
    return { enabled: false, provider: providerName, model, reason: "CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required." };
  }
  if (!images.length) {
    console.warn(`[ocr:${providerName}-semantic] SKIPPED model=${model} reason=No package images supplied.`);
    return { enabled: false, provider: providerName, model, reason: "No package images supplied." };
  }

  let timeoutId = null;
  let requestSignal = signal;
  const isMoondream = model === "@cf/moondream/moondream3.1-9B-A2B";
  if (isMoondream) {
    const timeoutController = new AbortController();
    timeoutId = setTimeout(() => timeoutController.abort(), 6500);
    if (signal && typeof AbortSignal?.any === "function") {
      requestSignal = AbortSignal.any([signal, timeoutController.signal]);
    } else {
      requestSignal = timeoutController.signal;
    }
  }

  try {
    const image = await buildContactSheet(images);
    const prompt = buildSemanticPrompt({ detections, rawText, categoryOptions });
    if (requestSignal?.aborted) throw new DOMException("The request was aborted.", "AbortError");

    const body = isMoondream
      ? { task: "query", image, question: `${prompt}\n\nReturn only compact JSON.`, reasoning: false, temperature: 0, max_tokens: 900, stream: false }
      : {
          messages: [
            { role: "system", content: "Return compact valid JSON only. Omit unsupported fields. No commentary." },
            { role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: image } }] },
          ],
          response_format: { type: "json_object" },
          chat_template_kwargs: { enable_thinking: false },
          max_tokens: 1200,
          temperature: 0,
        };

    const endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/${model}`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: requestSignal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data?.success === false) {
      const providerError = data?.errors?.map((item) => item?.message).filter(Boolean).join("; ")
        || data?.result?.error
        || `Cloudflare Workers AI failed (${response.status}).`;
      const error = new Error(providerError);
      error.statusCode = response.status;
      error.providerCode = data?.errors?.find((item) => item?.code != null)?.code ?? null;
      throw error;
    }

    let content;
    if (isMoondream) {
      content = data?.result?.answer ?? data?.result?.response ?? data?.result?.content ?? data?.response;
    } else {
      content = data?.result?.response?.choices?.[0]?.message?.content
        ?? data?.result?.choices?.[0]?.message?.content
        ?? data?.result?.response
        ?? data?.result?.content
        ?? data?.response;
    }
    const parsed = parseJsonContent(content, { recoverTruncated: true });
    const normalized = normalizeSemanticResult(parsed, categoryOptions);
    return { enabled: true, provider: providerName, model, fields: normalized.fields, suggestedCategory: normalized.suggestedCategory };
  } catch (error) {
    if (error?.name === "AbortError") {
      const reason = isMoondream ? "Cloudflare Moondream semantic provider timed out after 6500ms." : "Cloudflare semantic provider request was aborted.";
      console.error(`[ocr:${providerName}-semantic] FAILED model=${model} reason=${reason}`);
      return { enabled: false, provider: providerName, model, reason };
    }
    const status = error?.statusCode ? ` status=${error.statusCode}` : "";
    const code = error?.providerCode != null ? ` code=${error.providerCode}` : "";
    console.error(`[ocr:${providerName}-semantic] FAILED model=${model}${status}${code} reason=${error?.message || "Cloudflare semantic interpretation failed."}`);
    return { enabled: false, provider: providerName, model, reason: error?.message || "Cloudflare semantic interpretation failed.", statusCode: error?.statusCode ?? null, providerCode: error?.providerCode ?? null };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}
