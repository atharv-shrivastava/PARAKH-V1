import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { apiFetch } from "../lib/auth";
import "../styles/scan.css";
import "../styles/scan-theme.css";

const API_URL = "http://localhost:5000/api";
const PUTER_EVALUATE_URL = "http://localhost:8080/api/ocr/evaluate-structured";
const MAX_IMAGES = 4;

const ENGINE_RULE_OPTIONS = [
  ["PCR-R4","4","Mandatory declarations","Required declarations must be carried on pre-packaged commodities as prescribed."],
  ["PCR-R6-1-A","6(1)(a)","Manufacturer, packer and importer","The package must declare the responsible manufacturer/packer identity and applicable importer information."],
  ["PCR-R6-1-B","6(1)(b)","Common or generic name","The package shall bear the common or generic name of the commodity."],
  ["PCR-R6-1-C","6(1)(c)","Net quantity","The package shall declare net quantity in the prescribed standard unit or by number where appropriate."],
  ["PCR-R6-1-D","6(1)(d)","Month and year","The package shall declare the month and year of manufacture, pre-packing or import, subject to applicable exceptions."],
  ["PCR-R6-1-E","6(1)(e)","Retail sale price","The package shall bear the retail sale price in the prescribed manner."],
  ["PCR-R6-1-F","6(1)(f)","Dimensions","Where size is relevant, the prescribed dimensions shall be declared."],
  ["PCR-R6-2","6(2)","Consumer complaint contact","Consumer complaint contact details shall be declared as prescribed."],
  ["PCR-R6-3","6(3)","Separate stickers","Required declarations shall not be made by prohibited separate stickers, subject to permitted exceptions."],
  ["PCR-R7","7","Principal display panel","Declarations on the principal display panel must meet prescribed presentation and size requirements."],
  ["PCR-R8","8","Declarations on principal display panel","Required declarations shall appear on the principal display panel in the prescribed manner."],
  ["PCR-R9","9","Legibility and language","Declarations must be legible, prominent and presented in the permitted manner."],
  ["PCR-R10","10","Manufacturer/packer/importer address","The responsible entity name and complete address shall be declared in the prescribed manner."],
  ["PCR-R12-6","12(6)","Quantity expression","Quantity expressions must not create an exaggerated, misleading or inadequate impression."]
];

function ruleMeta(finding) {
  const code = String(finding?.ruleCode || finding?.ruleId || "");
  const number = String(finding?.ruleNumber || "");
  const known = ENGINE_RULE_OPTIONS.find(([knownCode, knownNumber]) => knownCode === code || knownNumber === number);
  return {
    code: known?.[0] || code || number || "RULE",
    number: known?.[1] || number,
    title: known?.[2] || finding?.title || "Legal Metrology requirement",
    statement: known?.[3] || finding?.description || finding?.message || "Applicable legal requirement must be satisfied."
  };
}

const OCR_FIELDS = ["productName","brandName","manufacturer","manufacturerAddress","packer","packerAddress","importer","importerAddress","netQuantity","unit","mrp","currency","dateOfManufacture","dateOfPacking","bestBefore","expiryDate","batchNumber","consumerCarePhone","consumerCareEmail","countryOfOrigin","fssaiLicenseNumber","barcode"];
const emptyForm = { brandName: "", productName: "", description: "", netQuantity: "", unit: "", mrp: "", barcode: "", shopName: "", shopAddress: "", shopCity: "", shopState: "", notes: "" };

function flattenCategories(nodes, path = []) {
  return nodes.flatMap((node) => {
    const next = [...path, node];
    return [{ ...node, path: next }, ...flattenCategories(node.children || [], next)];
  });
}

function fieldValue(result, key) {
  const field = result?.[key];
  return field?.status === "found" && field.value !== null && field.value !== undefined ? String(field.value) : "";
}

