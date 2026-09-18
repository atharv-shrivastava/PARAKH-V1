import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../lib/auth";
import { scanBarcodeImage, lookupDataKart, compareWithDataKart, calculateVerificationConfidence } from "../lib/verification";
import ScanVisualCheck from "../components/ScanVisualCheck";
import ImageEditor from "../components/ImageEditor";
import "../styles/scan.css";
import "../styles/ai-category.css";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:5000/api";
const OCR_URL = API_URL.replace(/\/api\/?$/, "");
const MAX_IMAGES = 4;
const BARCODE_MAX_SIZE = 8 * 1024 * 1024;
const PACKAGE_BARCODE_SCAN_LIMIT = 3;
const PACKAGE_BARCODE_SCAN_TIMEOUT_MS = 2200;
const EXPLICIT_BARCODE_SCAN_TIMEOUT_MS = 5000;
const NON_COMPLIANCE_FIELDS = new Set(["barcode", "gtin", "barcodeConfidence", "gtinConfidence"]);
const EMPTY_FORM = { brandName: "", productName: "", description: "", netQuantity: "", unit: "", mrp: "", barcode: "", shopName: "", shopAddress: "", shopCity: "", shopState: "", notes: "" };
const EMPTY_DATAKART = { attempted: false, found: false, gtin: null, product: null, error: null, status: "NOT_ATTEMPTED", source: null, comparison: null };
const RULE_OPTIONS = [
  { ruleNumber: "3", title: "Applicability and exclusions", statement: "Chapter II applicability depends on package and consumer categories specified by Rule 3." },
  { ruleNumber: "4", title: "Mandatory declarations", statement: "Packages must carry the declarations required by the Rules before being pre-packed for sale, distribution or delivery, subject to applicable exceptions." },
  { ruleNumber: "6(1)(a)", title: "Manufacturer, packer and importer declaration", statement: "The package must declare the responsible manufacturer/packer identity and applicable importer information." },
  { ruleNumber: "6(1)(b)", title: "Common or generic name", statement: "The package shall bear the common or generic name of the commodity." },
  { ruleNumber: "6(1)(c)", title: "Net quantity declaration", statement: "The package shall declare net quantity in the prescribed standard unit or by number where appropriate." },
  { ruleNumber: "6(1)(d)", title: "Month and year declaration", statement: "The package shall declare the month and year of manufacture, pre-packing or import, subject to commodity-specific exceptions." },
  { ruleNumber: "6(1)(e)", title: "Retail sale price", statement: "The package shall bear the retail sale price in the manner required by the Rules." },
  { ruleNumber: "6(1)(f)", title: "Dimensions where relevant", statement: "Where size is relevant, the prescribed dimensions shall be declared." },
  { ruleNumber: "6(2)", title: "Consumer complaint contact", statement: "Consumer complaint contact details shall be declared as prescribed." },
  { ruleNumber: "6(3)", title: "Restrictions on separate stickers", statement: "Required declarations shall not be made by prohibited separate stickers; the permitted revised MRP sticker is subject to its own conditions." },
  { ruleNumber: "7", title: "Principal display panel and declaration dimensions", statement: "Declarations on the principal display panel must meet the prescribed presentation and size requirements." },
  { ruleNumber: "8", title: "Declarations on principal display panel", statement: "Required declarations shall appear on the principal display panel in the prescribed manner." },
  { ruleNumber: "9", title: "Legibility and language of declarations", statement: "Declarations must be legible, prominent and presented in the permitted manner." },
  { ruleNumber: "10", title: "Manufacturer/packer/importer address presentation", statement: "The responsible entity name and complete address shall be declared in the prescribed manner." },
  { ruleNumber: "12(6)", title: "Non-misleading quantity expression", statement: "Quantity expressions must not create an exaggerated, misleading or inadequate impression." },
  { ruleNumber: "26(a)", title: "Pan masala exception", statement: "The specified Rule 26(a) clause does not apply to pan masala from 1 February 2026." },
];
const FIELD_LABELS = {
  productName: "Product name",
  brandName: "Brand name",
  manufacturer: "Manufacturer",
  manufacturerAddress: "Manufacturer address",
  packer: "Packer",
  packerAddress: "Packer address",
  marketer: "Marketer",
  marketerAddress: "Marketer address",
  importer: "Importer",
  importerAddress: "Importer address",
  netQuantity: "Net quantity",
  unit: "Unit",
  mrp: "MRP",
  currency: "Currency",
  dateOfManufacture: "Manufacturing date",
  dateOfPacking: "Packing date",
  bestBefore: "Best before",
  expiryDate: "Expiry date",
  batchNumber: "Batch / lot number",
  consumerCarePhone: "Consumer care phone",
  consumerCareEmail: "Consumer care email",
  countryOfOrigin: "Country of origin",
  fssaiLicenseNumber: "FSSAI license number",
};
const PLACEHOLDER_CATEGORY_NAMES = new Set(["ss", "test", "test1", "test3", "bb", "mn", "po", "hh", "hhg", "jj", "cc", "ssss"]);

