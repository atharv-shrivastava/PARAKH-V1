import { searchMrpRange } from "./marketPriceSearch.js";

const FIELD_MAP = {
  productName: "product_name", brandName: "brand_name", manufacturer: "manufacturer", manufacturerAddress: "manufacturer_address",
  packer: "packer", packerAddress: "packer_address", marketer: "marketer", marketerAddress: "marketer_address",
  importer: "importer", importerAddress: "importer_address", netQuantity: "net_quantity", unit: "unit", mrp: "mrp", currency: "currency",
  dateOfManufacture: "date_of_manufacture", dateOfPacking: "date_of_packing", bestBefore: "best_before", expiryDate: "expiry_date",
  batchNumber: "batch_number", consumerCarePhone: "consumer_care_phone", consumerCareEmail: "consumer_care_email",
  countryOfOrigin: "country_of_origin", fssaiLicenseNumber: "fssai_license_number", barcode: "barcode",
};

const RULE_ENGINE_FIELDS = [
  "productName", "brandName", "manufacturer", "manufacturerAddress", "packer", "packerAddress", "marketer", "marketerAddress",
  "importer", "importerAddress", "netQuantity", "unit", "mrp", "currency", "dateOfManufacture", "dateOfPacking", "bestBefore",
  "expiryDate", "batchNumber", "consumerCarePhone", "consumerCareEmail", "countryOfOrigin", "fssaiLicenseNumber",
];

const WEIGHTS = { datakart: 0.50, gemini: 0.30, rapidocr: 0.20 };

function clamp01(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(0, Math.min(1, number));
}

function normalize(value) {
  return String(value ?? "").normalize("NFKC").toLowerCase().replace(/[\u2010-\u2015]/g, "-").replace(/[^a-z0-9.]+/g, " ").trim().replace(/\s+/g, " ");
}

function numeric(value) {
  const match = String(value ?? "").replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function dataKartMatch(fieldKey, currentValue, registeredValue) {
  if (registeredValue == null || String(registeredValue).trim() === "") return null;
  if (currentValue == null || String(currentValue).trim() === "") return false;
  if (["mrp", "netQuantity"].includes(fieldKey)) {
    const left = numeric(currentValue);
    const right = numeric(registeredValue);
    return left != null && right != null && left === right;
  }
  const left = normalize(currentValue).replace(/\s+/g, "");
  const right = normalize(registeredValue).replace(/\s+/g, "");
  if (!left || !right) return false;
  if (left === right || left.includes(right) || right.includes(left)) return true;
  const leftTokens = new Set(normalize(currentValue).split(" ").filter(Boolean));
  const rightTokens = new Set(normalize(registeredValue).split(" ").filter(Boolean));
  const common = [...leftTokens].filter((token) => rightTokens.has(token));
  return common.length >= 2 && common.length / Math.min(leftTokens.size, rightTokens.size) >= 0.8;
}

function findRapidConfidence(field, evidence) {
  if (field?.status !== "found") return null;
  const preferredIndex = Number.isInteger(field?.evidenceIndex) ? field.evidenceIndex : -1;
  if (preferredIndex >= 0 && evidence?.[preferredIndex]) {
    const confidence = clamp01(evidence[preferredIndex]?.confidence);
    if (confidence != null) return confidence;
  }
  const target = normalize(field?.value);
  if (!target) return null;
  let best = null;
  for (const item of Array.isArray(evidence) ? evidence : []) {
    const text = normalize(item?.text);
    if (!text || !(text === target || text.includes(target) || target.includes(text))) continue;
    const confidence = clamp01(item?.confidence);
    if (confidence != null && (best == null || confidence > best)) best = confidence;
  }
  return best;
}

async function fetchDataKartByGtin(gtin) {
  const normalizedGtin = String(gtin ?? "").replace(/\D/g, "");
  const baseUrl = String(process.env.DATAKART_API_URL || "http://localhost:4000").replace(/\/$/, "");
  if (!normalizedGtin) return { product: null, matchedGtin: null };

  const url = `${baseUrl}/api/products/gtin/${encodeURIComponent(normalizedGtin)}`;
  console.log(`[DataKart] lookup gtin=${normalizedGtin} url=${url}`);

  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(Number(process.env.DATAKART_TIMEOUT_MS || 4000)) });
  } catch (error) {
    console.error(`[DataKart] request failed gtin=${normalizedGtin}:`, error?.message || error);
    throw error;
  }

  const responseText = await response.text();
  console.log(`[DataKart] response status=${response.status} gtin=${normalizedGtin} body=${responseText.slice(0, 1000)}`);

  let payload = {};
  try { payload = JSON.parse(responseText); } catch {}

  if (response.status === 404) return { product: null, matchedGtin: null };
  if (!response.ok) throw new Error(`DataKart API returned HTTP ${response.status}.`);
  if (!payload?.found || !payload?.product) return { product: null, matchedGtin: null };

  console.log(`[DataKart] MATCH gtin=${normalizedGtin} stored=${payload.matchedGtin || payload.product.gtin || "unknown"}`);
  return { product: payload.product, matchedGtin: payload.matchedGtin || payload.product.gtin || normalizedGtin };
}

function buildRuleEngineInput(result) {
  return Object.fromEntries(RULE_ENGINE_FIELDS.map((key) => {
    const field = result?.[key];
    if (!field || typeof field !== "object") return [key, field];
    return [key, { value: field.value ?? null, raw: field.raw ?? null, evidence: field.evidence ?? null, confidence: field.confidence ?? 0, status: field.status || "absent", ...(field.imageIndex != null ? { imageIndex: field.imageIndex } : {}), ...(field.evidenceIndex != null ? { evidenceIndex: field.evidenceIndex } : {}) }];
  }));
}

