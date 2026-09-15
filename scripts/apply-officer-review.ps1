$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not (Test-Path (Join-Path $Repo 'frontend/src/pages/ScanV2.jsx'))) { throw "PARAKH repository not found at $Repo" }
Set-Location $Repo

function Replace-Exact([string]$relativePath, [string]$old, [string]$new) {
  $path = Join-Path $Repo $relativePath
  $content = Get-Content $path -Raw -Encoding UTF8
  $count = ([regex]::Matches($content, [regex]::Escape($old))).Count
  if ($count -ne 1) { throw "Expected exactly one occurrence in $relativePath, found $count." }
  Set-Content -Path $path -Value $content.Replace($old, $new) -Encoding UTF8 -NoNewline
}

Replace-Exact 'backend/src/routes/products.js' @'
function calculateReviewedCompliance({ compliance, ocr, acceptedFindingIds }) {
  const findings = Array.isArray(compliance?.findings) ? compliance.findings : [];
  const engineViolations = findings.filter((finding) => finding?.status === "VIOLATION");
  const hasReviewSelection = Array.isArray(acceptedFindingIds);
  const acceptedSet = hasReviewSelection ? new Set(acceptedFindingIds.map(String)) : null;
  const acceptedViolations = acceptedSet ? engineViolations.filter((finding) => acceptedSet.has(String(finding.findingId))) : engineViolations;
  const rejectedViolations = hasReviewSelection ? engineViolations.filter((finding) => !acceptedSet.has(String(finding.findingId))) : [];
  const needsReview = Boolean(ocr?.needsReview) || Number(compliance?.summary?.unableToVerify || 0) > 0;
  const status = acceptedViolations.length > 0 ? "VIOLATION" : needsReview ? "NEEDS_REVIEW" : "OKAY";
  const reason = acceptedViolations.length > 0
    ? `Inspector accepted ${acceptedViolations.length} Rules Engine violation(s): ${acceptedViolations.map((x) => x.message || x.violationReason || x.ruleCode).join(" | ")}`
    : needsReview
      ? "Inspector review remains required because one or more OCR/rule checks could not be verified."
      : hasReviewSelection && rejectedViolations.length > 0
        ? "Rules Engine findings were reviewed; detected violations were not accepted by the inspector."
        : "Automated OCR and Rules Engine assessment completed; final legal verification remains with the inspector.";
  return { status, reason, engineViolations, acceptedViolations, rejectedViolations };
}
'@ @'
function calculateReviewedCompliance({ compliance, ocr, acceptedFindingIds, unableToVerifyDecisions = {} }) {
  const findings = Array.isArray(compliance?.findings) ? compliance.findings : [];
  const engineViolations = findings.filter((finding) => finding?.status === "VIOLATION");
  const acceptedSet = new Set(Array.isArray(acceptedFindingIds) ? acceptedFindingIds.map(String) : []);
  const decisions = unableToVerifyDecisions && typeof unableToVerifyDecisions === "object" ? unableToVerifyDecisions : {};
  const acceptedViolations = engineViolations.filter((finding) => acceptedSet.has(String(finding.findingId)));
  const rejectedViolations = engineViolations.filter((finding) => !acceptedSet.has(String(finding.findingId)));
  const unableToVerify = findings.filter((finding) => String(finding?.status || "").toUpperCase() === "UNABLE_TO_VERIFY");
  const unresolvedUnableToVerify = unableToVerify.filter((finding) => !["PASS", "FAIL"].includes(String(decisions[finding.findingId] || "").toUpperCase()));
  const failedUnableToVerify = unableToVerify.filter((finding) => String(decisions[finding.findingId] || "").toUpperCase() === "FAIL");
  const passedUnableToVerify = unableToVerify.filter((finding) => String(decisions[finding.findingId] || "").toUpperCase() === "PASS");
  const needsReview = Boolean(ocr?.needsReview) || unresolvedUnableToVerify.length > 0;
  const status = acceptedViolations.length > 0 || failedUnableToVerify.length > 0 ? "VIOLATION" : needsReview ? "NEEDS_REVIEW" : "OKAY";
  const acceptedCount = acceptedViolations.length + failedUnableToVerify.length;
  const reason = acceptedCount > 0
    ? `Inspector accepted ${acceptedCount} finding(s): ${[...acceptedViolations, ...failedUnableToVerify].map((x) => x.message || x.violationReason || x.ruleCode).join(" | ")}`
    : unresolvedUnableToVerify.length > 0
      ? `${unresolvedUnableToVerify.length} unable-to-verify finding(s) still require an explicit PASS or FAIL decision.`
      : "Rules Engine findings were reviewed by the inspector; detected violations were not accepted.";
  return { status, reason, engineViolations, acceptedViolations, rejectedViolations, unableToVerify, unresolvedUnableToVerify, failedUnableToVerify, passedUnableToVerify };
}
'@

