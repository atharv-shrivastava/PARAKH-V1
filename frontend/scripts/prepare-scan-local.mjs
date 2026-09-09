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
const scopeFixMarker = "/* PARAKH_BARCODE_SCOPE_FIX_V1 */";

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
    "reset analysis",
  );

  const helperAnchor = 'function formatElapsed(ms) {';
  const helperCode = `async function resolveGtin(barcodeFileValue, manualGtinValue, signal) {\n  const manual = String(manualGtinValue || "").replace(/\\s+/g, "").trim();\n  if (barcodeFileValue) {\n    const timeout = new Promise((resolve) => {\n      window.setTimeout(() => resolve({ attempted: true, found: false, value: null, gtin: manual || null, format: null, confidence: 0, source: manual ? "MANUAL_GTIN_FALLBACK" : "BARCODE_TIMEOUT", error: "Barcode decoding timed out." }), BARCODE_TIMEOUT_MS);\n    });\n    const decode = scanBarcodeImage(barcodeFileValue).then((decoded) => {\n      const gtin = decoded.found ? decoded.value : manual;\n      return { ...decoded, gtin: gtin || null, source: decoded.found ? "BARCODE_SCAN" : manual ? "MANUAL_GTIN_FALLBACK" : "NONE" };\n    });\n    return await Promise.race([decode, timeout]);\n  }\n  return { attempted: Boolean(manual), found: Boolean(manual), value: manual || null, gtin: manual || null, format: manual ? "MANUAL_GTIN" : null, confidence: manual ? 0.90 : 0, source: manual ? "MANUAL_GTIN" : "NONE", error: null };\n}\n\n`;
  if (!source.includes(helperAnchor)) throw new Error("ScanV2 patch anchor not found: formatElapsed");
  source = source.replace(helperAnchor, helperCode + helperAnchor);
}

