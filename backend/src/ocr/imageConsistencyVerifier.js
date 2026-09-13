import { GoogleGenAI } from "@google/genai";

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    consistent: { type: "boolean" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    reason: { type: "string" },
    products: {
      type: "array",
      items: {
        type: "object",
        properties: {
          imageIndex: { type: "integer", minimum: 0 },
          brand: { type: "string" },
          productName: { type: "string" },
          identityConfidence: { type: "number", minimum: 0, maximum: 1 },
        },
        required: ["imageIndex", "brand", "productName", "identityConfidence"],
      },
    },
    mismatchPairs: {
      type: "array",
      items: {
        type: "object",
        properties: {
          imageA: { type: "integer", minimum: 0 },
          imageB: { type: "integer", minimum: 0 },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          reason: { type: "string" },
        },
        required: ["imageA", "imageB", "confidence", "reason"],
      },
    },
  },
  required: ["consistent", "confidence", "reason", "products", "mismatchPairs"],
};

function parseJson(value) {
  if (value && typeof value === "object") return value;
  const raw = String(value || "").trim();
  if (!raw) throw new Error("Image consistency model returned an empty response.");
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  return JSON.parse((fenced ? fenced[1] : raw).trim());
}

export async function verifyPackageImageConsistency({ files = [], signal } = {}) {
  if (files.length <= 1) {
    return { enabled: false, checked: false, consistent: true, confidence: 1, reason: "Only one package image supplied.", products: [], mismatchPairs: [] };
  }

  const apiKey = process.env.GEMINI_API_KEY || process.env.OCR_AI_API_KEY || "";
  const model = process.env.GEMINI_IMAGE_CONSISTENCY_MODEL || process.env.GEMINI_SEMANTIC_MODEL || "gemini-3.7-flash";
  if (!apiKey) {
    return { enabled: false, checked: false, consistent: true, confidence: 0, reason: "Gemini image consistency verifier is not configured.", products: [], mismatchPairs: [], model };
  }

  const ai = new GoogleGenAI({ apiKey });
  const contents = [
    {
      text: `You are PARAKH V1's package-image consistency gate. Compare every uploaded package image independently and determine whether all images belong to the SAME physical product/package.

A valid multi-image submission may contain different views of the same product, such as front, back, side, bottom, top, barcode panel, ingredients panel, or manufacturer panel. These should be marked consistent even when the visible text is different.

Reject the submission only when the images clearly belong to different products or brands. Example: front of Kurkure + back of Lay's = INCONSISTENT. Front of Kurkure + back of Kurkure = CONSISTENT.

Use visual identity first: brand/logo, product name, packaging design, dominant product artwork, flavor/variant, and other stable product identity cues. Do not treat MRP, batch number, date, net quantity, barcode digits, nutrition table, manufacturer address, or other mutable/legal text as product identity. Different pack sizes of the same clearly identified product may be treated as consistent only when the product/variant identity is otherwise clearly the same.

Be conservative. Only set consistent=false when the evidence clearly indicates a different product. Return compact JSON matching the provided schema.`
    },
    ...files.map((file, index) => ({
      inlineData: { mimeType: file.mimetype || "image/jpeg", data: file.buffer.toString("base64") },
      _imageIndex: index,
    })),
  ];

  try {
    if (signal?.aborted) throw new DOMException("The request was aborted.", "AbortError");
    const response = await ai.models.generateContent({
      model,
      contents,
      config: {
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA,
        temperature: 0,
        thinkingConfig: { thinkingLevel: "low" },
        maxOutputTokens: 700,
      },
    });

    const parsed = parseJson(response.text);
    const products = Array.isArray(parsed.products) ? parsed.products : [];
    const mismatchPairs = Array.isArray(parsed.mismatchPairs) ? parsed.mismatchPairs : [];
    const confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0));
    const consistent = parsed.consistent !== false;

    return {
      enabled: true,
      checked: true,
      model,
      consistent,
      confidence,
      reason: String(parsed.reason || "").trim(),
      products,
      mismatchPairs,
      blocked: !consistent && confidence >= Number(process.env.PARAKH_IMAGE_MISMATCH_CONFIDENCE || 0.85),
    };
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    return {
      enabled: false,
      checked: false,
      model,
      consistent: true,
      confidence: 0,
      reason: error?.message || "Image consistency verification failed.",
      products: [],
      mismatchPairs: [],
      blocked: false,
    };
  }
}