function formFromOcr(result) {
  if (!result) return { ...emptyForm };
  const details = [
    ["Manufacturer", fieldValue(result, "manufacturer")],
    ["Manufacturer address", fieldValue(result, "manufacturerAddress")],
    ["Packer", fieldValue(result, "packer")],
    ["Packer address", fieldValue(result, "packerAddress")],
    ["Importer", fieldValue(result, "importer")],
    ["Importer address", fieldValue(result, "importerAddress")],
    ["Currency", fieldValue(result, "currency")],
    ["Manufacturing date", fieldValue(result, "dateOfManufacture")],
    ["Packing date", fieldValue(result, "dateOfPacking")],
    ["Best before", fieldValue(result, "bestBefore")],
    ["Expiry date", fieldValue(result, "expiryDate")],
    ["Batch / lot number", fieldValue(result, "batchNumber")],
    ["Consumer care phone", fieldValue(result, "consumerCarePhone")],
    ["Consumer care email", fieldValue(result, "consumerCareEmail")],
    ["Country of origin", fieldValue(result, "countryOfOrigin")],
    ["FSSAI license number", fieldValue(result, "fssaiLicenseNumber")],
  ].filter(([, value]) => value);
  const declarations = Array.isArray(result.otherDeclarations) ? result.otherDeclarations.filter(Boolean) : [];
  return {
    brandName: fieldValue(result, "brandName") || fieldValue(result, "manufacturer"),
    productName: fieldValue(result, "productName"),
    netQuantity: fieldValue(result, "netQuantity"),
    unit: fieldValue(result, "unit"),
    mrp: fieldValue(result, "mrp").replace(/[^0-9.]/g, ""),
    barcode: fieldValue(result, "barcode"),
    description: [...details.map(([label, value]) => `${label}: ${value}`), ...declarations].join("\n"),
    shopName: "",
    shopAddress: "",
    shopCity: "",
    shopState: "",
    notes: "",
  };
}

function verificationBadge(field) {
  const verification = String(field?.verification || "").toUpperCase();
  if (verification === "MATCH" || field?.verificationIcon === "✓") return { icon: "✓", label: "MATCH", tone: "#16a34a", background: "#dcfce7", border: "#86efac" };
  if (verification === "MISMATCH" || field?.verificationIcon === "✕") return { icon: "✕", label: "MISMATCH", tone: "#dc2626", background: "#fee2e2", border: "#fca5a5" };
  return { icon: "?", label: "UNVERIFIED", tone: "#a16207", background: "#fef3c7", border: "#fcd34d" };
}

async function fileToDataUrl(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1200 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d");
  if (!context) {
    bitmap.close();
    throw new Error("Could not prepare the image for storage.");
  }
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL("image/jpeg", 0.72);
}

