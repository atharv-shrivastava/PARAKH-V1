const QUANTITY_PAIR_RE = /\b([0-9]{1,8}(?:[.,][0-9]{1,3})?)\s*(mg|mcg|g|gm|gms|gram|grams|kg|kgs|ml|l|ltr|ltrs|litre|litres|liter|liters|cl|oz|lb|pcs|pieces|piece|units?|nos)\b/i;
const QUANTITY_PAIR_GLOBAL_RE = /\b([0-9]{1,8}(?:[.,][0-9]{1,3})?)\s*(mg|mcg|g|gm|gms|gram|grams|kg|kgs|ml|l|ltr|ltrs|litre|litres|liter|liters|cl|oz|lb|pcs|pieces|piece|units?|nos)\b/gi;
const UNIT_RE = /^(?:mg|mcg|g|gm|gms|gram|grams|kg|kgs|ml|l|ltr|ltrs|litre|litres|liter|liters|cl|oz|lb|pcs|pieces|piece|units?|nos)$/i;
const MRP_LINE_RE = /\b(?:m\.?\s*r\.?\s*p\.?|maximum\s+retail\s+price|retail\s+price)\b/i;
const MRP_VALUE_RE = /(?:₹|rs\.?|inr)?\s*([0-9]{1,7}(?:[0-9,]*(?:[.,][0-9]{1,2})?)?)/i;
const PHONE_RE = /(?:\+?91[\s-]?)?[6-9][0-9\s()\-.]{8,14}[0-9]/;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const BARCODE_RE = /\b([0-9]{8}|[0-9]{12}|[0-9]{13}|[0-9]{14})\b/;
const DATE_RE = /\b(?:0?[1-9]|[12][0-9]|3[01])[\/.\-](?:0?[1-9]|1[0-2])[\/.\-](?:20)?[0-9]{2}\b|\b(?:0?[1-9]|1[0-2])[\/.\-](?:20)?[0-9]{2}\b|\b20[0-9]{2}[\/.\-](?:0?[1-9]|1[0-2])[\/.\-](?:0?[1-9]|[12][0-9]|3[01])\b/i;
const LICENSE_RE = /\b(?:lic(?:ense)?|fssai|gst|iso|reg(?:istration)?)[\s.:#-]*[A-Z0-9\-/]{5,}\b/i;

function text(value) { return String(value ?? '').replace(/\s+/g, ' ').trim(); }
function confidenceOf(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0.55;
  return n > 1 ? Math.max(0, Math.min(1, n / 100)) : Math.max(0, Math.min(1, n));
}
function center(box) {
  if (!box) return null;
  const left = Number(box.left ?? box.x), top = Number(box.top ?? box.y), width = Number(box.width), height = Number(box.height);
  if (![left, top, width, height].every(Number.isFinite)) return null;
  return { x: left + width / 2, y: top + height / 2 };
}
function distance(a, b) {
  const ca = center(a?.boundingBox), cb = center(b?.boundingBox);
  if (!ca || !cb) return Number.POSITIVE_INFINITY;
  return Math.hypot(ca.x - cb.x, ca.y - cb.y);
}
function sameImage(a, b) { return Number(a?.imageIndex ?? 0) === Number(b?.imageIndex ?? 0); }
function makeField(value, evidence, source = 'LOCAL_OCR_REPAIR') {
  const safe = text(value);
  const confidence = evidence.reduce((best, item) => Math.max(best, confidenceOf(item?.confidence)), 0.55);
  return {
    value: safe, displayValue: safe,
    raw: evidence.map((item) => text(item?.text)).filter(Boolean).join(' '),
    evidence: evidence.map((item) => text(item?.text)).filter(Boolean).join(' '),
    confidence: Math.max(0.30, Math.min(0.94, confidence * 0.88)), status: 'found',
    imageIndex: Number.isInteger(evidence[0]?.imageIndex) ? evidence[0].imageIndex : 0,
    ...(Number.isInteger(evidence[0]?.evidenceIndex) ? { evidenceIndex: evidence[0].evidenceIndex } : {}),
    boundingBox: evidence[0]?.boundingBox || null,
    imageWidth: evidence[0]?.imageWidth || null, imageHeight: evidence[0]?.imageHeight || null,
    source, verification: source,
  };
}
function shouldReplaceField(current, candidate) {
  if (!candidate) return false;
  if (!current?.value || current?.status !== 'found') return true;
  return confidenceOf(candidate.confidence) > confidenceOf(current.confidence) + 0.02;
}

function quantityCandidates(detections = [], rawText = '') {
  const lines = Array.isArray(detections) ? detections.filter((item) => text(item?.text)) : [];
  const candidates = [];
  const add = (match, item = null, evidenceIndex = -1) => {
    if (!match) return;
    const quantity = match[1].replace(/,/g, '');
    const unit = match[2];
    candidates.push({
      quantity, unit, text: item ? text(item.text) : text(match[0]),
      imageIndex: Number.isInteger(item?.imageIndex) ? item.imageIndex : 0,
      evidenceIndex: Number.isInteger(item?.evidenceIndex) ? item.evidenceIndex : evidenceIndex,
      confidence: Number(item?.confidence || 0), boundingBox: item?.boundingBox || null,
    });
  };

  for (const item of lines) {
    for (const match of text(item.text).matchAll(QUANTITY_PAIR_GLOBAL_RE)) add(match, item);
  }

  const numberLines = lines.filter((item) => /^\s*[0-9]{1,8}(?:[.,][0-9]{1,3})?\s*$/.test(text(item.text)));
  const unitLines = lines.filter((item) => UNIT_RE.test(text(item.text)));
  for (const numberLine of numberLines) {
    for (const unitLine of unitLines) {
      if (!sameImage(numberLine, unitLine)) continue;
      const gap = distance(numberLine, unitLine);
      if (gap > 220) continue;
      candidates.push({
        quantity: text(numberLine.text).replace(/,/g, ''), unit: text(unitLine.text),
        text: `${text(numberLine.text)} ${text(unitLine.text)}`,
        imageIndex: numberLine.imageIndex ?? 0,
        evidenceIndex: Number.isInteger(numberLine.evidenceIndex) ? numberLine.evidenceIndex : -1,
        confidence: Math.max(confidenceOf(numberLine.confidence), confidenceOf(unitLine.confidence)),
        boundingBox: numberLine.boundingBox || unitLine.boundingBox || null,
      });
    }
  }

  const raw = text(rawText);
  for (const match of raw.matchAll(QUANTITY_PAIR_GLOBAL_RE)) add(match);
  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = `${candidate.imageIndex}|${candidate.quantity}|${candidate.unit.toLowerCase()}|${candidate.text.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function quantityRepair(detections = [], rawText = '') {
  const candidates = quantityCandidates(detections, rawText);
  if (!candidates.length) return null;
  const best = [...candidates].sort((a, b) => confidenceOf(b.confidence) - confidenceOf(a.confidence))[0];
  const evidence = (detections || []).filter((item) => item?.evidenceIndex === best.evidenceIndex).slice(0, 1);
  return { quantity: best.quantity, unit: best.unit, evidence, candidates };
}

function mrpRepair(detections = [], rawText = '') {
  const lines = Array.isArray(detections) ? detections.filter((item) => text(item?.text)) : [];
  for (const item of lines) {
    const line = text(item.text);
    if (!MRP_LINE_RE.test(line)) continue;
    const candidates = [...line.matchAll(new RegExp(MRP_VALUE_RE.source, 'gi'))].map((match) => match[1].replace(/,/g, '')).filter((value) => Number(value) <= 1000000);
    if (candidates.length) return { value: candidates[0], evidence: [item] };
    const nearby = lines.filter((candidate) => sameImage(item, candidate) && candidate !== item && /\b\d{1,7}(?:[.,]\d{1,2})?\b/.test(text(candidate.text))).filter((candidate) => distance(item, candidate) <= 220).filter((candidate) => !LICENSE_RE.test(text(candidate.text))).sort((a, b) => distance(item, a) - distance(item, b))[0];
    if (nearby) {
      const numeric = text(nearby.text).match(/\b[0-9]{1,7}(?:[.,][0-9]{1,2})?\b/);
      if (numeric && Number(numeric[0].replace(',', '')) <= 1000000) return { value: numeric[0].replace(/,/g, ''), evidence: [item, nearby] };
    }
  }
  const raw = text(rawText);
  const labelMatch = raw.match(new RegExp(`${MRP_LINE_RE.source}[^\\d]{0,40}([0-9]{1,7}(?:[0-9,]*(?:[.,][0-9]{1,2})?)?)`, 'i'));
  if (labelMatch && Number(labelMatch[1].replace(/,/g, '')) <= 1000000) return { value: labelMatch[1].replace(/,/g, ''), evidence: [] };
  return null;
}

export function repairNumericFields(fields = {}, detections = [], rawText = '') {
  const repaired = Object.fromEntries(Object.entries(fields || {}));
  const quantity = quantityRepair(detections, rawText);
  if (quantity) {
    const quantityField = makeField(quantity.quantity, quantity.evidence);
    quantityField.quantityCandidates = quantity.candidates;
    const unitField = makeField(quantity.unit, quantity.evidence);
    unitField.quantityCandidates = quantity.candidates;
    if (shouldReplaceField(repaired.netQuantity, quantityField)) repaired.netQuantity = quantityField;
    if (shouldReplaceField(repaired.unit, unitField)) repaired.unit = unitField;
  }
  const mrp = mrpRepair(detections, rawText);
  if (mrp) {
    const mrpField = makeField(mrp.value, mrp.evidence);
    if (shouldReplaceField(repaired.mrp, mrpField)) repaired.mrp = mrpField;
  }
  const lines = Array.isArray(detections) ? detections.filter((item) => text(item?.text)) : [];
  const phoneLine = lines.find((item) => PHONE_RE.test(text(item.text)));
  if (phoneLine && (!repaired.consumerCarePhone?.value || repaired.consumerCarePhone.status !== 'found')) repaired.consumerCarePhone = makeField(text(phoneLine.text).match(PHONE_RE)?.[0]?.replace(/\s+/g, ' ').trim(), [phoneLine], 'REGEX_OCR_REPAIR');
  const emailLine = lines.find((item) => EMAIL_RE.test(text(item.text)));
  if (emailLine && (!repaired.consumerCareEmail?.value || repaired.consumerCareEmail.status !== 'found')) repaired.consumerCareEmail = makeField(text(emailLine.text).match(EMAIL_RE)?.[0], [emailLine], 'REGEX_OCR_REPAIR');
  const dateLine = lines.find((item) => DATE_RE.test(text(item.text)));
  if (dateLine && (!repaired.dateOfManufacture?.value && !repaired.dateOfPacking?.value)) {
    const match = text(dateLine.text).match(DATE_RE); if (match?.[0]) repaired.dateOfManufacture = makeField(match[0], [dateLine], 'REGEX_OCR_REPAIR_CANDIDATE');
  }
  const barcodeLine = lines.find((item) => BARCODE_RE.test(text(item.text)));
  if (barcodeLine && (!repaired.barcode?.value || repaired.barcode.status !== 'found')) {
    const match = text(barcodeLine.text).match(BARCODE_RE); if (match?.[1]) repaired.barcode = makeField(match[1], [barcodeLine], 'REGEX_OCR_REPAIR_CANDIDATE');
  }
  return repaired;
}
