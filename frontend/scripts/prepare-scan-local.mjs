import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const scanPath = path.resolve(here, "../src/pages/ScanV2.jsx");
let source = await fs.readFile(scanPath, "utf8");

const forbidden = [
  "runGemini(",
  "runPuter(",
  "runPaddle(",
  "PADDLE_OCR_URL",
  "window.puter",
  "Cloud Vision",
  "Gemini/OpenAI fallback",
  "Puter.js",
];

const stale = forbidden.filter((token) => source.includes(token));
if (stale.length) throw new Error(`ScanV2.jsx still contains legacy browser OCR tokens: ${stale.join(", ")}`);
if (!source.includes("/api/ocr/analyze")) throw new Error("ScanV2.jsx is missing the local backend OCR request.");

const marker = "/* PARAKH_BARCODE_DATAKART_VERIFY_V1 */";
const previewMarker = "/* PARAKH_BARCODE_PREVIEW_V1 */";

function addOnce(needle, replacement, label) {
  if (source.includes(needle)) source = source.replace(needle, replacement);
  else if (label) console.warn(`PARAKH patch anchor missing: ${label}`);
}

if (!source.includes(marker)) {
  addOnce(
    'import { apiFetch } from "../lib/auth";',
    'import { apiFetch } from "../lib/auth";\nimport { scanBarcodeImage, lookupDataKart, compareWithDataKart, calculateVerificationConfidence } from "../lib/verification";',
    "verification import",
  );
  addOnce(
    'const MAX_IMAGES = 4;',
    `${marker}\nconst MAX_IMAGES = 4;\nconst BARCODE_MAX_SIZE = 8 * 1024 * 1024;\nconst BARCODE_TIMEOUT_MS = 4000;`,
    "MAX_IMAGES",
  );

  addOnce(
    '  const [message, setMessage] = useState("");',
    '  const [message, setMessage] = useState("");\n  const [barcodeFile, setBarcodeFile] = useState(null);\n  const [barcodePreviewUrl, setBarcodePreviewUrl] = useState("");\n  const [manualGtin, setManualGtin] = useState("");\n  const [barcodeResult, setBarcodeResult] = useState(null);\n  const [datakartVerification, setDatakartVerification] = useState(null);\n  const [verificationConfidence, setVerificationConfidence] = useState(null);',
    "barcode state",
  );

  addOnce(
    '  useEffect(() => {\n    if (!analyzing) return undefined;',
    '  useEffect(() => {\n    if (!barcodeFile) {\n      setBarcodePreviewUrl("");\n      return undefined;\n    }\n    const url = URL.createObjectURL(barcodeFile);\n    setBarcodePreviewUrl(url);\n    return () => URL.revokeObjectURL(url);\n  }, [barcodeFile]);\n\n  useEffect(() => {\n    if (!analyzing) return undefined;',
    "barcode preview effect",
  );

  addOnce(
    '  function resetAnalysisState() {\n    setOcr(null);\n    setCompliance(null);\n    setComplianceError(null);\n    setAcceptedFindingIds([]);\n    setManualViolations([]);\n    setManualViolationReason("");\n    setManualRuleNumber("");\n    setProviderInfo(null);\n    setAiSuggestedCategory(null);',
    '  function resetAnalysisState() {\n    setOcr(null);\n    setCompliance(null);\n    setComplianceError(null);\n    setAcceptedFindingIds([]);\n    setManualViolations([]);\n    setManualViolationReason("");\n    setManualRuleNumber("");\n    setProviderInfo(null);\n    setAiSuggestedCategory(null);\n    setBarcodeResult(null);\n    setDatakartVerification(null);\n    setVerificationConfidence(null);',
    "reset analysis state",
  );

  const helperAnchor = 'function formatElapsed(ms) {';
  const helperCode = `async function resolveGtin(barcodeFileValue, manualGtinValue, signal) {\n  const manual = String(manualGtinValue || "").replace(/\\s+/g, "").trim();\n  if (barcodeFileValue) {\n    const timeout = new Promise((resolve) => {\n      window.setTimeout(() => resolve({\n        attempted: true,\n        found: false,\n        value: null,\n        gtin: manual || null,\n        format: null,\n        confidence: 0,\n        source: manual ? "MANUAL_GTIN_FALLBACK" : "BARCODE_TIMEOUT",\n        error: "Barcode decoding timed out."\n      }), BARCODE_TIMEOUT_MS);\n    });\n    const decode = scanBarcodeImage(barcodeFileValue).then((decoded) => {\n      const gtin = decoded.found ? decoded.value : manual;\n      return { ...decoded, gtin: gtin || null, source: decoded.found ? "BARCODE_SCAN" : manual ? "MANUAL_GTIN_FALLBACK" : "NONE" };\n    });\n    return await Promise.race([decode, timeout]);\n  }\n  return { attempted: Boolean(manual), found: Boolean(manual), value: manual || null, gtin: manual || null, format: manual ? "MANUAL_GTIN" : null, confidence: manual ? 0.90 : 0, source: manual ? "MANUAL_GTIN" : "NONE", error: null };\n}\n\n`;
  if (!source.includes(helperAnchor)) throw new Error("ScanV2 patch anchor not found: formatElapsed");
  source = source.replace(helperAnchor, helperCode + helperAnchor);

  addOnce(
    '  function update(key, value) {\n    setForm((current) => ({ ...current, [key]: value }));\n  }',
    '  function update(key, value) {\n    setForm((current) => ({ ...current, [key]: value }));\n  }\n\n  function addBarcodeFile(input) {\n    const file = input?.[0];\n    if (!file) return;\n    if (!file.type.startsWith("image/")) return setMessage("Barcode upload must be an image.");\n    if (file.size > BARCODE_MAX_SIZE) return setMessage("Barcode image is too large. Use an image smaller than 8 MB.");\n    setBarcodeFile(file);\n    setBarcodeResult(null);\n    setDatakartVerification(null);\n    setVerificationConfidence(null);\n    setMessage("Barcode image ready. It will be decoded in parallel with package OCR when Analyze Images is clicked.");\n  }',
    "barcode handler",
  );

  addOnce(
    '    setAnalyzing(true);\n    setAnalysisDurationMs(null);\n    setMessage("Running RapidOCR + AI semantic verification...");',
    '    setAnalyzing(true);\n    setAnalysisDurationMs(null);\n    setMessage(barcodeFile || manualGtin.trim() ? "Running barcode/GTIN verification and RapidOCR + Gemini in parallel..." : "Running RapidOCR + AI semantic verification...");',
    "analysis message",
  );

  addOnce(
    '      const info = await runOcr(images.map((item) => item.file), controller.signal, categoryOptions);\n      const extracted = info.result;',
    '      const [ocrOutcome, barcodeOutcome] = await Promise.allSettled([\n        runOcr(images.map((item) => item.file), controller.signal, categoryOptions),\n        resolveGtin(barcodeFile, manualGtin, controller.signal),\n      ]);\n      if (ocrOutcome.status === "rejected") throw ocrOutcome.reason;\n      const info = ocrOutcome.value;\n      const identifier = barcodeOutcome.status === "fulfilled" ? barcodeOutcome.value : { attempted: Boolean(barcodeFile || manualGtin.trim()), found: false, value: null, gtin: manualGtin.trim() || null, confidence: 0, source: "NONE", error: barcodeOutcome.reason?.message || "Barcode verification failed." };\n      const extracted = info.result;\n      setOcr(extracted);\n      setForm(formFromOcr(extracted));\n      const gtin = identifier.gtin || manualGtin.trim();\n      const dk = gtin ? await lookupDataKart(gtin, controller.signal) : null;\n      const dkComparison = dk ? compareWithDataKart(extracted, dk) : { matchedFields: 0, comparedFields: 0, matchRate: null, comparisons: {} };\n      const confidenceResult = calculateVerificationConfidence({ ocrResult: extracted, providerInfo: info, barcodeResult: identifier, dataKartComparison: dkComparison });\n      setBarcodeResult(identifier);\n      setDatakartVerification(dk ? { ...dk, comparison: dkComparison } : null);\n      setVerificationConfidence(confidenceResult);',
    "parallel analysis",
  );

  addOnce(
    '      setProviderInfo(info);',
    '      setProviderInfo({ ...info, barcodeResult: identifier, datakartVerification: dk ? { ...dk, comparison: dkComparison } : null, verificationConfidence: confidenceResult });',
    "provider state",
  );

  addOnce(
    '          packageType: "retail",\n        }),',
    '          packageType: "retail",\n          datakartVerification: dk ? { ...dk, comparison: dkComparison } : null,\n          verificationConfidence: confidenceResult,\n        }),',
    "rules engine evidence",
  );

  const uploadAnchor = '<p className="scan-limit">{images.length}/{MAX_IMAGES} images selected</p>';
  const uploadPanel = [
    '<div className="scan-upload-actions">',
    '  <label className="secondary-button scan-file-button">Upload Barcode<input type="file" accept="image/*" onChange={(event) => { addBarcodeFile(event.target.files); event.target.value = ""; }} hidden /></label>',
    '  <input aria-label="Enter GTIN manually" placeholder="Enter GTIN manually" inputMode="numeric" value={manualGtin} onChange={(event) => { setManualGtin(event.target.value.replace(/\\D/g, "").slice(0, 18)); setBarcodeResult(null); }} />',
    '</div>',
  ].join("\n");
  if (!source.includes(uploadAnchor)) throw new Error("ScanV2 patch anchor not found: scan-limit");
  source = source.replace(uploadAnchor, uploadAnchor + "\n      " + uploadPanel);

  const providerAnchor = '{providerInfo && <section className="ocr-status-grid">';
  const verificationPanel = [
    '{providerInfo?.verificationConfidence && <section className="ocr-status-grid">',
    '  <div><strong>Barcode / GTIN</strong><span>{providerInfo.barcodeResult?.gtin || "Not supplied"} · {providerInfo.barcodeResult?.source || "NONE"}</span></div>',
    '  <div><strong>DataKart</strong><span>{providerInfo.datakartVerification?.found ? providerInfo.datakartVerification.comparison.matchedFields + "/" + providerInfo.datakartVerification.comparison.comparedFields + " fields matched" : providerInfo.datakartVerification?.attempted ? "GTIN not registered" : "Not queried"}</span></div>',
    '  <div><strong>Verification confidence</strong><span>{providerInfo.verificationConfidence.percentage}% · {providerInfo.verificationConfidence.label}</span></div>',
    '</section>}',
  ].join("\n");
  if (!source.includes(providerAnchor)) throw new Error("ScanV2 patch anchor not found: provider status");
  source = source.replace(providerAnchor, verificationPanel + "\n" + providerAnchor);
}

