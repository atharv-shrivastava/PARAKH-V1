import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const scanPath = path.resolve(here, "../src/pages/ScanV2.jsx");
let source = await fs.readFile(scanPath, "utf8");

if (!source.includes("/api/ocr/analyze")) throw new Error("ScanV2.jsx is missing the local backend OCR request.");

const importLine = 'import { scanBarcodeImage, lookupDataKart, compareWithDataKart, calculateVerificationConfidence } from "../lib/verification";';
const stateBlock = `  const [barcodeFile, setBarcodeFile] = useState(null);\n  const [barcodePreviewUrl, setBarcodePreviewUrl] = useState("");\n  const [manualGtin, setManualGtin] = useState("");\n  const [barcodeResult, setBarcodeResult] = useState(null);\n  const [datakartVerification, setDatakartVerification] = useState(null);\n  const [verificationConfidence, setVerificationConfidence] = useState(null);`;

if (!source.includes(importLine)) {
  source = source.replace('import { apiFetch } from "../lib/auth";', 'import { apiFetch } from "../lib/auth";\n' + importLine);
}

if (!source.includes("const BARCODE_TIMEOUT_MS")) {
  source = source.replace("const MAX_IMAGES = 4;", "const MAX_IMAGES = 4;\nconst BARCODE_MAX_SIZE = 8 * 1024 * 1024;\nconst BARCODE_TIMEOUT_MS = 4000;");
}

