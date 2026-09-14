import { searchMrpRange } from "./marketPriceSearch.js";

const FIELD_MAP = {
  productName: "product_name", brandName: "brand_name", manufacturer: "manufacturer", manufacturerAddress: "manufacturer_address",
  packer: "packer", packerAddress: "packer_address", marketer: "marketer", marketerAddress: "marketer_address",
  importer: "importer", importerAddress: "importer_address", netQuantity: "net_quantity", unit: "unit", mrp: "mrp", currency: "currency",
  dateOfManufacture: "date_of_manufacture", dateOfPacking: "date_of_packing", bestBefore: "best_before", expiryDate: "expiry_date",
  batchNumber: "batch_number", consumerCarePhone: "consumer_care_phone", consumerCareEmail: "consumer_care_email",
  countryOfOrigin: "country_of_origin", fssaiLicenseNumber: "fssai_license_number", barcode: "barcode",
};
const RULE_ENGINE_FIELDS = ["productName","brandName","manufacturer","manufacturerAddress","packer","packerAddress","marketer","marketerAddress","importer","importerAddress","netQuantity","unit","mrp","currency","dateOfManufacture","dateOfPacking","bestBefore","expiryDate","batchNumber","consumerCarePhone","consumerCareEmail","countryOfOrigin","fssaiLicenseNumber"];
const CONFIDENCE_WEIGHTS = { gemini: 0.45, grok: 0.45, rapidocr: 0.10, dataKart: 0.00 };
const HIGH_CONFIDENCE_THRESHOLD = 0.70;
const RULE_ENGINE_MIN_CONFIDENCE = 0.30;

function clamp01(value) { const n = Number(value); return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : null; }
function normalize(value) { return String(value ?? "").normalize("NFKC").toLowerCase().replace(/[\u2010-\u2015]/g, "-").replace(/[^a-z0-9.]+/g, " ").trim().replace(/\s+/g, " "); }
function numeric(value) { const m = String(value ?? "").replace(/,/g, "").match(/-?\d+(?:\.\d+)?/); return m ? Number(m[0]) : null; }
function dataKartMatch(key, current, registered) {
  if (registered == null || String(registered).trim() === "") return null;
  if (current == null || String(current).trim() === "") return false;
  if (["mrp","netQuantity"].includes(key)) { const a = numeric(current), b = numeric(registered); return a != null && b != null && a === b; }
  const a = normalize(current).replace(/\s+/g, ""), b = normalize(registered).replace(/\s+/g, "");
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  const at = new Set(normalize(current).split(" ").filter(Boolean)), bt = new Set(normalize(registered).split(" ").filter(Boolean));
  const common = [...at].filter((t) => bt.has(t));
  return common.length >= 2 && common.length / Math.min(at.size, bt.size) >= 0.8;
}
function rapidEvidenceScore(field) { return clamp01(field?.ocrEvidenceQuality) ?? clamp01(field?.rapidOcrConfidence) ?? 0; }
function voteConfidence(field, provider) { const vote = Array.isArray(field?.votes) ? field.votes.find((v) => String(v?.provider || "").toLowerCase() === provider) : null; return clamp01(vote?.confidence); }

async function fetchDataKartByGtin(gtin) {
  const normalizedGtin = String(gtin ?? "").replace(/\D/g, "");
  const baseUrl = String(process.env.DATAKART_API_URL || "http://localhost:4000").replace(/\/$/, "");
  if (!normalizedGtin) return { product: null, matchedGtin: null };
  const response = await fetch(`${baseUrl}/api/products/gtin/${encodeURIComponent(normalizedGtin)}`, { signal: AbortSignal.timeout(Number(process.env.DATAKART_TIMEOUT_MS || 4000)) });
  const responseText = await response.text();
  let payload = {}; try { payload = JSON.parse(responseText); } catch {}
  if (response.status === 404) return { product: null, matchedGtin: null };
  if (!response.ok) throw new Error(`DataKart API returned HTTP ${response.status}.`);
  if (!payload?.found || !payload?.product) return { product: null, matchedGtin: null };
  return { product: payload.product, matchedGtin: payload.matchedGtin || payload.product.gtin || normalizedGtin };
}

function buildRuleEngineInput(result) {
  return Object.fromEntries(RULE_ENGINE_FIELDS.map((key) => {
    const field = result?.[key];
    if (!field || typeof field !== "object") return [key, field];
    const confidence = clamp01(field.confidence) ?? 0;
    const value = field.value == null ? "" : String(field.value).trim();
    const eligible = value !== "" && !["absent","unreadable"].includes(field.status) && confidence >= RULE_ENGINE_MIN_CONFIDENCE;
    return [key, { value: eligible ? field.value : null, raw: eligible ? field.raw ?? null : null, evidence: eligible ? field.evidence ?? null : null, confidence, status: eligible ? "found" : "unverified", ...(eligible && field.imageIndex != null ? { imageIndex: field.imageIndex } : {}), ...(eligible && field.evidenceIndex != null ? { evidenceIndex: field.evidenceIndex } : {}) }];
  }));
}
function confidenceState(value) { return value >= 0.85 ? "high" : value >= HIGH_CONFIDENCE_THRESHOLD ? "acceptable" : "review"; }

