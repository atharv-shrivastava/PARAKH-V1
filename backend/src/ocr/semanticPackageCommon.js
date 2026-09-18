export const FIELD_KEYS = [
  "productName", "brandName", "manufacturer", "manufacturerAddress", "packer", "packerAddress",
  "marketer", "marketerAddress", "importer", "importerAddress", "netQuantity", "unit", "mrp",
  "currency", "dateOfManufacture", "dateOfPacking", "bestBefore", "expiryDate", "batchNumber",
  "consumerCarePhone", "consumerCareEmail", "countryOfOrigin", "fssaiLicenseNumber", "barcode",
];

export function confidence(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback;
}

export function text(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

const FIELD_VALUE_SCHEMA = {
  type: "object",
  properties: {
    value: { type: "string" },
    displayValue: { type: "string" },
    raw: { type: "string" },
    evidence: { type: "string" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    status: { type: "string", enum: ["found", "absent", "not_detected", "unreadable", "ambiguous"] },
    imageIndex: { type: "integer", minimum: 0 },
    evidenceIndex: { type: "integer", minimum: 0 },
  },
  required: ["value", "displayValue", "raw", "evidence", "confidence", "status", "imageIndex", "evidenceIndex"],
};

export function buildSemanticSchema(categoryOptions = []) {
  return {
    type: "object",
    properties: {
      ...Object.fromEntries(FIELD_KEYS.map((key) => [key, FIELD_VALUE_SCHEMA])),
      suggestedCategory: {
        type: "object",
        properties: {
          categoryId: { type: "string" },
          categoryName: { type: "string" },
          categoryPath: { type: "string" },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          reason: { type: "string" },
        },
        required: ["categoryId", "categoryName", "categoryPath", "confidence", "reason"],
      },
    },
    required: [...FIELD_KEYS, "suggestedCategory"],
  };
}

export function buildSemanticPrompt({ detections = [], rawText = "", categoryOptions = [], targetLanguage = "en" } = {}) {
  const compactDetections = detections.slice(0, 220).map((item, index) => ({
    evidenceIndex: index,
    imageIndex: item.imageIndex,
    text: item.text,
    confidence: item.confidence,
    boundingBox: item.boundingBox || null,
    imageWidth: item.imageWidth || null,
    imageHeight: item.imageHeight || null,
  }));
  const categories = categoryOptions.slice(0, 250).map((item) => ({
    id: String(item.id),
    name: text(item.name),
    path: text(item.path),
  }));

  return `You are the semantic evidence verifier inside PARAKH V1, a Legal Metrology packaged-commodity inspection system.
Your job is NOT to declare legal compliance. Your job is to reconstruct structured package declarations from the ORIGINAL PACKAGE IMAGE(S) plus RapidOCR evidence, conservatively and traceably, so a deterministic rules engine and a human inspector can review the result.

USER DISPLAY LANGUAGE: ${String(targetLanguage || "en").toLowerCase()}

SOURCE PRIORITY
1. ORIGINAL PACKAGE IMAGE(S) are the primary visual source. Read labels, values, spatial relationships, typography, nearby headings, logos, and declaration blocks directly from the image.
2. RapidOCR text and bounding boxes are evidence anchors. They are useful but can contain substitutions, missing characters, merged lines, duplicated text, or incorrect digits.
3. Never blindly copy OCR when the image visibly contradicts it.
4. Never invent text merely because a field is legally expected.
5. A legally expected field that is not visible is ABSENT/NOT_DETECTED, not guessed.
6. Do not turn a plausible web/DataKart value into package evidence. External references belong to later verification and MUST NOT be used to fabricate package fields.

CORE EXTRACTION METHOD
For EVERY field:
A. Inspect the package image for the exact candidate.
B. Search the OCR detections for matching text and nearby supporting text.
C. Use layout and proximity to connect labels to values. Examples: "M.R.P." near a rupee amount, "Net Qty" near a mass/volume, "Mfd." near a date, "Best Before" near a duration/date, "Customer Care" near phone/email.
D. Compare competing candidates. Prefer the candidate directly supported by the image and the strongest nearby OCR evidence.
E. Preserve the exact printed value in \`raw\` and \`value\` whenever it is safe to do so.
F. Put the OCR detection index containing the ACTUAL VALUE in \`evidenceIndex\`, not merely a label such as "MRP" or "Mfg".
G. If the correct candidate cannot be distinguished confidently, use status=ambiguous rather than choosing a random candidate.
H. Confidence is evidence confidence, not legal certainty. Do not output 0.90+ merely because the field is commonly expected.

CRITICAL ANTI-HALLUCINATION RULES
- Never fill a missing value from memory, product knowledge, a web result, a DataKart result, the field name, or an inferred brand/catalog record.
- Never convert a generic product expectation into package evidence.
- Never treat one OCR token as authoritative when the image contradicts it.
- Never merge text from unrelated package faces into one declaration merely because the words are semantically related.
- Never combine multiple possible manufacturers, addresses, phone numbers, emails, dates, MRPs, quantities, or batch codes into one field.
- When multiple candidates exist and the image does not establish which is authoritative, return ambiguous with the competing evidence described in \`raw\`/\`evidence\`.
- Do not infer statutory applicability or violations. Return declarations only.

FIELD-SPECIFIC RULES
PRODUCT NAME / BRAND
- productName = the consumer-facing marketed product name printed on the package.
- brandName = the brand identity. Keep brand and product name separate when the package clearly distinguishes them.
- If the package has one prominent consumer-facing identity and no separate product name is visibly distinguished, use that identity for BOTH productName and brandName rather than leaving productName blank.
- A concise brand-led product name and the same name with a generic descriptor such as "toothpaste", "shampoo", "soap", "biscuit", "juice", "flour", "oil", "cream", "lotion" may represent the same product identity. Prefer the concise printed marketed name.
- Never use slogans, ingredients, claims, FSSAI numbers, addresses, MRP, dates, weight, barcode, batch/lot/inkjet codes as productName.
- Compact codes such as BAAYZ011, LOT12345, MFG270826, #0326 are presumed production/traceability codes, not product names, unless the image unmistakably presents them as a consumer-facing brand.
- Legitimate numeric brands such as 7UP or 5 STAR are allowed only when the visual presentation clearly identifies them as branding/product names.

MANUFACTURER / PACKER / MARKETER / IMPORTER
- Identify the legal role from nearby wording such as "Mfd. by", "Manufactured by", "Packed by", "Marketed by", "Imported by", "Manufactured & Marketed by".
- Keep each role separate.
- If one entity legitimately occupies multiple roles, return the same entity separately for the applicable roles only when the package wording supports it.
- Never turn an address into an organization name.
- For addresses, preserve the complete printed address associated with that role. Do not silently splice address fragments from different roles or lines.
- If two legal entities appear on the package, do not collapse them into one manufacturer field.

NET QUANTITY / UNIT
- Extract declared net quantity, not serving size, nutrition quantity, ingredient percentage, pack count in a recipe, or recommended intake.
- netQuantity MUST contain the numeric amount only, for example "500", "1", "200".
- unit MUST contain the printed unit only, for example "g", "kg", "ml", "L", "pcs".
- NEVER put the unit inside netQuantity. "500 g" must become netQuantity="500" and unit="g".
- If the package visibly prints the quantity and unit together, split them into the two fields while preserving the exact printed quantity in raw/evidence.
- Distinguish mass, volume and count. Examples: 500 + g, 1 + kg, 200 + ml, 1 + L, 10 + pcs.
- Do not infer a unit that is not printed.

MRP / CURRENCY
- MRP means the retail price declaration, normally associated with "MRP", "M.R.P.", "Maximum Retail Price" or a visually equivalent declaration.
- evidenceIndex MUST identify the numeric price itself, not only the "MRP" label.
- Ignore promotional prices, discounts, "save" amounts, offer prices, unit prices, or price-per-100g unless the package clearly identifies them as the MRP declaration.
- Preserve the printed currency symbol/code when present. For Indian packages, distinguish ₹, Rs., and "INR" without inventing one when the package is unclear.
- If several prices appear, use spatial/contextual evidence to identify the actual MRP; otherwise mark ambiguous.

DATES / BATCH
- dateOfManufacture = manufacturing date only when the package supports it.
- dateOfPacking = packing/packed-on date only when explicitly supported.
- bestBefore = stated best-before duration/date. Do not convert a duration into a calendar date unless the package itself does so.
- expiryDate = expiry/use-by date only when explicitly labelled or clearly equivalent.
- batchNumber = lot/batch/traceability identifier, not a date or serial number unless the package labels it as the batch/lot.
- Never treat an inkjet code as a date unless the date structure and label context support it.

CONSUMER CARE
- Phone: extract the actual customer-care/contact number, not a FSSAI number, licence number, barcode, PIN code, fax number, or unrelated phone number.
- If several phone numbers are visible, prefer the one explicitly associated with "Consumer Care", "Customer Care", "Toll Free", "Helpline", "Contact", or equivalent.
- Email: extract the actual customer-care/support email. Do not replace it with a domain or infer an email address from a website.
- Preserve digits exactly. OCR often confuses 0/O, 1/I, 5/S, 8/B, and dropped leading digits. Correct such errors only when the image supports the correction.

FSSAI / LICENSE / BARCODE / COUNTRY
- FSSAI/license numbers are regulatory identifiers, not product names, batch numbers, or phone numbers.
- Barcode is useful as package evidence only if the digits are visibly present or supplied by a validated scanner. Do not invent a barcode from a product identity.
- Country of origin must be based on explicit package wording, not manufacturer location.

OCR CONFLICT RESOLUTION
When OCR and visual evidence disagree:
1. Re-read the image region containing the candidate.
2. Compare neighboring OCR detections and their coordinates.
3. Prefer the visually legible value over a clearly corrupted OCR string.
4. For numeric fields, count every digit and separator carefully.
5. For phone/email fields, prefer the candidate explicitly tied to consumer care.
6. For organization/address fields, preserve the exact legal entity and address block rather than merging nearby blocks.
7. If the image remains unclear, return ambiguous/unreadable. Do not guess.

EVIDENCE INDEX RULES
- evidenceIndex refers ONLY to the numbered RapidOCR detection objects below.
- For a FOUND field, point to the detection containing the actual value whenever such a detection exists.
- MRP -> numeric price detection.
- netQuantity -> quantity + unit detection.
- dates -> actual date/duration detection.
- batchNumber -> actual batch/lot code.
- phone/email -> actual phone/email detection.
- manufacturer/packer/marketer/importer -> the legal entity or the closest exact entity fragment; use nearby spatial context for its associated role label.
- address -> the address text itself, not just the role label.
- productName -> actual consumer-facing product-name text.
- If no trustworthy OCR detection matches the value, use status=unreadable/ambiguous or absent and set evidenceIndex=-1. Never fabricate geometry.

CONFIDENCE GUIDANCE
Use these as evidence-confidence anchors, not mathematical probabilities:
- 0.90-1.00: clearly visible in image, strong OCR match, correct context, little ambiguity.
- 0.75-0.89: clear image evidence with minor OCR noise or limited contextual ambiguity.
- 0.55-0.74: plausible but requires officer review or has source disagreement.
- 0.30-0.54: weak/partial/crowded evidence, significant OCR disagreement.
- 0.00-0.29: insufficient evidence. Prefer ambiguous/unreadable/absent instead of a forced value.
Do not assign high confidence simply because two fields look semantically related.

MULTILINGUAL DISPLAY RULES
- \`value\` is the canonical value used by downstream systems.
- \`displayValue\` is the human-readable value for the selected display language.
- Preserve legal names, addresses, phone numbers, emails, GTIN/barcodes, license IDs, batch codes, dates, MRP and quantity numerics exactly.
- For productName and brandName, when the USER DISPLAY LANGUAGE is English and the printed text is in Devanagari or another Indian script, provide a faithful English transliteration in \`value\` and \`displayValue\` when the identity is clear. Preserve the exact printed script in \`raw\` and \`evidence\`.
- Do not invent an English translation that changes the product identity. Transliteration is preferred over semantic translation for names.
- For generic commodity descriptions, use English when the target language is English.
- When target language is English, avoid returning Hindi/Devanagari script in productName or brandName unless the exact script is essential to the legal identity.

CATEGORY SUGGESTION
- Suggested category is separate from compliance extraction and MUST always be returned.
- Use ONLY one supplied final-category option when it is supported by the visible product identity and commodity type.
- Never invent a category id or pretend an unavailable category is selectable.
- Prefer the most specific supplied final category that matches the visible product identity.
- If no supplied final category is suitable, return categoryId="" with categoryName="" and categoryPath="", confidence=0, and explain briefly in reason.
- Do not omit suggestedCategory even when the answer is "not determined".

RESPONSE CONTRACT
Return EVERY field in FIELD_KEYS as an object.
For a found field include: value, displayValue, raw, evidence, confidence, status="found", imageIndex, evidenceIndex.
For an absent/not visible field use empty strings and status="absent".
Use status="unreadable" when the field appears to be present but cannot be read reliably.
Use status="ambiguous" when multiple plausible candidates exist or sources materially conflict.
Never use null for imageIndex/evidenceIndex when the schema expects integers. Use -1 when there is no trustworthy evidence index.
Do not perform compliance assessment or write legal conclusions.

RAPIDOCR DETECTIONS (evidenceIndex is the key):
${JSON.stringify(compactDetections)}

RAW RAPIDOCR TEXT:
${text(rawText)}

SUPPLIED FINAL CATEGORIES:
${JSON.stringify(categories)}

Return valid compact JSON only. No markdown. No commentary. No extra keys outside the requested schema.`;
}

export function normalizeSemanticResult(parsed, categoryOptions = []) {
  const normalized = {};
  for (const key of FIELD_KEYS) {
    const value = parsed?.[key] || {};
    const statusRaw = String(value?.status || "").toLowerCase();
    const status = ["found", "absent", "not_detected", "unreadable", "ambiguous"].includes(statusRaw)
      ? statusRaw === "not_detected" ? "absent" : statusRaw
      : value?.value != null && text(value.value) ? "found" : "absent";
    const canonical = value?.value != null && text(value.value) ? text(value.value) : null;
    const localized = value?.displayValue != null && text(value.displayValue) ? text(value.displayValue) : canonical;
    normalized[key] = {
      value: canonical,
      displayValue: localized,
      raw: value?.raw != null && text(value.raw) ? value.raw : null,
      evidence: value?.evidence != null && text(value.evidence) ? value.evidence : null,
      confidence: confidence(value?.confidence),
      status,
      ...(Number.isInteger(value?.imageIndex) ? { imageIndex: value.imageIndex } : {}),
      ...(Number.isInteger(value?.evidenceIndex) ? { evidenceIndex: value.evidenceIndex } : {}),
    };
  }
  const quantityValue = text(normalized.netQuantity?.value || "");
  const unitValue = text(normalized.unit?.value || "");
  const splitMatch = quantityValue.match(/^([0-9]+(?:[.,][0-9]+)?)\s*([a-zA-Zµμ%]+)$/);
  if (splitMatch) {
    const numericValue = splitMatch[1].replace(/,/g, "");
    normalized.netQuantity = {
      ...normalized.netQuantity,
      value: numericValue,
      displayValue: numericValue,
      status: normalized.netQuantity.status === "absent" ? "found" : normalized.netQuantity.status,
    };
    if (!unitValue) {
      normalized.unit = {
        ...normalized.unit,
        value: splitMatch[2],
        displayValue: splitMatch[2],
        raw: normalized.netQuantity.raw || null,
        evidence: normalized.netQuantity.evidence || null,
        confidence: normalized.netQuantity.confidence,
        status: "found",
      };
    }
  }

  const suggestion = parsed?.suggestedCategory && typeof parsed.suggestedCategory === "object"
    ? parsed.suggestedCategory
    : {};
  const allowed = categoryOptions.find((item) => String(item.id) === String(suggestion.categoryId));
  return {
    fields: normalized,
    suggestedCategory: {
      categoryId: allowed ? String(allowed.id) : "",
      categoryName: allowed ? text(allowed.name) : "",
      categoryPath: allowed ? text(allowed.path) : "",
      confidence: allowed ? confidence(suggestion.confidence) : 0,
      reason: text(suggestion.reason) || (allowed ? "Suggested from visible package identity and supplied final categories." : "No supplied offline final category confidently matched the visible package."),
    },
  };
}

function recoverJson(raw) {
  let s = raw.trim();
  const first = s.indexOf("{");
  if (first > 0) s = s.slice(first);
  const last = s.lastIndexOf("}");
  if (last >= 0) s = s.slice(0, last + 1);
  try { return JSON.parse(s); } catch {}

  let inString = false;
  let escaped = false;
  const stack = [];
  for (const ch of s) {
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if ((ch === "}" || ch === "]") && stack.at(-1) === ch) stack.pop();
  }
  if (inString) s += '"';
  while (stack.length) s += stack.pop();
  return JSON.parse(s);
}

export function parseJsonContent(content, { recoverTruncated = false } = {}) {
  if (typeof content === "object" && content) return content;
  const raw = text(content);
  if (!raw) throw new Error("Semantic model returned an empty response.");
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = (fenced ? fenced[1] : raw).trim();
  try { return JSON.parse(candidate); } catch (error) {
    if (recoverTruncated) return recoverJson(candidate);
    throw error;
  }
}