function Scan() {
  const videoRef = useRef(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraError, setCameraError] = useState("");
  const [categories, setCategories] = useState([]);
  const [images, setImages] = useState([]);
  const [ocr, setOcr] = useState(null);
  const [compliance, setCompliance] = useState(null);
  const [complianceError, setComplianceError] = useState(null);
  const [acceptedFindingIds, setAcceptedFindingIds] = useState([]);
  const [manualViolations, setManualViolations] = useState([]);
  const [selectedCategoryId, setSelectedCategoryId] = useState("");
  const [form, setForm] = useState(emptyForm);
  const [analyzing, setAnalyzing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showRegistration, setShowRegistration] = useState(false);
  const [useExtractedData, setUseExtractedData] = useState(false);
  const [message, setMessage] = useState("");
  const [analysisStartedAt, setAnalysisStartedAt] = useState(null);
  const [analysisElapsedMs, setAnalysisElapsedMs] = useState(0);
  const [analysisDurationMs, setAnalysisDurationMs] = useState(null);

  useEffect(() => {
    apiFetch(`${API_URL}/categories/tree/all`)
      .then((r) => {
        if (!r.ok) throw new Error(r.status === 401 ? "Please sign in first." : "Unable to load categories");
        return r.json();
      })
      .then(setCategories)
      .catch((e) => setMessage(e.message));
  }, []);

  useEffect(() => {
    return () => {
      if (videoRef.current?.srcObject) videoRef.current.srcObject.getTracks().forEach((track) => track.stop());
    };
  }, []);

  useEffect(() => {
    return () => {
      images.forEach((item) => {
        if (item?.url) URL.revokeObjectURL(item.url);
      });
    };
  }, [images]);

  useEffect(() => {
    if (!analyzing || !analysisStartedAt) return undefined;
    const timer = window.setInterval(() => setAnalysisElapsedMs(Date.now() - analysisStartedAt), 100);
    return () => window.clearInterval(timer);
  }, [analyzing, analysisStartedAt]);

  function formatElapsedMs(ms) {
    const seconds = Math.max(0, Math.floor(Number(ms || 0) / 1000));
    return String(Math.floor(seconds / 60)).padStart(2, "0") + ":" + String(seconds % 60).padStart(2, "0");
  }

  const flatCategories = flattenCategories(categories);
  const finalCategories = flatCategories.filter((c) => Boolean(c.isFinalProductType));
  const selectedCategory = flatCategories.find((c) => c.id === selectedCategoryId);
  const violationFindings = useMemo(() => {
    const findings = Array.isArray(compliance?.findings) ? compliance.findings : Array.isArray(compliance?.violations) ? compliance.violations : [];
    return findings.filter((finding) => finding?.status === "VIOLATION" || !finding?.status);
  }, [compliance]);
  const suggestedCategory = useMemo(() => {
    const ai = ocr?.suggestedCategory || ocr?.aiSemantic?.suggestedCategory || null;
    const aiId = ai?.categoryId ? String(ai.categoryId) : "";
    if (aiId) {
      const exact = finalCategories.find((category) => String(category.id) === aiId);
      if (exact) return exact;
    }
    const sourceText = String(ocr?.rawText || "") + " " + fieldValue(ocr, "productName") + " " + fieldValue(ocr, "brandName");
    const text = sourceText.toLowerCase();
    if (!text.trim()) return null;
    return finalCategories
      .filter((category) => text.includes(String(category.name || "").toLowerCase()) || text.includes(String(category.slug || "").replaceAll("-", " ").toLowerCase()))
      .sort((a, b) => b.name.length - a.name.length)[0] || null;
  }, [ocr, finalCategories]);

  function addFiles(files) {
    const selected = Array.from(files || []).filter((file) => file instanceof File && file.type.startsWith("image/"));
    if (!selected.length) return;
    setImages((current) => {
      const remaining = MAX_IMAGES - current.length;
      if (remaining <= 0) return current;
      const accepted = selected.slice(0, remaining).map((file) => ({
        file,
        url: URL.createObjectURL(file),
        dataUrlPromise: fileToDataUrl(file).catch(() => null),
      }));
      return [...current, ...accepted];
    });
    if (images.length + selected.length > MAX_IMAGES) setMessage(`You can retain a maximum of ${MAX_IMAGES} images.`);
    setOcr(null);
    setCompliance(null);
    setAcceptedFindingIds([]);
    setComplianceError(null);
    setShowRegistration(false);
    setUseExtractedData(false);
    setForm(emptyForm);
    setMessage("Images ready for analysis.");
  }

  function handleImages(event) {
    addFiles(event.target.files);
    event.target.value = "";
  }

  async function openCamera() {
    setCameraError("");
    setMessage("");
    if (images.length >= MAX_IMAGES) return setMessage(`You can retain a maximum of ${MAX_IMAGES} images.`);
    if (!navigator.mediaDevices?.getUserMedia) return setCameraError("Camera access is not available in this browser. Use Upload Images instead.");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      setCameraOpen(true);
      requestAnimationFrame(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play().catch(() => {});
        }
      });
    } catch (e) {
      setCameraError(e.name === "NotAllowedError" ? "Camera permission was denied. Allow camera access for localhost." : "Could not open the camera. Check that a webcam is available.");
    }
  }

  function closeCamera() {
    if (videoRef.current?.srcObject) videoRef.current.srcObject.getTracks().forEach((track) => track.stop());
    if (videoRef.current) videoRef.current.srcObject = null;
    setCameraOpen(false);
  }

  function capturePhoto() {
    const video = videoRef.current;
    if (!video || video.readyState < 2) return setCameraError("Camera is still starting. Try again in a moment.");
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d");
    if (!context) return setCameraError("Could not capture the image.");
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => {
      if (!blob) return setCameraError("Could not capture the image.");
      const file = new File([blob], `camera-${Date.now()}.jpg`, { type: "image/jpeg" });
      addFiles([file]);
      closeCamera();
    }, "image/jpeg", 0.88);
  }

  function removeImage(index) {
    setImages((current) => {
      const target = current[index];
      if (target?.url) URL.revokeObjectURL(target.url);
      return current.filter((_, i) => i !== index);
    });
    setOcr(null);
    setCompliance(null);
    setAcceptedFindingIds([]);
    setComplianceError(null);
    setShowRegistration(false);
    setUseExtractedData(false);
    setForm(emptyForm);
  }

  async function analyzeImages() {
    if (!images.length) return setMessage("Add at least one package image first.");
    const startedAt = Date.now();
    setAnalysisStartedAt(startedAt);
    setAnalysisElapsedMs(0);
    setAnalysisDurationMs(null);
    setAnalyzing(true);
    setMessage("Running RapidOCR primary OCR + semantic analysis...");
    try {
      let extracted;
      try {
        const formData = new FormData();
        images.forEach(({ file }) => formData.append("images", file));
        formData.append("categoryOptions", JSON.stringify(finalCategories.map((item) => ({ id: item.id, name: item.name, path: item.path.map((x) => x.name).join(" → ") }))));
        const rapidResponse = await apiFetch(API_URL + "/ocr/analyze", { method: "POST", body: formData });
        const rapidData = await rapidResponse.json().catch(() => ({}));
        if (!rapidResponse.ok || !rapidData.result) throw new Error(rapidData?.error?.message || rapidData?.error || "RapidOCR analysis failed.");
        extracted = rapidData.result;
      } catch (rapidError) {
        throw rapidError;
      }
      setMessage("OCR complete. Running Legal Metrology Rules Engine...");
      const response = await apiFetch(PUTER_EVALUATE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ocr: extracted,
          inspectionId: crypto.randomUUID(),
          productId: crypto.randomUUID(),
          inspectionDate: new Date().toISOString().slice(0, 10),
          context: "physical_package",
          commodityCategory: selectedCategory?.name || "packaged commodity",
          consumerType: "general",
          isImported: false,
          packageType: "retail",
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : data.error?.message || "Rules Engine evaluation failed");
      const findings = Array.isArray(data.compliance?.findings) ? data.compliance.findings : Array.isArray(data.compliance?.violations) ? data.compliance.violations : [];
      const violations = findings.filter((finding) => finding?.status === "VIOLATION" || !finding?.status);
      setAcceptedFindingIds(violations.map((finding, index) => String(finding.findingId ?? finding.ruleId ?? `violation-${index}`)));
      setOcr(extracted);
      setCompliance(data.compliance || null);
      setComplianceError(data.complianceError || null);
      setForm(emptyForm);
      setShowRegistration(false);
      setUseExtractedData(false);
      setMessage(data.complianceError ? `OCR complete. Rules Engine unavailable: ${data.complianceError.message}` : "OCR and Rules Engine analysis complete. Review the extracted data, then register the product.");
    } catch (e) {
      setMessage(e.message || "OCR analysis failed.");
    } finally {
      const elapsed = startedAt ? Date.now() - startedAt : 0;
      setAnalysisElapsedMs(elapsed);
      setAnalysisDurationMs(elapsed);
      setAnalysisStartedAt(null);
      setAnalyzing(false);
    }
  }

  function updateOcrField(key, value) {
    setOcr((current) => current ? { ...current, [key]: { ...current[key], value } } : current);
  }

  function applyExtractedData() {
    if (!ocr) return;
    setForm(formFromOcr(ocr));
    setUseExtractedData(true);
    setShowRegistration(true);
    setMessage("Extracted data applied to the registration form. Review and edit the fields before registering.");
  }

  function openRegistration() {
    setShowRegistration(true);
    setUseExtractedData(false);
    setForm(emptyForm);
    setMessage(ocr ? "Registration opened. Choose Use extracted data to populate the form, or enter everything manually." : "Manual registration opened.");
  }

  function toggleFinding(finding, index) {
    const id = String(finding?.findingId ?? finding?.ruleId ?? `violation-${index}`);
    setAcceptedFindingIds((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]);
  }

  function isFindingAccepted(finding, index) {
    const id = String(finding?.findingId ?? finding?.ruleId ?? `violation-${index}`);
    return acceptedFindingIds.includes(id);
  }

  function updateForm(key, value) { setForm((current) => ({ ...current, [key]: value })); }
  const [manualRuleCode, setManualRuleCode] = useState("");
  const [manualRuleNumber, setManualRuleNumber] = useState("");
  const [manualViolationReason, setManualViolationReason] = useState("");

  function addManualViolation() {
    const isCustom = manualRuleCode === "CUSTOM";
    const selectedRule = ENGINE_RULE_OPTIONS.find(([code]) => code === manualRuleCode);
    const number = isCustom ? manualRuleNumber.trim() : selectedRule?.[1];
    const reason = manualViolationReason.trim();
    if (!number) return setMessage("Select a Rules Engine category or enter a custom rule number.");
    if (!reason) return setMessage("Describe the observed violation.");
    const title = isCustom ? "Custom / other Legal Metrology rule" : selectedRule?.[2];
    const statement = isCustom ? "Statement supplied by the inspector; verify against the applicable law." : selectedRule?.[3];
    const code = isCustom ? "CUSTOM-" + number : selectedRule?.[0];
    setManualViolations((items) => [...items, {
      findingId: "MANUAL-" + crypto.randomUUID(),
      ruleCode: code,
      ruleNumber: number,
      title,
      ruleStatement: statement,
      status: "VIOLATION",
      severity: "REVIEW",
      message: reason
    }]);
    setManualRuleCode("");
    setManualRuleNumber("");
    setManualViolationReason("");
    setMessage("Manual violation added under Rule " + number + ".");
  }

  function removeManualViolation(id) {
    setManualViolations((items) => items.filter((item) => item.findingId !== id));
  }

  async function saveProduct(event) {
    event.preventDefault();
    if (!selectedCategoryId || !selectedCategory) return setMessage("Final category is required.");
    if (!form.shopName.trim()) return setMessage("Shop name is required.");
    setSaving(true);
    try {
      const imageUrls = (await Promise.all(images.map(({ file, dataUrlPromise }) => dataUrlPromise || fileToDataUrl(file)))).filter(Boolean);
      const effectiveViolationIds = [...acceptedFindingIds, ...manualViolations.map((item) => item.findingId)];
      const presentationNeedsReview = Number(ocr?.presentationChecks?.summary?.smallTextReview || 0) > 0 || Number(ocr?.presentationChecks?.summary?.notLocated || 0) > 0;
      const rulesStatus = compliance?.overallStatus;
      const status = effectiveViolationIds.length ? "VIOLATION" : rulesStatus === "UNABLE_TO_VERIFY" || !compliance || ocr?.needsReview || presentationNeedsReview ? "NEEDS_REVIEW" : "OKAY";
      const reason = status === "VIOLATION" ? "Rules Engine reported one or more compliance violations." : ocr?.needsReview ? "OCR contains low-confidence or unreadable fields and requires review." : "Automated OCR and Rules Engine assessment completed.";
      const response = await apiFetch(`${API_URL}/products`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, categoryId: selectedCategoryId, imageUrls, ocrData: { ocr, compliance: compliance || null, complianceError: complianceError || null, presentationChecks: ocr?.presentationChecks || null, manualViolations }, acceptedFindingIds: effectiveViolationIds, manualViolations, complianceStatus: status, violationReason: reason, inspectionDate: new Date().toISOString() }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not save product");
      const productId = data.product?.id || data.id;
      if (!productId) throw new Error("Product was saved but the server did not return its ID.");
      window.location.href = `/products/item/${productId}`;
    } catch (e) {
      setMessage(e.message);
    } finally {
      setSaving(false);
    }
  }

  return <div className="scan-page">
    <div className="page-header"><p className="eyebrow">PRODUCT INSPECTION</p><h1>Scan Product</h1><p>Capture or upload package images, extract declarations, run the Legal Metrology Rules Engine, then register the inspected product.</p></div>
    <section className="scan-area"><div className="scan-icon">⌁</div><h2>Capture or upload package images</h2><p>Use the camera or choose up to {MAX_IMAGES} images showing different sides of the package.</p><div className="scan-upload-actions"><button type="button" className="primary-button" onClick={openCamera}>Open Camera</button><label className="secondary-button scan-file-button">Upload Images<input type="file" accept="image/*" multiple onChange={handleImages} hidden /></label></div><p className="scan-limit">{images.length}/{MAX_IMAGES} images selected</p>{cameraError && <div className="status-message">{cameraError}</div>}</section>
    {cameraOpen && <div className="camera-overlay" role="dialog" aria-modal="true"><div className="camera-modal"><div className="camera-header"><h2>Capture package image</h2><button type="button" onClick={closeCamera}>Close</button></div><video ref={videoRef} className="camera-video" autoPlay playsInline muted /><div className="camera-actions"><button type="button" className="primary-button" onClick={capturePhoto}>Capture Photo</button><button type="button" className="secondary-button" onClick={closeCamera}>Cancel</button></div></div></div>}
    {images.length > 0 && <section className="scan-review"><div className="section-heading"><div><h2>Evidence images</h2><p>All selected images will be retained on the registered product.</p></div></div><div className="scan-image-grid">{images.map(({ url, file }, i) => <div className="scan-image-card" key={`${file.name}-${i}`}><img src={url} alt={`Package evidence ${i + 1}`} /><button type="button" onClick={() => removeImage(i)}>Remove</button><span>{file.name}</span></div>)}</div><button type="button" className="primary-button" onClick={analyzeImages} disabled={analyzing}>{analyzing ? "Analyzing..." : "Analyze Images"}</button></section>}
    {ocr && <section className="scan-review"><div className="section-heading"><div><h2>OCR extraction and Rules Engine result</h2><p>Edit the extracted values here if OCR needs correction. Use the registration actions below to carry them into the editable product form.</p></div></div><div className="ocr-fields-grid">{Object.entries(ocr).filter(([key, value]) => key !== "rawText" && value && typeof value === "object" && ["found","absent","unreadable","ambiguous"].includes(value.status)).map(([key, value]) => { const badge = verificationBadge(value); const overall = Number.isFinite(Number(value?.evidenceConfidence)) ? Math.round(Number(value.evidenceConfidence) * 100) : Math.round(Number(value?.confidence || 0) * 100); const sources = value?.confidenceSources || {}; return <label key={key} className="ocr-edit-field" style={{ position: "relative" }}><div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 6 }}><strong>{key.replace(/([A-Z])/g, " $1")}</strong><span title={badge.label} style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 7px", borderRadius: 999, border: `1px solid ${badge.border}`, background: badge.background, color: badge.tone, fontWeight: 800, fontSize: 11, letterSpacing: 0.3, whiteSpace: "nowrap" }}>{badge.icon} {badge.label}</span></div><input value={value.value ?? ""} placeholder={value.status === "found" ? "Review value" : value.status} onChange={(e) => updateOcrField(key, e.target.value)} /><small>{value.status === "found" ? <>{value?.evidenceConfidence != null ? `${overall}% evidence confidence` : `${overall}% confidence`} · DataKart {sources.datakart == null ? "—" : `${Math.round(sources.datakart * 100)}%`} · Gemini {sources.gemini == null ? "—" : `${Math.round(sources.gemini * 100)}%`} · RapidOCR {sources.rapidocr == null ? "—" : `${Math.round(sources.rapidocr * 100)}%`}</> : value.status}</small></label>; })}</div><div className="ocr-status-grid"><div><strong>Rules Engine</strong><span>{compliance?.overallStatus || "Not evaluated"}</span></div><div><strong>Evidence confidence</strong><span>{ocr.evidenceConfidence ? `${ocr.evidenceConfidence.weights.datakart * 100}% DataKart · ${ocr.evidenceConfidence.weights.gemini * 100}% Gemini · ${ocr.evidenceConfidence.weights.rapidocr * 100}% RapidOCR` : (ocr.needsReview ? "Review required" : "Confident")}</span></div><div><strong>Unreadable fields</strong><span>{ocr.unreadableFields?.length || 0}</span></div></div>{ocr?.presentationChecks && <div className="presentation-check-panel">
  <div className="section-heading"><div><h3>Readability, text-size & placement screening</h3><p>Assistive visual screening for SIH-required readability, font-size and placement checks. Exact statutory font-size measurement still requires calibrated officer verification.</p></div></div>
  <div className="ocr-status-grid">
    <div><strong>Readable signals</strong><span>{ocr.presentationChecks.summary?.likelyReadable ?? 0}</span></div>
    <div><strong>Small-text review</strong><span>{ocr.presentationChecks.summary?.smallTextReview ?? 0}</span></div>
    <div><strong>Declarations located</strong><span>{ocr.presentationChecks.summary?.located ?? 0}</span></div>
  </div>
  <div className="presentation-check-list">
    {Object.values(ocr.presentationChecks.rows || {}).filter((row) => row.value || row.status !== "absent").map((row) => <details key={row.field} className="rule-review-dropdown">
      <summary><span><strong>{row.field.replace(/([A-Z])/g, " $1")}</strong><small>{row.readability} · {row.fontSizeScreening} · {row.placement}</small></span></summary>
      <div className="rule-review-dropdown-body"><p><strong>Detected value</strong>{row.value || "Not established"}</p><p><strong>Placement</strong>{row.zone || "Not spatially located"}</p><p><strong>Evidence</strong>{row.evidenceText || "No matching OCR evidence"}</p></div>
    </details>)}
  </div>
</div>}{complianceError && <div className="status-message">Rules Engine: {complianceError.message}</div>}{compliance?.summary && <div className="ocr-summary">Rules: {compliance.summary.totalRulesEvaluated} · Passed: {compliance.summary.passed} · Violations: {compliance.summary.violations} · Unable to verify: {compliance.summary.unableToVerify}</div>}{violationFindings.length > 0 && <div className="finding-review rule-review-panel">
  <strong>Inspector review of detected violations</strong>
  <p>Checked findings are accepted into the final inspection. Unchecked findings remain in the audit record as rejected by the inspector.</p>
  {violationFindings.map((v, i) => {
    const meta = ruleMeta(v);
    return <details key={"finding-" + i} className="rule-review-dropdown">
      <summary>
        <input type="checkbox" checked={isFindingAccepted(v, i)} onChange={() => toggleFinding(v, i)} onClick={(e) => e.stopPropagation()} />
        <span><strong>Rule {meta.number || meta.code}</strong><small>{meta.code} · {v.severity || "REVIEW"}</small><em>{meta.title}</em></span>
      </summary>
      <div className="rule-review-dropdown-body">
        <p><strong>Rule statement</strong>{meta.statement}</p>
        <p><strong>Detected issue</strong>{v.message || v.reason || "Potential non-compliance detected."}</p>
      </div>
    </details>;
  })}
  <small>{acceptedFindingIds.length} of {violationFindings.length} detected violations accepted</small>
</div>}
<div className="manual-violation-panel rule-review-panel">
  <strong>Add violation by Rules Engine category</strong>
  <p>Select a configured rule and record the observed non-compliance.</p>
  <label>Rules Engine category
    <select value={manualRuleCode} onChange={(e) => setManualRuleCode(e.target.value)}>
      <option value="">Select rule</option>
      {ENGINE_RULE_OPTIONS.map(([code, number, title]) => <option key={code} value={code}>Rule {number} · {title}</option>)}
      <option value="CUSTOM">Custom / other</option>
    </select>
  </label>
  {ENGINE_RULE_OPTIONS.find(([code]) => code === manualRuleCode) && <div className="rule-reference-preview">
    <strong>Rule {ENGINE_RULE_OPTIONS.find(([code]) => code === manualRuleCode)[1]} statement</strong>
    <span>{ENGINE_RULE_OPTIONS.find(([code]) => code === manualRuleCode)[3]}</span>
  </div>}
  {manualRuleCode === "CUSTOM" && <label>Custom rule number<input value={manualRuleNumber} onChange={(e) => setManualRuleNumber(e.target.value)} placeholder="Example: 32" /></label>}
  <label>Observed violation<textarea value={manualViolationReason} onChange={(e) => setManualViolationReason(e.target.value)} placeholder="Describe the observed non-compliance..." /></label>
  <button type="button" className="secondary-button" onClick={addManualViolation}>Add violation</button>
  {manualViolations.map((v) => <details key={v.findingId} className="rule-review-dropdown">
    <summary><span><strong>Rule {v.ruleNumber}</strong><small>{v.ruleCode} · Manual</small><em>{v.title}</em></span></summary>
    <div className="rule-review-dropdown-body">
      <p><strong>Rule statement</strong>{v.ruleStatement}</p>
      <p><strong>Observation</strong>{v.message}</p>
      <button type="button" className="secondary-button" onClick={() => removeManualViolation(v.findingId)}>Remove</button>
    </div>
  </details>)}
</div>}<label>Raw OCR<textarea value={ocr.rawText || ""} onChange={(e) => setOcr((c) => ({ ...c, rawText: e.target.value }))} /></label>{suggestedCategory && <div className="scan-suggestion"><span>Suggested final category: <strong>{suggestedCategory.path.map((x) => x.name).join(" → ")}</strong></span><button type="button" className="secondary-button" onClick={() => setSelectedCategoryId(suggestedCategory.id)}>Use suggestion</button></div>}<div className="scan-upload-actions register-after-ocr"><button type="button" className="primary-button" onClick={openRegistration}>Register Product</button><button type="button" className="secondary-button" onClick={applyExtractedData}>Use extracted data</button></div></section>}
    {!showRegistration && <section className="scan-review registration-form"><div className="section-heading"><div><h2>Register product</h2><p>Register manually, or after OCR use the extracted result to prefill the registration form.</p></div></div><div className="scan-upload-actions"><button type="button" className="primary-button" onClick={openRegistration}>{ocr ? "Open Registration" : "Register Manually"}</button></div></section>}
    {showRegistration && <form className="scan-review registration-form" onSubmit={saveProduct}><div className="section-heading"><div><h2>Register product</h2><p>{ocr ? "Use extracted data to populate this form, then edit the final values before registering." : "Manual registration: package images are retained, but OCR is skipped."}</p></div></div>{ocr && <div className="scan-upload-actions extracted-data-actions"><button type="button" className="secondary-button" onClick={applyExtractedData}>Use extracted data</button>{useExtractedData && <span>Extracted data applied. All fields remain editable.</span>}</div>}<div className="form-grid"><label>Brand / Manufacturer<input value={form.brandName} onChange={(e) => updateForm("brandName", e.target.value)} /></label><label>Product name *<input required value={form.productName} onChange={(e) => updateForm("productName", e.target.value)} /></label><label>Quantity / volume / pieces<input value={form.netQuantity} onChange={(e) => updateForm("netQuantity", e.target.value)} /></label><label>Unit<select value={form.unit} onChange={(e) => updateForm("unit", e.target.value)}><option value="">Select</option><option value="mg">mg</option><option value="g">g</option><option value="kg">kg</option><option value="ml">ml</option><option value="L">L</option><option value="pcs">pcs</option><option value="dozen">dozen</option><option value="m">m</option></select></label><label>MRP<input type="number" min="0" step="0.01" value={form.mrp} onChange={(e) => updateForm("mrp", e.target.value)} /></label><label>Barcode<input value={form.barcode} onChange={(e) => updateForm("barcode", e.target.value)} /></label><label className="full-width">Final category *<select required value={selectedCategoryId} onChange={(e) => setSelectedCategoryId(e.target.value)}><option value="">Select a final category</option>{finalCategories.map((c) => <option key={c.id} value={c.id}>{c.path.map((x) => x.name).join(" → ")}</option>)}</select></label><label>Shop name *<input required value={form.shopName} onChange={(e) => updateForm("shopName", e.target.value)} /></label><label>Shop address<input value={form.shopAddress} onChange={(e) => updateForm("shopAddress", e.target.value)} /></label><label>City<input value={form.shopCity} onChange={(e) => updateForm("shopCity", e.target.value)} /></label><label>State<input value={form.shopState} onChange={(e) => updateForm("shopState", e.target.value)} /></label><label className="full-width">Notes<textarea value={form.notes} onChange={(e) => updateForm("notes", e.target.value)} /></label></div><button className="primary-button" disabled={saving}>{saving ? "Registering..." : "Register Product"}</button></form>}
    {message && <div className="status-message">{message}</div>}<Link className="back-link" to="/history">View inspection history →</Link>
  </div>;
}

export default Scan;