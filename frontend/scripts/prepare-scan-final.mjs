import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const scanPath = path.resolve(here, "../src/pages/ScanV2.jsx");
let source = await fs.readFile(scanPath, "utf8");

if (!source.includes("/api/ocr/analyze")) {
  throw new Error("ScanV2.jsx is missing the local backend OCR request.");
}

const IMPORT_MARKER = 'import { scanBarcodeImage, lookupDataKart, compareWithDataKart, calculateVerificationConfidence } from "../lib/verification";';
const STATE_MARKER = "const [barcodeFile, setBarcodeFile] = useState(null);";
const HANDLER_MARKER = "function addBarcodeFile(input)";
const UI_MARKER = "data-parallel-barcode-ui";

function replaceOnce(needle, replacement, label) {
  if (source.includes(needle)) {
    source = source.replace(needle, replacement);
    return true;
  }
  if (label) console.warn(`PARAKH patch anchor missing: ${label}`);
  return false;
}

if (!source.includes(IMPORT_MARKER)) {
  replaceOnce(
    'import { apiFetch } from "../lib/auth";',
    'import { apiFetch } from "../lib/auth";\n' + IMPORT_MARKER,
    "verification import",
  );
}

if (!source.includes("const BARCODE_TIMEOUT_MS")) {
  replaceOnce(
    "const MAX_IMAGES = 4;",
    'const MAX_IMAGES = 4;\nconst BARCODE_MAX_SIZE = 8 * 1024 * 1024;\nconst BARCODE_TIMEOUT_MS = 4000;',
    "barcode constants",
  );
}

if (!source.includes(STATE_MARKER)) {
  replaceOnce(
    '  const [message, setMessage] = useState("");',
    '  const [message, setMessage] = useState("");\n  const [barcodeFile, setBarcodeFile] = useState(null);\n  const [barcodePreviewUrl, setBarcodePreviewUrl] = useState("");\n  const [manualGtin, setManualGtin] = useState("");\n  const [barcodeResult, setBarcodeResult] = useState(null);\n  const [datakartVerification, setDatakartVerification] = useState(null);\n  const [verificationConfidence, setVerificationConfidence] = useState(null);',
    "barcode state",
  );
}

// Preview is managed directly by addBarcodeFile, so startup does not depend on
// the exact shape/location of the analysis timer useEffect.
if (!source.includes(HANDLER_MARKER)) {
  const updateAnchor = '  function update(key, value) {\n    setForm((current) => ({ ...current, [key]: value }));\n  }';
  const handler = `  function update(key, value) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function addBarcodeFile(input) {
    const file = input?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) return setMessage("Barcode upload must be an image.");
    if (file.size > BARCODE_MAX_SIZE) return setMessage("Barcode image is too large. Use an image smaller than 8 MB.");
    setBarcodeFile((previous) => {
      if (previous && previous !== file) {
        // The previous object URL is revoked when the preview element is replaced.
      }
      return file;
    });
    setBarcodePreviewUrl((previous) => {
      if (previous) URL.revokeObjectURL(previous);
      return URL.createObjectURL(file);
    });
    setBarcodeResult(null);
    setDatakartVerification(null);
    setVerificationConfidence(null);
    setMessage("Barcode image ready. It will be decoded in parallel with package OCR when Analyze Images is clicked.");
  }`;
  if (!replaceOnce(updateAnchor, handler, "barcode handler")) {
    throw new Error("Could not find ScanV2 component update anchor.");
  }
}

if (!source.includes("async function resolveGtin(")) {
  const helperAnchor = "function formatElapsed(ms) {";
  const helper = `async function resolveGtin(barcodeFileValue, manualGtinValue) {
  const manual = String(manualGtinValue || "").replace(/\\s+/g, "").trim();
  if (barcodeFileValue) {
    const timeout = new Promise((resolve) => {
      window.setTimeout(() => resolve({
        attempted: true,
        found: false,
        value: null,
        gtin: manual || null,
        format: null,
        confidence: 0,
        source: manual ? "MANUAL_GTIN_FALLBACK" : "BARCODE_TIMEOUT",
        error: "Barcode decoding timed out."
      }), BARCODE_TIMEOUT_MS);
    });
    const decode = scanBarcodeImage(barcodeFileValue).then((decoded) => {
      const gtin = decoded.found ? decoded.value : manual;
      return { ...decoded, gtin: gtin || null, source: decoded.found ? "BARCODE_SCAN" : manual ? "MANUAL_GTIN_FALLBACK" : "NONE" };
    });
    return Promise.race([decode, timeout]);
  }
  return {
    attempted: Boolean(manual),
    found: Boolean(manual),
    value: manual || null,
    gtin: manual || null,
    format: manual ? "MANUAL_GTIN" : null,
    confidence: manual ? 0.90 : 0,
    source: manual ? "MANUAL_GTIN" : "NONE",
    error: null,
  };
}

`;
  if (!replaceOnce(helperAnchor, helper + helperAnchor, "formatElapsed helper anchor")) {
    throw new Error("Could not find formatElapsed anchor.");
  }
}

