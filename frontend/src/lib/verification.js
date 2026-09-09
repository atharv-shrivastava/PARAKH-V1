import { BrowserMultiFormatReader } from "@zxing/browser";

const DATAKART_API_URL = import.meta.env.VITE_DATAKART_API_URL || "http://localhost:4000";

const FIELD_MAP = {
  productName: "product_name",
  brandName: "brand_name",
  manufacturer: "manufacturer",
  manufacturerAddress: "manufacturer_address",
  packer: "packer",
  packerAddress: "packer_address",
  marketer: "marketer",
  marketerAddress: "marketer_address",
  importer: "importer",
  importerAddress: "importer_address",
  netQuantity: "net_quantity",
  unit: "unit",
  mrp: "mrp",
  currency: "currency",
  dateOfManufacture: "date_of_manufacture",
  dateOfPacking: "date_of_packing",
  bestBefore: "best_before",
  expiryDate: "expiry_date",
  batchNumber: "batch_number",
  consumerCarePhone: "consumer_care_phone",
  consumerCareEmail: "consumer_care_email",
  countryOfOrigin: "country_of_origin",
  fssaiLicenseNumber: "fssai_license_number",
  barcode: "barcode",
};

function normalize(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[₹$€£,]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function numeric(value) {
  const match = String(value ?? "").replace(/,/g, "").match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function fieldScore(aiField, referenceValue, key) {
  if (!aiField || aiField.status !== "found" || aiField.value == null || referenceValue == null || referenceValue === "") return null;
  if (key === "mrp" || key === "netQuantity") {
    const left = numeric(aiField.value);
    const right = numeric(referenceValue);
    if (left == null || right == null) return 0;
    return left === right ? 1 : 0;
  }
  if (key === "unit") return normalize(aiField.value) === normalize(referenceValue) ? 1 : 0;
  const left = normalize(aiField.value);
  const right = normalize(referenceValue);
  return left === right ? 1 : left.includes(right) || right.includes(left) ? 0.85 : 0;
}

export async function scanBarcodeImage(file) {
  if (!file) return { attempted: false, found: false, value: null, format: null, confidence: 0, error: null };
  let url = null;
  try {
    const reader = new BrowserMultiFormatReader();
    url = URL.createObjectURL(file);
    const result = await reader.decodeFromImageUrl(url);
    const value = String(result?.getText?.() || "").trim();
    const format = result?.getBarcodeFormat?.() || null;
    const found = /^\d{8,18}$/.test(value);
    return {
      attempted: true,
      found,
      value: found ? value : null,
      format: format ? String(format) : null,
      confidence: found ? 0.98 : 0,
      error: found ? null : "A barcode was detected, but it did not contain a valid numeric GTIN-like value.",
    };
  } catch (error) {
    return { attempted: true, found: false, value: null, format: null, confidence: 0, error: error?.message || "Barcode decoding failed." };
  } finally {
    if (url) URL.revokeObjectURL(url);
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

export function compareWithDataKart(ocrResult, dataKart) {
  const comparisons = {};
  if (!dataKart?.found || !dataKart.product) return { matchedFields: 0, comparedFields: 0, matchRate: null, comparisons };
  for (const [key, column] of Object.entries(FIELD_MAP)) {
    const score = fieldScore(ocrResult?.[key], dataKart.product[column], key);
    if (score == null) continue;
    comparisons[key] = { aiValue: ocrResult[key].value, referenceValue: dataKart.product[column], score, match: score >= 0.85 };
  }
  const values = Object.values(comparisons);
  return { matchedFields: values.filter((item) => item.match).length, comparedFields: values.length, matchRate: values.length ? values.reduce((sum, item) => sum + item.score, 0) / values.length : null, comparisons };
}

function average(values) {
  const usable = values.filter((value) => Number.isFinite(value));
  return usable.length ? usable.reduce((sum, value) => sum + value, 0) / usable.length : null;
}

export function calculateVerificationConfidence({ ocrResult, providerInfo, barcodeResult, dataKartComparison }) {
  const ocrConfidence = average((ocrResult?.rawOcrEvidence || []).map((item) => Number(item.confidence)).filter(Number.isFinite));
  const semanticConfidence = average(Object.values(ocrResult || {}).map((field) => field && typeof field === "object" ? Number(field.confidence) : NaN));
  const barcodeConfidence = barcodeResult?.found ? Number(barcodeResult.confidence || 0.98) : null;
  const dataKartConfidence = Number.isFinite(Number(dataKartComparison?.matchRate)) ? Number(dataKartComparison.matchRate) : null;
  const components = [
    { key: "barcode", label: "Barcode", score: barcodeConfidence, weight: 0.25 },
    { key: "ocr", label: "OCR", score: ocrConfidence, weight: 0.25 },
    { key: "gemini", label: "Gemini semantic", score: semanticConfidence, weight: 0.30 },
    { key: "datakart", label: "DataKart field match", score: dataKartConfidence, weight: 0.20 },
  ].filter((component) => Number.isFinite(component.score));
  const weightTotal = components.reduce((sum, component) => sum + component.weight, 0);
  const overall = weightTotal ? components.reduce((sum, component) => sum + component.score * component.weight, 0) / weightTotal : 0;
  return {
    overall,
    percentage: Math.round(overall * 100),
    label: overall >= 0.85 ? "HIGH" : overall >= 0.65 ? "MEDIUM" : "LOW",
    components,
    providerCount: Number(providerInfo?.semantic?.providerCount || providerInfo?.semantic?.providers?.length || 0),
    disclaimer: "Evidence-confidence score only; it is not a statistical probability of legal compliance.",
  };
}