function flattenCategories(nodes, path = []) { return nodes.flatMap((node) => { const next = [...path, node]; return [{ ...node, path: next }, ...flattenCategories(node.children || [], next)]; }); }
function isSelectableFinalCategory(category) {
  if (!category?.isFinalProductType) return false;
  const names = (category.path || []).map((item) => String(item?.name || "").trim().toLowerCase());
  return !names.some((name) => PLACEHOLDER_CATEGORY_NAMES.has(name));
}
function fieldLabel(key) { return FIELD_LABELS[key] || String(key || "").replace(/([A-Z])/g, " $1").replace(/^./, (char) => char.toUpperCase()).trim(); }
function fieldValue(result, key) { const field = result?.[key]; if (field?.status !== "found") return ""; return String(field.displayValue ?? field.value ?? ""); }
function normalizeDigits(value) { return String(value ?? "").replace(/\D/g, "").trim(); }
function validGtin(value) {
  const digits = normalizeDigits(value);
  if (![8, 12, 13, 14].includes(digits.length)) return false;
  let sum = 0;
  for (let index = digits.length - 2, position = 0; index >= 0; index -= 1, position += 1) sum += Number(digits[index]) * (position % 2 === 0 ? 3 : 1);
  return (10 - (sum % 10)) % 10 === Number(digits[digits.length - 1]);
}
function formFromOcr(result, authoritativeGtin = "") {
  if (!result) return { ...EMPTY_FORM, barcode: authoritativeGtin || "" };
  const detailLines = [
    ["Manufacturer", fieldValue(result, "manufacturer")], ["Manufacturer address", fieldValue(result, "manufacturerAddress")], ["Marketer", fieldValue(result, "marketer")],
    ["Packer", fieldValue(result, "packer")], ["Packer address", fieldValue(result, "packerAddress")], ["Importer", fieldValue(result, "importer")], ["Importer address", fieldValue(result, "importerAddress")],
    ["Currency", fieldValue(result, "currency")], ["Manufacturing date", fieldValue(result, "dateOfManufacture")], ["Packing date", fieldValue(result, "dateOfPacking")],
    ["Best before", fieldValue(result, "bestBefore")], ["Expiry date", fieldValue(result, "expiryDate")], ["Batch / lot number", fieldValue(result, "batchNumber")],
    ["Consumer care phone", fieldValue(result, "consumerCarePhone")], ["Consumer care email", fieldValue(result, "consumerCareEmail")], ["Country of origin", fieldValue(result, "countryOfOrigin")], ["FSSAI license number", fieldValue(result, "fssaiLicenseNumber")],
  ].filter(([, value]) => value);
  const declarations = Array.isArray(result.otherDeclarations) ? result.otherDeclarations.filter(Boolean) : [];
  return { brandName: fieldValue(result, "brandName") || fieldValue(result, "manufacturer"), productName: fieldValue(result, "productName"), netQuantity: fieldValue(result, "netQuantity"), unit: fieldValue(result, "unit"), mrp: fieldValue(result, "mrp").replace(/[^0-9.]/g, ""), barcode: authoritativeGtin || "", description: [...detailLines.map(([label, value]) => `${label}: ${value}`), ...declarations].join("\n"), shopName: "", shopAddress: "", shopCity: "", shopState: "", notes: "" };
}
function readVisualInspection() { try { const parsed = JSON.parse(window.sessionStorage.getItem("parakhVisualInspection") || "null"); return parsed && typeof parsed === "object" ? parsed : null; } catch { return null; } }
async function fileToDataUrl(file) { const bitmap = await createImageBitmap(file); const scale = Math.min(1, 1200 / Math.max(bitmap.width, bitmap.height)); const canvas = document.createElement("canvas"); canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale)); const ctx = canvas.getContext("2d"); if (!ctx) { bitmap.close(); throw new Error("Could not prepare the image for storage."); } ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.close(); return canvas.toDataURL("image/jpeg", 0.72); }
async function runOcr(files, signal, categoryOptions = []) { const fd = new FormData(); files.forEach((file) => fd.append("images", file)); fd.append("categoryOptions", JSON.stringify(categoryOptions)); const response = await apiFetch(`${OCR_URL}/api/ocr/analyze`, { method: "POST", body: fd, signal }); const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error?.message || data.error || data.message || "Local OCR service unavailable."); if (!data.result) throw new Error("Local OCR returned no structured result."); return { result: data.result, provider: data.provider || "rapidocr", model: data.model || "RapidOCR", semantic: data.semantic || null, detectionProvider: data.detectionProvider || "rapidocr", detectionProviders: data.detectionProviders || ["rapidocr"], fallbackReason: data.fallbackReason || null, aiSuggestedCategory: data.aiSuggestedCategory || null, aiSemanticEnabled: Boolean(data.aiSemanticEnabled), aiSemanticError: data.aiSemanticError || null, timing: data.timing || null }; }
async function resolveGtin(barcodeFile, manualValue, packageFiles = []) {
  const manual = normalizeDigits(manualValue);
  if (manual) return validGtin(manual) ? { attempted: true, found: true, value: manual, gtin: manual, format: "MANUAL_GTIN", confidence: 0.90, source: "MANUAL_GTIN", error: null } : { attempted: true, found: false, value: null, gtin: null, format: "MANUAL_GTIN", confidence: 0, source: "MANUAL_GTIN", error: "Manual GTIN is not valid." };
  if (barcodeFile) { const decoded = await scanBarcodeImage(barcodeFile, EXPLICIT_BARCODE_SCAN_TIMEOUT_MS); return { ...decoded, gtin: decoded.found ? decoded.value : null, source: decoded.found ? "BARCODE_SCAN" : "NONE" }; }
  const candidates = Array.isArray(packageFiles) ? packageFiles.slice(0, PACKAGE_BARCODE_SCAN_LIMIT) : [];
  for (const file of candidates) { const decoded = await scanBarcodeImage(file, PACKAGE_BARCODE_SCAN_TIMEOUT_MS); if (decoded.found) return { ...decoded, gtin: decoded.value, source: "PACKAGE_IMAGE_BARCODE_SCAN" }; }
  return { attempted: candidates.length > 0, found: false, value: null, gtin: null, format: null, confidence: 0, source: candidates.length ? "PACKAGE_IMAGE_BARCODE_NOT_FOUND" : "NONE", error: candidates.length ? "No valid GTIN barcode was decoded from the supplied package images." : null };
}
function formatElapsed(ms) { const totalSeconds = Math.max(0, Math.floor(ms / 1000)); return `${String(Math.floor(totalSeconds / 60)).padStart(2, "0")}:${String(totalSeconds % 60).padStart(2, "0")}`; }
function datakartLabel(state) {
  if (!state) return "Not attempted";
  if (state.status === "CHECKING") return "Checking…";
  if (state.found || state.status === "FOUND") return "Reference found";
  if (state.status === "NOT_FOUND") return "No matching GTIN";
  if (state.status === "ERROR") return `Error: ${state.error || "lookup failed"}`;
  if (state.status === "ABORTED") return "Lookup cancelled";
  return "Not attempted";
}
function barcodeState(status = "NONE", error = null) { return { attempted: true, found: false, value: null, gtin: null, confidence: 0, source: status, error }; }

