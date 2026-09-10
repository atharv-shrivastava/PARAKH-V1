import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const scanPath = path.resolve(here, "../src/pages/ScanV2.jsx");
let source = await fs.readFile(scanPath, "utf8");

const MARKER = "/* PARAKH_SCAN_V2_INTEGRATION */";
const BARCODE_MARKER = "data-parallel-barcode-ui";
const CONFIDENCE_MARKER = "data-field-confidence";

if (!source.includes("/api/ocr/analyze")) {
  throw new Error("ScanV2.jsx is missing the backend OCR request.");
}

function insertOnce(anchor, insertion, label) {
  if (source.includes(insertion.trim())) return true;
  const index = source.indexOf(anchor);
  if (index < 0) {
    console.warn(`PARAKH optional anchor missing: ${label}`);
    return false;
  }
  source = source.slice(0, index) + insertion + source.slice(index);
  return true;
}

if (!source.includes("scanBarcodeImage")) {
  source = source.replace(
    'import { apiFetch } from "../lib/auth";',
    'import { apiFetch } from "../lib/auth";\nimport { scanBarcodeImage, lookupDataKart, compareWithDataKart, calculateVerificationConfidence } from "../lib/verification";'
  );
}
if (!source.includes("const BARCODE_TIMEOUT_MS")) {
  source = source.replace(
    "const MAX_IMAGES = 4;",
    "const MAX_IMAGES = 4;\nconst BARCODE_MAX_SIZE = 8 * 1024 * 1024;\nconst BARCODE_TIMEOUT_MS = 4000;"
  );
}

// Normalize generated verification state before doing any other edits. Older copies of this
// preparation script could append the same block more than once, leaving ScanV2 unparseable.
const stateLines = [
  'const [barcodeFile, setBarcodeFile] = useState(null);',
  'const [barcodePreviewUrl, setBarcodePreviewUrl] = useState("");',
  'const [manualGtin, setManualGtin] = useState("");',
  'const [barcodeResult, setBarcodeResult] = useState(null);',
  'const [datakartVerification, setDatakartVerification] = useState(null);',
  'const [verificationConfidence, setVerificationConfidence] = useState(null);',
];
const stateBlock = `\n  ${stateLines.join("\n  ")}\n`;
for (const line of stateLines) {
  source = source.replace(new RegExp(`(?:^|\\n)\\s*${line.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\s*(?=\\n|$)`, "gm"), "");
}
const messageToken = 'const [message, setMessage] = useState("");';
const messageIndex = source.indexOf(messageToken);
if (messageIndex >= 0) {
  const insertAt = messageIndex + messageToken.length;
  source = source.slice(0, insertAt) + stateBlock + source.slice(insertAt);
} else {
  throw new Error("Could not locate ScanV2 React state block.");
}

if (!source.includes("async function resolveGtin(")) {
  const helperAnchor = "function formatElapsed(ms) {";
  const idx = source.indexOf(helperAnchor);
  if (idx < 0) throw new Error("Could not locate formatElapsed() in ScanV2.jsx.");
  const helper = `async function resolveGtin(barcodeFile, manualValue) {
  const manual = String(manualValue || "").replace(/\\s+/g, "").trim();
  if (!barcodeFile) return { attempted: Boolean(manual), found: Boolean(manual), value: manual || null, gtin: manual || null, format: manual ? "MANUAL_GTIN" : null, confidence: manual ? 0.90 : 0, source: manual ? "MANUAL_GTIN" : "NONE", error: null };
  const timeout = new Promise((resolve) => window.setTimeout(() => resolve({ attempted: true, found: false, value: null, gtin: manual || null, format: null, confidence: 0, source: manual ? "MANUAL_GTIN_FALLBACK" : "BARCODE_TIMEOUT", error: "Barcode decoding timed out." }), BARCODE_TIMEOUT_MS));
  const decode = scanBarcodeImage(barcodeFile).then((decoded) => ({ ...decoded, gtin: decoded.found ? decoded.value : manual || null, source: decoded.found ? "BARCODE_SCAN" : manual ? "MANUAL_GTIN_FALLBACK" : "NONE" }));
  return Promise.race([decode, timeout]);
}

`;
  source = source.slice(0, idx) + helper + source.slice(idx);
}

