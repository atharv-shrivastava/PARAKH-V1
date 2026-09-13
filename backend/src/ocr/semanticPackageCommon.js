export const FIELD_KEYS = [
  "productName", "brandName", "manufacturer", "manufacturerAddress", "packer", "packerAddress",
  "marketer", "marketerAddress", "importer", "importerAddress", "netQuantity", "unit", "mrp",
  "currency", "dateOfManufacture", "dateOfPacking", "bestBefore", "expiryDate", "batchNumber",
  "consumerCarePhone", "consumerCareEmail", "countryOfOrigin", "fssaiLicenseNumber", "barcode",
];

const FIELD_DESCRIPTIONS = {
  productName: "Exact consumer-facing product name as printed on the package.",
  brandName: "Brand identity exactly as printed on the package.",
  manufacturer: "Manufacturer name exactly as printed.",
  manufacturerAddress: "Complete manufacturer physical postal address exactly as printed.",
  packer: "Packer name exactly as printed.",
  packerAddress: "Complete packer physical postal address exactly as printed.",
  marketer: "Marketer name exactly as printed.",
  marketerAddress: "Complete marketer physical postal address exactly as printed.",
  importer: "Importer name exactly as printed.",
  importerAddress: "Complete importer physical postal address exactly as printed.",
  netQuantity: "Net quantity declaration including its numeric value and unit as printed.",
  unit: "Unit exactly as printed, such as g, kg, ml, L, N or units.",
  mrp: "Numeric maximum retail price value, with raw evidence preserving the complete printed MRP expression.",
  currency: "Currency symbol or abbreviation exactly as printed, such as ₹, Rs. or INR.",
  dateOfManufacture: "Exact manufacturing date or month-year declaration.",
  dateOfPacking: "Exact packing/pre-packing date or month-year declaration.",
  bestBefore: "Exact best-before declaration, including duration wording where present.",
  expiryDate: "Exact expiry or use-by declaration.",
  batchNumber: "Exact batch, lot, production or inkjet batch identifier.",
  consumerCarePhone: "Consumer-care telephone/mobile number exactly as printed.",
  consumerCareEmail: "Consumer-care email address exactly as printed.",
  countryOfOrigin: "Country of origin declaration exactly as printed, including wording such as Made in India.",
  fssaiLicenseNumber: "FSSAI licence or registration number exactly as printed.",
  barcode: "Human-readable GTIN/barcode number if digits are printed on the package.",
};

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
    value: { type: "string" },
    displayValue: { type: "string" },
    raw: { type: "string" },
    evidence: { type: "string" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    status: { type: "string", enum: ["found", "absent", "not_detected", "unreadable", "ambiguous"] },
    imageIndex: { type: "integer", minimum: 0 },
    evidenceIndex: { type: "integer", minimum: 0 },
  },
  required: ["value", "displayValue", "raw", "evidence", "confidence", "status", "imageIndex", "evidenceIndex"],
};

