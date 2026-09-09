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
const concurrencyMarker = "/* PARAKH_PARALLEL_RULES_DATAKART_V2 */";

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
    '  function update(key, value) {\n    setForm((current) => ({ ...current, [key]: value }));\n  }',
    '  function update(key, value) {\n    setForm((current) => ({ ...current, [key]: value }));\n  }\n\n  function addBarcodeFile(input) {\n    const file = input?.[0];\n    if (!file) return;\n    if (!file.type.startsWith("image/")) return setMessage("Barcode upload must be an image.");\n    if (file.size > BARCODE_MAX_SIZE) return setMessage("Barcode image is too large. Use an image smaller than 8 MB.");\n    setBarcodeFile(file);\n    setBarcodeResult(null);\n    setDatakartVerification(null);\n    setVerificationConfidence(null);\n    setMessage("Barcode image ready. It will be decoded in parallel with package OCR when Analyze Images is clicked.");\n  }',
    "barcode handler",
  );
  addOnce(
    '  function resetAnalysisState() {\n    setOcr(null);\n    setCompliance(null);\n    setComplianceError(null);\n    setAcceptedFindingIds([]);\n    setManualViolations([]);\n    setManualViolationReason("");\n    setManualRuleNumber("");\n    setProviderInfo(null);\n    setAiSuggestedCategory(null);',
    '  function resetAnalysisState() {\n    setOcr(null);\n    setCompliance(null);\n    setComplianceError(null);\n    setAcceptedFindingIds([]);\n    setManualViolations([]);\n    setManualViolationReason("");\n    setManualRuleNumber("");\n    setProviderInfo(null);\n    setAiSuggestedCategory(null);\n    setBarcodeResult(null);\n    setDatakartVerification(null);\n    setVerificationConfidence(null);',
    "reset analysis",
  );
  const helperAnchor = 'function formatElapsed(ms) {';
  const helperCode = `async function resolveGtin(barcodeFileValue, manualGtinValue, signal) {\n  const manual = String(manualGtinValue || "").replace(/\\s+/g, "").trim();\n  if (barcodeFileValue) {\n    const timeout = new Promise((resolve) => {\n      window.setTimeout(() => resolve({ attempted: true, found: false, value: null, gtin: manual || null, format: null, confidence: 0, source: manual ? "MANUAL_GTIN_FALLBACK" : "BARCODE_TIMEOUT", error: "Barcode decoding timed out." }), BARCODE_TIMEOUT_MS);\n    });\n    const decode = scanBarcodeImage(barcodeFileValue).then((decoded) => {\n      const gtin = decoded.found ? decoded.value : manual;\n      return { ...decoded, gtin: gtin || null, source: decoded.found ? "BARCODE_SCAN" : manual ? "MANUAL_GTIN_FALLBACK" : "NONE" };\n    });\n    return await Promise.race([decode, timeout]);\n  }\n  return { attempted: Boolean(manual), found: Boolean(manual), value: manual || null, gtin: manual || null, format: manual ? "MANUAL_GTIN" : null, confidence: manual ? 0.90 : 0, source: manual ? "MANUAL_GTIN" : "NONE", error: null };\n}\n\n`;
  if (!source.includes(helperAnchor)) throw new Error("ScanV2 patch anchor not found: formatElapsed");
  source = source.replace(helperAnchor, helperCode + helperAnchor);
}

