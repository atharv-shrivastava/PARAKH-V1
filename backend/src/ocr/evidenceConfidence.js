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

const CONFIDENCE_WEIGHTS = { semanticConsensus: 1.00, ocrCorroboration: 0.00 };
const HIGH_CONFIDENCE_THRESHOLD = 0.70;
const RULE_ENGINE_MIN_CONFIDENCE = 0.30;

// External web data is reference evidence only. Keep this allow-list narrow:
// package-specific declarations such as addresses, dates, expiry and batch
// numbers must never be populated from the web.
const WEB_FALLBACK_FIELDS = new Set(["mrp", "netQuantity", "unit"]);

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

function paddleEvidenceScore(field) {
  const explicit = clamp01(field?.ocrEvidenceQuality);
  if (explicit != null) return explicit;
  const confidence = clamp01(field?.paddleOcrConfidence ?? field?.rapidOcrConfidence);
  return confidence ?? 0;
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
    const confidence = clamp01(field.confidence) ?? 0;
    const valueText = field.value == null ? "" : String(field.value).trim();
    const ruleEngineEligible = valueText !== "" && !["absent", "unreadable"].includes(field.status) && confidence >= RULE_ENGINE_MIN_CONFIDENCE;
    return [key, {
      value: ruleEngineEligible ? field.value : null,
      raw: ruleEngineEligible ? (field.raw ?? null) : null,
      evidence: ruleEngineEligible ? (field.evidence ?? null) : null,
      confidence,
      status: ruleEngineEligible ? "found" : "unverified",
      ...(ruleEngineEligible && field.imageIndex != null ? { imageIndex: field.imageIndex } : {}),
      ...(ruleEngineEligible && field.evidenceIndex != null ? { evidenceIndex: field.evidenceIndex } : {}),
    }];
  }));
}

function confidenceState(confidence) {
  if (confidence >= 0.85) return "high";
  if (confidence >= HIGH_CONFIDENCE_THRESHOLD) return "acceptable";
  return "review";
}

