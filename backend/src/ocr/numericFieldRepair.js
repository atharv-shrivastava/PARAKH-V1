const QUANTITY_PAIR_RE = /\b([0-9]+(?:[.,][0-9]+)?)\s*(mg|mcg|g|gm|gms|gram|grams|kg|kgs|ml|l|ltr|ltrs|litre|litres|liter|liters|cl|oz|lb|pcs|pieces|piece|units?|nos)\b/i;
const UNIT_RE = /^(?:mg|mcg|g|gm|gms|gram|grams|kg|kgs|ml|l|ltr|ltrs|litre|litres|liter|liters|cl|oz|lb|pcs|pieces|piece|units?|nos)$/i;
const MRP_LINE_RE = /\b(?:m\.?\s*r\.?\s*p\.?|maximum\s+retail\s+price|retail\s+price)\b/i;
const MRP_VALUE_RE = /(?:₹|rs\.?|inr)?\s*([0-9][0-9,]*(?:[.,][0-9]{1,2})?)/i;

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

function quantityRepair(detections = [], rawText = '') {
  const lines = Array.isArray(detections) ? detections.filter((item) => text(item?.text)) : [];

  for (const item of lines) {
    const match = text(item.text).match(QUANTITY_PAIR_RE);
    if (match) {
      return {
        quantity: match[1].replace(/,/g, ''),
        unit: match[2],
        evidence: [item],
      };
    }
  }

  const numberLines = lines.filter((item) => /^\s*[0-9]+(?:[.,][0-9]+)?\s*$/.test(text(item.text)));
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

  const source = text(rawText);
  const rawPair = source.match(QUANTITY_PAIR_RE);
  if (rawPair) return { quantity: rawPair[1].replace(/,/g, ''), unit: rawPair[2], evidence: [] };
  return null;
}

function mrpRepair(detections = [], rawText = '') {
  const lines = Array.isArray(detections) ? detections.filter((item) => text(item?.text)) : [];
  for (const item of lines) {
    const valueMatch = text(item.text).match(QUANTITY_PAIR_RE);
    if (MRP_LINE_RE.test(text(item.text))) {
      const match = text(item.text).match(MRP_VALUE_RE);
      if (match) return { value: match[1].replace(/,/g, ''), evidence: [item] };
      const nearby = lines
        .filter((candidate) => sameImage(item, candidate) && candidate !== item && /\d{1,6}/.test(text(candidate.text)))
        .filter((candidate) => distance(item, candidate) <= 220)
        .sort((a, b) => distance(item, a) - distance(item, b))[0];
      if (nearby) {
        const numeric = text(nearby.text).match(/[0-9][0-9,]*(?:[.,][0-9]{1,2})?/);
        if (numeric) return { value: numeric[0].replace(/,/g, ''), evidence: [item, nearby] };
      }
    }
  }
  const raw = text(rawText);
  const labelMatch = raw.match(new RegExp(`${MRP_LINE_RE.source}[^\\d]{0,30}([0-9][0-9,]*(?:[.,][0-9]{1,2})?)`, 'i'));
  if (labelMatch) return { value: labelMatch[1].replace(/,/g, ''), evidence: [] };
  return null;
}

export function repairNumericFields(fields = {}, detections = [], rawText = '') {
  const repaired = Object.fromEntries(Object.entries(fields || {}));
  const quantity = quantityRepair(detections, rawText);
  if (quantity) {
    const currentQuantity = repaired.netQuantity;
    const currentUnit = repaired.unit;
    if (!currentQuantity?.value || currentQuantity?.status !== 'found') {
      repaired.netQuantity = makeField(quantity.quantity, quantity.evidence);
    }
    if (!currentUnit?.value || currentUnit?.status !== 'found') {
      repaired.unit = makeField(quantity.unit, quantity.evidence);
    }
  }

  const mrp = mrpRepair(detections, rawText);
  if (mrp && (!repaired.mrp?.value || repaired.mrp?.status !== 'found')) {
    repaired.mrp = makeField(mrp.value, mrp.evidence);
  }
  return repaired;
}