if (!source.includes("const [barcodeFile, setBarcodeFile]")) {
  const stateAnchor = /  const \[message, setMessage\] = useState\(\"\"\);/;
  if (!stateAnchor.test(source)) throw new Error("Could not locate ScanV2 React state block.");
  source = source.replace(stateAnchor, (m) => m + "\n" + stateBlock);
}

if (!source.includes("async function resolveGtin(")) {
  const helperAnchor = "function formatElapsed(ms) {";
  if (!source.includes(helperAnchor)) throw new Error("Could not locate formatElapsed in ScanV2.jsx.");
  const helper = `async function resolveGtin(barcodeFileValue, manualGtinValue) {\n  const manual = String(manualGtinValue || "").replace(/\\s+/g, "").trim();\n  if (!barcodeFileValue) return { attempted: Boolean(manual), found: Boolean(manual), value: manual || null, gtin: manual || null, format: manual ? "MANUAL_GTIN" : null, confidence: manual ? 0.90 : 0, source: manual ? "MANUAL_GTIN" : "NONE", error: null };\n  const timeout = new Promise((resolve) => window.setTimeout(() => resolve({ attempted: true, found: false, value: null, gtin: manual || null, format: null, confidence: 0, source: manual ? "MANUAL_GTIN_FALLBACK" : "BARCODE_TIMEOUT", error: "Barcode decoding timed out." }), BARCODE_TIMEOUT_MS));\n  const decode = scanBarcodeImage(barcodeFileValue).then((decoded) => ({ ...decoded, gtin: decoded.found ? decoded.value : manual || null, source: decoded.found ? "BARCODE_SCAN" : manual ? "MANUAL_GTIN_FALLBACK" : "NONE" }));\n  return Promise.race([decode, timeout]);\n}\n\n`;
  source = source.replace(helperAnchor, helper + helperAnchor);
}

if (!source.includes("function addBarcodeFile(input)")) {
  const insertion = `  function addBarcodeFile(input) {\n    const file = input?.[0];\n    if (!file) return;\n    if (!file.type.startsWith("image/")) return setMessage("Barcode upload must be an image.");\n    if (file.size > BARCODE_MAX_SIZE) return setMessage("Barcode image is too large. Use an image smaller than 8 MB.");\n    setBarcodeFile(file);\n    setBarcodePreviewUrl(URL.createObjectURL(file));\n    setBarcodeResult(null);\n    setDatakartVerification(null);\n    setVerificationConfidence(null);\n    setMessage("Barcode image ready. It will be decoded in parallel with package OCR when Analyze Images is clicked.");\n  }\n\n`;
  const anchor = /  async function openCamera\(\)/;
  if (!anchor.test(source)) throw new Error("Could not locate openCamera in ScanV2.jsx.");
  source = source.replace(anchor, insertion + "  async function openCamera(");
}

if (!source.includes("data-parallel-barcode-ui")) {
  const uploadAnchor = '<p className="scan-limit">{images.length}/{MAX_IMAGES} images selected</p>';
  const ui = `<div data-parallel-barcode-ui="true" className="barcode-upload-section">\n        <div className="scan-upload-actions">\n          <label className="secondary-button scan-file-button">Upload Barcode<input type="file" accept="image/*" onChange={(event) => { addBarcodeFile(event.target.files); event.target.value = ""; }} hidden /></label>\n          <input aria-label="Enter GTIN manually" placeholder="Enter GTIN manually" inputMode="numeric" value={manualGtin} onChange={(event) => { setManualGtin(event.target.value.replace(/\\D/g, "").slice(0, 18)); setBarcodeResult(null); }} />\n        </div>\n        {barcodePreviewUrl && <div className="barcode-preview-card">\n          <div className="barcode-preview-heading"><strong>Uploaded barcode</strong><span>{barcodeFile?.name}</span></div>\n          <img className="barcode-preview-image" src={barcodePreviewUrl} alt="Uploaded barcode for scanning" />\n          <div className="barcode-preview-meta">{barcodeResult?.found ? "Decoded GTIN: " + barcodeResult.gtin : "Will be decoded when Analyze Images is clicked."}</div>\n        </div>}\n        {!barcodePreviewUrl && manualGtin && <div className="status-message">Manual GTIN entered: {manualGtin}</div>}\n      </div>`;
  const uploadAnchorRegex = /<p className="scan-limit">\{images\.length\/\{MAX_IMAGES\} images selected\}<\/p>/;
  if (uploadAnchorRegex.test(source)) source = source.replace(uploadAnchorRegex, (m) => m + "\n      " + ui);
  else throw new Error("Could not locate scan upload area.");
}

if (!source.includes("const [ocrOutcome, barcodeOutcome] = await Promise.allSettled")) {
  const analyzeRegex = /  async function analyze\(\)\s*\{[\s\S]*?\n  \}\s*\n\s*function updateOcrField/;
  if (analyzeRegex.test(source)) {
    const analyze = `  async function analyze() {\n    if (!images.length) return setMessage("Add at least one package image first.");\n    setAnalyzing(true);\n    setAnalysisDurationMs(null);\n    setMessage(barcodeFile || manualGtin.trim() ? "Running barcode, RapidOCR and Gemini in parallel..." : "Running RapidOCR + AI semantic verification...");\n    const controller = new AbortController();\n    controllerRef.current?.abort();\n    controllerRef.current = controller;\n    try {\n      const categoryOptions = finalCategories.map((category) => ({ id: category.id, name: category.name, path: category.path.map((item) => item.name).join(" → ") }));\n      const [ocrOutcome, barcodeOutcome] = await Promise.allSettled([runOcr(images.map((item) => item.file), controller.signal, categoryOptions), resolveGtin(barcodeFile, manualGtin)]);\n      if (ocrOutcome.status === "rejected") throw ocrOutcome.reason;\n      const info = ocrOutcome.value;\n      const identifier = barcodeOutcome.status === "fulfilled" ? barcodeOutcome.value : { attempted: Boolean(barcodeFile || manualGtin.trim()), found: false, value: null, gtin: manualGtin.trim() || null, confidence: 0, source: "NONE", error: barcodeOutcome.reason?.message || "Barcode verification failed." };\n      const extracted = info.result;\n      const gtin = identifier.gtin || manualGtin.trim();\n      window.sessionStorage.setItem("parakhDeclarationEvidence", JSON.stringify(extracted.declarationEvidence || []));\n      window.dispatchEvent(new CustomEvent("parakh:declaration-evidence", { detail: extracted.declarationEvidence || [] }));\n      setOcr(extracted);\n      setForm(formFromOcr(extracted));\n      setUseExtractedData(true);\n      setShowRegistration(true);\n      setAiSuggestedCategory(info.aiSuggestedCategory || null);\n      setBarcodeResult(identifier);\n      setProviderInfo({ ...info, barcodeResult: identifier });\n      setMessage("OCR + Gemini completed. Rules Engine and DataKart verification are running in parallel...");\n      const visualInspection = readVisualInspection();\n      const rulesPromise = apiFetch(OCR_URL + "/api/ocr/evaluate-structured", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ocr: extracted, visualFlags: visualInspection || {}, inspectionId: crypto.randomUUID(), productId: crypto.randomUUID(), inspectionDate: new Date().toISOString().slice(0, 10), context: "physical_package", commodityCategory: "packaged commodity", consumerType: "general", isImported: false, packageType: "retail", datakartVerification: null }), signal: controller.signal });\n      const dataKartPromise = gtin ? lookupDataKart(gtin, controller.signal).then((dk) => dk ? { ...dk, comparison: compareWithDataKart(extracted, dk) } : null) : Promise.resolve(null);\n      const [rulesOutcome, dataKartOutcome] = await Promise.allSettled([rulesPromise, dataKartPromise]);\n      if (rulesOutcome.status === "fulfilled") { const response = rulesOutcome.value; const data = await response.json().catch(() => ({})); if (!response.ok) { setCompliance(null); setComplianceError({ message: data.error || "Rules Engine evaluation failed" }); } else { setCompliance(data.compliance || null); setComplianceError(data.complianceError || null); setAcceptedFindingIds((data.compliance?.findings || []).filter((finding) => finding.status === "VIOLATION").map((finding) => finding.findingId)); } } else if (rulesOutcome.reason?.name !== "AbortError") { setCompliance(null); setComplianceError({ message: rulesOutcome.reason?.message || "Rules Engine evaluation failed" }); }\n      const dk = dataKartOutcome.status === "fulfilled" ? dataKartOutcome.value : null;\n      const dkComparison = dk?.comparison || { matchedFields: 0, comparedFields: 0, matchRate: null, comparisons: {} };\n      const confidenceResult = calculateVerificationConfidence({ ocrResult: extracted, providerInfo: info, barcodeResult: identifier, dataKartComparison: dkComparison });\n      setDatakartVerification(dk);\n      setVerificationConfidence(confidenceResult);\n      setProviderInfo({ ...info, barcodeResult: identifier, datakartVerification: dk ? { ...dk, comparison: dkComparison } : null, verificationConfidence: confidenceResult });\n      if (Number.isFinite(info.timing?.totalMs)) setAnalysisDurationMs(Number(info.timing.totalMs));\n      setMessage("Analysis complete. Review the extracted fields and verification results.");\n    } catch (error) { if (error?.name === "AbortError") return; setMessage(error.message || "OCR analysis failed."); } finally { if (controllerRef.current === controller) controllerRef.current = null; setAnalysisDurationMs((current) => current ?? analysisElapsedMs); setAnalyzing(false); }\n  }\n\n  function updateOcrField`;
    source = source.replace(analyzeRegex, analyze);
  }
}

await fs.writeFile(scanPath, source, "utf8");
console.log("PARAKH stable scan integration: barcode UI + preview; barcode/OCR parallel; Rules Engine/DataKart parallel.");
