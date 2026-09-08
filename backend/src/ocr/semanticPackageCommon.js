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

// Keep the API schema deliberately conservative. Gemini structured output supports
// a limited JSON-Schema subset, so nullable/optional nested properties are avoided.
const FIELD_VALUE_SCHEMA = {
  type: "object",
  properties: {
    value: { type: "string" },
    raw: { type: "string" },
    evidence: { type: "string" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    status: { type: "string", enum: ["found", "absent", "not_detected", "unreadable", "ambiguous"] },
    imageIndex: { type: "integer", minimum: 0 },
    evidenceIndex: { type: "integer", minimum: 0 },
  },
  required: ["value", "raw", "evidence", "confidence", "status", "imageIndex", "evidenceIndex"],
};

export function buildSemanticSchema(categoryOptions = []) {
  return {
    type: "object",
    properties: {
      ...Object.fromEntries(FIELD_KEYS.map((key) => [key, FIELD_VALUE_SCHEMA])),
      suggestedCategory: {
        type: "object",
        properties: {
          categoryId: { type: "string" },
          categoryName: { type: "string" },
          categoryPath: { type: "string" },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          reason: { type: "string" },
        },
        required: ["categoryId", "categoryName", "categoryPath", "confidence", "reason"],
      },
    },
    required: FIELD_KEYS,
  };
}

export function buildSemanticPrompt({ detections = [], rawText = "", categoryOptions = [] } = {}) {
  const compactDetections = detections.slice(0, 160).map((item, index) => ({
    evidenceIndex: index,
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

CRITICAL PRODUCT NAME RULES:
1. productName means the consumer-facing marketed name of the actual product, not an internal identifier.
2. NEVER classify batch numbers, lot numbers, manufacturing/inkjet codes, serial codes, MRP values, dates, weights, barcodes, FSSAI numbers, license numbers, phone numbers, addresses, USP markings, or other regulatory/production codes as productName.
3. A compact alphanumeric token containing letters and multiple digits, such as "BAAYZ011", is strongly indicative of a batch/printing code. It MUST NOT be returned as productName, even if it is prominent in OCR or visually easy to read.
4. A token such as "#0326" or a similar short numeric/marked code MUST NOT be returned as productName.
5. Do not infer a productName merely because a candidate is the largest remaining OCR box. Product-name selection requires positive semantic and visual evidence that the text is consumer-facing product branding/name.
6. Common legitimate marketed names containing numbers (for example 7UP or a product line with a number) may be accepted only when the image/context clearly presents them as branding or a product name. Do not reject every alphanumeric product name blindly.
7. If the product name is not confidently visible, return value="", status="absent". Do NOT guess from batch codes, manufacturer text, slogans, claims, ingredients, or category names.
8. Keep productName separate from brandName. A brand logo/name is not automatically the product name, and a batch code is never the product name.

CRITICAL EVIDENCE RULES:
1. evidenceIndex refers ONLY to the numbered RapidOCR detection objects below. It is not a guessed position in the image.
2. For every FOUND field, evidenceIndex MUST point to the OCR detection containing the actual value text or the closest OCR fragment of that value. Do NOT point to a label-only detection such as "MRP", "Net Weight", "Manufactured by", "Contact", or "READ MRP HERE" when the actual value appears in another detection.
3. For MRP, evidenceIndex must point to the numeric retail price (for example 229.00), ideally including the currency symbol/value if that same OCR detection contains it. Never use a standalone "MRP" label as MRP evidence.
4. For netQuantity, evidenceIndex must point to the quantity value and unit (for example 500 g, 1 kg, 100 ml), not a standalone "Net Weight" or "Net Quantity" label.
5. For dates, evidenceIndex must point to the actual date/month-year text, not the words "Mfg", "PKD", "Best Before", or "Expiry" alone.
6. For productName, evidenceIndex MUST point to the actual product-name text. Never point to a batch/lot/inkjet code as productName evidence. If there is no trustworthy product-name OCR detection, return productName as absent rather than attaching an unrelated box.
7. For manufacturer/packer/importer/marketer and their addresses, evidenceIndex must point to the actual entity/address text, not the role heading alone. Use spatial context when the role heading and value are on adjacent lines.
8. For consumer care phone/email and barcode, evidenceIndex must point to the actual phone/email/barcode text.
9. Prefer the OCR fragment whose text has the greatest lexical overlap with the field value. A semantically related label with poor value overlap is NOT valid evidence.
10. When no OCR detection corresponds to the value, set evidenceIndex=0 only because the schema requires an integer, but set status to unreadable or absent as appropriate. Do not invent geometry from an unrelated detection.

For every field return an object. Use empty strings for value/raw/evidence/imageIndex/evidenceIndex when the field is not detected, and status=absent. For a detected field return value, confidence (0..1), status (found/absent/not_detected/unreadable/ambiguous), imageIndex, and evidenceIndex. Correct OCR mistakes only when the image supports the correction. Keep product name and brand separate. Distinguish manufacturer/packer/marketer/importer, net quantity vs serving size, and MRP vs sale/offer price. Do not assess legal compliance.

suggestedCategory is optional. When uncertain, omit it. When supplied, use only one of the supplied category ids. Use empty strings for categoryId/categoryName/categoryPath/reason when no suggestion is made.

RapidOCR detections (evidenceIndex is the key):
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
      value: value?.value != null && text(value.value) ? value.value : null,
      raw: value?.raw != null && text(value.raw) ? value.raw : null,
      evidence: value?.evidence != null && text(value.evidence) ? value.evidence : null,
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
      categoryId: allowed ? String(allowed.id) : text(suggestion.categoryId) || null,
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