export async function applyEvidenceConfidence(result, options = {}) {
  const barcodeImageProvided = Boolean(options?.barcodeImageProvided);
  const next = { ...result };
  const scannedBarcode = String(next.barcode?.source === "BARCODE_IMAGE_DECODER" ? next.barcode?.value : "").replace(/\D/g, "");
  const barcode = scannedBarcode || null;
  let dataKart = null, dataKartMatchedGtin = null, dataKartError = null, webMrpRange = null;
  if (barcode) {
    try { const lookup = await fetchDataKartByGtin(barcode); dataKart = lookup.product; dataKartMatchedGtin = lookup.matchedGtin; }
    catch (error) { dataKartError = error?.message || "DataKart lookup failed."; }
  }
  if (barcode && !dataKart && !dataKartError) {
    try { webMrpRange = await searchMrpRange({ productName: result?.productName?.value, brandName: result?.brandName?.value, netQuantity: result?.netQuantity?.value, unit: result?.unit?.value }); }
    catch (error) { webMrpRange = { status: "UNAVAILABLE", error: error?.message || "Web MRP search failed." }; }
  }

  const details = {};
  for (const [fieldKey, fieldValue] of Object.entries(result || {})) {
    if (!fieldValue || typeof fieldValue !== "object" || !FIELD_MAP[fieldKey]) continue;
    const semanticAI = clamp01(fieldValue.confidence) ?? 0;
    const gemini = voteConfidence(fieldValue, "gemini");
    const grok = voteConfidence(fieldValue, "grok");
    const rapidocr = rapidEvidenceScore(fieldValue);
    const registeredValue = dataKart?.[FIELD_MAP[fieldKey]];
    const dataKartMatchState = dataKartMatch(fieldKey, fieldValue.value, registeredValue);
    const fused = Math.max(0, Math.min(1, 0.90 * semanticAI + 0.10 * rapidocr));
    const verification = dataKartMatchState === true ? "MATCH" : dataKartMatchState === false ? "MISMATCH" : "UNVERIFIED";
    const nextField = {
      ...fieldValue,
      confidence: Math.round(fused * 1000) / 1000,
      evidenceConfidence: Math.round(fused * 1000) / 1000,
      confidenceSources: { gemini, grok, semanticAI, rapidocr, weights: { ...CONFIDENCE_WEIGHTS }, dataKart: null },
      verification,
      verificationIcon: verification === "MATCH" ? "✓" : verification === "MISMATCH" ? "✕" : "?",
      confidenceLabel: "AI-weighted evidence confidence",
      dataKart: { state: verification, registeredValue: registeredValue ?? null },
      confidenceState: confidenceState(fused),
    };
    next[fieldKey] = nextField;
    details[fieldKey] = nextField.confidenceSources;
  }

  next.ruleEngineInput = buildRuleEngineInput(next);
  next.majorityVote = next.ruleEngineInput;
  if (next.mrp && webMrpRange?.min != null && webMrpRange?.max != null && next.mrp.value != null) next.mrp = { ...next.mrp, webMarketRange: webMrpRange, value: `${next.mrp.value} · web MRP range ₹${webMrpRange.min}–₹${webMrpRange.max}` };

  next.evidenceConfidence = {
    weights: { ...CONFIDENCE_WEIGHTS },
    highConfidenceThreshold: HIGH_CONFIDENCE_THRESHOLD,
    ruleEngineMinimumConfidence: RULE_ENGINE_MIN_CONFIDENCE,
    method: "Gemini (45%) + Grok (45%) semantic consensus with RapidOCR evidence quality (10%). DataKart is reference verification only and never contributes to compliance scoring.",
    dataKartAvailable: Boolean(dataKart), dataKartError, dataKartMatchedGtin, webMrpRange, fields: details,
  };

  const dataKartStatus = dataKart ? "REGISTERED" : dataKartError ? "UNAVAILABLE" : barcodeImageProvided && !barcode ? "BARCODE_UNREADABLE" : barcode ? "NOT_FOUND" : "NO_GTIN";
  next.dataKartVerification = { status: dataKartStatus, code: dataKartStatus, message: dataKart ? "✓ Product found in DataKart" : dataKartError ? "? DataKart could not be reached" : dataKartStatus === "BARCODE_UNREADABLE" ? "? Barcode could not be decoded" : barcode ? "✕ Product not found in DataKart" : "? No barcode scan result", gtin: barcode, matchedGtin: dataKartMatchedGtin };
  next.dataKartReference = dataKart ? { gtin: barcode, matchedGtin: dataKartMatchedGtin, product: dataKart, note: "Reference verification only. DataKart does not determine compliance." } : null;
  return next;
}