if (!source.includes("function addBarcodeFile(input)")) {
  const anchor = /\n  async function openCamera\(/;
  const handler = `
  function addBarcodeFile(input) {
    const file = input?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) return setMessage("Barcode upload must be an image.");
    if (file.size > BARCODE_MAX_SIZE) return setMessage("Barcode image is too large. Use an image smaller than 8 MB.");
    if (barcodePreviewUrl) URL.revokeObjectURL(barcodePreviewUrl);
    setBarcodeFile(file);
    setBarcodePreviewUrl(URL.createObjectURL(file));
    setBarcodeResult(null);
    setDatakartVerification(null);
    setVerificationConfidence(null);
    setMessage("Barcode image ready. It will be decoded with the barcode scanner when Analyze Images is clicked.");
  }
`;
  if (!anchor.test(source)) throw new Error("Could not locate openCamera() safely.");
  source = source.replace(anchor, handler + "\n  async function openCamera(");
}

if (!source.includes(BARCODE_MARKER)) {
  const ui = `<div data-parallel-barcode-ui="true" className="barcode-upload-section">
        <div className="scan-upload-actions">
          <label className="secondary-button scan-file-button">Upload Barcode<input type="file" accept="image/*" onChange={(event) => { addBarcodeFile(event.target.files); event.target.value = ""; }} hidden /></label>
          <input aria-label="Enter GTIN manually" placeholder="Enter GTIN manually" inputMode="numeric" value={manualGtin} onChange={(event) => { setManualGtin(event.target.value.replace(/\\D/g, "").slice(0, 18)); setBarcodeResult(null); }} />
        </div>
        {barcodePreviewUrl && <div className="barcode-preview-card">
          <div className="barcode-preview-heading"><strong>Uploaded barcode</strong><span>{barcodeFile?.name}</span></div>
          <img className="barcode-preview-image" src={barcodePreviewUrl} alt="Uploaded barcode for scanning" />
          <div className="barcode-preview-meta">{barcodeResult?.found ? "Decoded GTIN: " + barcodeResult.gtin : "Will be decoded when Analyze Images is clicked."}</div>
          <button type="button" className="secondary-button" onClick={removeBarcodeFile}>Remove</button>
        </div>}
        {!barcodePreviewUrl && manualGtin && <div className="status-message">Manual GTIN entered: {manualGtin}</div>}
      </div>`;
  const counterRe = /<p[^>]*className=["']scan-limit["'][^>]*>[^<]*\{images\.length\}[^<]*<\/p>/;
  if (counterRe.test(source)) source = source.replace(counterRe, (m) => m + "\n      " + ui);
  else {
    const headingRe = /<h2>Capture or upload package images<\/h2>/;
    if (!headingRe.test(source)) throw new Error("Could not locate package upload area.");
    source = source.replace(headingRe, (m) => m + "\n      " + ui);
  }
}

if (!source.includes("const [ocrOutcome, barcodeOutcome] = await Promise.allSettled")) {
  const start = source.indexOf("  async function analyze() {");
  if (start >= 0) {
    const bodyStart = source.indexOf("{", start);
    let depth = 0;
    let end = -1;
    let inString = false;
    let quote = "";
    let escaped = false;
    for (let i = bodyStart; i < source.length; i += 1) {
      const ch = source[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === quote) inString = false;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") { inString = true; quote = ch; continue; }
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) { end = i + 1; break; }
      }
    }
    if (end > 0) {
      const analyze = `  async function analyze() {
    if (!images.length) return setMessage("Add at least one package image first.");
    setAnalyzing(true);
    setAnalysisDurationMs(null);
    setMessage(barcodeFile || manualGtin.trim() ? "Running barcode scanner, RapidOCR and Gemini in parallel..." : "Running RapidOCR + AI semantic verification...");
    const controller = new AbortController();
    controllerRef.current?.abort();
    controllerRef.current = controller;
    try {
      const categoryOptions = finalCategories.map((category) => ({ id: category.id, name: category.name, path: category.path.map((item) => item.name).join(" → ") }));
      const [ocrOutcome, barcodeOutcome] = await Promise.allSettled([
        runOcr(images.map((item) => item.file), controller.signal, categoryOptions),
        resolveGtin(barcodeFile, manualGtin),
      ]);
      if (ocrOutcome.status !== "fulfilled") throw ocrOutcome.reason;
      const info = ocrOutcome.value;
      const identifier = barcodeOutcome.status === "fulfilled" ? barcodeOutcome.value : { attempted: Boolean(barcodeFile || manualGtin.trim()), found: false, value: null, gtin: manualGtin.trim() || null, confidence: 0, source: "NONE", error: barcodeOutcome.reason?.message || "Barcode verification failed." };
      const extracted = info.result;
      const gtin = identifier.gtin || manualGtin.trim();
      window.sessionStorage.setItem("parakhDeclarationEvidence", JSON.stringify(extracted.declarationEvidence || []));
      window.dispatchEvent(new CustomEvent("parakh:declaration-evidence", { detail: extracted.declarationEvidence || [] }));
      setOcr(extracted);
      setForm(formFromOcr(extracted));
      setUseExtractedData(true);
      setShowRegistration(true);
      setAiSuggestedCategory(info.aiSuggestedCategory || null);
      setBarcodeResult(identifier);
      setProviderInfo({ ...info, barcodeResult: identifier });
      setMessage("OCR + Gemini completed. Rules Engine and DataKart verification are running in parallel...");

      const visualInspection = readVisualInspection();
      const rulesPromise = apiFetch(OCR_URL + "/api/ocr/evaluate-structured", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ocr: extracted, visualFlags: visualInspection || {}, inspectionId: crypto.randomUUID(), productId: crypto.randomUUID(), inspectionDate: new Date().toISOString().slice(0, 10), context: "physical_package", commodityCategory: "packaged commodity", consumerType: "general", isImported: false, packageType: "retail", datakartVerification: null }), signal: controller.signal });
      const dataKartPromise = gtin ? lookupDataKart(gtin, controller.signal).then((dk) => dk ? { ...dk, comparison: compareWithDataKart(extracted, dk) } : null) : Promise.resolve(null);
      const [rulesOutcome, dataKartOutcome] = await Promise.allSettled([rulesPromise, dataKartPromise]);

      if (rulesOutcome.status === "fulfilled") {
        const response = rulesOutcome.value;
        const data = await response.json().catch(() => ({}));
        if (!response.ok) { setCompliance(null); setComplianceError({ message: data.error || "Rules Engine evaluation failed" }); }
        else { setCompliance(data.compliance || null); setComplianceError(data.complianceError || null); setAcceptedFindingIds((data.compliance?.findings || []).filter((finding) => finding.status === "VIOLATION").map((finding) => finding.findingId)); }
      } else if (rulesOutcome.reason?.name !== "AbortError") {
        setCompliance(null);
        setComplianceError({ message: rulesOutcome.reason?.message || "Rules Engine evaluation failed" });
      }

      const dk = dataKartOutcome.status === "fulfilled" ? dataKartOutcome.value : null;
      const dkComparison = dk?.comparison || { matchedFields: 0, comparedFields: 0, matchRate: null, comparisons: {} };
      const confidenceResult = calculateVerificationConfidence({ ocrResult: extracted, providerInfo: info, barcodeResult: identifier, dataKartComparison: dkComparison });
      setDatakartVerification(dk);
      setVerificationConfidence(confidenceResult);
      setProviderInfo({ ...info, barcodeResult: identifier, datakartVerification: dk ? { ...dk, comparison: dkComparison } : null, verificationConfidence: confidenceResult });
      if (Number.isFinite(info.timing?.totalMs)) setAnalysisDurationMs(Number(info.timing.totalMs));
      setMessage("Analysis complete. Review the extracted fields and verification results.");
    } catch (error) {
      if (error?.name === "AbortError") return;
      setMessage(error.message || "OCR analysis failed.");
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
      setAnalysisDurationMs((current) => current ?? analysisElapsedMs);
      setAnalyzing(false);
    }
  }`;
      source = source.slice(0, start) + analyze + source.slice(end);
    } else {
      console.warn("PARAKH: could not safely replace analyze(); leaving existing analyze function unchanged.");
    }
  } else {
    console.warn("PARAKH: analyze() not found; leaving existing analyze function unchanged.");
  }
}

if (!source.includes(CONFIDENCE_MARKER)) {
  const confidenceRegex = /<small>\{value\.status === "found" \? `\$\{Math\.round\(Number\(value\.confidence \|\| 0\) \* 100\)\}% confidence` : value\.status\}<\/small>/;
  if (confidenceRegex.test(source)) {
    source = source.replace(confidenceRegex, '<small data-field-confidence>{value.status === "found" ? `${Math.round(Number(value.confidence || 0) * 100)}% confidence` : value.status === "ambiguous" ? "Needs verification" : value.status}</small>');
  } else {
    console.warn("PARAKH: OCR field confidence renderer anchor not found; existing field confidence display left unchanged.");
  }
}

source = source.replace(/\n$/, "");
if (!source.includes(MARKER)) source += `\n\n${MARKER}\n`;
await fs.writeFile(scanPath, source, "utf8");
console.log("PARAKH Scan V2 integration ready: barcode + OCR/Gemini parallel, Rules Engine + DataKart parallel, extracted fields prefilled, per-field confidence shown.");