// Repair any earlier generated version of the patch. The previous build-time patch
// accidentally placed addBarcodeFile at module scope, where React setters do not exist.
const brokenHelperPattern = /\nfunction addBarcodeFile\(input\) \{[\s\S]*?\n\}\n\n(?=function formatElapsed\(ms\))/;
if (brokenHelperPattern.test(source)) {
  source = source.replace(brokenHelperPattern, "\n");
}

if (!source.includes("function addBarcodeFile(input) {")) {
  const componentHelperAnchor = '  function update(key, value) {\n    setForm((current) => ({ ...current, [key]: value }));\n  }';
  const componentHelper = '  function addBarcodeFile(input) {\n    const file = input?.[0];\n    if (!file) return;\n    if (!file.type.startsWith("image/")) return setMessage("Barcode upload must be an image.");\n    if (file.size > BARCODE_MAX_SIZE) return setMessage("Barcode image is too large. Use an image smaller than 8 MB.");\n    setBarcodeFile(file);\n    setBarcodeResult(null);\n    setDatakartVerification(null);\n    setVerificationConfidence(null);\n    setMessage("Barcode image ready. It will be decoded in parallel with package OCR when Analyze Images is clicked.");\n  }';
  if (!source.includes(componentHelperAnchor)) throw new Error("Could not repair barcode helper scope.");
  source = source.replace(componentHelperAnchor, componentHelperAnchor + "\n\n" + componentHelper);
}