if (!source.includes("const [ocrOutcome, barcodeOutcome] = await Promise.allSettled")) {
  const analyzeRegex = /  async function analyze\(\)\s*\{[\s\S]*?\n  \}\s*\n\s*function updateOcrField/;
  if (!analyzeRegex.test(source)) {
    throw new Error("Could not safely locate analyze() in ScanV2.jsx. Restore ScanV2.jsx from git and rerun npm run dev.");
  }

  const analyze = `  async function analyze() {
    if (!images.length) return setMessage("Add at least one package image first.");
    setAnalyzing(true);
    setAnalysisDurationMs(null);
    setMessage(barcodeFile || manualGtin.trim() ? "Running barcode, RapidOCR and Gemini in parallel..." : "Running RapidOCR + AI semantic verification...");
    const controller = new AbortController();
    controllerRef.current?.abort();
    controllerRef.current = controller;
    try {
      const categoryOptions = finalCategories.map((category) => ({
        id: category.id,
        name: category.name,
        path: category.path.map((item) => item.name).join(" → "),
      }));

      const [ocrOutcome, barcodeOutcome] = await Promise.allSettled([
        runOcr(images.map((item) => item.file), controller.signal, categoryOptions),
        resolveGtin(barcodeFile, manualGtin),
      ]);
      if (ocrOutcome.status === "rejected") throw ocrOutcome.reason;

      const info = ocrOutcome.value;
      const identifier = barcodeOutcome.status === "fulfilled"
        ? barcodeOutcome.value
        : { attempted: Boolean(barcodeFile || manualGtin.trim()), found: false, value: null, gtin: manualGtin.trim() || null, confidence: 0, source: "NONE", error: barcodeOutcome.reason?.message || "Barcode verification failed." };
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
          visualFlags: visualInspection || {},
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
        ? lookupDataKart(gtin, controller.signal).then((dk) => dk ? { ...dk, comparison: compareWithDataKart(extracted, dk) } : null)
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
      const confidenceResult = calculateVerificationConfidence({
        ocrResult: extracted,
        providerInfo: info,
        barcodeResult: identifier,
        dataKartComparison: dkComparison,
      });
      setDatakartVerification(dk);
      setVerificationConfidence(confidenceResult);
      setProviderInfo({
        ...info,
        barcodeResult: identifier,
        datakartVerification: dk ? { ...dk, comparison: dkComparison } : null,
        verificationConfidence: confidenceResult,
      });
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
  }

  function updateOcrField`;

  replaceOnce(analyzeRegex, analyze, "analyze function");
}

if (!source.includes(UI_MARKER)) {
  const uploadAnchor = '<p className="scan-limit">{images.length}/{MAX_IMAGES} images selected</p>';
  const ui = `<div data-parallel-barcode-ui="true" className="barcode-upload-section">
        <div className="scan-upload-actions">
          <label className="secondary-button scan-file-button">Upload Barcode<input type="file" accept="image/*" onChange={(event) => { addBarcodeFile(event.target.files); event.target.value = ""; }} hidden /></label>
          <input aria-label="Enter GTIN manually" placeholder="Enter GTIN manually" inputMode="numeric" value={manualGtin} onChange={(event) => { setManualGtin(event.target.value.replace(/\\D/g, "").slice(0, 18)); setBarcodeResult(null); }} />
        </div>
        {barcodePreviewUrl && <div className="barcode-preview-card">
          <div className="barcode-preview-heading"><strong>Uploaded barcode</strong><span>{barcodeFile?.name}</span></div>
          <img className="barcode-preview-image" src={barcodePreviewUrl} alt="Uploaded barcode for scanning" />
          <div className="barcode-preview-meta">{barcodeResult?.found ? "Decoded GTIN: " + barcodeResult.gtin : "Will be decoded when Analyze Images is clicked."}</div>
        </div>}
        {!barcodePreviewUrl && manualGtin && <div className="status-message">Manual GTIN entered: {manualGtin}</div>}
      </div>`;
  if (!replaceOnce(uploadAnchor, uploadAnchor + "\n      " + ui, "scan upload area")) {
    throw new Error("Could not find scan upload area in ScanV2.jsx.");
  }
}

if (!source.includes("Barcode / GTIN") && source.includes("{providerInfo && <section className=\"ocr-status-grid\">")) {
  const anchor = '{providerInfo && <section className="ocr-status-grid">';
  const verification = `{providerInfo?.verificationConfidence && <section className="ocr-status-grid">
      <div><strong>Barcode / GTIN</strong><span>{providerInfo.barcodeResult?.gtin || "Not supplied"} · {providerInfo.barcodeResult?.source || "NONE"}</span></div>
      <div><strong>DataKart</strong><span>{providerInfo.datakartVerification?.found ? providerInfo.datakartVerification.comparison.matchedFields + "/" + providerInfo.datakartVerification.comparison.comparedFields + " fields matched" : providerInfo.datakartVerification?.attempted ? "GTIN not registered" : "Not queried"}</span></div>
      <div><strong>Verification confidence</strong><span>{providerInfo.verificationConfidence.percentage}% · {providerInfo.verificationConfidence.label}</span></div>
    </section>}

    `;
  replaceOnce(anchor, verification + anchor, "verification status panel");
}

await fs.writeFile(scanPath, source, "utf8");
console.log("PARAKH final scan patch applied: barcode UI + preview restored; barcode + OCR/Gemini parallel; Rules Engine + DataKart parallel.");
