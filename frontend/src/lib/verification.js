import { BrowserMultiFormatReader } from "@zxing/browser";
import { apiFetch } from "./auth";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:5000/api";
const NON_COMPLIANCE_FIELDS = new Set(["barcode", "gtin", "barcodeConfidence", "gtinConfidence"]);

const FIELD_MAP = {
  productName: "product_name", brandName: "brand_name", manufacturer: "manufacturer", manufacturerAddress: "manufacturer_address",
  packer: "packer", packerAddress: "packer_address", marketer: "marketer", marketerAddress: "marketer_address",
  importer: "importer", importerAddress: "importer_address", netQuantity: "net_quantity", unit: "unit", mrp: "mrp", currency: "currency",
  dateOfManufacture: "date_of_manufacture", dateOfPacking: "date_of_packing", bestBefore: "best_before", expiryDate: "expiry_date",
  batchNumber: "batch_number", consumerCarePhone: "consumer_care_phone", consumerCareEmail: "consumer_care_email", countryOfOrigin: "country_of_origin",
  fssaiLicenseNumber: "fssai_license_number",
};

function normalize(value) {
  return String(value ?? "").toLowerCase().replace(/[₹$€£,]/g, "").replace(/[^\p{L}\p{N}.]+/gu, " ").replace(/\s+/g, " ").trim();
}

function normalizeGtin(value) {
  return String(value ?? "").replace(/\D/g, "").trim();
}