if (!source.includes(concurrencyMarker)) {
  const analyzeRegex = /  async function analyze\(\) \{[\s\S]*?\n  \}\n\n  function updateOcrField/;
  if (!analyzeRegex.test(source)) throw new Error("Could not locate ScanV2 analyze function for concurrency patch.");
  const analyzeFunction = `  async function analyze() {\n    if (!images.length) return setMessage("Add at least one package image first.");\n    setAnalyzing(true);\n    setAnalysisDurationMs(null);\n    setMessage(barcodeFile || manualGtin.trim()\n      ? "Running barcode, RapidOCR and Gemini in parallel..."\n      : "Running RapidOCR + AI semantic verification...");\n    const controller = new AbortController();\n    controllerRef.current?.abort();\n    controllerRef.current = controller;\n    try {\n      const categoryOptions = finalCategories.map((category) => ({\n        id: category.id,\n        name: category.name,\n        path: category.path.map((item) => item.name).join(" → "),\n      }));\n\n      // Stage 1: the package-analysis branch and barcode branch start together.\n      const [ocrOutcome, barcodeOutcome] = await Promise.allSettled([\n        runOcr(images.map((item) => item.file), controller.signal, categoryOptions),\n        resolveGtin(barcodeFile, manualGtin, controller.signal),\n      ]);\n      if (ocrOutcome.status === "rejected") throw ocrOutcome.reason;\n\n      const info = ocrOutcome.value;\n      const identifier = barcodeOutcome.status === "fulfilled"\n        ? barcodeOutcome.value\n        : { attempted: Boolean(barcodeFile || manualGtin.trim()), found: false, value: null, gtin: manualGtin.trim() || null, confidence: 0, source: "NONE", error: barcodeOutcome.reason?.message || "Barcode verification failed." };\n      const extracted = info.result;\n      const gtin = identifier.gtin || manualGtin.trim();\n\n      // Show extracted data as soon as OCR/Gemini is ready. Registration no longer waits for barcode/DataKart.\n      window.sessionStorage.setItem("parakhDeclarationEvidence", JSON.stringify(extracted.declarationEvidence || []));\n      window.dispatchEvent(new CustomEvent("parakh:declaration-evidence", { detail: extracted.declarationEvidence || [] }));\n      setOcr(extracted);\n      setForm(formFromOcr(extracted));\n      setUseExtractedData(true);\n      setShowRegistration(true);\n      setAiSuggestedCategory(info.aiSuggestedCategory || null);\n      setBarcodeResult(identifier);\n      setProviderInfo({ ...info, barcodeResult: identifier });\n      setMessage("OCR + Gemini completed. Rules Engine and DataKart verification are running in parallel...");\n\n      const visualInspection = readVisualInspection();\n\n      // Stage 2: Rules Engine and DataKart now run concurrently. The Rules Engine does not wait for DataKart.\n      const rulesPromise = apiFetch(\`${OCR_URL}/api/ocr/evaluate-structured\`, {\n        method: "POST",\n        headers: { "Content-Type": "application/json" },\n        body: JSON.stringify({\n          ocr: extracted,\n          visualFlags: visualInspection ? {\n            readability: visualInspection.readability,\n            readable: visualInspection.readable,\n            textDetected: visualInspection.textDetected,\n            placementReview: visualInspection.placementReview,\n            fontSizeCalibrated: visualInspection.fontSizeCalibrated,\n            estimatedTextHeightMm: visualInspection.estimatedTextHeightMm,\n            declarationCoverageScreened: visualInspection.declarationCoverageScreened,\n          } : {},\n          inspectionId: crypto.randomUUID(),\n          productId: crypto.randomUUID(),\n          inspectionDate: new Date().toISOString().slice(0, 10),\n          context: "physical_package",\n          commodityCategory: "packaged commodity",\n          consumerType: "general",\n          isImported: false,\n          packageType: "retail",\n          datakartVerification: null,\n        }),\n        signal: controller.signal,\n      });\n\n      const dataKartPromise = gtin\n        ? lookupDataKart(gtin, controller.signal).then((dk) => {\n            const comparison = dk\n              ? compareWithDataKart(extracted, dk)\n              : { matchedFields: 0, comparedFields: 0, matchRate: null, comparisons: {} };\n            return dk ? { ...dk, comparison } : null;\n          })\n        : Promise.resolve(null);\n\n      const [rulesOutcome, dataKartOutcome] = await Promise.allSettled([rulesPromise, dataKartPromise]);\n\n      if (rulesOutcome.status === "fulfilled") {\n        const response = rulesOutcome.value;\n        const data = await response.json().catch(() => ({}));\n        if (!response.ok) {\n          setCompliance(null);\n          setComplianceError({ message: data.error || "Rules Engine evaluation failed" });\n        } else {\n          setCompliance(data.compliance || null);\n          setComplianceError(data.complianceError || null);\n          setAcceptedFindingIds((data.compliance?.findings || [])\n            .filter((finding) => finding.status === "VIOLATION")\n            .map((finding) => finding.findingId));\n        }\n      } else if (rulesOutcome.reason?.name !== "AbortError") {\n        setCompliance(null);\n        setComplianceError({ message: rulesOutcome.reason?.message || "Rules Engine evaluation failed" });\n      }\n\n      const dk = dataKartOutcome.status === "fulfilled" ? dataKartOutcome.value : null;\n      const dkComparison = dk?.comparison || { matchedFields: 0, comparedFields: 0, matchRate: null, comparisons: {} };\n      const confidenceResult = calculateVerificationConfidence({\n        ocrResult: extracted,\n        providerInfo: info,\n        barcodeResult: identifier,\n        dataKartComparison: dkComparison,\n      });\n      setBarcodeResult(identifier);\n      setDatakartVerification(dk);\n      setVerificationConfidence(confidenceResult);\n      setProviderInfo({\n        ...info,\n        barcodeResult: identifier,\n        datakartVerification: dk ? { ...dk, comparison: dkComparison } : null,\n        verificationConfidence: confidenceResult,\n      });\n\n      if (Number.isFinite(info.timing?.totalMs)) setAnalysisDurationMs(Number(info.timing.totalMs));\n      setManualViolations([]);\n      setManualViolationReason("");\n      setManualRuleNumber("");\n      setSelectedCategoryId("");\n      const rulesDone = rulesOutcome.status === "fulfilled" && rulesOutcome.value.ok;\n      const dataKartDone = dataKartOutcome.status === "fulfilled";\n      setMessage(\n        `${rulesDone ? "Rules Engine completed" : "Rules Engine needs review"}. ${dataKartDone ? "DataKart verification completed" : "DataKart verification unavailable"}. Extracted fields are ready for review and registration.`\n      );\n    } catch (error) {\n      if (error?.name === "AbortError") return;\n      setMessage(error.message || "OCR analysis failed.");\n    } finally {\n      if (controllerRef.current === controller) controllerRef.current = null;\n      setAnalysisDurationMs((current) => current ?? analysisElapsedMs);\n      setAnalyzing(false);\n    }\n  }`;
  source = source.replace(analyzeRegex, `${analyzeFunction}\n\n  function updateOcrField`);
  source += `\n${concurrencyMarker}\n`;
}