export default function ScanV2() {
  const videoRef = useRef(null); const controllerRef = useRef(null); const dataKartControllerRef = useRef(null); const analysisRunRef = useRef(0);
  const [categories, setCategories] = useState([]); const [images, setImages] = useState([]); const [ocr, setOcr] = useState(null); const [compliance, setCompliance] = useState(null); const [complianceError, setComplianceError] = useState(null); const [acceptedFindingIds, setAcceptedFindingIds] = useState([]); const [findingResolutions, setFindingResolutions] = useState({}); const [manualViolations, setManualViolations] = useState([]); const [manualViolationReason, setManualViolationReason] = useState(""); const [manualRuleNumber, setManualRuleNumber] = useState(""); const [selectedCategoryId, setSelectedCategoryId] = useState(""); const [form, setForm] = useState(EMPTY_FORM); const [providerInfo, setProviderInfo] = useState(null); const [aiSuggestedCategory, setAiSuggestedCategory] = useState(null); const [cameraOpen, setCameraOpen] = useState(false); const [cameraError, setCameraError] = useState(""); const [analyzing, setAnalyzing] = useState(false); const [analysisElapsedMs, setAnalysisElapsedMs] = useState(0); const [analysisDurationMs, setAnalysisDurationMs] = useState(null); const [saving, setSaving] = useState(false); const [showRegistration, setShowRegistration] = useState(false); const [useExtractedData, setUseExtractedData] = useState(false); const [editingImageIndex, setEditingImageIndex] = useState(null); const [message, setMessage] = useState(""); const [barcodeFile, setBarcodeFile] = useState(null); const [barcodePreviewUrl, setBarcodePreviewUrl] = useState(""); const [manualGtin, setManualGtin] = useState(""); const [barcodeResult, setBarcodeResult] = useState(null); const [datakartVerification, setDatakartVerification] = useState(EMPTY_DATAKART); const [verificationConfidence, setVerificationConfidence] = useState(null);

  useEffect(() => { apiFetch(`${API_URL}/categories/tree/all?sourceType=OFFLINE`).then(async (r) => { if (!r.ok) throw new Error("Unable to load offline categories"); return r.json(); }).then(setCategories).catch((e) => setMessage(e.message)); }, []);
  useEffect(() => () => { controllerRef.current?.abort(); dataKartControllerRef.current?.abort(); if (videoRef.current?.srcObject) videoRef.current.srcObject.getTracks().forEach((track) => track.stop()); }, []);
  useEffect(() => { if (!analyzing) return undefined; const started = Date.now(); setAnalysisElapsedMs(0); const timer = window.setInterval(() => setAnalysisElapsedMs(Date.now() - started), 100); return () => window.clearInterval(timer); }, [analyzing]);

  const finalCategories = flattenCategories(categories).filter(isSelectableFinalCategory);
  const findings = Array.isArray(compliance?.findings) ? compliance.findings : [];
  const violations = findings.filter((finding) => String(finding.status || "").toUpperCase() === "VIOLATION");
  const unresolvedFindings = findings.filter((finding) => {
    const status = String(finding.status || "").toUpperCase().replace(/[\s-]+/g, "_");
    return status === "UNABLE_TO_VERIFY" || status === "UNVERIFIED";
  });
  const unresolvedRemaining = unresolvedFindings.filter((finding) => {
    const decision = findingResolutions[finding.findingId]?.decision;
    return !decision;
  });
  const accepted = violations.filter((finding) => acceptedFindingIds.includes(finding.findingId));
  const resolvedViolations = unresolvedFindings
    .filter((finding) => findingResolutions[finding.findingId]?.decision === "VIOLATION_CONFIRMED")
    .map((finding) => ({
      ...finding,
      status: "VIOLATION",
      severity: finding.severity || "REVIEW",
      violationReason: findingResolutions[finding.findingId]?.note || finding.violationReason || finding.message || "Confirmed by officer review.",
    }));
  const selectedViolations = [...accepted, ...resolvedViolations, ...manualViolations]
    .filter((finding, index, list) => list.findIndex((item) => item.findingId === finding.findingId) === index);
  const barcodeCompare = datakartVerification?.comparison?.comparisons || {};
  const scannerGtin = barcodeResult?.found ? barcodeResult.gtin : null;

  function update(key, value) { setForm((current) => ({ ...current, [key]: value })); }
  function resetVerificationState() { dataKartControllerRef.current?.abort(); dataKartControllerRef.current = null; setBarcodeResult(null); setDatakartVerification({ ...EMPTY_DATAKART }); setVerificationConfidence(null); }
  function resetAnalysisState() { setOcr(null); setCompliance(null); setComplianceError(null); setAcceptedFindingIds([]); setFindingResolutions({}); setManualViolations([]); setManualViolationReason(""); setManualRuleNumber(""); setProviderInfo(null); setAiSuggestedCategory(null); setSelectedCategoryId(""); setShowRegistration(false); setUseExtractedData(false); setForm(EMPTY_FORM); window.sessionStorage.removeItem("parakhDeclarationEvidence"); resetVerificationState(); }
  function resetScan() { analysisRunRef.current += 1; controllerRef.current?.abort(); dataKartControllerRef.current?.abort(); controllerRef.current = null; dataKartControllerRef.current = null; if (videoRef.current?.srcObject) videoRef.current.srcObject.getTracks().forEach((track) => track.stop()); if (videoRef.current) videoRef.current.srcObject = null; if (barcodePreviewUrl) URL.revokeObjectURL(barcodePreviewUrl); setImages((current) => { current.forEach((item) => URL.revokeObjectURL(item.url)); return []; }); setCameraOpen(false); setCameraError(""); setBarcodeFile(null); setBarcodePreviewUrl(""); setManualGtin(""); setBarcodeResult(null); setDatakartVerification({ ...EMPTY_DATAKART }); setVerificationConfidence(null); setEditingImageIndex(null); resetAnalysisState(); setAnalyzing(false); setAnalysisElapsedMs(0); setAnalysisDurationMs(null); setSaving(false); setMessage("Scan reset. Add new package images to begin again."); }
  function addFiles(input) { const files = Array.from(input || []).filter((file) => file instanceof File && file.type.startsWith("image/")); if (!files.length) return; resetAnalysisState(); setImages((current) => [...current, ...files.slice(0, MAX_IMAGES - current.length).map((file) => ({ file, url: URL.createObjectURL(file) }))]); setMessage("Images ready. Use Edit on any image to rotate or crop before analysis."); }
  function applyEditedImage(index, file) { setImages((current) => current.map((item, imageIndex) => { if (imageIndex !== index) return item; URL.revokeObjectURL(item.url); return { file, url: URL.createObjectURL(file) }; })); resetAnalysisState(); setEditingImageIndex(null); setMessage("Edited image applied. Analyze again to use the corrected image."); }
  function addBarcodeFile(input) { const file = input?.[0]; if (!file) return; if (!file.type.startsWith("image/")) return setMessage("Barcode upload must be an image."); if (file.size > BARCODE_MAX_SIZE) return setMessage("Barcode image is too large. Use an image smaller than 8 MB."); if (barcodePreviewUrl) URL.revokeObjectURL(barcodePreviewUrl); setBarcodeFile(file); setBarcodePreviewUrl(URL.createObjectURL(file)); resetVerificationState(); setMessage("Barcode image ready. It will be scanned independently from OCR."); }
  function removeBarcodeFile() { if (barcodePreviewUrl) URL.revokeObjectURL(barcodePreviewUrl); setBarcodeFile(null); setBarcodePreviewUrl(""); resetVerificationState(); setMessage("Barcode image removed. Package-image barcode scanning remains available during analysis."); }
  async function openCamera() { setCameraError(""); if (!navigator.mediaDevices?.getUserMedia) return setCameraError("Camera access is unavailable. Use Upload Images instead."); try { const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false }); setCameraOpen(true); requestAnimationFrame(() => { if (videoRef.current) { videoRef.current.srcObject = stream; videoRef.current.play().catch(() => {}); } }); } catch (error) { setCameraError(error.name === "NotAllowedError" ? "Camera permission was denied." : "Could not open the camera."); } }
  function closeCamera() { if (videoRef.current?.srcObject) videoRef.current.srcObject.getTracks().forEach((track) => track.stop()); if (videoRef.current) videoRef.current.srcObject = null; setCameraOpen(false); }
  function capture() { const video = videoRef.current; if (!video || video.readyState < 2) return setCameraError("Camera is still starting. Try again."); const canvas = document.createElement("canvas"); canvas.width = video.videoWidth; canvas.height = video.videoHeight; const ctx = canvas.getContext("2d"); if (!ctx) return setCameraError("Could not capture the image."); ctx.drawImage(video, 0, 0, canvas.width, canvas.height); canvas.toBlob((blob) => { if (!blob) return setCameraError("Could not capture the image."); addFiles([new File([blob], `camera-${Date.now()}.jpg`, { type: "image/jpeg" })]); closeCamera(); }, "image/jpeg", 0.88); }
  function remove(index) { setImages((current) => current.filter((item, i) => { if (i === index) URL.revokeObjectURL(item.url); return i !== index; })); resetAnalysisState(); }

  async function analyze() {
    if (!images.length) return setMessage("Add at least one package image first.");
    const runId = ++analysisRunRef.current;
    controllerRef.current?.abort(); dataKartControllerRef.current?.abort();
    const controller = new AbortController(); const dataKartController = new AbortController();
    controllerRef.current = controller; dataKartControllerRef.current = dataKartController;
    setAnalyzing(true); setAnalysisDurationMs(null); setCompliance(null); setComplianceError(null); setVerificationConfidence(null); setDatakartVerification({ ...EMPTY_DATAKART });
    setMessage(barcodeFile || manualGtin.trim() ? "Running barcode scanner, RapidOCR and Gemini in parallel..." : "Running RapidOCR, Gemini and package-image barcode detection in parallel...");
    try {
      const categoryOptions = finalCategories.map((category) => ({ id: category.id, name: category.name, path: category.path.map((item) => item.name).join(" → ") }));
      const packageFiles = images.map((item) => item.file);
      const [ocrOutcome, barcodeOutcome] = await Promise.allSettled([runOcr(packageFiles, controller.signal, categoryOptions), resolveGtin(barcodeFile, manualGtin, packageFiles)]);
      if (runId !== analysisRunRef.current || controller.signal.aborted) return;
      if (ocrOutcome.status !== "fulfilled") throw ocrOutcome.reason;
      const info = ocrOutcome.value;
      const identifier = barcodeOutcome.status === "fulfilled" ? barcodeOutcome.value : barcodeState("BARCODE_SCAN_ERROR", barcodeOutcome.reason?.message || "Barcode verification failed.");
      const extracted = info.result;
      const authoritativeGtin = identifier.found ? identifier.gtin : null;
      setOcr(extracted); setForm(formFromOcr(extracted, authoritativeGtin || "")); setUseExtractedData(true); setShowRegistration(true); setAiSuggestedCategory(info.aiSuggestedCategory || null); setBarcodeResult(identifier); setProviderInfo({ ...info, barcodeResult: identifier });
      window.sessionStorage.setItem("parakhDeclarationEvidence", JSON.stringify(extracted.declarationEvidence || [])); window.dispatchEvent(new CustomEvent("parakh:declaration-evidence", { detail: extracted.declarationEvidence || [] }));

      let dataKartPromise = Promise.resolve({ ...EMPTY_DATAKART, attempted: false });
      if (authoritativeGtin) {
        setDatakartVerification({ ...EMPTY_DATAKART, attempted: true, gtin: authoritativeGtin, status: "CHECKING", source: "datakart-supabase" });
        dataKartPromise = lookupDataKart(authoritativeGtin, dataKartController.signal).then((dk) => ({ ...dk, comparison: compareWithDataKart(extracted, dk), status: dk?.found ? "FOUND" : dk?.status || "NOT_FOUND" }));
      } else setDatakartVerification({ ...EMPTY_DATAKART, attempted: false, gtin: null, status: "NOT_ATTEMPTED", error: identifier.error || null });

      const visualInspection = readVisualInspection();
      const rulesPromise = apiFetch(`${OCR_URL}/api/ocr/evaluate-structured`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ocr: extracted, visualFlags: visualInspection || {}, inspectionId: crypto.randomUUID(), productId: crypto.randomUUID(), inspectionDate: new Date().toISOString().slice(0, 10), context: "physical_package", commodityCategory: "packaged commodity", consumerType: "general", isImported: false, packageType: "retail", datakartVerification: null }), signal: controller.signal });
      const [rulesOutcome, dataKartOutcome] = await Promise.allSettled([rulesPromise, dataKartPromise]);
      if (runId !== analysisRunRef.current || controller.signal.aborted) return;
      if (rulesOutcome.status === "fulfilled") { const response = rulesOutcome.value; const data = await response.json().catch(() => ({})); if (!response.ok) { setCompliance(null); setComplianceError({ message: data.error || "Rules Engine evaluation failed" }); } else { setCompliance(data.compliance || null); setComplianceError(data.complianceError || null); setAcceptedFindingIds([]); setFindingResolutions({}); } }
      else if (rulesOutcome.reason?.name !== "AbortError") { setCompliance(null); setComplianceError({ message: rulesOutcome.reason?.message || "Rules Engine evaluation failed" }); }

      const dk = dataKartOutcome.status === "fulfilled" ? dataKartOutcome.value : { ...EMPTY_DATAKART, attempted: Boolean(authoritativeGtin), gtin: authoritativeGtin, status: authoritativeGtin ? "ERROR" : "NOT_ATTEMPTED", error: dataKartOutcome.reason?.message || "DataKart lookup failed.", source: "datakart-supabase" };
      const dkComparison = dk.comparison || { matchedFields: 0, comparedFields: 0, unknownFields: 0, matchRate: null, comparisons: {}, gtin: authoritativeGtin, status: dk.status };
      const confidenceResult = calculateVerificationConfidence({ ocrResult: extracted, dataKartComparison: dkComparison });
      setDatakartVerification(dk); setVerificationConfidence(confidenceResult); setProviderInfo({ ...info, barcodeResult: identifier, datakartVerification: dk, verificationConfidence: confidenceResult });
      if (Number.isFinite(info.timing?.totalMs)) setAnalysisDurationMs(Number(info.timing.totalMs));
      setMessage("Analysis complete. Review the extracted fields and verification results.");
    } catch (error) { if (runId !== analysisRunRef.current || error?.name === "AbortError") return; setMessage(error.message || "OCR analysis failed."); }
    finally { if (controllerRef.current === controller) controllerRef.current = null; if (dataKartControllerRef.current === dataKartController) dataKartControllerRef.current = null; setAnalyzing(false); setAnalysisDurationMs((current) => current ?? analysisElapsedMs); }
  }

  function updateOcrField(key, value) { setOcr((current) => current ? { ...current, [key]: { ...current[key], value, displayValue: value, canonicalValue: current[key]?.canonicalValue ?? current[key]?.value, status: "found" } } : current); }
  function applyExtractedData() { if (!ocr) return; setForm(formFromOcr(ocr, scannerGtin || "")); setUseExtractedData(true); setShowRegistration(true); setMessage("Extracted details applied to the registration form. The barcode field uses the authoritative scanner GTIN only."); }
  function applyAiCategory() { const categoryId = aiSuggestedCategory?.categoryId; if (!categoryId || !finalCategories.some((category) => String(category.id) === String(categoryId))) return setMessage("AI suggested a category name, but it does not match an available offline final category. Select the category manually."); setSelectedCategoryId(String(categoryId)); setMessage(`AI category applied: ${aiSuggestedCategory.categoryPath || aiSuggestedCategory.categoryName}.`); }
  function openManualRegistration() { setForm({ ...EMPTY_FORM, barcode: scannerGtin || "" }); setUseExtractedData(false); setShowRegistration(true); setMessage("Manual registration opened. Enter the final product details below."); }
  function toggle(id) { setAcceptedFindingIds((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]); }
  function resolveFinding(findingId, decision, note = "") {
    setFindingResolutions((current) => ({
      ...current,
      [findingId]: { decision, note },
    }));
  }
  function updateFindingReviewNote(findingId, note) {
    setFindingResolutions((current) => ({
      ...current,
      [findingId]: { ...(current[findingId] || {}), note },
    }));
  }
  function addManualViolation() { const reason = manualViolationReason.trim(); const rule = RULE_OPTIONS.find((item) => item.ruleNumber === manualRuleNumber); if (!rule) return setMessage("Select the applicable Rules Engine category before adding a manual violation."); if (!reason) return setMessage("Enter a reason before adding a manual violation."); setManualViolations((current) => [...current, { findingId: `MANUAL-${crypto.randomUUID()}`, ruleCode: `MANUAL-R${rule.ruleNumber}`, ruleNumber: rule.ruleNumber, ruleTitle: rule.title, ruleStatement: rule.statement, status: "VIOLATION", severity: "REVIEW", message: reason, violationReason: reason }]); setManualViolationReason(""); setManualRuleNumber(""); }
  function removeManualViolation(id) { setManualViolations((current) => current.filter((finding) => finding.findingId !== id)); }
  function ruleDetails(finding) { const match = RULE_OPTIONS.find((item) => item.ruleNumber === String(finding.ruleNumber)); return { code: finding.ruleCode || `R${finding.ruleNumber || "-"}`, number: finding.ruleNumber || "Unspecified", title: finding.ruleTitle || match?.title || "Rules Engine finding", statement: finding.ruleStatement || match?.statement || "The Rules Engine reported a legal compliance issue for this rule.", issue: finding.violationReason || finding.message || "Violation detected." }; }
  async function save(event) {
    event.preventDefault();
    if (unresolvedRemaining.length) return setMessage(`Review all ${unresolvedRemaining.length} remaining Unable to Verify findings before submitting.`);
    if (!selectedCategoryId) return setMessage("Select an offline final category before saving.");
    if (!form.shopName.trim()) return setMessage("Shop name is required."); setSaving(true); try { const imageUrls = await Promise.all(images.map((item) => fileToDataUrl(item.file))); const visualInspection = readVisualInspection(); const response = await apiFetch(`${API_URL}/products`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...form, barcode: scannerGtin || "", categoryId: selectedCategoryId, sourceType: "OFFLINE", imageUrls, acceptedFindingIds, ocrData: {
            ocr,
            compliance,
            complianceError,
            providerInfo,
            aiSuggestedCategory,
            visualInspection,
            manualViolations,
            officerReview: {
              resolvedFindings: Object.fromEntries(
                Object.entries(findingResolutions).filter(([, review]) => review?.decision),
              ),
            },
          },
          complianceStatus: selectedViolations.length ? "VIOLATION" : "OKAY", violationReason: selectedViolations.map((finding) => finding.message || finding.violationReason || finding.ruleCode).join(" | "), inspectionDate: new Date().toISOString() }) }); const data = await response.json(); if (!response.ok) throw new Error(data.error || "Could not save product"); const id = data.product?.id || data.id; if (!id) throw new Error("Product was saved but its ID was not returned."); window.location.href = `/products/item/${id}`; } catch (error) { setMessage(error.message); } finally { setSaving(false); } }

  const editingImage = editingImageIndex == null ? null : images[editingImageIndex]; const displayedAnalysisTime = analysisDurationMs != null ? formatElapsed(analysisDurationMs) : formatElapsed(analysisElapsedMs);
  return <div className="scan-page">
    <div className="page-header"><p className="eyebrow">PRODUCT INSPECTION</p><h1>Scan Product</h1><p>Capture or upload package images, prepare their orientation/crop, detect printed text, interpret declarations with AI assistance, and review compliance before registration.</p></div>
    <section className="scan-area"><div className="scan-icon">⌁</div><h2>Capture or upload package images</h2><p>Use the camera or choose up to {MAX_IMAGES} images showing different sides.</p><div className="scan-upload-actions"><button type="button" className="primary-button" onClick={openCamera}>Open Camera</button><label className="secondary-button scan-file-button">Upload Images<input type="file" accept="image/*" multiple onChange={(event) => { addFiles(event.target.files); event.target.value = ""; }} hidden /></label><button type="button" className="secondary-button" onClick={resetScan}>Stop & Reset Scan</button></div><p className="scan-limit">{images.length}/{MAX_IMAGES} images selected</p><div className="barcode-upload-section"><div className="scan-upload-actions"><label className="secondary-button scan-file-button">Upload Barcode<input type="file" accept="image/*" onChange={(event) => { addBarcodeFile(event.target.files); event.target.value = ""; }} hidden /></label><input aria-label="Enter GTIN manually" placeholder="Enter GTIN manually" inputMode="numeric" value={manualGtin} onChange={(event) => { setManualGtin(event.target.value.replace(/\D/g, "").slice(0, 18)); resetVerificationState(); }} /></div>{barcodePreviewUrl && <div className="barcode-preview-card"><div className="barcode-preview-heading"><strong>Uploaded barcode</strong><span>{barcodeFile?.name}</span><button type="button" className="secondary-button" onClick={removeBarcodeFile}>Remove</button></div><img className="barcode-preview-image" src={barcodePreviewUrl} alt="Uploaded barcode for scanning"/><div className="barcode-preview-meta">{barcodeResult?.found ? `Decoded GTIN: ${barcodeResult.gtin}` : barcodeResult?.error || "Barcode will be decoded independently from OCR when Analyze Images is clicked."}</div></div>}{!barcodePreviewUrl && manualGtin && <div className="status-message">Manual GTIN entered: {manualGtin}</div>}</div>{cameraError && <div className="status-message">{cameraError}</div>}</section>
    {cameraOpen && <div className="camera-overlay" role="dialog" aria-modal="true"><div className="camera-modal"><div className="camera-header"><h2>Capture package image</h2><button type="button" onClick={closeCamera}>Close</button></div><video ref={videoRef} className="camera-video" autoPlay playsInline muted /><div className="camera-actions"><button type="button" className="primary-button" onClick={capture}>Capture Photo</button><button type="button" className="secondary-button" onClick={closeCamera}>Cancel</button></div></div></div>}
    {editingImage && <ImageEditor file={editingImage.file} url={editingImage.url} onApply={(file) => applyEditedImage(editingImageIndex, file)} onClose={() => setEditingImageIndex(null)} />}
    {images.length > 0 && <section className="scan-review"><div className="section-heading"><div><h2>Evidence images</h2><p>Rotate or crop any image before OCR. Edited images are the ones sent to OCR and retained with the registered product.</p></div></div><div className="scan-image-grid">{images.map(({ url, file }, index) => <div className="scan-image-card" key={`${file.name}-${index}`}><img src={url} alt={`Package evidence ${index + 1}`} /><div className="scan-image-card-actions"><button type="button" onClick={() => setEditingImageIndex(index)}>Edit crop / rotate</button><button type="button" onClick={() => remove(index)}>Remove</button></div><span>{file.name}</span></div>)}</div><div className="analyze-action-row"><button type="button" className="primary-button" onClick={analyze} disabled={analyzing}>{analyzing ? "Analyzing..." : "Analyze Images"}</button>{(analyzing || analysisDurationMs != null) && <span className="analysis-timer" aria-live="polite">Analysis time: <strong>{displayedAnalysisTime}</strong></span>}</div></section>}
    {images.length > 0 && <ScanVisualCheck />}
    {providerInfo && <section className="ocr-status-grid"><div><strong>OCR / field mapper</strong><span>{providerInfo.aiSemanticEnabled ? "RapidOCR + Gemini multimodal semantic mapping" : "RapidOCR + local deterministic mapping"}</span></div><div><strong>Text detection</strong><span>{providerInfo.detectionProviders?.length ? providerInfo.detectionProviders.join(" + ") : providerInfo.detectionProvider || "RapidOCR"}</span></div><div><strong>Selected violations</strong><span>{selectedViolations.length}</span></div></section>}
    {barcodeResult && <section className="scan-review barcode-result-panel"><div className="section-heading"><div><h2>Barcode verification</h2><p>The barcode is decoded independently from OCR. Only a validated scanner/manual GTIN can select a DataKart record. OCR-readable digits are never authoritative and never enter the compliance score.</p></div></div><div className="ocr-status-grid"><div><strong>Barcode data</strong><span>{scannerGtin || "Not decoded"}</span></div><div><strong>Barcode source</strong><span>{barcodeResult.source || "NONE"}</span></div><div><strong>DataKart</strong><span>{datakartLabel(datakartVerification)}</span></div></div><div className="barcode-data-comparison"><h3>Barcode vs extracted data</h3><div className="ocr-status-grid"><div><strong>Scanner GTIN</strong><span>{scannerGtin || "Not available"}</span></div><div><strong>OCR barcode field</strong><span>Not trusted / excluded</span></div><div><strong>Compliance comparison</strong><span>Not scored by design</span></div></div></div>{datakartVerification?.error && datakartVerification.status === "ERROR" && <div className="status-message">DataKart: {datakartVerification.error}</div>}{datakartVerification?.found && <div className="barcode-data-comparison"><h3>Barcode-selected DataKart product vs extracted fields</h3><div className="ocr-fields-grid">{Object.entries(barcodeCompare).map(([key, comparison]) => <div className="ocr-edit-field" key={key}><strong>{fieldLabel(key)}</strong><input value={comparison.rawAiValue ?? ""} readOnly /><small>{comparison.status === "UNKNOWN" ? "? Not scored" : `${comparison.status === "MATCH" ? "✓ MATCH" : "✕ MISMATCH"} · ${Math.round(Number(comparison.verificationConfidence ?? comparison.score ?? 0) * 100)}% verification confidence · reference: ${comparison.referenceValue ?? ""}`}</small></div>)}</div></div>}</section>}
    {verificationConfidence && <section className="ocr-status-grid"><div><strong>Verification confidence</strong><span>{verificationConfidence.percentage}% · {verificationConfidence.label}</span></div><div><strong>Evidence weights</strong><span>OCR 30% · Gemini 30% · DataKart 40%</span></div><div><strong>Barcode in compliance score</strong><span>Excluded</span></div></section>}
    {aiSuggestedCategory && <section className="ai-category-card"><div className="ai-category-copy"><div className="ai-category-eyebrow">AI SUGGESTED CATEGORY</div><h2>{aiSuggestedCategory.categoryPath || aiSuggestedCategory.categoryName || "Category not determined"}</h2><p>{aiSuggestedCategory.reason || "Suggested from package imagery and OCR evidence."}</p></div><div className="ai-category-meta"><span className="ai-category-confidence">{Math.round(Number(aiSuggestedCategory.confidence || 0) * 100)}% confidence</span><button type="button" className="primary-button" onClick={applyAiCategory} disabled={!aiSuggestedCategory.categoryId}>Use AI Suggestion</button></div></section>}
    {ocr && <section className="scan-review"><div className="section-heading"><div><h2>OCR extraction and rule review</h2><p>Extracted MRP, quantity, dates and other declarations are data. A violation appears only when a legal rule fails or an inspector explicitly records one.</p></div></div><div className="ocr-fields-grid">{Object.entries(ocr).filter(([key, value]) => !NON_COMPLIANCE_FIELDS.has(key) && key !== "rawText" && key !== "semantic" && key !== "aiSemantic" && key !== "aiSuggestedCategory" && value && typeof value === "object" && ["found", "absent", "unreadable", "ambiguous"].includes(value.status)).map(([key, value]) => <label key={key} className="ocr-edit-field"><strong>{fieldLabel(key)}</strong><input value={value.displayValue ?? value.value ?? ""} placeholder={value.status === "found" ? "Review value" : value.status} onChange={(event) => updateOcrField(key, event.target.value)} /><small data-field-confidence>{value.status === "found" ? `${Math.round(Number(value.confidence || 0) * 100)}% confidence` : value.status === "ambiguous" ? "Needs verification" : value.status}</small></label>)}</div>{complianceError && <div className="status-message">Rules Engine: {complianceError.message || complianceError}</div>}{compliance?.summary && <div className="ocr-summary">Rules: {compliance.summary.totalRulesEvaluated} · Passed: {compliance.summary.passed} · Violations: {compliance.summary.violations} · Unable to verify: {compliance.summary.unableToVerify}</div>}{violations.length > 0 && <div className="rule-review-panel"><div className="section-heading"><div><h3>Engine violations</h3><p>Every detected violation is shown as a dropdown. The header gives the engine code/category; open it to see the rule statement and exactly what failed.</p></div></div>{violations.map((finding) => { const details = ruleDetails(finding); return <details className="rule-review-dropdown" key={finding.findingId}><summary><input type="checkbox" checked={acceptedFindingIds.includes(finding.findingId)} onChange={() => toggle(finding.findingId)} onClick={(event) => event.stopPropagation()} /><span><strong>{details.code}</strong><small>Rule {details.number} · {details.title} · {finding.severity || "REVIEW"}</small></span></summary><div className="rule-review-dropdown-body"><p><strong>Rule statement</strong>{details.statement}</p><p><strong>Detected issue</strong>{details.issue}</p><p><strong>Engine category</strong>{details.code} · {details.number}</p></div></details>; })}<div className="ocr-summary">Selected engine violations: <strong>{accepted.length}</strong> of {violations.length}</div></div>}
      {compliance && <div className="rule-review-panel unresolved-review-panel"><div className="section-heading"><div><h3>Officer review: Unable to Verify</h3><p>Each unresolved engine finding must be explicitly resolved by the officer before submission.</p></div><div className="ocr-summary"><strong>{unresolvedRemaining.length}</strong> remaining</div></div>{unresolvedFindings.length ? unresolvedFindings.map((finding) => { const details = ruleDetails(finding); const review = findingResolutions[finding.findingId] || {}; return <div className="rule-review-dropdown unresolved-finding" key={finding.findingId}><div className="rule-review-dropdown-body"><div className="section-heading"><div><strong>{details.code}</strong><small>Rule {details.number} · {details.title}</small></div><strong>{review.decision ? review.decision.replace(/_/g, " ") : "UNRESOLVED"}</strong></div><p><strong>Rule statement</strong>{details.statement}</p><p><strong>Engine finding</strong>{details.issue}</p><label><strong>Officer resolution</strong><select value={review.decision || ""} onChange={(event) => resolveFinding(finding.findingId, event.target.value, review.note || "")}><option value="">Select resolution</option><option value="VERIFIED_PRESENT">Verified present</option><option value="VIOLATION_CONFIRMED">Violation confirmed</option><option value="NOT_APPLICABLE">Not applicable</option></select></label><label><strong>Officer note</strong><textarea value={review.note || ""} onChange={(event) => updateFindingReviewNote(finding.findingId, event.target.value)} placeholder="Record what you observed on the package." /></label></div></div>; }) : <div className="ocr-summary">No Unable to Verify findings were returned.</div>}<div className="ocr-summary">Resolved: <strong>{unresolvedFindings.length - unresolvedRemaining.length}</strong> / {unresolvedFindings.length}</div></div>}
      <div className="rule-review-panel manual-violation-panel"><div className="section-heading"><div><h3>Add a violation</h3><p>Select the Rules Engine category, then describe the observed issue. The selected rule number, statement and your reason are stored together.</p></div></div><label><strong>Rules Engine category</strong><select value={manualRuleNumber} onChange={(event) => setManualRuleNumber(event.target.value)}><option value="">Select rule / category</option>{RULE_OPTIONS.map((rule) => <option value={rule.ruleNumber} key={rule.ruleNumber}>Rule {rule.ruleNumber} · {rule.title}</option>)}</select></label>{manualRuleNumber && <div className="rule-reference-preview"><strong>Rule {manualRuleNumber} statement</strong><span>{RULE_OPTIONS.find((rule) => rule.ruleNumber === manualRuleNumber)?.statement}</span></div>}<textarea value={manualViolationReason} onChange={(event) => setManualViolationReason(event.target.value)} placeholder="Describe the observed violation, what was missing/incorrect, and any relevant evidence." /><button type="button" className="secondary-button" onClick={addManualViolation}>Add violation</button>{manualViolations.map((finding) => <details className="rule-review-dropdown" key={finding.findingId}><summary><span><strong>{finding.ruleCode}</strong><small>Rule {finding.ruleNumber} · {finding.ruleTitle} · Inspector override</small></span></summary><div className="rule-review-dropdown-body"><p><strong>Rule statement</strong>{finding.ruleStatement}</p><p><strong>Inspector finding</strong>{finding.message}</p><button type="button" className="secondary-button" onClick={() => removeManualViolation(finding.findingId)}>Remove</button></div></details>)}<div className="ocr-summary">Manual violations: <strong>{manualViolations.length}</strong></div></div><label>Raw OCR<textarea value={ocr.rawText || ""} onChange={(event) => setOcr((current) => ({ ...current, rawText: event.target.value }))} /></label><div className="extracted-action-panel"><div><strong>Registration actions</strong><span>Use the reviewed OCR details to prefill the final editable registration form, or register manually.</span></div><div className="scan-upload-actions"><button type="button" className="primary-button" onClick={applyExtractedData}>Use extracted details</button><button type="button" className="secondary-button" onClick={openManualRegistration}>Register manually</button></div></div></section>}
    {!showRegistration && !ocr && <section className="scan-review registration-form"><div className="section-heading"><div><h2>Register product</h2><p>Manual registration retains the package images but skips OCR.</p></div></div><button type="button" className="primary-button" onClick={openManualRegistration}>Register Manually</button></section>}
    {showRegistration && <form className="scan-review registration-form" onSubmit={save}><div className="section-heading"><div><h2>Register offline product</h2><p>{useExtractedData ? "Extracted details have been applied. Edit any value below before registering." : "Manual registration. Enter the final product details below."}</p></div></div>{ocr && <div className="extracted-action-panel compact"><div><strong>Extracted details</strong><span>{useExtractedData ? "Applied to this form. All fields remain editable." : "Not applied yet."}</span></div><button type="button" className="secondary-button" onClick={applyExtractedData}>Use extracted details</button></div>}<div className="registration-grid"><label>Product name<input value={form.productName} onChange={(event) => update("productName", event.target.value)} required /></label><label>Brand name<input value={form.brandName} onChange={(event) => update("brandName", event.target.value)} /></label><label>Net quantity<input value={form.netQuantity} onChange={(event) => update("netQuantity", event.target.value)} /></label><label>Unit<input value={form.unit} onChange={(event) => update("unit", event.target.value)} /></label><label>MRP<input type="number" min="0" step="0.01" value={form.mrp} onChange={(event) => update("mrp", event.target.value)} /></label><label>Barcode<input value={form.barcode} readOnly={Boolean(scannerGtin)} onChange={(event) => update("barcode", event.target.value.replace(/\D/g, "").slice(0, 18))} placeholder={scannerGtin ? "Authoritative scanner GTIN" : "Optional"} /></label><label>Offline final category<select value={selectedCategoryId} onChange={(event) => setSelectedCategoryId(event.target.value)} required><option value="">Select an offline final category</option>{finalCategories.map((category) => <option value={category.id} key={category.id}>{category.path.map((item) => item.name).join(" → ")}</option>)}</select></label><label>Shop name<input value={form.shopName} onChange={(event) => update("shopName", event.target.value)} required /></label><label>Shop address<input value={form.shopAddress} onChange={(event) => update("shopAddress", event.target.value)} /></label><label>City<input value={form.shopCity} onChange={(event) => update("shopCity", event.target.value)} /></label><label>State<input value={form.shopState} onChange={(event) => update("shopState", event.target.value)} /></label><label className="span-2">Description<textarea value={form.description} onChange={(event) => update("description", event.target.value)} /></label><label className="span-2">Inspector notes<textarea value={form.notes} onChange={(event) => update("notes", event.target.value)} /></label></div><div className="ocr-status-grid"><div><strong>Final status</strong><span>{selectedViolations.length ? "VIOLATION" : unresolvedRemaining.length || ocr?.needsReview ? "NEEDS_REVIEW" : "OKAY"}</span></div><div><strong>Selected violations</strong><span>{selectedViolations.length}</span></div><div><strong>Images retained</strong><span>{images.length}</span></div></div><div className="scan-upload-actions"><button type="submit" className="primary-button" disabled={saving}>{saving ? "Saving..." : "Register Offline Product"}</button><button type="button" className="secondary-button" onClick={() => setShowRegistration(false)}>Back</button></div></form>}
    {message && <div className="status-message">{message}</div>}
  </div>;
}