export async function applyEvidenceConfidence(result, options = {}) {
  const barcodeImageProvided = Boolean(options?.barcodeImageProvided);
  const next = { ...result };
  const evidence = Array.isArray(result?.rawOcrEvidence) ? result.rawOcrEvidence : [];

  // IMPORTANT: DataKart must use the actual barcode scanner result only.
  // RapidOCR/Gemini may read human-readable barcode digits as evidence, but
  // those values are never allowed to become the authoritative GTIN.
  const scannedBarcode = String(next.barcode?.source === "BARCODE_IMAGE_DECODER" ? next.barcode?.value : "")
    .replace(/\D/g, "");
  const barcode = scannedBarcode || null;
  console.log(`[DataKart] barcode source=${barcode ? "BARCODE_SCANNER" : barcodeImageProvided ? "BARCODE_UNREADABLE" : "NONE"} gtin=${barcode || "none"}`);

  next.ruleEngineInput = buildRuleEngineInput(result);
  next.majorityVote = next.ruleEngineInput;

  let dataKart = null;
  let dataKartMatchedGtin = null;
  let dataKartError = null;
  let webMrpRange = null;
  const geminiAvailable = Boolean(result?.aiSemantic?.providerCount);
  if (barcode) {
    try {
      const lookup = await fetchDataKartByGtin(barcode);
      dataKart = lookup.product;
      dataKartMatchedGtin = lookup.matchedGtin;
    } catch (error) {
      dataKartError = error?.message || "DataKart lookup failed.";
    }
  }

  if (!dataKart && !dataKartError) {
    try {
      webMrpRange = await searchMrpRange({
        productName: result?.productName?.value,
        brandName: result?.brandName?.value,
        netQuantity: result?.netQuantity?.value,
        unit: result?.unit?.value,
      });
    } catch (error) {
      webMrpRange = { status: "UNAVAILABLE", error: error?.message || "Web MRP search failed." };
    }
  }

  const details = {};
  for (const [fieldKey, fieldValue] of Object.entries(result || {})) {
    if (!fieldValue || typeof fieldValue !== "object" || !FIELD_MAP[fieldKey]) continue;
    const gemini = geminiAvailable ? clamp01(fieldValue.confidence) : null;
    const rapidocr = findRapidConfidence(fieldValue, evidence);
    const registeredValue = dataKart?.[FIELD_MAP[fieldKey]];
    const dataKartMatchState = dataKartMatch(fieldKey, fieldValue.value, registeredValue);
    const datakart = dataKartMatchState == null ? null : dataKartMatchState ? 1 : 0;
    const fused = (WEIGHTS.datakart * (datakart ?? 0))
      + (WEIGHTS.gemini * (gemini ?? 0))
      + (WEIGHTS.rapidocr * (rapidocr ?? 0));
    const verification = dataKartMatchState === true ? "MATCH" : dataKartMatchState === false ? "MISMATCH" : "UNVERIFIED";
    const state = verification === "MATCH" ? "verified" : verification === "MISMATCH" ? "mismatch" : fused >= 0.375 ? "likely" : "review";

    next[fieldKey] = {
      ...fieldValue,
      confidence: Math.round(fused * 1000) / 1000,
      evidenceConfidence: Math.round(fused * 1000) / 1000,
      confidenceSources: { datakart, gemini, rapidocr, weights: { ...WEIGHTS } },
      verification,
      verificationIcon: verification === "MATCH" ? "✓" : verification === "MISMATCH" ? "✕" : "?",
      confidenceLabel: "Evidence confidence",
      dataKart: { state: verification, registeredValue: registeredValue ?? null },
      confidenceState: state,
    };
    details[fieldKey] = next[fieldKey].confidenceSources;
  }

  if (next.mrp && webMrpRange?.min != null && webMrpRange?.max != null && next.mrp.value != null) {
    next.mrp = {
      ...next.mrp,
      webMarketRange: webMrpRange,
      value: `${next.mrp.value} · web MRP range ₹${webMrpRange.min}–₹${webMrpRange.max}`,
    };
  }

  next.evidenceConfidence = {
    weights: { ...WEIGHTS },
    method: "Fixed evidence voting: DataKart 50% + Gemini 30% + RapidOCR 20%. DataKart GTIN lookup uses only the barcode scanner result; OCR/Gemini barcode text is evidence only.",
    dataKartAvailable: Boolean(dataKart),
    dataKartError,
    dataKartMatchedGtin,
    webMrpRange,
    fields: details,
  };

  const gtin = barcode;
  const dataKartStatus = dataKart
    ? "REGISTERED"
    : dataKartError
      ? "UNAVAILABLE"
      : barcodeImageProvided && !barcode
        ? "BARCODE_UNREADABLE"
        : barcode
          ? "NOT_FOUND"
          : "NO_GTIN";
  const dataKartMessage = dataKart
    ? "✓ Product found in DataKart"
    : dataKartError
      ? "? DataKart could not be reached"
      : dataKartStatus === "BARCODE_UNREADABLE"
        ? "? Barcode could not be decoded"
        : barcode
          ? "✕ Product not found in DataKart"
          : "? No barcode scan result";

  next.dataKartVerification = {
    status: dataKartStatus,
    code: dataKartStatus,
    message: dataKartMessage,
    gtin,
    matchedGtin: dataKartMatchedGtin,
  };
  next.dataKartReference = dataKart
    ? { gtin, matchedGtin: dataKartMatchedGtin, product: dataKart, note: "Reference verification only. DataKart does not determine compliance." }
    : null;

  return next;
}
