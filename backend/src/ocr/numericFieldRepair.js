const QUANTITY_PAIR_RE = /\b([0-9]{1,8}(?:[.,][0-9]{1,3})?)\s*(mg|mcg|g|gm|gms|gram|grams|kg|kgs|ml|l|ltr|ltrs|litre|litres|liter|liters|cl|oz|lb|pcs|pieces|piece|units?|nos)\b/i;
const UNIT_RE = /^(?:mg|mcg|g|gm|gms|gram|grams|kg|kgs|ml|l|ltr|ltrs|litre|litres|liter|liters|cl|oz|lb|pcs|pieces|piece|units?|nos)$/i;
const MRP_LINE_RE = /\b(?:m\.?\s*r\.?\s*p\.?|maximum\s+retail\s+price|retail\s+price)\b/i;
const MRP_VALUE_RE = /(?:₹|rs\.?|inr)?\s*([0-9]{1,7}(?:[0-9,]*(?:[.,][0-9]{1,2})?)?)/i;
const PHONE_RE = /(?:\+?91[\s-]?)?[6-9][0-9\s()\-.]{8,14}[0-9]/;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const BARCODE_RE = /\b([0-9]{8}|[0-9]{12}|[0-9]{13}|[0-9]{14})\b/;
const DATE_RE = /\b(?:0?[1-9]|[12][0-9]|3[01])[\/.\-](?:0?[1-9]|1[0-2])[\/.\-](?:20)?[0-9]{2}\b|\b(?:0?[1-9]|1[0-2])[\/.\-](?:20)?[0-9]{2}\b|\b20[0-9]{2}[\/.\-](?:0?[1-9]|1[0-2])[\/.\-](?:0?[1-9]|[12][0-9]|3[01])\b/i;
const LICENSE_RE = /\b(?:lic(?:ense)?|fssai|gst|iso|reg(?:istration)?)[\s.:#-]*[A-Z0-9\-/]{5,}\b/i;

function text(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function confidenceOf(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0.55;
  return n > 1 ? Math.max(0, Math.min(1, n / 100)) : Math.max(0, Math.min(1, n));
}

function center(box) {
  if (!box) return null;
  const left = Number(box.left ?? box.x);
  const top = Number(box.top ?? box.y);
  const width = Number(box.width);
  const height = Number(box.height);
  if (![left, top, width, height].every(Number.isFinite)) return null;
  return { x: left + width / 2, y: top + height / 2 };
}

function distance(a, b) {
  const ca = center(a?.boundingBox);
  const cb = center(b?.boundingBox);
  if (!ca || !cb) return Number.POSITIVE_INFINITY;
  return Math.hypot(ca.x - cb.x, ca.y - cb.y);
}

function sameImage(a, b) {
  return Number(a?.imageIndex ?? 0) === Number(b?.imageIndex ?? 0);
}

function makeField(value, evidence, source = 'LOCAL_OCR_REPAIR') {
  const safe = text(value);
  const confidence = evidence.reduce((best, item) => Math.max(best, confidenceOf(item?.confidence)), 0.55);
  return {
    value: safe,
    displayValue: safe,
    raw: evidence.map((item) => text(item?.text)).filter(Boolean).join(' '),
    evidence: evidence.map((item) => text(item?.text)).filter(Boolean).join(' '),
    confidence: Math.max(0.30, Math.min(0.94, confidence * 0.88)),
    status: 'found',
    imageIndex: Number.isInteger(evidence[0]?.imageIndex) ? evidence[0].imageIndex : 0,
    ...(Number.isInteger(evidence[0]?.evidenceIndex) ? { evidenceIndex: evidence[0].evidenceIndex } : {}),
    boundingBox: evidence[0]?.boundingBox || null,
    imageWidth: evidence[0]?.imageWidth || null,
    imageHeight: evidence[0]?.imageHeight || null,
    source,
    verification: source,
  };
}

function shouldReplaceField(current, candidate) {
  if (!candidate) return false;
  if (!current?.value || current?.status !== 'found') return true;
  const currentConfidence = confidenceOf(current.confidence);
  const candidateConfidence = confidenceOf(candidate.confidence);
  return candidateConfidence > currentConfidence + 0.02;
}

function quantityRepair(detections = [], rawText = '') {
  const lines = Array.isArray(detections) ? detections.filter((item) => text(item?.text)) : [];
  for (const item of lines) {
    const match = text(item.text).match(QUANTITY_PAIR_RE);
    if (match) return { quantity: match[1].replace(/,/g, ''), unit: match[2], evidence: [item] };
  }

  const numberLines = lines.filter((item) => /^\s*[0-9]{1,8}(?:[.,][0-9]{1,3})?\s*$/.test(text(item.text)));
  const unitLines = lines.filter((item) => UNIT_RE.test(text(item.text)));
  let best = null;
  for (const numberLine of numberLines) {
    for (const unitLine of unitLines) {
      if (!sameImage(numberLine, unitLine)) continue;
      const gap = distance(numberLine, unitLine);
      if (gap > 220) continue;
      const score = confidenceOf(numberLine.confidence) * 0.4 + confidenceOf(unitLine.confidence) * 0.3 + Math.max(0, 1 - gap / 220) * 0.3;
      if (!best || score > best.score) best = { numberLine, unitLine, score };
    }
  }
  if (best) return { quantity: text(best.numberLine.text).replace(/,/g, ''), unit: text(best.unitLine.text), evidence: [best.numberLine, best.unitLine] };

  const rawPair = text(rawText).match(QUANTITY_PAIR_RE);
  if (rawPair) return { quantity: rawPair[1].replace(/,/g, ''), unit: rawPair[2], evidence: [] };
  return null;
}

function mrpRepair(detections = [], rawText = '') {
  const lines = Array.isArray(detections) ? detections.filter((item) => text(item?.text)) : [];
  for (const item of lines) {
    const line = text(item.text);
    if (!MRP_LINE_RE.test(line)) continue;
    const candidates = [...line.matchAll(new RegExp(MRP_VALUE_RE.source, 'gi'))]
      .map((match) => match[1].replace(/,/g, ''))
      .filter((value) => Number(value) <= 1000000);
    if (candidates.length) return { value: candidates[0], evidence: [item] };

    const nearby = lines
      .filter((candidate) => sameImage(item, candidate) && candidate !== item && /\b\d{1,7}(?:[.,]\d{1,2})?\b/.test(text(candidate.text)))
      .filter((candidate) => distance(item, candidate) <= 220)
      .filter((candidate) => !LICENSE_RE.test(text(candidate.text)))
      .sort((a, b) => distance(item, a) - distance(item, b))[0];
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
    const unitField = makeField(quantity.unit, quantity.evidence);
    if (shouldReplaceField(repaired.netQuantity, quantityField)) repaired.netQuantity = quantityField;
    if (shouldReplaceField(repaired.unit, unitField)) repaired.unit = unitField;
  }

  const mrp = mrpRepair(detections, rawText);
  if (mrp) {
    const mrpField = makeField(mrp.value, mrp.evidence);
    if (shouldReplaceField(repaired.mrp, mrpField)) repaired.mrp = mrpField;
  }

  // Regex repairs are evidence extractors, not legal judgments. Only fill a field
  // when a candidate is structurally well-formed and spatially tied to OCR evidence.
  const lines = Array.isArray(detections) ? detections.filter((item) => text(item?.text)) : [];
  const phoneLine = lines.find((item) => PHONE_RE.test(text(item.text)));
  if (phoneLine && (!repaired.consumerCarePhone?.value || repaired.consumerCarePhone.status !== 'found')) {
    const match = text(phoneLine.text).match(PHONE_RE);
    repaired.consumerCarePhone = makeField(match?.[0]?.replace(/\s+/g, ' ').trim(), [phoneLine], 'REGEX_OCR_REPAIR');
  }
  const emailLine = lines.find((item) => EMAIL_RE.test(text(item.text)));
  if (emailLine && (!repaired.consumerCareEmail?.value || repaired.consumerCareEmail.status !== 'found')) {
    const match = text(emailLine.text).match(EMAIL_RE);
    repaired.consumerCareEmail = makeField(match?.[0], [emailLine], 'REGEX_OCR_REPAIR');
  }
  const dateLine = lines.find((item) => DATE_RE.test(text(item.text)));
  if (dateLine && (!repaired.dateOfManufacture?.value && !repaired.dateOfPacking?.value)) {
    const match = text(dateLine.text).match(DATE_RE);
    if (match?.[0]) repaired.dateOfManufacture = makeField(match[0], [dateLine], 'REGEX_OCR_REPAIR_CANDIDATE');
  }
  const barcodeLine = lines.find((item) => BARCODE_RE.test(text(item.text)));
  if (barcodeLine && (!repaired.barcode?.value || repaired.barcode.status !== 'found')) {
    const match = text(barcodeLine.text).match(BARCODE_RE);
    if (match?.[1]) repaired.barcode = makeField(match[1], [barcodeLine], 'REGEX_OCR_REPAIR_CANDIDATE');
  }

  return repaired;
}
