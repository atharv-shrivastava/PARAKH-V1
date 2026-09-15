$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot

function Write-Utf8NoBom([string]$Path, [string]$Value) {
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Value, $utf8)
}

function Replace-Once([string]$Path, [string]$Pattern, [string]$Replacement, [string]$Name) {
  $full = Join-Path $root $Path
  if (-not (Test-Path $full)) { throw "${Name}: file not found: $full" }
  $text = Get-Content -Raw -Path $full
  $updated = [regex]::Replace($text, $Pattern, $Replacement, 1)
  if ($updated -eq $text) { throw "${Name}: pattern not found in $Path" }
  Write-Utf8NoBom $full $updated
  Write-Host "patched $Path ($Name)"
}

# The authoritative Rule 6 evaluator must recognize PARAKH's canonical extracted field names.
Replace-Once "rules-engine/src/engine/rule-6-declarations-evaluator.ts" `
  "aliases: \['measurements\.netQuantity', 'declarations\.quantityText'\]," `
  "aliases: ['measurements.netQuantity', 'declarations.quantityText', 'netQuantity']," `
  "rule6-net-quantity-aliases"

Replace-Once "rules-engine/src/engine/rule-6-declarations-evaluator.ts" `
  "aliases: \['declarations\.manufactureOrImportDate', 'declarations\.manufactureDate', 'declarations\.packingDate', 'declarations\.importDate'\]," `
  "aliases: ['declarations.manufactureOrImportDate', 'declarations.manufactureDate', 'declarations.packingDate', 'declarations.importDate', 'declarations.dateOfManufacture', 'declarations.dateOfPacking', 'declarations.dateOfPrePacking', 'declarations.dateOfImport']," `
  "rule6-date-aliases"

Replace-Once "rules-engine/src/engine/rule-6-declarations-evaluator.ts" `
  "aliases: \['transaction\.mrp'\]," `
  "aliases: ['transaction.mrp', 'declarations.mrp', 'mrp', 'declarations.retailSalePrice', 'retailSalePrice']," `
  "rule6-mrp-aliases"

Replace-Once "rules-engine/src/engine/rule-6-declarations-evaluator.ts" `
  "aliases: \['declarations\.consumerCare', 'declarations\.consumerComplaintNameAddressPhoneEmail'\]," `
  "aliases: ['declarations.consumerCare', 'declarations.consumerComplaintNameAddressPhoneEmail', 'declarations.consumerCarePhone', 'declarations.consumerCareEmail']," `
  "rule6-consumer-contact-aliases"

Replace-Once "rules-engine/src/engine/rule-6-declarations-evaluator.ts" `
  "aliases: \['declarations\.manufacturerOrPacker', 'declarations\.manufacturerNameAddress', 'declarations\.packerNameAddress', 'declarations\.importerNameAddress'\]," `
  "aliases: ['declarations.manufacturerOrPacker', 'declarations.manufacturerNameAddress', 'declarations.packerNameAddress', 'declarations.importerNameAddress', 'declarations.manufacturer', 'declarations.packer', 'declarations.importer']," `
  "rule6-manufacturer-aliases"

# Add direct canonical-field fallbacks in evidenceValue so OCR field names are trusted evidence.
Replace-Once "rules-engine/src/engine/rule-6-declarations-evaluator.ts" `
  "const evidence = r\.evidence\.find\(x => x\.field === field \|\| x\.field === field\.replace\(/\^declarations\\\\\./, ''\)\);" `
  "const evidence = r.evidence.find(x => x.field === field || x.field === field.replace(/^declarations\\./, ''));" `
  "rule6-evidence-path-normalization"

# Missing automated evidence is not proof of a statutory violation. It requires officer verification.
Replace-Once "rules-engine/src/engine/rule-6-declarations-evaluator.ts" `
  "return finding\('PCR-R6-1-A', '6\\(1\\)\\(a\\)', 'VIOLATION', 'declarations\.manufacturerPackerImporter', 'The combined OCR, Gemini and Grok evidence did not establish the responsible manufacturer, packer or importer name/address declaration\.', 'No provider established the required responsible-entity declaration\.', \['declarations\.manufacturerName', 'declarations\.completeAddress'\]\);" `
  "return finding('PCR-R6-1-A', '6(1)(a)', 'UNABLE_TO_VERIFY', 'declarations.manufacturerPackerImporter', 'The automated inspection could not reliably establish the responsible manufacturer, packer or importer name/address declaration. Officer verification is required.', undefined, ['declarations.manufacturerName', 'declarations.completeAddress']);" `
  "rule6-missing-manufacturer-review"

Replace-Once "rules-engine/src/engine/rule-6-declarations-evaluator.ts" `
  "return finding\('PCR-R6-2', '6\\(2\\)', 'VIOLATION', 'declarations\.consumerComplaintContact', 'The combined OCR, Gemini and Grok evidence did not establish any consumer-complaint contact declaration\.', 'No provider established the required consumer-complaint contact\.'\);" `
  "return finding('PCR-R6-2', '6(2)', 'UNABLE_TO_VERIFY', 'declarations.consumerComplaintContact', 'The automated inspection could not reliably establish the consumer-complaint contact declaration. Officer verification is required.', undefined, ['declarations.consumerComplaintContact', 'declarations.consumerComplaintPhoneOrEmail']);" `
  "rule6-missing-contact-review"

Replace-Once "rules-engine/src/engine/rule-6-declarations-evaluator.ts" `
  "findings\.push\(finding\(req\.code, req\.number, 'VIOLATION', req\.field, `The combined OCR, Gemini and Grok evidence did not establish the required \$\{req\.label\}\.`, 'No provider established the required declaration\.', fields\)\);" `
  "findings.push(finding(req.code, req.number, 'UNABLE_TO_VERIFY', req.field, `The automated inspection could not reliably establish the required ${req.label}. Officer verification is required.`, undefined, fields));" `
  "rule6-generic-missing-review"

# Rule 4 is a parent declaration bundle and duplicates the specialized Rule 6 declaration findings.
Replace-Once "rules-engine/src/engine/complete-evaluator-v2.ts" `
  "const configuredOther = configured\?\.findings\.filter\(f => !AUTHORITATIVE_SPECIALIZED_RULES\.has\(f\.ruleId\)\) \?\? \[\];" `
  "const configuredOther = configured?.findings.filter(f => !AUTHORITATIVE_SPECIALIZED_RULES.has(f.ruleId) && f.ruleId !== 'PCR-R4') ?? [];" `
  "suppress-parent-rule4-duplicates"

# Prevent legacy configured Rule 6-style findings from ever being merged back with specialized ones.
Replace-Once "rules-engine/src/engine/complete-evaluator-v2.ts" `
  "const findings = \[\.\.\.specializedOther, \.\.\.specializedAuthoritative, \.\.\.configuredOther\];" `
  "const rawFindings = [...specializedOther, ...specializedAuthoritative, ...configuredOther];\n  const findingKeys = new Set<string>();\n  const findings = rawFindings.filter(f => {\n    const key = `${f.ruleCode}|${f.ruleNumber}|${f.field || ''}`;\n    if (findingKeys.has(key)) return false;\n    findingKeys.add(key);\n    return true;\n  });" `
  "dedupe-final-engine-findings"

$engine = Join-Path $root "rules-engine"
Push-Location $engine
try {
  if (Test-Path "node_modules") { & npm run build; if ($LASTEXITCODE -ne 0) { throw "rules-engine build failed" } }
} finally {
  Pop-Location
}

Write-Host "Authoritative declaration-rule mapping fixed: declaration presence, not extraction success, now drives Rule 6 findings."