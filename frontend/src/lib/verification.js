import { BrowserMultiFormatReader } from "@zxing/browser";

const DATAKART_API_URL = import.meta.env.VITE_DATAKART_API_URL || "http://localhost:4000";
const STATUS_MARKERS = { MATCH: "\u2060", MISMATCH: "\u2061", UNKNOWN: "\u2062" };

const FIELD_MAP = {
  productName: "product_name", brandName: "brand_name", manufacturer: "manufacturer", manufacturerAddress: "manufacturer_address",
  packer: "packer", packerAddress: "packer_address", marketer: "marketer", marketerAddress: "marketer_address",
  importer: "importer", importerAddress: "importer_address", netQuantity: "net_quantity", unit: "unit", mrp: "mrp", currency: "currency",
  dateOfManufacture: "date_of_manufacture", dateOfPacking: "date_of_packing", bestBefore: "best_before", expiryDate: "expiry_date",
  batchNumber: "batch_number", consumerCarePhone: "consumer_care_phone", consumerCareEmail: "consumer_care_email", countryOfOrigin: "country_of_origin",
  fssaiLicenseNumber: "fssai_license_number", barcode: "barcode",
};

function normalize(value) {
  return String(value ?? "").toLowerCase().replace(/[₹$€£,]/g, "").replace(/[^\p{L}\p{N}.]+/gu, " ").replace(/\s+/g, " ").trim();
}

const GENERIC_PRODUCT_DESCRIPTORS = [
  "tooth paste", "toothpaste", "shampoo", "soap", "face wash", "facewash", "biscuit", "biscuits", "juice", "flour", "detergent", "oil",
  "cream", "lotion", "cleaner", "conditioner", "gel", "powder", "tea", "coffee", "milk", "drink", "water", "snack", "tooth gel", "mouthwash",
];

function productIdentity(value) {
  let text = normalize(value);
  for (const descriptor of GENERIC_PRODUCT_DESCRIPTORS) text = text.replace(new RegExp(`\\b${descriptor.replace(/\s+/g, "\\\\s+")}\\b`, "gi"), " ");
  return text.replace(/\s+/g, " ").trim();
}

function numeric(value) {
  const match = String(value ?? "").replace(/,/g, "").match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function gtinChecksum(value) {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (![8, 12, 13, 14].includes(digits.length)) return false;
  let sum = 0;
  for (let index = digits.length - 2, position = 0; index >= 0; index -= 1, position += 1) sum += Number(digits[index]) * (position % 2 === 0 ? 3 : 1);
  return (10 - (sum % 10)) % 10 === Number(digits[digits.length - 1]);
}

function parseBarcodeResult(result) {
  const value = String(result?.getText?.() || "").replace(/\s+/g, "").trim();
  const format = result?.getBarcodeFormat?.() || null;
  const isNumericGtin = /^\d{8,14}$/.test(value);
  const found = isNumericGtin && gtinChecksum(value);
  return {
    value: found ? value : null,
    found,
    format: format ? String(format) : null,
    confidence: found ? 0.99 : 0,
    error: found ? null : isNumericGtin ? "A barcode was detected, but its GTIN check digit is invalid." : "A barcode was detected, but it did not contain a valid numeric GTIN."
  };
}

async function loadImageCanvas(file, scale = 1, rotation = 0) {
  const bitmap = await createImageBitmap(file);
  const radians = rotation * Math.PI / 180;
  const sin = Math.abs(Math.sin(radians));
  const cos = Math.abs(Math.cos(radians));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * cos + height * sin));
  canvas.height = Math.max(1, Math.round(width * sin + height * cos));
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    bitmap.close();
    throw new Error("Could not prepare barcode image.");
  }
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate(radians);
  ctx.drawImage(bitmap, -width / 2, -height / 2, width, height);
  bitmap.close();
  return canvas;
}

async function decodeCanvas(reader, canvas) {
  try {
    return reader.decodeFromCanvas(canvas);
  } catch {
    return null;
  }
}

