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

export async function scanBarcodeImage(file) {
  if (!file) return { attempted: false, found: false, value: null, format: null, confidence: 0, error: null };
  let url = null;
  try {
    const reader = new BrowserMultiFormatReader();
    url = URL.createObjectURL(file);
    const result = await reader.decodeFromImageUrl(url);
    const value = String(result?.getText?.() || "").replace(/\s+/g, "").trim();
    const format = result?.getBarcodeFormat?.() || null;
    const isNumericGtin = /^\d{8,14}$/.test(value);
    const found = isNumericGtin && gtinChecksum(value);
    return { attempted: true, found, value: found ? value : null, format: format ? String(format) : null, confidence: found ? 0.99 : 0, error: found ? null : isNumericGtin ? "A barcode was detected, but its GTIN check digit is invalid." : "A barcode was detected, but it did not contain a valid numeric GTIN." };
  } catch (error) {
    return { attempted: true, found: false, value: null, format: null, confidence: 0, error: error?.message || "Barcode decoding failed." };
  } finally { if (url) URL.revokeObjectURL(url); }
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
    if (key === "barcode") continue;
    const aiField = ocrResult?.[key];
    const referenceValue = dataKart.product[column];
    const score = fieldScore(aiField, referenceValue, key);
    const hasAiValue = Boolean(aiField && aiField.status === "found" && aiField.value != null && String(aiField.value).trim());
    const hasReferenceValue = referenceValue != null && String(referenceValue).trim() !== "";
    if (hasAiValue && hasReferenceValue) {
      const status = score >= 0.85 ? "MATCH" : "MISMATCH";
      comparisons[key] = { aiValue: `${STATUS_MARKERS[status]}${aiField.value}`, referenceValue, score, match: status === "MATCH", status };
    } else if (hasAiValue && !hasReferenceValue) {
      comparisons[key] = { aiValue: `${STATUS_MARKERS.UNKNOWN}${aiField.value}`, referenceValue: null, score: null, match: null, status: "UNKNOWN" };
    } else if (!hasAiValue && hasReferenceValue) {
      comparisons[key] = { aiValue: `${STATUS_MARKERS.UNKNOWN}`, referenceValue, score: null, match: null, status: "UNKNOWN" };
    }
  }
  const comparable = Object.values(comparisons).filter((item) => Number.isFinite(item.score));
  return {
    matchedFields: comparable.filter((item) => item.match).length,
    comparedFields: comparable.length,
    matchRate: comparable.length ? comparable.reduce((sum, item) => sum + item.score, 0) / comparable.length : null,
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
  const overall = weightTotal ? components.reduce((sum, component) => sum + component.score * component.weight, 0) / weightTotal : 0;
  return { overall, percentage: Math.round(overall * 100), label: overall >= 0.85 ? "HIGH" : overall >= 0.65 ? "MEDIUM" : "LOW", components, providerCount: Number(providerInfo?.semantic?.providerCount || providerInfo?.semantic?.providers?.length || 0), disclaimer: "Evidence-confidence score only; it is not a statistical probability of legal compliance." };
}

function enhanceComparisonUi() {
  const panels = document.querySelectorAll(".barcode-data-comparison");
  panels.forEach((panel) => {
    panel.querySelectorAll(".ocr-edit-field").forEach((field) => {
      const input = field.querySelector("input");
      const small = field.querySelector("small");
      if (!input || !small) return;
      const raw = String(input.value || "");
      const status = raw.startsWith(STATUS_MARKERS.MATCH) ? "MATCH" : raw.startsWith(STATUS_MARKERS.MISMATCH) ? "MISMATCH" : raw.startsWith(STATUS_MARKERS.UNKNOWN) ? "UNKNOWN" : null;
      if (!status) return;
      const cleanValue = raw.replace(/^[\u2060\u2061\u2062]/, "");
      if (input.value !== cleanValue) input.value = cleanValue;
      const percentMatch = String(small.textContent || "").match(/(\d+(?:\.\d+)?)%/);
      if (status === "UNKNOWN") {
        small.textContent = "? Not scored";
      } else {
        small.textContent = `${status === "MATCH" ? "✓ MATCH" : "✕ MISMATCH"}${percentMatch ? ` · ${percentMatch[1]}%` : ""}`;
      }
    });
    const scores = [...panel.querySelectorAll("small")]
      .map((node) => Number(String(node.textContent).match(/(\d+(?:\.\d+)?)%/)?.[1]))
      .filter(Number.isFinite);
    if (scores.length) {
      const confidence = Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length);
      const statusGrid = panel.closest(".barcode-result-panel")?.querySelector(".ocr-status-grid");
      const dataKartSpan = statusGrid?.children?.[2]?.querySelector("span");
      if (dataKartSpan && /Reference found/.test(dataKartSpan.textContent || "")) dataKartSpan.textContent = `Reference found · ${confidence}% confidence`;
    }
  });

  document.querySelectorAll(".barcode-result-panel").forEach((panel) => {
    const comparison = [...panel.querySelectorAll(".barcode-data-comparison")].find((node) => node.querySelector("h3")?.textContent?.includes("Barcode vs extracted data"));
    const matchSpan = [...(comparison?.querySelectorAll(".ocr-status-grid div span") || [])].find((span) => span.parentElement?.querySelector("strong")?.textContent === "Match");
    if (!matchSpan) return;
    if (/MATCH/.test(matchSpan.textContent || "") && !/MISMATCH/.test(matchSpan.textContent || "")) matchSpan.textContent = "✓ MATCH · additional evidence";
    else if (/MISMATCH/.test(matchSpan.textContent || "")) matchSpan.textContent = "✕ MISMATCH";
    else matchSpan.textContent = "? No comparable OCR barcode";
  });
}

if (typeof window !== "undefined" && !window.__PARAKH_COMPARISON_UI__) {
  window.__PARAKH_COMPARISON_UI__ = true;
  const observer = new MutationObserver(enhanceComparisonUi);
  window.setTimeout(() => observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true }), 0);
  window.setTimeout(enhanceComparisonUi, 50);
}
