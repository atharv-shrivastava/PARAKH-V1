import crypto from "node:crypto";

function clean(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("en-IN")
    .replace(/\s+/g, " ")
    .trim();
}

function digits(value) {
  return String(value ?? "").replace(/\D/g, "");
}

function numberKey(value) {
  if (value === null || value === undefined || value === "") return "";
  const n = Number(String(value).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n.toFixed(2) : clean(value);
}

function fieldValue(value) {
  if (value && typeof value === "object") return value.value ?? value.displayValue ?? value.canonicalValue ?? "";
  return value ?? "";
}

function parseStoredOcr(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return {}; }
}

function findingKey(finding) {
  const status = clean(finding?.status);
  if (status !== "violation") return "";
  return clean(finding?.ruleCode || finding?.ruleNumber || finding?.findingId || finding?.message);
}

export function canonicalProductIdentity(input = {}) {
  const stored = parseStoredOcr(input.ocrData);
  const ocr = stored?.ocr && typeof stored.ocr === "object" ? stored.ocr : stored;
  const compliance = stored?.compliance && typeof stored.compliance === "object" ? stored.compliance : input.compliance;
  const findings = Array.isArray(compliance?.findings) ? compliance.findings : [];
  const manualViolations = Array.isArray(stored?.manualViolations) ? stored.manualViolations : [];
  const violationSignature = [...findings.map(findingKey), ...manualViolations.map(findingKey)]
    .filter(Boolean)
    .sort()
    .join(",");

  const identity = {
    version: "PARAKH-PRODUCT-ID-V2",
    productName: clean(input.productName),
    brandName: clean(input.brandName),
    manufacturerName: clean(input.manufacturerName || fieldValue(ocr?.manufacturer)),
    manufacturerAddress: clean(fieldValue(ocr?.manufacturerAddress)),
    marketer: clean(fieldValue(ocr?.marketer)),
    marketerAddress: clean(fieldValue(ocr?.marketerAddress)),
    countryOfOrigin: clean(fieldValue(ocr?.countryOfOrigin)),
    consumerCarePhone: clean(fieldValue(ocr?.consumerCarePhone)),
    consumerCareEmail: clean(fieldValue(ocr?.consumerCareEmail)),
    netQuantity: clean(input.netQuantity),
    unit: clean(input.unit),
    mrp: numberKey(input.mrp),
    barcode: digits(input.barcode),
    batchNumber: clean(fieldValue(ocr?.batchNumber) || input.batchNumber),
    expiryDate: clean(fieldValue(ocr?.expiryDate) || fieldValue(ocr?.bestBefore)),
    dateOfManufacture: clean(fieldValue(ocr?.dateOfManufacture)),
    violationSignature,
  };

  return Object.entries(identity)
    .map(([key, value]) => `${key}=${value}`)
    .join("|");
}

export function productFingerprint(input = {}) {
  return crypto.createHash("sha256").update(canonicalProductIdentity(input), "utf8").digest("hex");
}

export function parakhIdFor(input = {}) {
  return `PARAKH-${productFingerprint(input).slice(0, 16).toUpperCase()}`;
}

export function sameProduct(left, right) {
  return productFingerprint(left) === productFingerprint(right);
}