// Barcode preview is patched as a final idempotent step.
if (!source.includes(previewMarker)) {
  addOnce(
    '  const [barcodeFile, setBarcodeFile] = useState(null);',
    '  const [barcodeFile, setBarcodeFile] = useState(null);\n  const [barcodePreviewUrl, setBarcodePreviewUrl] = useState("");',
    "barcode preview state",
  );
  addOnce(
    '  useEffect(() => {\n    if (!analyzing) return undefined;',
    '  useEffect(() => {\n    if (!barcodeFile) {\n      setBarcodePreviewUrl("");\n      return undefined;\n    }\n    const url = URL.createObjectURL(barcodeFile);\n    setBarcodePreviewUrl(url);\n    return () => URL.revokeObjectURL(url);\n  }, [barcodeFile]);\n\n  useEffect(() => {\n    if (!analyzing) return undefined;',
    "barcode preview effect fallback",
  );
  addOnce(
    '<p className="scan-limit">{images.length}/{MAX_IMAGES} images selected</p>',
    '<p className="scan-limit">{images.length}/{MAX_IMAGES} images selected</p>\n      {barcodePreviewUrl && <div className="barcode-preview-card">\n        <div className="barcode-preview-heading"><strong>Uploaded barcode</strong><span>{barcodeFile?.name}</span></div>\n        <img className="barcode-preview-image" src={barcodePreviewUrl} alt="Uploaded barcode for scanning" />\n        <div className="barcode-preview-meta">{barcodeResult?.found ? `Decoded GTIN: ${barcodeResult.gtin}` : "Will be decoded when Analyze Images is clicked."}</div>\n      </div>}',
    "barcode preview markup",
  );
}

await fs.writeFile(scanPath, source, "utf8");
console.log("PARAKH scan pipeline: barcode + OCR/Gemini together, then Rules Engine + DataKart together; registration remains available as soon as OCR finishes.");