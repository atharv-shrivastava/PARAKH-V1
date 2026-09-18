import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { apiFetch } from "../lib/auth";
import "../styles/ecommerce.css";

const API_URL = import.meta.env.VITE_API_URL || "https://parakh-backend-p4mx.onrender.com/api";
const MAX_IMAGES = 6;
const EDITABLE_FIELDS = [
  ["productName", "Product name"], ["brand", "Brand / Manufacturer"], ["manufacturer", "Manufacturer"],
  ["manufacturerAddress", "Manufacturer address"], ["packer", "Packer"], ["packerAddress", "Packer address"],
  ["marketer", "Marketer"], ["importer", "Importer"], ["netQuantity", "Net quantity"], ["unit", "Unit"],
  ["mrp", "MRP / Price"], ["currency", "Currency"], ["sku", "SKU / MPN"], ["gtin", "GTIN / Barcode"],
  ["batchNumber", "Batch / Lot"], ["dateOfManufacture", "Manufacturing date"], ["dateOfPacking", "Packing date"],
  ["bestBefore", "Best before"], ["expiryDate", "Expiry date"], ["consumerCarePhone", "Consumer care phone"],
  ["consumerCareEmail", "Consumer care email"], ["countryOfOrigin", "Country of origin"],
  ["fssaiLicenseNumber", "FSSAI license"], ["description", "Description"],
];

const ENGINE_RULE_OPTIONS = [
  ["PCR-R4", "4", "Mandatory declarations on pre-packaged commodities", "Packages must carry the declarations required by the Rules before being pre-packed for sale, distribution or delivery, subject to the rule explanations."],
  ["PCR-R6-1-A", "6(1)(a)", "Manufacturer, packer and importer declaration", "The package must declare the responsible manufacturer/packer identity and applicable importer information."],
  ["PCR-R6-1-B", "6(1)(b)", "Common or generic name", "The package shall bear the common or generic name of the commodity."],
  ["PCR-R6-1-C", "6(1)(c)", "Net quantity declaration", "The package shall declare net quantity in the prescribed standard unit or by number where appropriate."],
  ["PCR-R6-1-D", "6(1)(d)", "Month and year declaration", "The package shall declare the month and year of manufacture, pre-packing or import, subject to commodity-specific exceptions."],
  ["PCR-R6-1-E", "6(1)(e)", "Retail sale price", "The package shall bear the retail sale price in the manner required by the Rules."],
  ["PCR-R6-1-F", "6(1)(f)", "Dimensions where relevant", "Where size is relevant, the prescribed dimensions shall be declared."],
  ["PCR-R6-2", "6(2)", "Consumer complaint contact", "Consumer complaint contact details shall be declared as prescribed."],
  ["PCR-R6-3", "6(3)", "Restrictions on separate stickers", "Required declarations shall not be made by prohibited separate stickers; permitted revised MRP stickers are subject to their own conditions."],
  ["PCR-R7", "7", "Principal display panel and declaration dimensions", "Declarations on the principal display panel must meet the prescribed presentation and size requirements."],
  ["PCR-R8", "8", "Declarations on principal display panel", "Required declarations shall appear on the principal display panel in the prescribed manner."],
  ["PCR-R9", "9", "Legibility and language of declarations", "Declarations must be legible, prominent and presented in the permitted manner."],
  ["PCR-R10", "10", "Manufacturer/packer/importer address presentation", "The responsible entity name and complete address shall be declared in the prescribed manner."],
  ["PCR-R12-6", "12(6)", "Quantity expression must not be exaggerated or misleading", "Quantity expressions must not create an exaggerated, misleading or inadequate impression."],
  ["PCR-R6-10A-2026", "6(10A)", "Country-of-origin filter for imported products on e-commerce", "The e-commerce country-of-origin filter requirement is governed by dated 2026 amendments."],
  ["PCR-R26-A-PAN-MASALA", "26(a)", "Pan masala exception", "The specified Rule 26(a) clause does not apply to pan masala."],
];

