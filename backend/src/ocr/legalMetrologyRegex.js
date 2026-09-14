const pick = (re, text) => { const m = String(text || "").match(re); return m || null; };
const clean = (v) => String(v || "").replace(/\s+/g, " ").trim();
const field = (value, item, extra = {}) => ({ value, displayValue: value, raw: item?.text || value, evidence: item?.text || value, status: "found", source: "REGEX_LEGAL_METROLOGY", confidence: Math.max(0.35, Math.min(0.85, Number(item?.confidence || 0.6) * 0.92)), imageIndex: item?.imageIndex ?? 0, evidenceIndex: item?.evidenceIndex ?? -1, boundingBox: item?.boundingBox || null, imageWidth: item?.imageWidth || null, imageHeight: item?.imageHeight || null, verification: "regex-format-validated", regexEvidence: extra });
const units = "mg|mcg|g|gm|kg|ml|cl|l|ltr|oz|lb|pcs?|pieces?|units?|nos|n";
const patterns = {
  mrp: /\bMRP\s*[:\-]?\s*(?:Rs\.?|₹|INR)?\s*(\d+(?:,\d{3})*(?:\.\d{1,2})?)(?:\s*[-–—]\s*(?:Rs\.?|₹|INR)?\s*(\d+(?:\.\d{1,2})?))?/i,
  usp: /\bUSP\s*[:\-]?\s*(?:Rs\.?|₹|INR)?\s*(\d+(?:\.\d{1,2})?)\s*\/\s*(g|kg|ml|l|pc|piece)\b/i,
  netCombo: new RegExp(`((?:\\d+\\s*N\\s*[xX]\\s*\\d+(?:\\.\\d+)?\\s*(?:${units})\\s*\\+?\\s*)+)=?\\s*(\\d+(?:\\.\\d+)?)\\s*(${units})\\b`, "i"),
  netSimple: new RegExp(`(?:Net\\s*(?:Wt\\.?|Weight|Qty|Quantity))?\\s*[:\\-]?\\s*(\\d+(?:,\\d{3})*(?:\\.\\d+)?)\\s*(${units})\\b`, "i"),
  batch: /(?:Batch\s*(?:No\.?|Number)?|\bB\b)\s*[:\-]?\s*([A-Z0-9]{5,16})\b/i,
  mfgDate: /(?:#\s*|Mfg\.?\s*Date|Date\s*of\s*Packing|MFD|PKD)\s*[:\-]?\s*(\d{1,2}\s*[/-]\s*\d{2,4}|\d{4}\s*[/-]\s*\d{1,2})/i,
  ean13: /\b\d{13}\b/g,
  email: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i,
  website: /\b(?:https?:\/\/)?(?:www\.)?[A-Z0-9-]+(?:\.[A-Z0-9-]+)+\b/i,
  phone: /\b(?:\+?91[\s-]?)?(?:1800[\s-]?\d{6,8}|[6-9]\d{9})\b/i,
  pincode: /\b\d{6}\b/g,
  mfgLicense: /(?:Mfg\.?\s*Lic\.?\s*No\.?|Manufacturing\s*Licence?\s*No\.?)\s*[:\-]?\s*([A-Z0-9./\-]+)/i,
  marketedBy: /(?:Marketed\s*by|Mktd\.?\s*by)\s*[:\-]?\s*([^\n,]{3,100})/i,
  mfdBy: /(?:Mfd\.?\s*by|Manufactured\s*by)\s*[:\-]?\s*([^\n,]{3,100})/i,
  packedBy: /(?:Packed\s*by|Packed\s*at)\s*[:\-]?\s*([^\n,]{3,100})/i,
  importedBy: /(?:Imported\s*by|Importer)\s*[:\-]?\s*([^\n,]{3,100})/i,
  origin: /(?:Country\s*of\s*Origin|Made\s*in)\s*[:\-]?\s*([A-Za-z][A-Za-z .'-]{2,60})/i,
  fssai: /(?:FSSAI\s*(?:Lic(?:ence|ense)?\.?\s*)?(?:No\.?|Number)?)\s*[:\-]?\s*([0-9]{10,16})/i,
};
export function normalizeLegalMetrologyFields(result = {}) {
  const next = { ...result };
  const items = Array.isArray(result.declarationEvidence) ? result.declarationEvidence : [];
  const texts = items.length ? items : (result.rawText ? [{ text: result.rawText, confidence: 0.6, imageIndex: 0, evidenceIndex: -1 }] : []);
  const first = (re) => { for (const item of texts) { const m = pick(re, item.text); if (m) return { item, m, full: clean(m[0]) }; } return null; };
  const set = (key, hit, value, extra = {}) => { if (!hit || next[key]?.value) return; next[key] = field(value, hit.item, extra); };
  const mrp = first(patterns.mrp); if (mrp) { const a = Number(mrp.m[1].replace(/,/g, "")); const b = mrp.m[2] ? Number(mrp.m[2].replace(/,/g, "")) : null; next.mrpCandidates = b == null ? [a] : [a, b]; next.mrpPricingPattern = b == null ? "SINGLE_PRICE" : "DUAL_PRICE"; set("mrp", mrp, String(a), { candidates: next.mrpCandidates, pattern: next.mrpPricingPattern }); }
  const usp = first(patterns.usp); if (usp) set("usp", usp, `${usp.m[1]} / ${usp.m[2]}`, { numericValue: Number(usp.m[1]), unit: usp.m[2] });
  const combo = first(patterns.netCombo); if (combo) { const total = `${combo.m[2]} ${combo.m[3]}`; set("netQuantity", combo, total, { packComposition: clean(combo.m[1]) }); next.packComposition = { value: clean(combo.m[1]), finalTotal: total, source: "REGEX_LEGAL_METROLOGY" }; } else { const net = first(patterns.netSimple); if (net) set("netQuantity", net, `${net.m[1].replace(/,/g, "")} ${net.m[2]}`); }
  const batch = first(patterns.batch); if (batch) set("batchNumber", batch, batch.m[1].toUpperCase());
  const date = first(patterns.mfgDate); if (date) set("dateOfManufacture", date, date.m[1].replace(/\s+/g, ""));
  const ean = texts.flatMap((item) => (item.text.match(patterns.ean13) || []).map((v) => ({ item, value: v }))); if (ean.length) { next.barcodeCandidates = [...new Set(ean.map((x) => x.value))]; if (!next.barcode?.value) next.barcode = field(ean[0].value, ean[0].item, { format: "EAN-13" }); }
  const phone = first(patterns.phone); if (phone) set("consumerCarePhone", phone, phone.m[0]);
  const email = first(patterns.email); if (email) set("consumerCareEmail", email, email.m[0]);
  const website = first(patterns.website); if (website) set("website", website, website.m[0]);
  const pincodeMatches = texts.flatMap((item) => { const barcodes = [...(item.text.matchAll(patterns.ean13))].map((m) => [m.index, m.index + m[0].length]); return [...item.text.matchAll(patterns.pincode)].filter((m) => !barcodes.some(([s,e]) => (m.index >= s && m.index + 6 <= e))).map((m) => ({ item, value: m[0] })); }); if (pincodeMatches.length) { next.pincodeCandidates = [...new Set(pincodeMatches.map((x) => x.value))]; set("pincode", pincodeMatches[0], pincodeMatches[0].value); }
  const license = first(patterns.mfgLicense); if (license) set("mfgLicenseNo", license, license.m[1]);
  const marketed = first(patterns.marketedBy); if (marketed) set("marketer", marketed, clean(marketed.m[1]));
  const mfd = first(patterns.mfdBy); if (mfd) set("manufacturer", mfd, clean(mfd.m[1]));
  const packed = first(patterns.packedBy); if (packed) set("packer", packed, clean(packed.m[1]));
  const imported = first(patterns.importedBy); if (imported) set("importer", imported, clean(imported.m[1]));
  const origin = first(patterns.origin); if (origin) set("countryOfOrigin", origin, clean(origin.m[1]));
  const fssai = first(patterns.fssai); if (fssai) set("fssaiLicenseNumber", fssai, fssai.m[1]);
  next.regexNormalization = { schemaVersion: "legal-metrology-v1", fields: ["mrp","usp","netQuantity","packComposition","batchNumber","dateOfManufacture","barcodeCandidates","consumerCarePhone","consumerCareEmail","website","pincodeCandidates","mfgLicenseNo","marketer","manufacturer","packer","importer","countryOfOrigin","fssaiLicenseNumber"], mrpPattern: next.mrpPricingPattern || null };
  return next;
}
