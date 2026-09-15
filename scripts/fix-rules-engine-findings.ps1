$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$file = Join-Path $root "rules-engine\src\engine\evaluator.ts"
if (-not (Test-Path $file)) { throw "rules-engine/src/engine/evaluator.ts not found: $file" }

$text = Get-Content -Raw -Path $file

# 1) Absence of machine evidence is not proof of a legal violation.
$oldMissing = '  const missingDeclaration = (): ConditionResult => ({ status: ''VIOLATION'', missing: [condition.targetField], message: condition.errorMessage, reason: `${condition.violationReason} No declaration evidence was established by the available inspection providers.`, evidence, conflicts });'
$newMissing = '  const missingDeclaration = (): ConditionResult => ({ status: ''UNABLE_TO_VERIFY'', missing: [condition.targetField], message: condition.errorMessage, evidence, conflicts });'
if (-not $text.Contains($oldMissing)) { throw "Could not locate missingDeclaration implementation." }
$text = $text.Replace($oldMissing, $newMissing)

# 2) Keep the specialized Rule 6 declaration findings authoritative over overlapping Rule 4 checks.
$oldExport = '  findings.push(...quantityFindings(request)); const summary = {'
$newExport = @'
  findings.push(...quantityFindings(request));

  const coveredRule4Fields = new Set<string>();
  for (const finding of findings) {
    if (finding.ruleId !== 'PCR-R4' || !finding.field) continue;
    const duplicateTarget =
      finding.field === 'declarations.retailSalePrice' ? 'declarations.retailSalePrice' :
      finding.field === 'declarations.manufacturerOrPacker' ? 'declarations.manufacturerOrPacker' :
      finding.field === 'declarations.commonOrGenericName' ? 'declarations.commonOrGenericName' :
      finding.field === 'declarations.netQuantity' ? 'declarations.netQuantity' : null;
    if (duplicateTarget) coveredRule4Fields.add(duplicateTarget);
  }

  const specializedFields = new Set<string>([
    'declarations.retailSalePrice',
    'declarations.manufacturerOrPacker',
    'declarations.commonOrGenericName',
    'declarations.netQuantity',
  ]);

  const dedupedFindings = findings
    .filter(finding => !(finding.ruleId === 'PCR-R4' && finding.field && specializedFields.has(finding.field) && coveredRule4Fields.has(finding.field)))
    .reduce<Finding[]>((output, finding) => {
      const semanticKey = [finding.ruleNumber ?? '', finding.field ?? '', finding.status].join('|');
      const existing = output.find(item => [item.ruleNumber ?? '', item.field ?? '', item.status].join('|') === semanticKey);
      if (!existing) output.push(finding);
      return output;
    }, []);

  findings.length = 0;
  findings.push(...dedupedFindings);

  const summary = {
'@
if (-not $text.Contains($oldExport)) { throw "Could not locate findings summary boundary." }
$text = $text.Replace($oldExport, $newExport.TrimEnd("`r", "`n"))

# The new reducer can collapse repeated Rule 6 findings produced by an older duplicated rule provider.
$text = $text -replace "export const ENGINE_VERSION = '[^']+';", "export const ENGINE_VERSION = '0.2.2';"

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($file, $text, $utf8NoBom)

$node = Join-Path $root "rules-engine\node_modules\.bin\tsc.cmd"
if (Test-Path $node) {
  & $node --noEmit
  if ($LASTEXITCODE -ne 0) { throw "rules-engine TypeScript validation failed." }
}

Write-Host "Rules engine repaired: missing evidence => UNABLE_TO_VERIFY, overlapping Rule 4 findings suppressed, duplicate semantic findings collapsed."