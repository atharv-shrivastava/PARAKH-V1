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
if (stale.length) {
  throw new Error(`ScanV2.jsx still contains legacy browser OCR tokens: ${stale.join(", ")}`);
}

if (!source.includes("/api/ocr/analyze")) {
  throw new Error("ScanV2.jsx is missing the local backend OCR request.");
}

const marker = "/* PARAKH_BARCODE_DATAKART_VERIFY_V1 */";
if (!source.includes(marker)) {
  source = source.replace(
    'import { apiFetch } from "../lib/auth";',
    'import { apiFetch } from "../lib/auth";\nimport { scanBarcodeImage, lookupDataKart, compareWithDataKart, calculateVerificationConfidence } from "../lib/verification";',
  );

  source = source.replace(
    'const MAX_IMAGES = 4;',
    `${marker}\nconst MAX_IMAGES = 4;\nconst BARCODE_MAX_SIZE = 8 * 1024 * 1024;`,
  );

  source = source.replace(
    '  const [message, setMessage] = useState("");',
    '  const [message, setMessage] = useState("");\n  const [barcodeFile, setBarcodeFile] = useState(null);\n  const [manualGtin, setManualGtin] = useState("");\n  const [barcodeResult, setBarcodeResult] = useState(null);\n  const [datakartVerification, setDatakartVerification] = useState(null);\n  const [verificationConfidence, setVerificationConfidence] = useState(null);',
  );

  source = source.replace(
    '    setProviderInfo(null);\n    setAiSuggestedCategory(null);',
    '    setProviderInfo(null);\n    setAiSuggestedCategory(null);\n    setBarcodeResult(null);\n    setDatakartVerification(null);\n    setVerificationConfidence(null);',
  );

  const helperAnchor = 'function formatElapsed(ms) {';
  const helperCode = `async function resolveGtin(barcodeFileValue, manualGtinValue, signal) {\n  const manual = String(manualGtinValue || "").replace(/\\s+/g, "").trim();\n  if (barcodeFileValue) {\n    const decoded = await scanBarcodeImage(barcodeFileValue);\n    const gtin = decoded.found ? decoded.value : manual;\n    return { ...decoded, gtin: gtin || null, source: decoded.found ? "BARCODE_SCAN" : manual ? "MANUAL_GTIN_FALLBACK" : "NONE" };\n  }\n  return { attempted: Boolean(manual), found: Boolean(manual), value: manual || null, gtin: manual || null, format: manual ? "MANUAL_GTIN" : null, confidence: manual ? 0.90 : 0, source: manual ? "MANUAL_GTIN" : "NONE", error: null };\n}\n\nfunction addBarcodeFile(input) {\n  const file = input?.[0];\n  if (!file) return;\n  if (!file.type.startsWith("image/")) { setMessage("Barcode upload must be an image."); return; }\n  if (file.size > BARCODE_MAX_SIZE) { setMessage("Barcode image is too large. Use an image smaller than 8 MB."); return; }\n  setBarcodeFile(file);\n  setBarcodeResult(null);\n  setDatakartVerification(null);\n  setVerificationConfidence(null);\n  setMessage("Barcode image ready. It will be decoded in parallel with package OCR when Analyze Images is clicked.");\n}\n\n`;
  source = source.replace(helperAnchor, helperCode + helperAnchor);

  source = source.replace(
    '    setAnalyzing(true);\n    setAnalysisDurationMs(null);\n    setMessage("Running RapidOCR + AI semantic verification...");',
    '    setAnalyzing(true);\n    setAnalysisDurationMs(null);\n    setMessage(barcodeFile || manualGtin.trim() ? "Running barcode/GTIN verification and RapidOCR + Gemini in parallel..." : "Running RapidOCR + AI semantic verification...");',
  );

  source = source.replace(
    '      const info = await runOcr(images.map((item) => item.file), controller.signal, categoryOptions);\n      const extracted = info.result;',
    '      const [ocrOutcome, barcodeOutcome] = await Promise.allSettled([\n        runOcr(images.map((item) => item.file), controller.signal, categoryOptions),\n        resolveGtin(barcodeFile, manualGtin, controller.signal),\n      ]);\n      if (ocrOutcome.status === "rejected") throw ocrOutcome.reason;\n      const info = ocrOutcome.value;\n      const identifier = barcodeOutcome.status === "fulfilled" ? barcodeOutcome.value : { attempted: Boolean(barcodeFile || manualGtin.trim()), found: false, value: null, gtin: manualGtin.trim() || null, confidence: 0, source: "NONE", error: barcodeOutcome.reason?.message || "Barcode verification failed." };\n      const extracted = info.result;\n      const gtin = identifier.gtin || manualGtin.trim();\n      const dk = gtin ? await lookupDataKart(gtin, controller.signal) : null;\n      const dkComparison = dk ? compareWithDataKart(extracted, dk) : { matchedFields: 0, comparedFields: 0, matchRate: null, comparisons: {} };\n      const confidenceResult = calculateVerificationConfidence({ ocrResult: extracted, providerInfo: info, barcodeResult: identifier, dataKartComparison: dkComparison });\n      setBarcodeResult(identifier);\n      setDatakartVerification(dk ? { ...dk, comparison: dkComparison } : null);\n      setVerificationConfidence(confidenceResult);',
  );

  source = source.replace(
    '      setProviderInfo(info);',
    '      setProviderInfo({ ...info, barcodeResult: identifier, datakartVerification: dk ? { ...dk, comparison: dkComparison } : null, verificationConfidence: confidenceResult });',
  );

  source = source.replace(
    '          packageType: "retail",\n        }),',
    '          packageType: "retail",\n          datakartVerification: dk ? { ...dk, comparison: dkComparison } : null,\n          verificationConfidence: confidenceResult,\n        }),',
  );

  source = source.replace(
    '      setMessage(info.aiSuggestedCategory?.categoryName',
    '      setMessage(`${info.aiSuggestedCategory?.categoryName ?',
  );

  source = source.replace(
    '        ? `${providerMessage.replace("Running Rules Engine...", "Rules Engine completed.")} Analysis time: ${formatElapsed(Number(info.timing?.totalMs || 0))}. AI suggests: ${info.aiSuggestedCategory.categoryPath || info.aiSuggestedCategory.categoryName}.`\n        : info.aiSemanticError',
    '        `${providerMessage.replace("Running Rules Engine...", "Rules Engine completed.")} Analysis time: ${formatElapsed(Number(info.timing?.totalMs || 0))}. AI suggests: ${info.aiSuggestedCategory.categoryPath || info.aiSuggestedCategory.categoryName}.` : info.aiSemanticError',
  );

  source = source.replace(
    '            : `OCR and Rules Engine evaluation complete in ${formatElapsed(Number(info.timing?.totalMs || 0))}. Review the extracted fields, then choose how to register the product.`);',
    '            : `OCR and Rules Engine evaluation complete in ${formatElapsed(Number(info.timing?.totalMs || 0))}. Review the extracted fields, then choose how to register the product.`} ${gtin ? `GTIN: ${gtin}. ${dk?.found ? "DataKart match found." : "No DataKart record found."}` : ""} Verification confidence: ${confidenceResult.percentage}% (${confidenceResult.label}).`);',
  );

  const uploadAnchor = '<p className="scan-limit">{images.length}/{MAX_IMAGES} images selected</p>';
  const uploadPanel = `<div className="scan-upload-actions">\n        <label className="secondary-button scan-file-button">Upload Barcode<input type="file" accept="image/*" onChange={(event) => { addBarcodeFile(event.target.files); event.target.value = ""; }} hidden /></label>\n        <input aria-label="Enter GTIN manually" placeholder="Enter GTIN manually" inputMode="numeric" value={manualGtin} onChange={(event) => { setManualGtin(event.target.value.replace(/\\D/g, "").slice(0, 18)); setBarcodeResult(null); }} />\n      </div>\n      {(barcodeFile || manualGtin) && <div className="status-message">{barcodeFile ? `Barcode image: ${barcodeFile.name}` : "Manual GTIN entered."} {barcodeResult?.found ? `Decoded GTIN: ${barcodeResult.gtin}` : ""}</div>}`;
  source = source.replace(uploadAnchor, uploadAnchor + "\n      " + uploadPanel);

  const providerAnchor = '{providerInfo && <section className="ocr-status-grid">';
  const verificationPanel = `{providerInfo?.verificationConfidence && <section className="ocr-status-grid">\n      <div><strong>Barcode / GTIN</strong><span>{providerInfo.barcodeResult?.gtin || "Not supplied"} · {providerInfo.barcodeResult?.source || "NONE"}</span></div>\n      <div><strong>DataKart</strong><span>{providerInfo.datakartVerification?.found ? `${providerInfo.datakartVerification.comparison.matchedFields}/${providerInfo.datakartVerification.comparison.comparedFields} fields matched` : providerInfo.datakartVerification?.attempted ? "GTIN not registered" : "Not queried"}</span></div>\n      <div><strong>Verification confidence</strong><span>{providerInfo.verificationConfidence.percentage}% · {providerInfo.verificationConfidence.label}</span></div>\n    </section>}\n\n    `;
  source = source.replace(providerAnchor, verificationPanel + providerAnchor);

  await fs.writeFile(scanPath, source, "utf8");
  console.log("PARAKH scan page patched with parallel barcode/GTIN verification, DataKart comparison, and evidence confidence calculation.");
} else {
  console.log("PARAKH scan page barcode/DataKart verification patch already present.");
}

console.log("PARAKH frontend scan pipeline verified: local backend OCR request plus parallel barcode/GTIN verification.");