export function buildSemanticSchema(categoryOptions = []) {
  return {
    type: "object",
    properties: {
      ...Object.fromEntries(FIELD_KEYS.map((key) => [key, {
        ...FIELD_VALUE_SCHEMA,
        description: FIELD_DESCRIPTIONS[key],
      }])),
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

export function buildSemanticPrompt({ detections = [], rawText = "", categoryOptions = [], targetLanguage = "en" } = {}) {
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
  return `PARAKH semantic package mapper. Inspect the ORIGINAL package image(s) AND RapidOCR text/boxes together.\n\nUSER DISPLAY LANGUAGE: ${String(targetLanguage || "en").toLowerCase()}\n\nUse visual evidence first and OCR as supporting text. You have access to the original package images in this request. Do not rely only on the OCR text. Use spatial relationships between labels, logos, product-name text, prices, quantities and dates. Correct OCR mistakes only when the actual image supports the correction. Never invent values.\n\nCRITICAL MULTILINGUAL FIELD RULES:\n1. "value" is the canonical extracted value as printed or semantically identified on the package. Keep it suitable for compliance rules and DataKart comparison.\n2. "displayValue" is the human-readable version that should be shown inside PARAKH fields for the selected USER DISPLAY LANGUAGE.\n3. Translate or transliterate only when the field is meaningfully translatable. Product names and generic commodity descriptions may be translated when appropriate.\n4. Preserve brand names, manufacturer/packer/marketer/importer legal names, addresses, phone numbers, email addresses, GTIN/barcodes, FSSAI/license IDs, batch codes, dates and numeric MRP/quantity values. Never invent a translated legal identifier.\n5. Units may be localized for display, but the canonical "value" should remain the package value. Example: canonical "500 g" may display as the local-language equivalent while retaining the number.\n6. Country names and generic product descriptions may be localized when the target language has a natural equivalent.\n7. If the target language is English, displayValue should normally equal value.\n8. If a faithful localization would be unsafe or uncertain, displayValue MUST equal value.\n\nCRITICAL PRODUCT IDENTITY RULES:\n1. productName means the consumer-facing marketed name of the actual product shown on the package.\n2. brandName means the brand identity shown on the package. Keep brandName and productName separate when the package clearly distinguishes them.\n3. A brand can also function as the complete consumer-facing product name. For example, if the package clearly shows "DANT KANTI" and the product is toothpaste, productName may legitimately be "Dant Kanti" even if the longer descriptive wording is "Dant Kanti Toothpaste".\n4. Treat capitalization, punctuation and spacing differences as the same text identity. "DANT KANTI", "Dant Kanti" and "dant-kanti" are the same lexical identity.\n5. When one product-name candidate is a shorter brand-led form and the other is the same phrase plus a generic commodity descriptor such as "toothpaste", "shampoo", "soap", "face wash", "biscuit", "juice", "flour", "detergent", "oil", "cream", "lotion" or similar, treat them as the same underlying product identity rather than different products.\n6. Do NOT split a single product into different identities merely because one source says the concise marketed name and another source appends the generic commodity type. Preserve the concise consumer-facing name in productName when that is what is visibly printed.\n7. Never classify batch numbers, lot numbers, manufacturing/inkjet codes, serial codes, MRP values, dates, weights, barcodes, FSSAI numbers, license numbers, phone numbers, addresses, USP markings, ingredients or regulatory/production codes as productName.\n8. A compact alphanumeric token containing letters and multiple digits, such as "BAAYZ011", is strongly indicative of a batch/printing code. It MUST NOT be returned as productName.\n9. A token such as "#0326" or a similar short numeric/marked code MUST NOT be returned as productName.\n10. Do not infer productName merely because a candidate is the largest remaining OCR box. Product-name selection requires positive semantic and visual evidence that the text is consumer-facing product branding/name.\n11. Common legitimate marketed names containing numbers (for example 7UP or a product line with a number) may be accepted only when the image/context clearly presents them as branding or a product name.\n12. If the product name is not confidently visible, return value="", displayValue="", status="absent". Do NOT guess from batch codes, manufacturer text, slogans, claims, ingredients, or category names.\n\nCRITICAL EVIDENCE RULES:\n1. evidenceIndex refers ONLY to the numbered RapidOCR detection objects below.\n2. For every FOUND field, evidenceIndex MUST point to the OCR detection containing the actual value text or the closest OCR fragment of that value.\n3. For MRP, evidenceIndex must point to the numeric retail price, not a standalone "MRP" label.\n4. For netQuantity, evidenceIndex must point to the quantity value and unit, not a standalone quantity label.\n5. For dates, evidenceIndex must point to the actual date/month-year text, not a label such as "Mfg" or "Best Before".\n6. For productName, evidenceIndex MUST point to actual product-name text. Never point to a batch/lot/inkjet code as productName evidence.\n7. For manufacturer/packer/importer/marketer and addresses, evidenceIndex must point to the actual entity/address text, using nearby spatial context when the role heading and value are on adjacent lines.\n8. For consumer care phone/email and barcode, evidenceIndex must point to the actual phone/email/barcode text.\n9. Prefer the OCR fragment with the greatest lexical overlap with the field value. A semantically related label with poor value overlap is NOT valid evidence.\n10. When no OCR detection corresponds to the value, set status to unreadable or absent as appropriate instead of inventing geometry.\n\nFor every field return an object. Use empty strings for value/displayValue/raw/evidence/imageIndex/evidenceIndex when the field is not detected, with status=absent. For a detected field return value, displayValue, confidence, status, imageIndex and evidenceIndex. Distinguish manufacturer/packer/marketer/importer, net quantity vs serving size, and MRP vs sale/offer price. Do not assess legal compliance.\n\nsuggestedCategory is optional. When uncertain, omit it. When supplied, use only one supplied category id.\n\nRapidOCR detections (evidenceIndex is the key):\n${JSON.stringify(compactDetections)}\n\nRaw RapidOCR text:\n${text(rawText)}\n\nFinal categories:\n${JSON.stringify(categories)}\n\nReturn compact JSON only. No markdown or commentary.`;
}

export function normalizeSemanticResult(parsed, categoryOptions = []) {
  const normalized = {};
  for (const key of FIELD_KEYS) {
    const value = parsed?.[key] || {};
    const statusRaw = String(value?.status || "").toLowerCase();
    const status = ["found", "absent", "not_detected", "unreadable", "ambiguous"].includes(statusRaw)
      ? statusRaw === "not_detected" ? "absent" : statusRaw
      : value?.value != null && text(value.value) ? "found" : "absent";
    const canonical = value?.value != null && text(value.value) ? text(value.value) : null;
    const localized = value?.displayValue != null && text(value.displayValue) ? text(value.displayValue) : canonical;
    normalized[key] = {
      value: canonical,
      displayValue: localized,
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
