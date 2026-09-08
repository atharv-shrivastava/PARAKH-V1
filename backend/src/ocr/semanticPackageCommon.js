export const FIELD_KEYS = [
  "productName", "brandName", "manufacturer", "manufacturerAddress", "packer", "packerAddress",
  "marketer", "marketerAddress", "importer", "importerAddress", "netQuantity", "unit", "mrp",
  "currency", "dateOfManufacture", "dateOfPacking", "bestBefore", "expiryDate", "batchNumber",
  "consumerCarePhone", "consumerCareEmail", "countryOfOrigin", "fssaiLicenseNumber", "barcode",
];

export function confidence(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback;
}

export function text(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

const FIELD_VALUE_SCHEMA = {
  type: "object",
  properties: {
    value: { type: "string", nullable: true },
    raw: { type: "string", nullable: true },
    evidence: { type: "string", nullable: true },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    status: { type: "string", enum: ["found", "absent", "not_detected", "unreadable", "ambiguous"] },
    imageIndex: { type: "integer", minimum: 0, nullable: true },
    evidenceIndex: { type: "integer", minimum: 0, nullable: true },
  },
  required: ["value", "confidence", "status"],
};

export function buildSemanticSchema(categoryOptions = []) {
  return {
    type: "object",
    properties: {
      ...Object.fromEntries(FIELD_KEYS.map((key) => [key, FIELD_VALUE_SCHEMA])),
      suggestedCategory: {
        type: "object",
        properties: {
          categoryId: { type: "string", nullable: true },
          categoryName: { type: "string", nullable: true },
          categoryPath: { type: "string", nullable: true },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          reason: { type: "string", nullable: true },
        },
        required: ["categoryId", "confidence"],
      },
    },
  };
}

export function buildSemanticPrompt({ detections = [], rawText = "", categoryOptions = [] } = {}) {
  const compactDetections = detections.slice(0, 160).map((item) => ({
    imageIndex: item.imageIndex,
    text: item.text,
    confidence: item.confidence,
    boundingBox: item.boundingBox || null,
    imageWidth: item.imageWidth || null,
    imageHeight: item.imageHeight || null,
  }));
  const categories = categoryOptions.slice(0, 250).map((item) => ({
    id: String(item.id),
    name: text(item.name),
    path: text(item.path),
  }));
  return `PARAKH semantic package mapper. Inspect the package image(s) AND RapidOCR text together.

Map only fields supported by the image/OCR. Use visual context and nearby headings, not literal keyword matching. A value can belong to a label on another line or nearby, such as "READ MRP HERE" followed by a price. Correct OCR mistakes only when the image supports the correction. Never invent values.

For detected fields return value, confidence (0..1), status (found/absent/not_detected/unreadable/ambiguous), with optional raw, evidence, imageIndex, and evidenceIndex. evidenceIndex must point to the most relevant RapidOCR detection when available. Use not_detected when the declaration is not visible anywhere in the supplied image(s); use unreadable only when you can see it but cannot read it; never guess from product knowledge. OMIT unsupported fields. Keep product name and brand separate. Distinguish manufacturer/packer/marketer/importer, net quantity vs serving size, and MRP vs sale/offer price. Do not assess legal compliance.

suggestedCategory must use only a supplied category id and should be omitted when uncertain.

RapidOCR detections:
${JSON.stringify(compactDetections)}

Raw RapidOCR text:
${text(rawText)}

Final categories:
${JSON.stringify(categories)}

Return compact JSON only. No markdown or commentary.`;
}

export function normalizeSemanticResult(parsed, categoryOptions = []) {
  const normalized = {};
  for (const key of FIELD_KEYS) {
    const value = parsed?.[key] || {};
    const statusRaw = String(value?.status || "").toLowerCase();
    const status = ["found", "absent", "not_detected", "unreadable", "ambiguous"].includes(statusRaw)
      ? statusRaw === "not_detected" ? "absent" : statusRaw
      : value?.value != null && text(value.value) ? "found" : "absent";
    normalized[key] = {
      value: value?.value ?? null,
      raw: value?.raw ?? null,
      evidence: value?.evidence ?? value?.raw ?? value?.value ?? null,
      confidence: confidence(value?.confidence),
      status,
      ...(Number.isInteger(value?.imageIndex) ? { imageIndex: value.imageIndex } : {}),
      ...(Number.isInteger(value?.evidenceIndex) ? { evidenceIndex: value.evidenceIndex } : {}),
    };
  }
  const suggestion = parsed?.suggestedCategory || {};
  const allowed = categoryOptions.find((item) => String(item.id) === String(suggestion.categoryId));
  return {
    fields: normalized,
    suggestedCategory: {
      categoryId: allowed ? String(allowed.id) : null,
      categoryName: allowed ? text(allowed.name) : text(suggestion.categoryName) || null,
      categoryPath: allowed ? text(allowed.path) : text(suggestion.categoryPath) || null,
      confidence: confidence(suggestion.confidence),
      reason: text(suggestion.reason) || null,
    },
  };
}

function recoverJson(raw) {
  let s = raw.trim();
  const first = s.indexOf("{");
  if (first > 0) s = s.slice(first);
  const last = s.lastIndexOf("}");
  if (last >= 0) s = s.slice(0, last + 1);
  try { return JSON.parse(s); } catch {}

  let inString = false;
  let escaped = false;
  const stack = [];
  for (const ch of s) {
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if ((ch === "}" || ch === "]") && stack.at(-1) === ch) stack.pop();
  }
  if (inString) s += '"';
  while (stack.length) s += stack.pop();
  return JSON.parse(s);
}

export function parseJsonContent(content, { recoverTruncated = false } = {}) {
  if (typeof content === "object" && content) return content;
  const raw = text(content);
  if (!raw) throw new Error("Semantic model returned an empty response.");
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = (fenced ? fenced[1] : raw).trim();
  try { return JSON.parse(candidate); } catch (error) {
    if (recoverTruncated) return recoverJson(candidate);
    throw error;
  }
}