function flatten(nodes, path = []) {
  return nodes.flatMap((node) => {
    const next = [...path, node];
    return [{ ...node, path: next }, ...flatten(node.children || [], next)];
  });
}
function displayFindingStatus(finding) { return String(finding?.status || "").toUpperCase(); }
function ruleMeta(finding) { const code = String(finding?.ruleCode || ""); const number = String(finding?.ruleNumber || ""); const known = ENGINE_RULE_OPTIONS.find(([knownCode, knownNumber]) => knownCode === code || knownNumber === number); return { code: known?.[0] || code || number || "RULE", number: known?.[1] || number, title: known?.[2] || finding?.title || "Legal Metrology requirement", statement: known?.[3] || finding?.description || finding?.message || "Applicable legal requirement must be satisfied." }; }
function firstMatch(text, patterns) { for (const pattern of patterns) { const match = text.match(pattern); if (match?.[1]) return match[1].trim(); } return ""; }
function parseWrittenListingText(text) { const source = String(text || "").replace(/\s+/g, " ").trim(); if (!source) return {}; const quantity = firstMatch(source, [/(?:net\s+(?:quantity|content)|net\s+wt\.?|item\s+(?:weight|quantity)|weight)\s*[:\-]?\s*([0-9]+(?:\.[0-9]+)?\s*(?:kg|g|gram|grams|mg|ml|l|litre|liter|litres|liters|pcs?|pieces?))\b/i,/\b([0-9]+(?:\.[0-9]+)?\s*(?:kg|g|mg|ml|l|litre|liter))\b/i]); const mrp = firstMatch(source, [/(?:maximum\s+retail\s+price|m\.r\.p\.?|mrp)\s*[:\-]?\s*(?:₹|rs\.?|inr)?\s*([0-9]+(?:\.[0-9]{1,2})?)/i]); const brand = firstMatch(source, [/(?:brand|brand\s+name)\s*[:\-]\s*([^|;,]{2,80})/i]); const manufacturer = firstMatch(source, [/(?:manufacturer|manufactured\s+by)\s*[:\-]\s*([^|;]{3,160})/i]); const origin = firstMatch(source, [/(?:country\s+of\s+origin|country\s+of\s+manufacture)\s*[:\-]\s*([A-Za-z][A-Za-z .'-]{2,50})/i]); const barcode = firstMatch(source, [/(?:barcode|ean|gtin)\s*[:\-]?\s*([0-9]{8,18})\b/i]); const unit = quantity ? (quantity.match(/[a-z]+$/i)?.[0] || "") : ""; return { netQuantity: quantity || "", unit, mrp, brand, manufacturer, countryOfOrigin: origin, gtin: barcode, listingText: source }; }
function structuredListingField(value) {
  const text = String(value ?? "").trim();
  return text
    ? { value: text, raw: text, evidence: text, confidence: 0.92, status: "found", source: "LISTING" }
    : { value: null, raw: null, evidence: null, confidence: 0, status: "unverified", source: "LISTING" };
}
function buildListingStructuredOcr(listing) {
  return {
    productName: structuredListingField(listing?.productName),
    brandName: structuredListingField(listing?.brand),
    manufacturer: structuredListingField(listing?.manufacturer),
    manufacturerAddress: structuredListingField(listing?.manufacturerAddress),
    packer: structuredListingField(listing?.packer),
    packerAddress: structuredListingField(listing?.packerAddress),
    marketer: structuredListingField(listing?.marketer),
    importer: structuredListingField(listing?.importer),
    netQuantity: structuredListingField(listing?.netQuantity),
    unit: structuredListingField(listing?.unit),
    mrp: structuredListingField(listing?.mrp),
    currency: structuredListingField(listing?.currency),
    batchNumber: structuredListingField(listing?.batchNumber),
    dateOfManufacture: structuredListingField(listing?.dateOfManufacture),
    dateOfPacking: structuredListingField(listing?.dateOfPacking),
    bestBefore: structuredListingField(listing?.bestBefore),
    expiryDate: structuredListingField(listing?.expiryDate),
    consumerCarePhone: structuredListingField(listing?.consumerCarePhone),
    consumerCareEmail: structuredListingField(listing?.consumerCareEmail),
    countryOfOrigin: structuredListingField(listing?.countryOfOrigin),
    fssaiLicenseNumber: structuredListingField(listing?.fssaiLicenseNumber),
    "ecommerce.countryOfOriginFilter": structuredListingField(
      listing?.filterEvidence === true ? true : listing?.filterEvidence === false ? false : ""
    ),
    rawText: String(listing?.listingText || "").trim(),
    otherDeclarations: [],
    extractionSources: { listingData: true },
    warnings: ["Rules Engine evidence includes public listing data when package OCR is unavailable."]
  };
}
function mergeStructuredOcr(listingOcr, extractedOcr) {
  if (!extractedOcr || typeof extractedOcr !== "object") return listingOcr;
  const merged = { ...listingOcr, ...extractedOcr };
  for (const key of Object.keys(listingOcr)) {
    const fallback = listingOcr[key];
    const extracted = extractedOcr[key];
    if (fallback && typeof fallback === "object" && fallback.status === "found" &&
        (!extracted || typeof extracted !== "object" || extracted.status !== "found" || !String(extracted.value ?? "").trim())) {
      merged[key] = fallback;
    }
  }
  merged.rawText = String(extractedOcr.rawText || listingOcr.rawText || "").trim();
  merged.otherDeclarations = Array.isArray(extractedOcr.otherDeclarations) && extractedOcr.otherDeclarations.length
    ? extractedOcr.otherDeclarations
    : listingOcr.otherDeclarations;
  return merged;
}
function ocrValue(result, key) { const field = result?.[key]; const value = field?.value; if (value === null || value === undefined || String(value).trim() === "") return ""; const status = String(field?.status || "").toLowerCase(); if (["not_detected", "absent", "not_found", "unknown"].includes(status)) return ""; return String(value).trim(); }
function mergeListingWithOcr(listing, ocr) { if (!ocr) return { ...listing, ocrMerged: false }; const next = { ...listing }; const mappings = { productName: "productName", brand: "brandName", manufacturer: "manufacturer", manufacturerAddress: "manufacturerAddress", packer: "packer", packerAddress: "packerAddress", marketer: "marketer", importer: "importer", netQuantity: "netQuantity", unit: "unit", mrp: "mrp", currency: "currency", gtin: "barcode", batchNumber: "batchNumber", dateOfManufacture: "dateOfManufacture", dateOfPacking: "dateOfPacking", bestBefore: "bestBefore", expiryDate: "expiryDate", consumerCarePhone: "consumerCarePhone", consumerCareEmail: "consumerCareEmail", countryOfOrigin: "countryOfOrigin", fssaiLicenseNumber: "fssaiLicenseNumber" }; for (const [listingKey, ocrKey] of Object.entries(mappings)) { const value = ocrValue(ocr, ocrKey); if (value && (!next[listingKey] || !String(next[listingKey]).trim())) next[listingKey] = value; } const declarations = Array.isArray(ocr?.otherDeclarations) ? ocr.otherDeclarations.map((x) => typeof x === "string" ? x : x?.text).filter(Boolean) : []; if (declarations.length) { const existing = String(next.description || "").trim(); next.description = existing ? `${existing}\n${declarations.join("\n")}` : declarations.join("\n"); } next.ocrMerged = true; return next; }

export default function EcommerceInspection() {
  const navigate = useNavigate(); const controllerRef = useRef(null); const analysisStartedRef = useRef(null);
  const [url, setUrl] = useState(""); const [listing, setListing] = useState(null); const [ocr, setOcr] = useState(null); const [compliance, setCompliance] = useState(null); const [categories, setCategories] = useState([]); const [categoryId, setCategoryId] = useState(""); const [categoryFilter, setCategoryFilter] = useState(""); const [selectedViolations, setSelectedViolations] = useState([]); const [manualViolations, setManualViolations] = useState([]); const [manualRuleCode, setManualRuleCode] = useState(""); const [manualRuleNumber, setManualRuleNumber] = useState(""); const [manualViolationReason, setManualViolationReason] = useState(""); const [error, setError] = useState(""); const [message, setMessage] = useState(""); const [busy, setBusy] = useState(false); const [analysisElapsedMs, setAnalysisElapsedMs] = useState(0); const [analysisDurationMs, setAnalysisDurationMs] = useState(null); const [saving, setSaving] = useState(false);
  useEffect(() => { apiFetch(`${API_URL}/categories/tree/all?sourceType=ECOMMERCE`).then(async (r) => { const d = await r.json().catch(() => []); if (!r.ok) throw new Error(d?.error || "Could not load e-commerce categories"); setCategories(Array.isArray(d) ? d : []); }).catch((e) => setError(e.message || "Could not load e-commerce categories")); return () => controllerRef.current?.abort(); }, []);
  useEffect(() => { if (!busy) return undefined; const tick = () => setAnalysisElapsedMs(Math.max(0, Date.now() - (analysisStartedRef.current || Date.now()))); tick(); const timer = window.setInterval(tick, 100); return () => window.clearInterval(timer); }, [busy]);
  const imageUrls = (listing?.imageUrls || []).slice(0, MAX_IMAGES); const findings = useMemo(() => compliance?.findings || [], [compliance]); const violationFindings = useMemo(() => findings.filter((f) => displayFindingStatus(f) === "VIOLATION"), [findings]); const allViolationsSelected = violationFindings.length > 0 && violationFindings.every((f) => selectedViolations.includes(String(f.findingId))); const finalCategories = useMemo(() => flatten(categories).filter((c) => c.isFinalProductType && c.sourceType === "ECOMMERCE"), [categories]); const filteredFinalCategories = useMemo(() => { const query = categoryFilter.trim().toLowerCase(); return query ? finalCategories.filter((category) => category.path.some((node) => String(node.name || "").toLowerCase().includes(query))) : finalCategories; }, [categoryFilter, finalCategories]); const selectedManualRule = useMemo(() => ENGINE_RULE_OPTIONS.find(([code]) => code === manualRuleCode) || null, [manualRuleCode]);
  function formatElapsed(ms) { const totalSeconds = Math.max(0, Math.floor(Number(ms || 0) / 1000)); const minutes = Math.floor(totalSeconds / 60); const seconds = totalSeconds % 60; return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`; }
  const displayedAnalysisTime = formatElapsed(busy ? analysisElapsedMs : (analysisDurationMs ?? analysisElapsedMs));
  function resetState({ clearUrl = true, text = "E-commerce analyzer reset." } = {}) { controllerRef.current?.abort(); controllerRef.current = null; analysisStartedRef.current = null; if (clearUrl) setUrl(""); setListing(null); setOcr(null); setCompliance(null); setCategoryId(""); setCategoryFilter(""); setSelectedViolations([]); setManualViolations([]); setManualRuleCode(""); setManualRuleNumber(""); setManualViolationReason(""); setError(""); setMessage(text); setBusy(false); setAnalysisElapsedMs(0); setAnalysisDurationMs(null); }
  function cancelInspection() { resetState({ clearUrl: false, text: "Inspection cancelled. The current draft was discarded." }); }
  function setSelectedDefaults(result) { setSelectedViolations((result?.findings || []).filter((f) => displayFindingStatus(f) === "VIOLATION").map((f) => String(f.findingId))); }
  async function inspectListing(event) { event.preventDefault(); const value = url.trim(); if (!/^https?:\/\/\S+$/i.test(value)) return setError("Enter a valid public product listing URL."); const controller = new AbortController(); controllerRef.current?.abort(); controllerRef.current = controller; analysisStartedRef.current = Date.now(); setAnalysisElapsedMs(0); setAnalysisDurationMs(null); setBusy(true); setError(""); setMessage("Fetching listing data and product images..."); setListing(null); setOcr(null); setCompliance(null); setCategoryId(""); setCategoryFilter(""); setSelectedViolations([]); setManualViolations([]); setManualRuleCode(""); setManualRuleNumber(""); setManualViolationReason(""); try { const response = await apiFetch(`${API_URL}/products/ecommerce/analyze-url`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: value }), signal: controller.signal }); const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error || "Could not inspect the listing."); const written = parseWrittenListingText(data.listing?.text); let extractedOcr = data.ocr || null; const listingWithWritten = { ...(data.listing || {}), ...Object.fromEntries(Object.entries(written).filter(([key, item]) => key !== "listingText" && item && !data.listing?.[key])), listingText: written.listingText || data.listing?.text || "" }; const listingStructuredOcr = buildListingStructuredOcr(listingWithWritten); const sourceImages = Array.isArray(listingWithWritten.imageUrls) ? listingWithWritten.imageUrls.slice(0, MAX_IMAGES) : []; if (sourceImages.length) { setMessage(`Running shared Fast OCR + AI semantic analysis on ${sourceImages.length} image${sourceImages.length === 1 ? "" : "s"}...`); const imageResponse = await apiFetch(`${API_URL}/products/ecommerce-ocr/images`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ imageUrls: sourceImages, categoryOptions: finalCategories.map((c) => c.name), rawText: listingWithWritten.listingText || "" }), signal: controller.signal }); const imageData = await imageResponse.json().catch(() => ({})); if (imageResponse.ok) extractedOcr = imageData?.result || imageData?.ocr || extractedOcr; }
      const merged = mergeListingWithOcr(listingWithWritten, extractedOcr); const structuredOcr = mergeStructuredOcr(listingStructuredOcr, extractedOcr); setListing(merged); setOcr(structuredOcr); setMessage("Evaluating the listing against the Legal Metrology Rules Engine..."); const evaluationResponse = await apiFetch(`${API_URL}/ocr/evaluate-structured`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ocr: structuredOcr, evidenceText: merged.listingText || "", sourceType: "ECOMMERCE", context: "ecommerce_listing", category: merged.category || "", isImported: Boolean(merged.countryOfOrigin) }), signal: controller.signal }); const evaluation = await evaluationResponse.json().catch(() => ({})); if (evaluationResponse.ok && evaluation?.compliance) { setCompliance(evaluation.compliance); setSelectedDefaults(evaluation.compliance); } else if (data?.compliance) { setCompliance(data.compliance); setSelectedDefaults(data.compliance); setMessage("Rules Engine findings were generated from public listing evidence because package OCR did not return structured data."); } else { setCompliance(null); setMessage(evaluation?.complianceError?.message || evaluation?.error || "Rules Engine unavailable; manual review is still available."); } const suggested = evaluation?.suggestedCategory || data?.suggestedCategory; if (!categoryId && suggested) { const match = finalCategories.find((c) => String(c.name).toLowerCase() === String(suggested).toLowerCase()); if (match) setCategoryId(match.id); } setAnalysisDurationMs(Date.now() - (analysisStartedRef.current || Date.now())); setBusy(false); } catch (error) { if (error?.name === "AbortError") return; setError(error?.message || "Could not inspect the listing."); setBusy(false); setAnalysisDurationMs(Date.now() - (analysisStartedRef.current || Date.now())); } }
  const sourceModeLabel = "E-commerce";
  return <div className="ecommerce-page"><div className="page-header"><p className="eyebrow">E-COMMERCE INSPECTION</p><h1>Inspect Product Listing</h1><p>Enter a public listing URL. PARAKH combines website data with the same RapidOCR + AI semantic pipeline used for package scanning, then sends the evidence to the Rules Engine.</p><Link to="/ecommerce-products" className="back-link">View saved e-commerce products →</Link></div>
    <section className="ecommerce-panel"><form onSubmit={inspectListing} className="inspect-form"><label>Public listing URL<input type="url" required value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/product/..." disabled={busy} /></label><div className="inspect-action-row"><button className="primary-button" type="submit" disabled={busy || !url.trim()}>{busy ? "Inspecting…" : "Inspect listing"}</button>{(busy || listing) && <button className="secondary-action" type="button" onClick={cancelInspection}>Cancel</button>}<span className="ecommerce-analysis-timer">{displayedAnalysisTime}</span></div></form></section>
    {error && <div className="status-message">{error}</div>}{message && !error && <div className="status-message">{message}</div>}
    {listing && <section className="ecommerce-panel"><div className="section-heading"><div><h2>Listing data & extracted declarations</h2><p>Edit any field before registration. Product and category names are kept exactly as received.</p></div></div><div className="ecommerce-results-grid">{EDITABLE_FIELDS.map(([key,label]) => <label key={key}>{label}<input value={listing[key] || ""} onChange={(e) => setListing((current) => ({ ...current, [key]: e.target.value }))} /></label>)}</div>{imageUrls.length > 0 && <div className="ecommerce-image-row">{imageUrls.map((src, index) => <img key={src + index} src={src} alt={`Listing evidence ${index + 1}`} />)}</div>}</section>}
    {listing && <section className="ecommerce-panel"><div className="section-heading"><div><h2>Assign final product category</h2><p>Search categories in English even when the interface is translated.</p></div></div><input value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)} placeholder="Filter categories" /><select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}><option value="">Select final category</option>{filteredFinalCategories.map((c) => <option key={c.id} value={c.id}>{c.path.map((node) => node.name).join(" → ")}</option>)}</select><p className="category-identity-note">The stored category name is never rewritten by the interface language.</p></section>}
    {listing && <section className="ecommerce-panel"><div className="section-heading"><div><h2>Rules Engine assessment</h2><p>Automated findings are shown separately from inspector observations. Violations and unresolved checks remain visible before registration.</p></div></div>{compliance?.summary && <div className="ecommerce-compliance-summary"><div><span>Total rules</span><strong>{compliance.summary.totalRulesEvaluated ?? findings.length}</strong></div><div className="pass"><span>Passed</span><strong>{compliance.summary.passed ?? 0}</strong></div><div className="violation"><span>Violations</span><strong>{compliance.summary.violations ?? violationFindings.length}</strong></div><div className="unable"><span>Unable to verify</span><strong>{compliance.summary.unableToVerify ?? findings.filter((f) => displayFindingStatus(f) === "UNABLE_TO_VERIFY").length}</strong></div></div>}{compliance && findings.length > 0 && <div className="rules-findings">{findings.map((finding) => { const meta = ruleMeta(finding); const status = displayFindingStatus(finding); return <details className={`rule-review-dropdown ecommerce-status-${status.toLowerCase()}`} key={finding.findingId}><summary><span>{meta.number || meta.code}</span><strong>{status}</strong><em>{meta.title}</em></summary><div className="rule-review-dropdown-body"><strong>{meta.title}</strong><p>{meta.statement}</p><span>{finding.message || finding.violationReason || "No additional detail recorded."}</span></div></details>; })}</div>}{compliance && findings.length === 0 && <div className="ecommerce-empty-state">Rules Engine returned no findings.</div>}{!compliance && !error && <div className="ecommerce-empty-state">Rules Engine results are not available yet.</div>}</section>}
    {listing && <section className="ecommerce-panel"><div className="section-heading"><div><h2>Manual rule observation</h2><p>Add an inspector observation without changing the stored product data.</p></div></div><select value={manualRuleCode} onChange={(e) => { const value = e.target.value; setManualRuleCode(value); const meta = ENGINE_RULE_OPTIONS.find(([code]) => code === value); setManualRuleNumber(meta?.[1] || ""); }}><option value="">Select configured rule</option>{ENGINE_RULE_OPTIONS.map(([code, number, title]) => <option key={code} value={code}>{number} · {title}</option>)}</select><input value={manualRuleNumber} onChange={(e) => setManualRuleNumber(e.target.value)} placeholder="Custom rule number" /><textarea value={manualViolationReason} onChange={(e) => setManualViolationReason(e.target.value)} placeholder="Inspector observation" /><button type="button" className="secondary-action" onClick={() => { if (!manualViolationReason.trim()) return; setManualViolations((items) => [...items, { ruleCode: manualRuleCode, ruleNumber: manualRuleNumber.trim() || "Custom", reason: manualViolationReason.trim(), title: selectedManualRule?.[2] || "Manual observation" }]); setManualRuleCode(""); setManualRuleNumber(""); setManualViolationReason(""); }}>Add observation</button></section>}
    {listing && <section className="ecommerce-panel"><div className="section-heading"><div><h2>Registration</h2><p>Product/category names remain unchanged; interface text follows the selected language.</p></div></div><button className="primary-button" disabled={saving || !categoryId} onClick={() => { if (!categoryId) return; setSaving(true); apiFetch(`${API_URL}/products`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...listing, productName: String(listing.productName || "").trim() || "Unnamed product", categoryId, sourceType: sourceModeLabel.toUpperCase(), sourceUrl: listing.sourceUrl || url, ocrData: JSON.stringify({ ocr, compliance, manualViolations }), complianceStatus: violationFindings.some((f) => selectedViolations.includes(String(f.findingId))) || manualViolations.length ? "VIOLATION" : "NEEDS_REVIEW" }) }).then(async (r) => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d?.error || "Registration failed"); navigate(`/products/item/${d.id}`); }).catch((e) => setError(e.message)).finally(() => setSaving(false)); }}>{saving ? "Registering…" : "Register product"}</button></section>}
  </div>;
}