// Do not let resetAnalysisState discard the selected barcode. resetScan still clears it explicitly.
source = source.replace('    setAiSuggestedCategory(null);\n    setBarcodeFile(null);\n    setBarcodePreviewUrl("");\n    setBarcodeResult(null);', '    setAiSuggestedCategory(null);\n    setBarcodeResult(null);');

if (!source.includes('setBarcodePreviewUrl("");')) {
  const resetScanAnchor = '    setEditingImageIndex(null);\n    resetAnalysisState();';
  if (source.includes(resetScanAnchor)) {
    source = source.replace(resetScanAnchor, '    setEditingImageIndex(null);\n    setBarcodeFile(null);\n    setBarcodePreviewUrl("");\n    setManualGtin("");\n    resetAnalysisState();');
  }
}

if (!source.includes('URL.createObjectURL(barcodeFile)')) {
  const effectAnchor = '  useEffect(() => {\n    if (!analyzing) return undefined;';
  const effect = '  useEffect(() => {\n    if (!barcodeFile) {\n      setBarcodePreviewUrl("");\n      return undefined;\n    }\n    const url = URL.createObjectURL(barcodeFile);\n    setBarcodePreviewUrl(url);\n    return () => URL.revokeObjectURL(url);\n  }, [barcodeFile]);\n\n';
  if (source.includes(effectAnchor)) source = source.replace(effectAnchor, effect + effectAnchor);
}

if (!source.includes('className="barcode-preview-card"')) {
  const uploadAnchor = '<p className="scan-limit">{images.length}/{MAX_IMAGES} images selected</p>';
  const previewPanel = [
    '{barcodePreviewUrl && <div className="barcode-preview-card">',
    '  <div className="barcode-preview-heading"><strong>Uploaded barcode</strong><span>{barcodeFile?.name}</span></div>',
    '  <img className="barcode-preview-image" src={barcodePreviewUrl} alt="Uploaded barcode for scanning" />',
    '  <div className="barcode-preview-meta">{barcodeResult?.found ? `Decoded GTIN: ${barcodeResult.gtin}` : "Will be decoded when Analyze Images is clicked."}</div>',
    '</div>}',
  ].join("\n");
  if (source.includes(uploadAnchor)) source = source.replace(uploadAnchor, uploadAnchor + "\n      " + previewPanel);
}

// Ensure extracted OCR is visible immediately instead of waiting on the Rules Engine.
if (!source.includes('setForm(formFromOcr(extracted));')) {
  source = source.replace('      const extracted = info.result;', '      const extracted = info.result;\n      setOcr(extracted);\n      setForm(formFromOcr(extracted));');
}

// Mark the source after repair so subsequent Vite starts do not duplicate UI patches.
if (!source.includes(previewMarker)) source += `\n${previewMarker}\n`;

await fs.writeFile(scanPath, source, "utf8");
console.log("PARAKH scan pipeline prepared: visible barcode preview, scoped barcode handler, parallel OCR/Gemini + barcode verification, bounded barcode decoding, and immediate extracted fields.");