export async function scanBarcodeImage(file, timeoutMs = 5000) {
  if (!file) return { attempted: false, found: false, value: null, format: null, confidence: 0, error: null };
  const started = Date.now();
  const reader = new BrowserMultiFormatReader();
  let objectUrl = null;
  try {
    objectUrl = URL.createObjectURL(file);
    try {
      const result = await Promise.race([
        reader.decodeFromImageUrl(objectUrl),
        new Promise((_, reject) => window.setTimeout(() => reject(new Error("Barcode decode timeout.")), timeoutMs))
      ]);
      const parsed = parseBarcodeResult(result);
      if (parsed.found) return { attempted: true, ...parsed };
    } catch {
      // Continue with local image preprocessing passes below.
    }

    const remaining = Math.max(500, timeoutMs - (Date.now() - started));
    const passes = [
      { scale: 1.5, rotation: 0 },
      { scale: 2, rotation: 0 },
      { scale: 1.5, rotation: 90 },
      { scale: 1.5, rotation: 270 },
    ];
    const deadline = Date.now() + remaining;
    for (const pass of passes) {
      if (Date.now() >= deadline) break;
      try {
        const canvas = await loadImageCanvas(file, pass.scale, pass.rotation);
        const result = await decodeCanvas(reader, canvas);
        if (result) {
          const parsed = parseBarcodeResult(result);
          if (parsed.found) return { attempted: true, ...parsed };
        }
      } catch {
        // Try the next preprocessing pass.
      }
    }

    return { attempted: true, found: false, value: null, format: null, confidence: 0, error: "Barcode was not decoded from this image." };
  } catch (error) {
    return { attempted: true, found: false, value: null, format: null, confidence: 0, error: error?.message || "Barcode decoding failed." };
  } finally {
    reader.reset?.();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}

export async function lookupDataKart(gtin, signal) {
  const normalizedGtin = String(gtin || "").replace(/\s+/g, "").trim();
  if (!normalizedGtin) return { attempted: false, found: false, gtin: null, product: null, error: null };
  try {
    const response = await fetch(`${DATAKART_API_URL}/api/products/gtin/${encodeURIComponent(normalizedGtin)}`, { signal, headers: { Accept: "application/json" } });
    const data = await response.json().catch(() => ({}));
    if (response.status === 404) return { attempted: true, found: false, gtin: normalizedGtin, product: null, error: null };
    if (!response.ok) throw new Error(data?.error || `DataKart lookup failed (${response.status}).`);
    return { attempted: true, found: Boolean(data?.found && data?.product), gtin: normalizedGtin, product: data?.product || null, error: null };
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    return { attempted: true, found: false, gtin: normalizedGtin, product: null, error: error?.message || "DataKart lookup failed." };
  }
}

function fieldScore(aiField, referenceValue, key) {
  if (!aiField || aiField.status !== "found" || aiField.value == null || referenceValue == null || referenceValue === "") return null;
  if (key === "mrp" || key === "netQuantity") {
    const left = numeric(aiField.value), right = numeric(referenceValue);
    if (left == null || right == null) return 0;
    return left === right ? 1 : 0;
  }
  if (key === "unit") return normalize(aiField.value) === normalize(referenceValue) ? 1 : 0;
  if (key === "productName") {
    const left = productIdentity(aiField.value), right = productIdentity(referenceValue);
    if (!left || !right) return 0;
    if (left === right) return 1;
    if (left.includes(right) || right.includes(left)) return 0.98;
    return normalize(aiField.value) === normalize(referenceValue) ? 1 : 0;
  }
  const left = normalize(aiField.value), right = normalize(referenceValue);
  return left === right ? 1 : left.includes(right) || right.includes(left) ? 0.85 : 0;
}

function combinedFieldConfidence(aiField, rapidEvidence, referenceScore) {
  const gemini = Number(aiField?.confidence);
  const evidenceIndex = Number.isInteger(aiField?.evidenceIndex) ? aiField.evidenceIndex : -1;
  const rapid = evidenceIndex >= 0 ? Number(rapidEvidence?.[evidenceIndex]?.confidence) : NaN;
  const values = [
    Number.isFinite(rapid) ? { value: rapid, weight: 0.30 } : null,
    Number.isFinite(gemini) ? { value: gemini, weight: 0.30 } : null,
    Number.isFinite(Number(referenceScore)) ? { value: Number(referenceScore), weight: 0.40 } : null,
  ].filter(Boolean);
  const weightTotal = values.reduce((sum, item) => sum + item.weight, 0);
  return weightTotal ? values.reduce((sum, item) => sum + item.value * item.weight, 0) / weightTotal : null;
}

export function compareWithDataKart(ocrResult, dataKart) {
  const comparisons = {};
  if (!dataKart?.found || !dataKart.product) return { matchedFields: 0, comparedFields: 0, unknownFields: 0, matchRate: null, comparisons };
  const rapidEvidence = Array.isArray(ocrResult?.rawOcrEvidence) ? ocrResult.rawOcrEvidence : [];
  for (const [key, column] of Object.entries(FIELD_MAP)) {
    if (key === "barcode") continue;
    const aiField = ocrResult?.[key];
    const referenceValue = dataKart.product[column];
    const score = fieldScore(aiField, referenceValue, key);
    const hasAiValue = Boolean(aiField && aiField.status === "found" && aiField.value != null && String(aiField.value).trim());
    const hasReferenceValue = referenceValue != null && String(referenceValue).trim() !== "";
    if (hasAiValue && hasReferenceValue) {
      const status = score >= 0.85 ? "MATCH" : "MISMATCH";
      const verificationConfidence = combinedFieldConfidence(aiField, rapidEvidence, score);
      aiField.verification = { status, confidence: verificationConfidence };
      if (Number.isFinite(verificationConfidence)) aiField.confidence = verificationConfidence;
      comparisons[key] = {
        aiValue: `${STATUS_MARKERS[status]}${aiField.value}`,
        rawAiValue: aiField.value,
        referenceValue,
        score: null,
        matchScore: score,
        verificationConfidence,
        match: status === "MATCH",
        status,
      };
    } else if (hasAiValue && !hasReferenceValue) {
      aiField.verification = { status: "UNVERIFIED", confidence: null };
      comparisons[key] = {
        aiValue: `${STATUS_MARKERS.UNKNOWN}${aiField.value}`,
        rawAiValue: aiField.value,
        referenceValue: null,
        score: null,
        matchScore: null,
        verificationConfidence: null,
        match: null,
        status: "UNKNOWN",
      };
    }
  }
  const comparable = Object.values(comparisons).filter((item) => Number.isFinite(item.matchScore));
  const matchedFields = comparable.filter((item) => item.match).length;
  const unknownFields = Object.values(comparisons).filter((item) => item.status === "UNKNOWN").length;
  return {
    matchedFields,
    comparedFields: comparable.length,
    unknownFields,
    matchRate: comparable.length ? comparable.reduce((sum, item) => sum + item.matchScore, 0) / comparable.length : null,
    comparisons,
  };
}

function average(values) {
  const usable = values.filter((value) => Number.isFinite(value));
  return usable.length ? usable.reduce((sum, value) => sum + value, 0) / usable.length : null;
}

export function calculateVerificationConfidence({ ocrResult, providerInfo, dataKartComparison }) {
  const ocrConfidence = average((ocrResult?.rawOcrEvidence || []).map((item) => Number(item.confidence)).filter(Number.isFinite));
  const semanticFields = Object.values(ocrResult || {}).filter((field) => field && typeof field === "object" && "confidence" in field);
  const semanticConfidence = average(semanticFields.map((field) => Number(field.confidence)).filter(Number.isFinite));
  const dataKartConfidence = Number.isFinite(Number(dataKartComparison?.matchRate)) ? Number(dataKartComparison.matchRate) : null;
  const components = [
    { key: "ocr", label: "OCR", score: ocrConfidence, weight: 0.35 },
    { key: "gemini", label: "Gemini semantic", score: semanticConfidence, weight: 0.40 },
    { key: "datakart", label: "DataKart confidence", score: dataKartConfidence, weight: 0.25 },
  ].filter((component) => Number.isFinite(component.score));
  const weightTotal = components.reduce((sum, component) => sum + component.weight, 0);
  const weightedOverall = weightTotal ? components.reduce((sum, component) => sum + component.score * component.weight, 0) / weightTotal : 0;
  const matchedFields = Number(dataKartComparison?.matchedFields || 0);
  const comparisonAvailable = Boolean(dataKartComparison && Number(dataKartComparison.comparedFields) > 0);
  const agreementBonus = comparisonAvailable ? Math.min(0.10, matchedFields * 0.02) : 0;
  const overall = Math.min(1, weightedOverall + agreementBonus);
  return {
    overall,
    percentage: Math.round(overall * 100),
    label: overall >= 0.85 ? "HIGH" : overall >= 0.65 ? "MEDIUM" : "LOW",
    components,
    agreementBonus,
    matchedFields,
    providerCount: Number(providerInfo?.semantic?.providerCount || providerInfo?.semantic?.providers?.length || 0),
    disclaimer: "Evidence-confidence score only; it is not a statistical probability of legal compliance."
  };
}