Replace-Exact 'backend/src/routes/products.js' @'
    const review = calculateReviewedCompliance({ compliance: parsedOcrData?.compliance, ocr: parsedOcrData?.ocr, acceptedFindingIds });
'@ @'
    const unableToVerifyDecisions = parsedOcrData?.complianceReview?.unableToVerifyDecisions && typeof parsedOcrData.complianceReview.unableToVerifyDecisions === "object" ? parsedOcrData.complianceReview.unableToVerifyDecisions : {};
    const review = calculateReviewedCompliance({ compliance: parsedOcrData?.compliance, ocr: parsedOcrData?.ocr, acceptedFindingIds, unableToVerifyDecisions });
'@

Replace-Exact 'backend/src/routes/products.js' @'
    const enrichedOcrData = parsedOcrData && typeof parsedOcrData === "object" ? { ...parsedOcrData, complianceReview: { engineViolationCount: review.engineViolations.length, acceptedFindingIds: review.acceptedViolations.map((x) => x.findingId), rejectedFindingIds: review.rejectedViolations.map((x) => x.findingId), reviewedAt: new Date().toISOString() } } : parsedOcrData;
'@ @'
    const suppliedReview = parsedOcrData?.complianceReview && typeof parsedOcrData.complianceReview === "object" ? parsedOcrData.complianceReview : {};
    const enrichedOcrData = parsedOcrData && typeof parsedOcrData === "object" ? { ...parsedOcrData, complianceReview: { engineViolationCount: review.engineViolations.length, acceptedFindingIds: [...review.acceptedViolations, ...review.failedUnableToVerify].map((x) => x.findingId), rejectedFindingIds: review.rejectedViolations.map((x) => x.findingId), unableToVerifyDecisions: suppliedReview.unableToVerifyDecisions || {}, manualDecisions: Array.isArray(suppliedReview.manualDecisions) ? suppliedReview.manualDecisions : [], reviewedAt: suppliedReview.reviewedAt || new Date().toISOString() } } : parsedOcrData;
'@

Replace-Exact 'backend/src/ocr/fastRoutes.js' @'
  const numericRepaired = repairNumericFields(next, evidence, rawText);
  next.netQuantity = numericRepaired.netQuantity || next.netQuantity;
  next.unit = numericRepaired.unit || next.unit;
  next.mrp = numericRepaired.mrp || next.mrp;
  return next;
'@ @'
  const numericRepaired = repairNumericFields(next, evidence, rawText);
  next.netQuantity = numericRepaired.netQuantity || next.netQuantity;
  next.unit = numericRepaired.unit || next.unit;
  next.mrp = numericRepaired.mrp || next.mrp;
  const quantityText = text(next.netQuantity?.value || next.netQuantity?.displayValue || "");
  const quantityMatch = quantityText.match(/^\s*(\d+(?:\.\d+)?)\s*(mg|mcg|g|gm|kg|ml|l|ltr|cl|oz|lb|pcs?|pieces?|units?|nos)\s*$/i);
  if (quantityMatch) {
    const numericValue = quantityMatch[1];
    const normalizedUnit = quantityMatch[2].toLowerCase();
    next.netQuantity = { ...(next.netQuantity || {}), value: numericValue, displayValue: numericValue, raw: next.netQuantity?.raw || quantityText, evidence: next.netQuantity?.evidence || quantityText, status: "found" };
    next.unit = { ...(next.unit || {}), value: normalizedUnit, displayValue: normalizedUnit, raw: next.unit?.raw || quantityText, evidence: next.unit?.evidence || quantityText, status: "found", confidence: Math.min(Number(next.netQuantity?.confidence || 1), Number(next.unit?.confidence || next.netQuantity?.confidence || 1)) };
  }
  return next;
'@