function isValidGtin(value) {
  const digits = normalizeGtin(value);
  if (![8, 12, 13, 14].includes(digits.length)) return false;
  let sum = 0;
  for (let index = digits.length - 2, position = 0; index >= 0; index -= 1, position += 1) {
    sum += Number(digits[index]) * (position % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10 === Number(digits[digits.length - 1]);
}

function parseBarcodeResult(result) {
  const value = normalizeGtin(result?.getText?.());
  const format = result?.getBarcodeFormat?.() ? String(result.getBarcodeFormat()) : null;
  if (!isValidGtin(value)) {
    return { value: null, found: false, format, confidence: 0, error: value ? "Barcode detected, but the decoded value is not a valid GTIN." : "Barcode detected without a numeric GTIN." };
  }
  return { value, found: true, format, confidence: 0.99, error: null };
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
  if (!ctx) { bitmap.close(); throw new Error("Could not prepare barcode image."); }
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate(radians);
  ctx.drawImage(bitmap, -width / 2, -height / 2, width, height);
  bitmap.close();
  return canvas;
}

export async function scanBarcodeImage(file, timeoutMs = 5000) {
  if (!file) return { attempted: false, found: false, value: null, format: null, confidence: 0, error: null };
  const reader = new BrowserMultiFormatReader();
  let objectUrl = null;
  const started = Date.now();
  try {
    objectUrl = URL.createObjectURL(file);
    try {
      const result = await Promise.race([
        reader.decodeFromImageUrl(objectUrl),
        new Promise((_, reject) => window.setTimeout(() => reject(new Error("Barcode decode timeout.")), timeoutMs)),
      ]);
      const parsed = parseBarcodeResult(result);
      if (parsed.found) return { attempted: true, ...parsed };
    } catch {}

    const deadline = Date.now() + Math.max(500, timeoutMs - (Date.now() - started));
    for (const pass of [
      { scale: 1.5, rotation: 0 }, { scale: 2, rotation: 0 },
      { scale: 1.5, rotation: 90 }, { scale: 1.5, rotation: 270 },
    ]) {
      if (Date.now() >= deadline) break;
      try {
        const canvas = await loadImageCanvas(file, pass.scale, pass.rotation);
        const result = await reader.decodeFromCanvas(canvas);
        if (result) {
          const parsed = parseBarcodeResult(result);
          if (parsed.found) return { attempted: true, ...parsed };
        }
      } catch {}
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
  const normalizedGtin = normalizeGtin(gtin);
  if (!isValidGtin(normalizedGtin)) {
    return { attempted: false, found: false, gtin: normalizedGtin || null, product: null, error: normalizedGtin ? "DataKart lookup requires a valid GTIN." : null, status: "NOT_ATTEMPTED", source: null };
  }
  try {
    const response = await apiFetch(`${API_URL}/datakart/gtin/${encodeURIComponent(normalizedGtin)}`, { signal, cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (response.status === 404) return { attempted: true, found: false, gtin: normalizedGtin, product: null, error: null, status: "NOT_FOUND", source: data?.source || "datakart-supabase" };
    if (!response.ok) return { attempted: true, found: false, gtin: normalizedGtin, product: null, error: data?.error || `DataKart lookup failed (${response.status}).`, status: "ERROR", source: data?.source || "datakart-supabase" };
    const found = Boolean(data?.found && data?.product);
    return { attempted: true, found, gtin: normalizedGtin, product: found ? data.product : null, error: found ? null : "DataKart returned no product for this GTIN.", status: found ? "FOUND" : "NOT_FOUND", source: data?.source || "datakart-supabase" };
  } catch (error) {
    if (error?.name === "AbortError") return { attempted: true, found: false, gtin: normalizedGtin, product: null, error: "DataKart lookup was cancelled.", status: "ABORTED", source: "datakart-supabase" };
    return { attempted: true, found: false, gtin: normalizedGtin, product: null, error: error?.message || "DataKart lookup failed.", status: "ERROR", source: "datakart-supabase" };
  }
}

function numeric(value) {
  const match = String(value ?? "").replace(/,/g, "").match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function productIdentity(value) {
  return normalize(value).replace(/\b(?:tooth ?paste|shampoo|soap|biscuit(?:s)?|juice|flour|detergent|oil|cream|lotion|cleaner|conditioner|gel|powder|tea|coffee|milk|drink|water|snack|mouthwash)\b/gi, "").replace(/\s+/g, " ").trim();
}

function fieldMatchScore(aiField, referenceValue, key) {
  if (!aiField || aiField.status !== "found" || aiField.value == null || referenceValue == null || String(referenceValue).trim() === "") return null;
  if (key === "mrp" || key === "netQuantity") {
    const left = numeric(aiField.value), right = numeric(referenceValue);
    return left != null && right != null && left === right ? 1 : 0;
  }
  if (key === "unit") return normalize(aiField.value) === normalize(referenceValue) ? 1 : 0;
  if (key === "productName") {
    const left = productIdentity(aiField.value), right = productIdentity(referenceValue);
    if (!left || !right) return 0;
    if (left === right) return 1;
    if (left.includes(right) || right.includes(left)) return 0.98;
  }
  const left = normalize(aiField.value), right = normalize(referenceValue);
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) return 0.85;
  return 0;
}

function paddleConfidence(evidence, field) {
  if (!Array.isArray(evidence) || !field) return null;
  if (Number.isInteger(field.evidenceIndex) && Number.isFinite(Number(evidence[field.evidenceIndex]?.confidence))) return Number(evidence[field.evidenceIndex].confidence);
  const candidate = evidence.find((item) => item?.field === field.fieldName || item?.key === field.fieldName || item?.name === field.fieldName);
  return Number.isFinite(Number(candidate?.confidence)) ? Number(candidate.confidence) : null;
}

function weightedAverage(parts) {
  const usable = parts.filter((part) => Number.isFinite(part.score) && part.weight > 0);
  if (!usable.length) return null;
  const totalWeight = usable.reduce((sum, part) => sum + part.weight, 0);
  return usable.reduce((sum, part) => sum + part.score * part.weight, 0) / totalWeight;
}

export function compareWithDataKart(ocrResult, dataKart) {
  const empty = { matchedFields: 0, comparedFields: 0, unknownFields: 0, matchRate: null, comparisons: {}, gtin: dataKart?.gtin || null, status: dataKart?.status || "NOT_FOUND" };
  if (!dataKart?.found || !dataKart.product) return empty;

  const comparisons = {};
  const paddleEvidence = Array.isArray(ocrResult?.rawOcrEvidence) ? ocrResult.rawOcrEvidence : [];
  for (const [key, column] of Object.entries(FIELD_MAP)) {
    if (NON_COMPLIANCE_FIELDS.has(key)) continue;
    const sourceField = ocrResult?.[key];
    if (!sourceField || typeof sourceField !== "object") continue;
    const field = { ...sourceField, fieldName: key };
    const referenceValue = dataKart.product[column];
    const matchScore = fieldMatchScore(field, referenceValue, key);
    const hasAi = field.status === "found" && field.value != null && String(field.value).trim() !== "";
    const hasReference = referenceValue != null && String(referenceValue).trim() !== "";
    if (!hasAi) continue;
    if (!hasReference) {
      comparisons[key] = { aiValue: field.value, rawAiValue: field.value, referenceValue: null, matchScore: null, verificationConfidence: null, score: null, match: null, status: "UNKNOWN" };
      continue;
    }
    const match = matchScore >= 0.85;
    const extractionConfidence = Number(field.semanticConsensusConfidence ?? field.geminiConfidence ?? field.confidence);
    const verificationConfidence = weightedAverage([
      { score: Number.isFinite(extractionConfidence) ? extractionConfidence : null, weight: 0.60 },
      { score: matchScore, weight: 0.40 },
    ]);
    comparisons[key] = { aiValue: field.value, rawAiValue: field.value, referenceValue, matchScore, verificationConfidence, score: verificationConfidence, match, status: match ? "MATCH" : "MISMATCH" };
  }

  const comparable = Object.values(comparisons).filter((item) => Number.isFinite(item.matchScore));
  return {
    matchedFields: comparable.filter((item) => item.match).length,
    comparedFields: comparable.length,
    unknownFields: Object.values(comparisons).filter((item) => item.status === "UNKNOWN").length,
    matchRate: comparable.length ? comparable.reduce((sum, item) => sum + item.matchScore, 0) / comparable.length : null,
    comparisons,
    gtin: dataKart.gtin,
    status: "FOUND",
  };
}

function average(values) {
  const usable = values.filter(Number.isFinite);
  return usable.length ? usable.reduce((sum, value) => sum + value, 0) / usable.length : null;
}

export function calculateVerificationConfidence({ ocrResult, dataKartComparison }) {
  const extractionConfidence = average(Object.entries(ocrResult || {})
    .filter(([key, field]) => !NON_COMPLIANCE_FIELDS.has(String(key).toLowerCase()) && field && typeof field === "object" && field.status === "found")
    .map(([, field]) => Number(field.semanticConsensusConfidence ?? field.geminiConfidence ?? field.confidence)));
  const dataKartConfidence = Number.isFinite(Number(dataKartComparison?.matchRate)) ? Number(dataKartComparison.matchRate) : null;
  const overall = Number.isFinite(extractionConfidence) && Number.isFinite(dataKartConfidence)
    ? weightedAverage([
        { score: extractionConfidence, weight: 0.60 },
        { score: dataKartConfidence, weight: 0.40 },
      ])
    : extractionConfidence;
  const resolved = Number.isFinite(overall) ? Math.max(0, Math.min(1, overall)) : 0;
  return {
    overall: resolved,
    percentage: Math.round(resolved * 100),
    label: resolved >= 0.85 ? "HIGH" : resolved >= 0.65 ? "MEDIUM" : "LOW",
    components: { extraction: extractionConfidence, datakart: dataKartConfidence },
    weights: { extraction: 0.60, datakart: 0.40 },
    barcodeExcludedFromCompliance: true,
    matchedFields: Number(dataKartComparison?.matchedFields || 0),
    comparedFields: Number(dataKartComparison?.comparedFields || 0),
    dataKartStatus: dataKartComparison?.status || "NOT_ATTEMPTED",
    disclaimer: "Reference verification score only; it is not a statistical probability of legal compliance.",
  };
}
