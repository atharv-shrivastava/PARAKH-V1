$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot

function Replace-Once([string]$Path, [string]$Old, [string]$New, [string]$Name) {
  $full = Join-Path $root $Path
  if (-not (Test-Path $full)) { throw "$Name: file not found: $full" }
  $text = Get-Content -Raw -Path $full
  $count = ([regex]::Matches($text, [regex]::Escape($Old))).Count
  if ($count -ne 1) { throw "$Name: expected exactly 1 match in $Path, found $count" }
  $updated = $text.Replace($Old, $New)
  Set-Content -Path $full -Value $updated -Encoding utf8NoBOM
  Write-Host "patched $Path ($Name)"
}

# 1) PaddleOCR: preprocess images normally, then run the independent image inferences concurrently.
#    The previous loop waited for image 1, then image 2, then image 3, which made a 3-image scan
#    roughly the sum of all three Paddle inference times.
Replace-Once "ocr-service/main.py" @'
    engine = _get_paddle(language)
    all_entries = []
    engine_ms = 0
    for image, original_width, original_height, scale, image_index in prepared:
        image_started = time.monotonic()

        def infer(source):
            return extract_paddle(engine.predict(source), image_index, scale, original_width, original_height)

        entries = await asyncio.to_thread(infer, np.asarray(image))
        first_quality = quality(entries)
        if first_quality < 0.55:
            fallback_entries = await asyncio.to_thread(infer, np.asarray(enhanced_image(image)))
            if quality(fallback_entries) > first_quality:
                entries = fallback_entries
        elapsed = round((time.monotonic() - image_started) * 1000)
        engine_ms += elapsed
        all_entries.extend(entries)
        print(f"[ocr:paddle] image={image_index + 1} lang={normalize_language(language)} size={original_width}x{original_height} entries={len(entries)} engine={elapsed}ms")
'@ @'
    engine = _get_paddle(language)

    async def process_one(image, original_width, original_height, scale, image_index):
        image_started = time.monotonic()

        def infer(source):
            return extract_paddle(engine.predict(source), image_index, scale, original_width, original_height)

        entries = await asyncio.to_thread(infer, np.asarray(image))
        first_quality = quality(entries)
        if first_quality < 0.55:
            fallback_entries = await asyncio.to_thread(infer, np.asarray(enhanced_image(image)))
            if quality(fallback_entries) > first_quality:
                entries = fallback_entries
        elapsed = round((time.monotonic() - image_started) * 1000)
        print(f"[ocr:paddle] image={image_index + 1} lang={normalize_language(language)} size={original_width}x{original_height} entries={len(entries)} engine={elapsed}ms")
        return entries, elapsed

    batches = await asyncio.gather(*[
        process_one(image, original_width, original_height, scale, image_index)
        for image, original_width, original_height, scale, image_index in prepared
    ])
    all_entries = []
    engine_ms = 0
    for entries, elapsed in batches:
        all_entries.extend(entries)
        engine_ms += elapsed
'@ "parallelize-paddle-images"

# 2) Make the shared semantic prompt treat the uploaded images as a single inspection set.
#    Models must first decide whether the images are consistent views of ONE physical package.
#    They must not merge two different products into one record.
Replace-Once "backend/src/ocr/semanticPackageCommon.js" @'
CORE EXTRACTION METHOD
For EVERY field:
'@ @'
PACKAGE IMAGE SET / SAME-PACKAGE CHECK
- Treat all supplied package images as one inspection set containing multiple views of the same physical package ONLY if the visual/product evidence supports that conclusion.
- First compare the images using product name, brand, package artwork, container/shape, manufacturer/marketer wording, net quantity, MRP context, GTIN/barcode when visibly readable, batch/lot markings, and other unique visual identifiers.
- Multiple sides of the same package should be combined. A front, back, side panel and bottom/label view are complementary evidence for ONE product.
- Do NOT assume that image count means product count. Three images may simply be three faces of one package.
- If the images appear to show different physical products, sizes, flavors, variants, brands, or clearly conflicting package identities, do NOT merge their declarations. Mark the package set as multiple_packages or uncertain and keep field extraction conservative.
- A quantity printed as a promotional claim such as "100 g extra", "free 100 g", "extra 100g", "20% extra", or similar bonus/marketing wording is NOT the package net quantity unless the package separately declares that number as the actual net quantity.
- For net quantity, require explicit declaration context such as "Net Qty", "Net Quantity", "Net Wt", "Net Weight", "Net Content" or an unmistakable equivalent. Ignore serving sizes, nutrition quantities, ingredient amounts, recipe quantities, promotional bonus quantities, and comparison claims.
- If one image shows the declared net quantity and another shows an "extra/free" claim, use the declared net quantity and keep the promotional quantity out of the netQuantity field.
- If two plausible declared quantities remain and the image context does not distinguish them, return netQuantity as ambiguous rather than selecting the larger or smaller number.