Replace-Exact 'frontend/src/pages/ScanV2.jsx' @'
  const [categories, setCategories] = useState([]); const [images, setImages] = useState([]); const [ocr, setOcr] = useState(null); const [compliance, setCompliance] = useState(null); const [complianceError, setComplianceError] = useState(null); const [acceptedFindingIds, setAcceptedFindingIds] = useState([]); const [manualViolations, setManualViolations] = useState([]); const [manualViolationReason, setManualViolationReason] = useState("");
'@ @'
  const [categories, setCategories] = useState([]); const [images, setImages] = useState([]); const [ocr, setOcr] = useState(null); const [compliance, setCompliance] = useState(null); const [complianceError, setComplianceError] = useState(null); const [acceptedFindingIds, setAcceptedFindingIds] = useState([]); const [unableToVerifyDecisions, setUnableToVerifyDecisions] = useState({}); const [manualViolations, setManualViolations] = useState([]); const [manualViolationReason, setManualViolationReason] = useState("");
'@

Replace-Exact 'frontend/src/pages/ScanV2.jsx' @'
  const violations = compliance?.findings?.filter((finding) => finding.status === "VIOLATION") || [];
  const accepted = compliance?.findings?.filter((finding) => acceptedFindingIds.includes(finding.findingId)) || [];
  const selectedViolations = [...accepted, ...manualViolations];
'@ @'
  const violations = compliance?.findings?.filter((finding) => finding.status === "VIOLATION") || [];
  const unableToVerify = compliance?.findings?.filter((finding) => finding.status === "UNABLE_TO_VERIFY") || [];
  const accepted = compliance?.findings?.filter((finding) => acceptedFindingIds.includes(finding.findingId)) || [];
  const failedUnableToVerify = unableToVerify.filter((finding) => unableToVerifyDecisions[finding.findingId] === "FAIL");
  const unresolvedUnableToVerify = unableToVerify.filter((finding) => !["PASS", "FAIL"].includes(unableToVerifyDecisions[finding.findingId]));
  const selectedViolations = [...accepted, ...failedUnableToVerify, ...manualViolations];
  const reviewComplete = unresolvedUnableToVerify.length === 0;
'@

Replace-Exact 'frontend/src/pages/ScanV2.jsx' @'
  function toggle(id) { setAcceptedFindingIds((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]); }
'@ @'
  function toggle(id) { setAcceptedFindingIds((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]); }
  function setUnableDecision(id, decision) { setUnableToVerifyDecisions((current) => ({ ...current, [id]: decision })); }
'@

Replace-Exact 'frontend/src/pages/ScanV2.jsx' @'
  async function save(event) { event.preventDefault(); if (!selectedCategoryId) return setMessage("Select an offline final category before saving."); if (!form.shopName.trim()) return setMessage("Shop name is required."); setSaving(true);
'@ @'
  async function save(event) { event.preventDefault(); if (!selectedCategoryId) return setMessage("Select an offline final category before saving."); if (!form.shopName.trim()) return setMessage("Shop name is required."); if (!reviewComplete) return setMessage("Every Unable to Verify finding must be explicitly marked PASS or FAIL before submission."); setSaving(true);
'@

Replace-Exact 'frontend/src/pages/ScanV2.jsx' @'
  async function save(event) { event.preventDefault(); if (!selectedCategoryId) return setMessage("Select an offline final category before saving."); if (!form.shopName.trim()) return setMessage("Shop name is required."); if (!reviewComplete) return setMessage("Every Unable to Verify finding must be explicitly marked PASS or FAIL before submission."); setSaving(true); try { const imageUrls = await Promise.all(images.map((item) => fileToDataUrl(item.file))); const visualInspection = readVisualInspection(); const response = await apiFetch(`${API_URL}/products`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...form, barcode: scannerGtin || "", categoryId: selectedCategoryId, sourceType: "OFFLINE", imageUrls, acceptedFindingIds, ocrData: { ocr, compliance, complianceError, providerInfo, aiSuggestedCategory, visualInspection, manualViolations }, complianceStatus: selectedViolations.length ? "VIOLATION" : "OKAY", violationReason: selectedViolations.map((finding) => finding.message || finding.violationReason || finding.ruleCode).join(" | "), inspectionDate: new Date().toISOString() }) }); const data = await response.json(); if (!response.ok) throw new Error(data.error || "Could not save product"); const id = data.product?.id || data.id; if (!id) throw new Error("Product was saved but its ID was not returned."); window.location.href = `/products/item/${id}`; } catch (error) { setMessage(error.message); } finally { setSaving(false); } }
