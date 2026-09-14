const QUANTITY_PAIR_RE = /\b([0-9]{1,8}(?:[.,][0-9]{1,3})?)\s*(mg|mcg|g|gm|gms|gram|grams|kg|kgs|ml|l|ltr|ltrs|litre|litres|liter|liters|cl|oz|lb|pcs|pieces|piece|units?|nos)\b/i;
const UNIT_RE = /^(?:mg|mcg|g|gm|gms|gram|grams|kg|kgs|ml|l|ltr|ltrs|litre|litres|liter|liters|cl|oz|lb|pcs|pieces|piece|units?|nos)$/i;
const MRP_LINE_RE = /\b(?:m\.?\s*r\.?\s*p\.?|maximum\s+retail\s+price|retail\s+price)\b/i;
const MRP_VALUE_RE = /(?:₹|rs\.?|inr)?\s*([0-9]{1,7}(?:[0-9,]*(?:[.,][0-9]{1,2})?)?)/i;
const PHONE_RE = /(?:\+?91[\s-]?)?[6-9][0-9\s()\-.]{8,14}[0-9]/;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const BARCODE_RE = /\b([0-9]{8}|[0-9]{12}|[0-9]{13}|[0-9]{14})\b/;
const DATE_RE = /\b(?:0?[1-9]|[12][0-9]|3[01])[\/.\-](?:0?[1-9]|1[0-2])[\/.\-](?:20)?[0-9]{2}\b|\b(?:0?[1-9]|1[0-2])[\/.\-](?:20)?[0-9]{2}\b|\b20[0-9]{2}[\/.\-](?:0?[1-9]|1[0-2])[\/.\-](?:0?[1-9]|[12][0-9]|3[01])\b/i;
const LICENSE_RE = /\b(?:lic(?:ense)?|fssai|gst|iso|reg(?:istration)?)[\s.:#-]*[A-Z0-9\-/]{5,}\b/i;
const QUANTITY_CONTEXT_RE = /\b(?:net\s*(?:qty|quantity|weight|wt|contents?)|net\s*content|quantity|pack\s*size|gross\s*weight|weight|volume|contents?)\b/i;
const NEGATIVE_QUANTITY_CONTEXT_RE = /\b(?:serving|per\s+serving|energy|protein|carbohydrate|carbs?|sodium|salt|sugar|fat|calories?|nutrition|%\s*d?aily|daily\s+value|ingredients?|fssai|license|registration|batch|lot|phone|toll\s*free|pin(?:code)?|pincode|customer\s*care|consumer\s*care)\b/i;
const MRP_CONTEXT_RE = /\b(?:m\.?r\.?p|maximum\s+retail\s+price|retail\s+price)\b/i;
const NEGATIVE_MRP_CONTEXT_RE = /\b(?:fssai|license|registration|batch|lot|phone|toll\s*free|pin(?:code)?|pincode|ingredients?|nutrition|serving)\b/i;

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

function quantityCandidateScore(item, match, lines) {
  let score = confidenceOf(item?.confidence) * 40;
  const value = Number(String(match[1]).replace(/,/g, ''));
  const unit = String(match[2] || '').toLowerCase();
  const line = text(item?.text);
  const metrics = item?.boundingBox;
  const lower = line.toLowerCase();

  if (QUANTITY_CONTEXT_RE.test(lower)) score += 38;
  if (NEGATIVE_QUANTITY_CONTEXT_RE.test(lower)) score -= 45;
  if (/\b(?:net\s*(?:wt|weight|qty|quantity)|net\s*content)\b/i.test(lower)) score += 25;
  if (/^(?:\d+(?:[.,]\d+)?)\s*(?:g|kg|mg|ml|l|ltr|cl|oz|lb)$/i.test(line)) score += 10;
  if (value <= 0) score -= 100;
  if (value > 100000) score -= 30;
  if (/^(?:mg|mcg)$/i.test(unit)) score += 1;
  if (/^(?:g|kg|ml|l|ltr|cl|oz|lb)$/i.test(unit)) score += 4;
  if (metrics && Number(metrics.height) > 0) score += Math.min(8, Number(metrics.height) / 10);
  return score;
}

function rawQuantityCandidates(rawText) {
  const raw = text(rawText);
  const candidates = [];
  for (const match of raw.matchAll(new RegExp(QUANTITY_PAIR_RE.source, 'gi'))) {
    const start = Math.max(0, Number(match.index || 0) - 70);
    const end = Math.min(raw.length, Number(match.index || 0) + match[0].length + 70);
    const context = raw.slice(start, end);
    let score = 20;
    if (QUANTITY_CONTEXT_RE.test(context)) score += 45;
    if (NEGATIVE_QUANTITY_CONTEXT_RE.test(context)) score -= 35;
    if (/\bnet\s*(?:wt|weight|qty|quantity|content)\b/i.test(context)) score += 30;
    candidates.push({ quantity: match[1].replace(/,/g, ''), unit: match[2], context, score });
  }
  return candidates.sort((a, b) => b.score - a.score);
}

function quantityRepair(detections = [], rawText = '') {
  const lines = Array.isArray(detections) ? detections.filter((item) => text(item?.text)) : [];
  const candidates = [];

  for (const item of lines) {
    const match = text(item.text).match(QUANTITY_PAIR_RE);
    if (match) candidates.push({ quantity: match[1].replace(/,/g, ''), unit: match[2], evidence: [item], score: quantityCandidateScore(item, match, lines) });
  }

  const numberLines = lines.filter((item) => /^\s*[0-9]{1,8}(?:[.,][0-9]{1,3})?\s*$/.test(text(item.text)));
  const unitLines = lines.filter((item) => UNIT_RE.test(text(item.text)));
  for (const numberLine of numberLines) {
    for (const unitLine of unitLines) {
      if (!sameImage(numberLine, unitLine)) continue;
      const gap = distance(numberLine, unitLine);
      if (gap > 220) continue;
      const combinedText = `${text(numberLine.text)} ${text(unitLine.text)}`;
      const pseudoMatch = combinedText.match(QUANTITY_PAIR_RE) || [null, text(numberLine.text), text(unitLine.text)];
      let score = confidenceOf(numberLine.confidence) * 32 + confidenceOf(unitLine.confidence) * 25 + Math.max(0, 1 - gap / 220) * 25;
      if (QUANTITY_CONTEXT_RE.test(combinedText)) score += 30;
      if (NEGATIVE_QUANTITY_CONTEXT_RE.test(combinedText)) score -= 45;
      candidates.push({ quantity: text(numberLine.text).replace(/,/g, ''), unit: text(unitLine.text), evidence: [numberLine, unitLine], score });
    }
  }

  for (const candidate of rawQuantityCandidates(rawText)) {
    candidates.push({ quantity: candidate.quantity, unit: candidate.unit, evidence: [], score: candidate.score });
  }

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  if (!best || best.score < 25) return null;
  return { quantity: best.quantity, unit: best.unit, evidence: best.evidence };
}

function mrpCandidateScore(item, value) {
  const line = text(item?.text);
  let score = confidenceOf(item?.confidence) * 40;
  if (MRP_CONTEXT_RE.test(line)) score += 55;
  if (NEGATIVE_MRP_CONTEXT_RE.test(line)) score -= 50;
  if (/₹|\brs\.?\b|\binr\b/i.test(line)) score += 18;
  if (Number(value) > 1000000 || Number(value) <= 0) score -= 100;
  return score;
}

function mrpRepair(detections = [], rawText = '') {
  const lines = Array.isArray(detections) ? detections.filter((item) => text(item?.text)) : [];
  const candidates = [];
  for (const item of lines) {
    const line = text(item.text);
    if (!MRP_LINE_RE.test(line)) continue;
    const matches = [...line.matchAll(new RegExp(MRP_VALUE_RE.source, 'gi'))];
    for (const match of matches) {
      const value = match[1].replace(/,/g, '');
      if (Number(value) <= 1000000) candidates.push({ value, evidence: [item], score: mrpCandidateScore(item, value) });
    }
  }

  for (const item of lines) {
    const line = text(item.text);
    if (!MRP_LINE_RE.test(line)) continue;
    const nearby = lines
      .filter((candidate) => sameImage(item, candidate) && candidate !== item && /\b\d{1,7}(?:[.,]\d{1,2})?\b/.test(text(candidate.text)))
      .filter((candidate) => distance(item, candidate) <= 220)
      .filter((candidate) => !LICENSE_RE.test(text(candidate.text)))
      .map((candidate) => {
        const numeric = text(candidate.text).match(/\b[0-9]{1,7}(?:[.,][0-9]{1,2})?\b/);
        if (!numeric) return null;
        return { value: numeric[0].replace(/,/g, ''), evidence: [item, candidate], score: mrpCandidateScore(item, numeric[0]) + Math.max(0, 25 - distance(item, candidate) / 10) };
      })
      .filter(Boolean);
    candidates.push(...nearby);
  }

  const raw = text(rawText);
  const labelMatch = raw.match(new RegExp(`${MRP_LINE_RE.source}[^\\d]{0,40}([0-9]{1,7}(?:[0-9,]*(?:[.,][0-9]{1,2})?)?)`, 'i'));
  if (labelMatch && Number(labelMatch[1].replace(/,/g, '')) <= 1000000) candidates.push({ value: labelMatch[1].replace(/,/g, ''), evidence: [], score: 60 });

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  if (!best || best.score < 30) return null;
  return { value: best.value, evidence: best.evidence };
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