PACKAGE ASSESSMENT OUTPUT
- Return an extra top-level object named packageAssessment with:
  - status: exactly one of "single_package", "multiple_packages", or "uncertain".
  - confidence: a number from 0 to 1.
  - evidence: a concise explanation naming the matching or conflicting package identifiers/views.
- "single_package" means the supplied images are consistent views of one physical package.
- "multiple_packages" means at least two different physical products/packages are visible.
- "uncertain" means the images do not provide enough identity evidence to decide safely.

CORE EXTRACTION METHOD
For EVERY field:
'@ "package-grouping-prompt"

Replace-Once "backend/src/ocr/semanticPackageCommon.js" @'
Your job is NOT to declare legal compliance. Your job is to reconstruct structured package declarations from the ORIGINAL PACKAGE IMAGE(S) plus RapidOCR evidence, conservatively and traceably, so a deterministic rules engine and a human inspector can review the result.
'@ @'
Your job is NOT to declare legal compliance. Your job is to reconstruct structured package declarations from the ORIGINAL PACKAGE IMAGE(S) plus PaddleOCR evidence, conservatively and traceably, so a deterministic rules engine and a human inspector can review the result.
'@ "rename-ocr-source"

Replace-Once "backend/src/ocr/semanticPackageCommon.js" @'
RAPIDOCR DETECTIONS (evidenceIndex is the key):
${JSON.stringify(compactDetections)}

RAW RAPIDOCR TEXT:
${text(rawText)}
'@ @'
PADDLEOCR DETECTIONS (evidenceIndex is the key):
${JSON.stringify(compactDetections)}

RAW PADDLEOCR TEXT:
${text(rawText)}
'@ "rename-prompt-evidence"

Replace-Once "backend/src/ocr/semanticPackageCommon.js" @'
Return valid compact JSON only. No markdown. No commentary. No extra keys outside the requested schema.`;
'@ @'
Return valid compact JSON only. No markdown. No commentary. The response may include the required packageAssessment object in addition to the field objects and suggestedCategory.`;
'@ "allow-package-assessment"

# 3) Keep the model-specific interpreters' packageAssessment so fastRoutes can enforce/review it.
Replace-Once "backend/src/ocr/geminiPackageInterpreter.js" @'
    const parsed = parseJsonContent(response.text || "", { recoverTruncated: true });
    const normalized = normalizeSemanticResult(parsed, categoryOptions);
    const mergedFields = mergeDeterministicEvidence(normalized.fields, detections, rawText);
    return { enabled: true, provider: "gemini", model, fields: mergedFields, suggestedCategory: normalized.suggestedCategory, timingMs: elapsedMs };
'@ @'
    const parsed = parseJsonContent(response.text || "", { recoverTruncated: true });
    const normalized = normalizeSemanticResult(parsed, categoryOptions);
    const mergedFields = mergeDeterministicEvidence(normalized.fields, detections, rawText);
    const packageAssessment = parsed?.packageAssessment && typeof parsed.packageAssessment === "object"
      ? {
          status: ["single_package", "multiple_packages", "uncertain"].includes(String(parsed.packageAssessment.status)) ? String(parsed.packageAssessment.status) : "uncertain",
          confidence: Math.max(0, Math.min(1, Number(parsed.packageAssessment.confidence) || 0)),
          evidence: String(parsed.packageAssessment.evidence || "").trim(),
        }
      : { status: "uncertain", confidence: 0, evidence: "Model did not return packageAssessment." };
    return { enabled: true, provider: "gemini", model, fields: mergedFields, suggestedCategory: normalized.suggestedCategory, packageAssessment, timingMs: elapsedMs };
'@ "preserve-gemini-package-assessment"

Replace-Once "backend/src/ocr/grokPackageInterpreter.js" @'
    const output = data?.choices?.[0]?.message?.content;
    const parsed = parseJsonContent(output, { recoverTruncated: true });
    const normalized = normalizeSemanticResult(parsed, categoryOptions);
    return { enabled: true, provider: "grok", model, fields: normalized.fields, suggestedCategory: normalized.suggestedCategory, timingMs: elapsedMs };
'@ @'
    const output = data?.choices?.[0]?.message?.content;
    const parsed = parseJsonContent(output, { recoverTruncated: true });
    const normalized = normalizeSemanticResult(parsed, categoryOptions);
    const packageAssessment = parsed?.packageAssessment && typeof parsed.packageAssessment === "object"
      ? {
          status: ["single_package", "multiple_packages", "uncertain"].includes(String(parsed.packageAssessment.status)) ? String(parsed.packageAssessment.status) : "uncertain",
          confidence: Math.max(0, Math.min(1, Number(parsed.packageAssessment.confidence) || 0)),
          evidence: String(parsed.packageAssessment.evidence || "").trim(),
        }
      : { status: "uncertain", confidence: 0, evidence: "Model did not return packageAssessment." };
    return { enabled: true, provider: "grok", model, fields: normalized.fields, suggestedCategory: normalized.suggestedCategory, packageAssessment, timingMs: elapsedMs };
'@ "preserve-grok-package-assessment"

Write-Host "OCR grouping/performance patch prepared. Restart the OCR service and backend after running this script."