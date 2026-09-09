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

const WEIGHTS = {
  datakart: 0.50,
  gemini: 0.30,
  rapidocr: 0.20,
};

function clamp01(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(0, Math.min(1, number));
}

function normalize(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[^a-z0-9.]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function numeric(value) {
  const match = String(value ?? "").replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function extractGtinFromRapidEvidence(evidence) {
  const candidates = [];
  for (const item of Array.isArray(evidence) ? evidence : []) {
    const text = String(item?.text ?? "").replace(/[^0-9]/g, "");
    const matches = text.match(/(?:\d{14}|\d{13}|\d{12}|\d{8})/g) || [];
    for (const value of matches) candidates.push(value);
  }
  const exactLengths = [13, 14, 12, 8];
  return exactLengths.map((length) => candidates.find((value) => value.length === length)).find(Boolean) || null;
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

function findRapidConfidence(fieldKey, field, evidence) {
  if (field?.status !== "found") return null;
  const preferredIndex = Number.isInteger(field?.evidenceIndex) ? field.evidenceIndex : -1;
  if (preferredIndex >= 0 && evidence?.[preferredIndex]) {
    const item = evidence[preferredIndex];
    const confidence = clamp01(item?.confidence);
    if (confidence != null) return confidence;
  }

  const target = normalize(field?.value);
  if (!target) return null;
  let best = null;
  for (const item of Array.isArray(evidence) ? evidence : []) {
    const text = normalize(item?.text);
    if (!text) continue;
    const exact = text === target || text.includes(target) || target.includes(text);
    if (!exact) continue;
    const confidence = clamp01(item?.confidence);
    if (confidence == null) continue;
    if (best == null || confidence > best) best = confidence;
  }
  return best;
}

async function fetchDataKartByGtin(gtin) {
  const normalizedGtin = String(gtin ?? "").replace(/\D/g, "");
  const baseUrl = String(process.env.DATAKART_SUPABASE_URL || "https://iaghrncbfpxpwcdgyuen.supabase.co").replace(/\/$/, "");
  const apiKey = String(process.env.DATAKART_SUPABASE_KEY || "").trim();
  if (!normalizedGtin || !apiKey) return null;

  const query = new URLSearchParams({ select: "*", gtin: `eq.${normalizedGtin}`, active: "eq.true", limit: "1" });
  const response = await fetch(`${baseUrl}/rest/v1/products?${query.toString()}`, {
    headers: { apikey: apiKey, Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(Number(process.env.DATAKART_TIMEOUT_MS || 4000)),
  });
  if (!response.ok) return null;
  const data = await response.json().catch(() => []);
  return Array.isArray(data) && data.length ? data[0] : null;
}

export async function applyEvidenceConfidence(result) {
  const next = { ...result };
  const evidence = Array.isArray(result?.rawOcrEvidence) ? result.rawOcrEvidence : [];
  const explicitBarcode = String(next.barcode?.value ?? "").replace(/\D/g, "");
  const rapidBarcode = extractGtinFromRapidEvidence(evidence);
  const barcode = explicitBarcode || rapidBarcode || null;
  if (!explicitBarcode && rapidBarcode) {
    next.barcode = {
      ...(next.barcode || { raw: null, confidence: 0, evidence: null, status: "absent" }),
      value: rapidBarcode,
      raw: next.barcode?.raw || rapidBarcode,
      evidence: next.barcode?.evidence || rapidBarcode,
      status: "found",
      source: "RAPIDOCR_EVIDENCE"
    };
  }
  let dataKart = null;
  let dataKartError = null;
  const geminiAvailable = Boolean(result?.aiSemantic?.providerCount);

  if (barcode) {
    try {
      dataKart = await fetchDataKartByGtin(barcode);
    } catch (error) {
      dataKartError = error?.message || "DataKart lookup failed.";
    }
  }

  const details = {};

  for (const [fieldKey, fieldValue] of Object.entries(result || {})) {
    if (!fieldValue || typeof fieldValue !== "object" || !FIELD_MAP[fieldKey]) continue;

    const gemini = geminiAvailable ? clamp01(fieldValue.confidence) : null;
    const rapidocr = findRapidConfidence(fieldKey, fieldValue, evidence);
    const registeredValue = dataKart?.[FIELD_MAP[fieldKey]];
    const dataKartMatchState = dataKartMatch(fieldKey, fieldValue.value, registeredValue);
    const datakart = dataKartMatchState == null ? null : dataKartMatchState ? 1 : 0;

    const pieces = [
      { key: "datakart", weight: WEIGHTS.datakart, value: datakart },
      { key: "gemini", weight: WEIGHTS.gemini, value: gemini },
      { key: "rapidocr", weight: WEIGHTS.rapidocr, value: rapidocr },
    ].filter((piece) => piece.value != null);

    const denominator = pieces.reduce((sum, piece) => sum + piece.weight, 0);
    const fused = denominator > 0
      ? pieces.reduce((sum, piece) => sum + piece.weight * piece.value, 0) / denominator
      : 0;

    const verification = dataKartMatchState === true ? "MATCH" : dataKartMatchState === false ? "MISMATCH" : "UNVERIFIED";
    const state = verification === "MATCH"
      ? "verified"
      : verification === "MISMATCH"
        ? "mismatch"
        : fused >= 0.75
          ? "likely"
          : "review";

    next[fieldKey] = {
      ...fieldValue,
      confidence: Math.round(fused * 1000) / 1000,
      evidenceConfidence: Math.round(fused * 1000) / 1000,
      confidenceSources: {
        datakart: datakart == null ? null : Math.round(datakart * 1000) / 1000,
        gemini: gemini == null ? null : Math.round(gemini * 1000) / 1000,
        rapidocr: rapidocr == null ? null : Math.round(rapidocr * 1000) / 1000,
      },
      verification,
      verificationIcon: verification === "MATCH" ? "✓" : verification === "MISMATCH" ? "✕" : "?",
      confidenceLabel: "Evidence confidence",
      dataKart: {
        state: verification,
        registeredValue: registeredValue ?? null,
      },
      confidenceState: state,
    };

    details[fieldKey] = next[fieldKey].confidenceSources;
  }

  next.evidenceConfidence = {
    weights: { ...WEIGHTS },
    method: "50% DataKart + 30% Gemini + 20% RapidOCR; unavailable sources are removed and remaining weights are renormalized.",
    dataKartAvailable: Boolean(dataKart),
    dataKartError,
    fields: details,
  };

  const gtin = barcode ? String(barcode).replace(/\D/g, "") : null;
  const dataKartStatus = dataKart ? "REGISTERED" : dataKartError ? "UNAVAILABLE" : barcode ? "NOT_FOUND" : "NO_GTIN";
  const dataKartMessage = dataKart ? "✓ Product found in DataKart" : dataKartError ? "? DataKart could not be reached" : barcode ? "✕ Product not found in DataKart" : "? Product could not be checked: no GTIN detected";
  next.dataKartVerification = {
    status: dataKartStatus,
    code: dataKartStatus,
    message: dataKartMessage,
    gtin,
  };

  return next;
}