// Repair any earlier version that accidentally placed addBarcodeFile at module scope.
if (!source.includes(scopeFixMarker)) {
  const globalHandlerRegex = /\nfunction addBarcodeFile\(input\) \{[\s\S]*?\n\}\n\n(?=function formatElapsed\()/;
  const globalMatch = source.match(globalHandlerRegex);
  if (globalMatch) {
    source = source.replace(globalHandlerRegex, "\nfunction formatElapsed(");
  }
  const componentAnchor = '  function update(key, value) {\n    setForm((current) => ({ ...current, [key]: value }));\n  }';
  const scopedHandler = `  function update(key, value) {\n    setForm((current) => ({ ...current, [key]: value }));\n  }\n\n  function addBarcodeFile(input) {\n    const file = input?.[0];\n    if (!file) return;\n    if (!file.type.startsWith("image/")) return setMessage("Barcode upload must be an image.");\n    if (file.size > BARCODE_MAX_SIZE) return setMessage("Barcode image is too large. Use an image smaller than 8 MB.");\n    setBarcodeFile(file);\n    setBarcodeResult(null);\n    setDatakartVerification(null);\n    setVerificationConfidence(null);\n    setMessage("Barcode image ready. It will be decoded in parallel with package OCR when Analyze Images is clicked.");\n  }`;
  if (!source.includes('  function addBarcodeFile(input) {') && source.includes(componentAnchor)) {
    source = source.replace(componentAnchor, scopedHandler);
  }
  source += `\n${scopeFixMarker}\n`;
}

if (!source.includes(concurrencyMarker)) {
  const analyzeRegex = /  async function analyze\(\) \{[\s\S]*?\n  \}\n\n  function updateOcrField/;
  if (!analyzeRegex.test(source)) throw new Error("Could not locate ScanV2 analyze function for concurrency patch.");
  const analyzeFunction = `  async function analyze() {
    if (!images.length) return setMessage("Add at least one package image first.");
    setAnalyzing(true);
    setAnalysisDurationMs(null);
    setMessage(barcodeFile || manualGtin.trim() ? "Running barcode, RapidOCR and Gemini in parallel..." : "Running RapidOCR + AI semantic verification...");
    const controller = new AbortController();
    controllerRef.current?.abort();
    controllerRef.current = controller;
    try {
      const categoryOptions = finalCategories.map((category) => ({ id: category.id, name: category.name, path: category.path.map((item) => item.name).join(" → ") }));

      const [ocrOutcome, barcodeOutcome] = await Promise.allSettled([
        runOcr(images.map((item) => item.file), controller.signal, categoryOptions),
        resolveGtin(barcodeFile, manualGtin, controller.signal),
      ]);
      if (ocrOutcome.status === "rejected") throw ocrOutcome.reason;

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
      const rulesPromise = apiFetch(OCR_URL + "/api/ocr/evaluate-structured", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ocr: extracted,
          visualFlags: visualInspection ? { readability: visualInspection.readability, readable: visualInspection.readable, textDetected: visualInspection.textDetected, placementReview: visualInspection.placementReview, fontSizeCalibrated: visualInspection.fontSizeCalibrated, estimatedTextHeightMm: visualInspection.estimatedTextHeightMm, declarationCoverageScreened: visualInspection.declarationCoverageScreened } : {},
          inspectionId: crypto.randomUUID(),
          productId: crypto.randomUUID(),
          inspectionDate: new Date().toISOString().slice(0, 10),
          context: "physical_package",
          commodityCategory: "packaged commodity",
          consumerType: "general",
          isImported: false,
          packageType: "retail",
          datakartVerification: null,
        }),
        signal: controller.signal,
      });

      const dataKartPromise = gtin
        ? lookupDataKart(gtin, controller.signal).then((dk) => {
            const comparison = dk ? compareWithDataKart(extracted, dk) : { matchedFields: 0, comparedFields: 0, matchRate: null, comparisons: {} };
            return dk ? { ...dk, comparison } : null;
          })
        : Promise.resolve(null);

      const [rulesOutcome, dataKartOutcome] = await Promise.allSettled([rulesPromise, dataKartPromise]);

      if (rulesOutcome.status === "fulfilled") {
        const response = rulesOutcome.value;
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          setCompliance(null);
          setComplianceError({ message: data.error || "Rules Engine evaluation failed" });
        } else {
          setCompliance(data.compliance || null);
          setComplianceError(data.complianceError || null);
          setAcceptedFindingIds((data.compliance?.findings || []).filter((finding) => finding.status === "VIOLATION").map((finding) => finding.findingId));
        }
      } else if (rulesOutcome.reason?.name !== "AbortError") {
        setCompliance(null);
        setComplianceError({ message: rulesOutcome.reason?.message || "Rules Engine evaluation failed" });
      }

      const dk = dataKartOutcome.status === "fulfilled" ? dataKartOutcome.value : null;
      const dkComparison = dk?.comparison || { matchedFields: 0, comparedFields: 0, matchRate: null, comparisons: {} };
      const confidenceResult = calculateVerificationConfidence({ ocrResult: extracted, providerInfo: info, barcodeResult: identifier, dataKartComparison: dkComparison });
      setBarcodeResult(identifier);
      setDatakartVerification(dk);
      setVerificationConfidence(confidenceResult);
      setProviderInfo({ ...info, barcodeResult: identifier, datakartVerification: dk ? { ...dk, comparison: dkComparison } : null, verificationConfidence: confidenceResult });

      if (Number.isFinite(info.timing?.totalMs)) setAnalysisDurationMs(Number(info.timing.totalMs));
      setManualViolations([]);
      setManualViolationReason("");
      setManualRuleNumber("");
      setSelectedCategoryId("");
      const rulesDone = rulesOutcome.status === "fulfilled" && rulesOutcome.value.ok;
      const dataKartDone = dataKartOutcome.status === "fulfilled";
      setMessage((rulesDone ? "Rules Engine completed" : "Rules Engine needs review") + ". " + (dataKartDone ? "DataKart verification completed" : "DataKart verification unavailable") + ". Extracted fields are ready for review and registration.");
    } catch (error) {
      if (error?.name === "AbortError") return;
      setMessage(error.message || "OCR analysis failed.");
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
      setAnalysisDurationMs((current) => current ?? analysisElapsedMs);
      setAnalyzing(false);
    }
  }`;
  source = source.replace(analyzeRegex, `${analyzeFunction}\n\n  function updateOcrField`);
  source += `\n${concurrencyMarker}\n`;
}

if (!source.includes(previewMarker)) {
  addOnce(
    '<p className="scan-limit">{images.length}/{MAX_IMAGES} images selected</p>',
    '<p className="scan-limit">{images.length}/{MAX_IMAGES} images selected</p>\n      {barcodePreviewUrl && <div className="barcode-preview-card">\n        <div className="barcode-preview-heading"><strong>Uploaded barcode</strong><span>{barcodeFile?.name}</span></div>\n        <img className="barcode-preview-image" src={barcodePreviewUrl} alt="Uploaded barcode for scanning" />\n        <div className="barcode-preview-meta">{barcodeResult?.found ? `Decoded GTIN: ${barcodeResult.gtin}` : "Will be decoded when Analyze Images is clicked."}</div>\n      </div>}',
    "barcode preview markup",
  );
  source += `\n${previewMarker}\n`;
}

await fs.writeFile(scanPath, source, "utf8");
console.log("PARAKH scan pipeline: barcode + OCR/Gemini together, then Rules Engine + DataKart together; registration remains available as soon as OCR finishes.");