'@ @'
  async function save(event) { event.preventDefault(); if (!selectedCategoryId) return setMessage("Select an offline final category before saving."); if (!form.shopName.trim()) return setMessage("Shop name is required."); if (!reviewComplete) return setMessage("Every Unable to Verify finding must be explicitly marked PASS or FAIL before submission."); setSaving(true); try { const imageUrls = await Promise.all(images.map((item) => fileToDataUrl(item.file))); const visualInspection = readVisualInspection(); const manualDecisions = manualViolations.map((finding) => ({ findingId: finding.findingId, ruleCode: finding.ruleCode, ruleNumber: finding.ruleNumber, decision: "ACCEPTED", reason: finding.message || finding.violationReason || "Manual officer violation" })); const officerReview = { unableToVerifyDecisions, manualDecisions, reviewedAt: new Date().toISOString() }; const response = await apiFetch(`${API_URL}/products`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...form, barcode: scannerGtin || "", categoryId: selectedCategoryId, sourceType: "OFFLINE", imageUrls, acceptedFindingIds, ocrData: { ocr, compliance, complianceError, providerInfo, aiSuggestedCategory, visualInspection, manualViolations, complianceReview: officerReview }, complianceStatus: selectedViolations.length ? "VIOLATION" : "OKAY", violationReason: selectedViolations.map((finding) => finding.message || finding.violationReason || finding.ruleCode).join(" | "), inspectionDate: new Date().toISOString() }) }); const data = await response.json(); if (!response.ok) throw new Error(data.error || "Could not save product"); const id = data.product?.id || data.id; if (!id) throw new Error("Product was saved but its ID was not returned."); window.location.href = `/products/item/${id}`; } catch (error) { setMessage(error.message); } finally { setSaving(false); } }
'@

Replace-Exact 'frontend/src/pages/ScanV2.jsx' @'
      <div className="rule-review-panel manual-violation-panel"><div className="section-heading">
'@ @'
      {unableToVerify.length > 0 && <div className="rule-review-panel"><div className="section-heading"><div><h3>Unable to Verify review</h3><p>Every unresolved engine finding must receive an explicit PASS or FAIL decision. PASS means the officer reviewed the evidence and did not establish a violation. FAIL converts the unresolved finding into an accepted violation.</p></div></div>{unableToVerify.map((finding) => { const details = ruleDetails(finding); const decision = unableToVerifyDecisions[finding.findingId] || ""; return <details className="rule-review-dropdown" key={finding.findingId}><summary><span><strong>{details.code}</strong><small>Rule {details.number} · {details.title} · Officer decision: {decision || "PENDING"}</small></span></summary><div className="rule-review-dropdown-body"><p><strong>Rule statement</strong>{details.statement}</p><p><strong>Engine status</strong>UNABLE_TO_VERIFY</p><p><strong>Engine message</strong>{details.issue}</p><div className="scan-upload-actions"><button type="button" className={decision === "PASS" ? "primary-button" : "secondary-button"} onClick={() => setUnableDecision(finding.findingId, "PASS")}>Pass</button><button type="button" className={decision === "FAIL" ? "primary-button" : "secondary-button"} onClick={() => setUnableDecision(finding.findingId, "FAIL")}>Fail</button></div></div></details>; })}<div className="ocr-summary">Resolved: <strong>{unableToVerify.length - unresolvedUnableToVerify.length}</strong> · Pending: <strong>{unresolvedUnableToVerify.length}</strong></div></div>}
      <div className="rule-review-panel manual-violation-panel"><div className="section-heading">
'@

Replace-Exact 'frontend/src/pages/ScanV2.jsx' @'
    {showRegistration && <form className="scan-review registration-form" onSubmit={save}>
'@ @'
    {showRegistration && <form className="scan-review registration-form" onSubmit={save}>
'@

Set-Content -Path (Join-Path $Repo '.officer-review-patch-applied') -Value (Get-Date).ToString('o') -Encoding UTF8 -NoNewline
Remove-Item (Join-Path $Repo '.officer-review-patch-applied') -Force

Write-Host "Officer review integration patch applied. Run frontend/build and rules-engine tests before committing."