export async function applyEvidenceConfidence(result, options = {}) {
  const barcodeImageProvided = Boolean(options?.barcodeImageProvided);
  const next = { ...result };
  const evidence = Array.isArray(result?.rawOcrEvidence) ? result.rawOcrEvidence : [];

  const scannedBarcode = String(next.barcode?.source === "BARCODE_IMAGE_DECODER" ? next.barcode?.value : "").replace(/\D/g, "");
  const barcode = scannedBarcode || null;
  console.log(`[DataKart] barcode source=${barcode ? "BARCODE_SCANNER" : barcodeImageProvided ? "BARCODE_UNREADABLE" : "NONE"} gtin=${barcode || "none"}`);

  let dataKart = null;
  let dataKartMatchedGtin = null;
  let dataKartError = null;
  let webMrpRange = null;
  let webFallbackReason = null;
  if (barcode) {
    try {
      const lookup = await fetchDataKartByGtin(barcode);
      dataKart = lookup.product;
      dataKartMatchedGtin = lookup.matchedGtin;
    } catch (error) {
      dataKartError = error?.message || "DataKart lookup failed.";
    }
  }

  // No usable barcode should not stop product-level reference lookup.
  // When a GTIN exists but DataKart does not have it, the same MRP web fallback
  // remains available. In both cases, the fallback is field-scoped.
  const shouldSearchWebMrp = !barcode || (Boolean(barcode) && !dataKart && !dataKartError);
  if (shouldSearchWebMrp) {
    webFallbackReason = barcode ? "GTIN_NOT_FOUND" : "NO_USABLE_BARCODE";
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
    const semanticConsensus = clamp01(fieldValue.confidence);
    const paddleocr = paddleEvidenceScore(fieldValue);
    const registeredValue = dataKart?.[FIELD_MAP[fieldKey]];
    const dataKartMatchState = dataKartMatch(fieldKey, fieldValue.value, registeredValue);
    // Field fusion has already resolved the independent Gemini visual
    // evidence against OCR/regex corroboration. Do not apply a second
    // confidence formula that penalizes a correct Gemini value merely because
    // its text could not be matched to an OCR rectangle.
    const fused = Math.max(0, Math.min(1, semanticConsensus ?? 0));
    const verification = dataKartMatchState === true ? "MATCH" : dataKartMatchState === false ? "MISMATCH" : "UNVERIFIED";
    const nextField = {
      ...fieldValue,
      confidence: Math.round(fused * 1000) / 1000,
      evidenceConfidence: Math.round(fused * 1000) / 1000,
      confidenceSources: { semanticConsensus, paddleocr, weights: { ...CONFIDENCE_WEIGHTS }, dataKart: null },
      verification,
      verificationIcon: verification === "MATCH" ? "✓" : verification === "MISMATCH" ? "✕" : "?",
      confidenceLabel: "Evidence confidence",
      dataKart: { state: verification, registeredValue: registeredValue ?? null },
      confidenceState: confidenceState(fused),
    };
    next[fieldKey] = nextField;
    details[fieldKey] = nextField.confidenceSources;
  }

  next.ruleEngineInput = buildRuleEngineInput(next);
  next.majorityVote = next.ruleEngineInput;

  if (webMrpRange && typeof webMrpRange === "object") {
    // Keep package extraction authoritative. Web results are reference-only
    // hints for selected product-level fields and never become legal evidence.
    if (WEB_FALLBACK_FIELDS.has("mrp") && next.mrp && typeof next.mrp === "object") {
      next.mrp = {
        ...next.mrp,
        webFallback: {
          status: webMrpRange.status || "NOT_FOUND",
          min: webMrpRange.min ?? null,
          max: webMrpRange.max ?? null,
          currency: webMrpRange.currency || "INR",
          source: "WEB_REFERENCE",
          reason: webFallbackReason,
          referenceOnly: true,
          disclaimer: webMrpRange.disclaimer || "Reference only; not package evidence.",
        },
      };
    }

    const quantityCandidates = Array.isArray(webMrpRange.netQuantityCandidates)
      ? webMrpRange.netQuantityCandidates
      : [];
    if (quantityCandidates.length) {
      if (WEB_FALLBACK_FIELDS.has("netQuantity") && next.netQuantity && typeof next.netQuantity === "object") {
        next.netQuantity = {
          ...next.netQuantity,
          webFallback: {
            candidates: quantityCandidates,
            source: "WEB_REFERENCE",
            reason: webFallbackReason,
            referenceOnly: true,
          },
        };
      }
      if (WEB_FALLBACK_FIELDS.has("unit") && next.unit && typeof next.unit === "object") {
        next.unit = {
          ...next.unit,
          webFallback: {
            candidates: [...new Set(quantityCandidates.map((item) => item.unit).filter(Boolean))],
            source: "WEB_REFERENCE",
            reason: webFallbackReason,
            referenceOnly: true,
          },
        };
      }
    }
  }

  next.evidenceConfidence = {
    weights: { ...CONFIDENCE_WEIGHTS },
    highConfidenceThreshold: HIGH_CONFIDENCE_THRESHOLD,
    ruleEngineMinimumConfidence: RULE_ENGINE_MIN_CONFIDENCE,
    method: "Independent Gemini visual extraction is fused with deterministic OCR/regex corroboration at field level. OCR geometry is evidence metadata and does not reduce a valid visual extraction when no trustworthy box match exists. Fields with usable values at 30% or higher remain eligible for Rules Engine evaluation; below 30% is withheld. DataKart is reference verification only and never contributes to Rules Engine input.",
    dataKartAvailable: Boolean(dataKart),
    dataKartError,
    dataKartMatchedGtin,
    webMrpRange,
    webFallback: {
      enabled: Boolean(webFallbackReason),
      reason: webFallbackReason,
      fields: [...WEB_FALLBACK_FIELDS],
      referenceOnly: true,
    },
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
