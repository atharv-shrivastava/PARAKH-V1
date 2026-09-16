import express from "express";
import multer from "multer";
import crypto from "node:crypto";
import { authenticate } from "../middleware/auth.js";

const router = express.Router();
router.use(authenticate);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 6, fileSize: 12 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = new Set(["image/jpeg", "image/png", "image/webp"]);
    cb(allowed.has(file.mimetype) ? null : new Error("Only JPEG, PNG and WebP images are supported."), allowed.has(file.mimetype));
  },
});

function text(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function buildTargets(ocr) {
  const targetFields = new Set([
    "productName", "netQuantity", "mrp", "dateOfManufacture", "dateOfPacking", "bestBefore",
    "expiryDate", "batchNumber", "consumerCarePhone", "consumerCareEmail", "manufacturer",
    "packer", "importer", "brandName",
  ]);
  return Object.entries(ocr || {}).flatMap(([field, item]) => {
    if (!targetFields.has(field) || !item || typeof item !== "object" || !item.boundingBox) return [];
    return [{
      field,
      imageIndex: Number.isInteger(item.imageIndex) ? item.imageIndex : 0,
      text: text(item.evidence || item.raw || item.value),
      boundingBox: item.boundingBox,
    }];
  });
}

function makeRulesEvidence(ocr) {
  return Object.entries(ocr || {}).flatMap(([field, item]) => {
    if (!item || typeof item !== "object" || item.status !== "found" || item.value == null) return [];
    const confidence = Number(item.confidence || 0);
    if (confidence < 0.30) return [];
    const mapped = {
      mrp: "declarations.retailSalePrice",
      netQuantity: "declarations.netQuantity",
      unit: "declarations.netQuantityUnit",
      productName: "declarations.commonOrGenericName",
      manufacturer: "declarations.manufacturerOrPacker",
      manufacturerAddress: "declarations.completeAddress",
      packerAddress: "declarations.completeAddress",
      importerAddress: "declarations.completeAddress",
      dateOfManufacture: "declarations.manufactureOrImportDate",
      dateOfPacking: "declarations.manufactureOrImportDate",
      consumerCarePhone: "declarations.consumerComplaintContact",
      consumerCareEmail: "declarations.consumerComplaintContact",
    };
    const legalField = mapped[field];
    if (!legalField) return [];
    return [{
      evidenceId: `font-vision-${field}-${crypto.randomUUID()}`,
      field: legalField,
      rawValue: item.raw ?? item.evidence ?? item.value,
      normalizedValue: item.value,
      confidence: Math.max(0, Math.min(1, confidence)),
      source: "OCR",
      sourceImageRef: item.imageIndex != null ? `image-${Number(item.imageIndex) + 1}` : undefined,
      timestamp: new Date().toISOString(),
      reliability: confidence >= 0.70 ? "HIGH" : "LOW",
    }];
  });
}

async function runVision(files, targets, panelArea, surfaceType) {
  const visionUrl = process.env.OPENCV_VISION_URL || "http://localhost:8082";
  const form = new FormData();
  for (const [index, file] of files.entries()) {
    form.append("images", new Blob([file.buffer], { type: file.mimetype }), file.originalname || `package-${index + 1}.jpg`);
  }
  form.append("targets", JSON.stringify(targets));
  if (panelArea != null && panelArea !== "") form.append("principal_display_panel_area_cm2", String(panelArea));
  form.append("surface_type", surfaceType || "normal");

  let response;
  try {
    response = await fetch(`${visionUrl}/api/vision/font-size`, { method: "POST", body: form });
  } catch (error) {
    throw new Error(`OpenCV vision service unavailable: ${error.message}`);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.detail || data?.error || `OpenCV vision failed (${response.status}).`);
  return data;
}

async function evaluateRules(req, ocr, vision) {
  const rulesEngineUrl = process.env.RULES_ENGINE_URL || "http://localhost:8090";
  const body = {
    inspectionId: req.body?.inspectionId || crypto.randomUUID(),
    productId: req.body?.productId || crypto.randomUUID(),
    inspectionDate: req.body?.inspectionDate || new Date().toISOString().slice(0, 10),
    context: req.body?.context || "physical_package",
    productMetadata: {
      brandName: ocr?.brandName?.value || undefined,
      commodityCategory: req.body?.commodityCategory || "packaged commodity",
      consumerType: req.body?.consumerType || "general",
      isImported: Boolean(req.body?.isImported),
      countryOfOrigin: ocr?.countryOfOrigin?.value || undefined,
      packageType: req.body?.packageType || "retail",
    },
    evidence: makeRulesEvidence(ocr),
    visualFlags: {
      ...(req.body?.visualFlags || {}),
      principalDisplayPanelAreaCm2: Number(vision.principalDisplayPanelAreaCm2 || req.body?.principalDisplayPanelAreaCm2 || 0) || undefined,
      surfaceType: vision.surfaceType || req.body?.surfaceType || "normal",
      rule7FontSizeMeasurements: vision.measurements || [],
      fontSizeCalibrationReference: vision.calibrationReference || null,
    },
  };

  const response = await fetch(`${rulesEngineUrl}/api/rules-engine/evaluate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(Number(process.env.RULES_ENGINE_TIMEOUT_MS || "15000")),
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error || data?.message || `Rules Engine failed (${response.status}).`);
  return data;
}

router.post("/font-size-compliance", upload.array("images", 6), async (req, res) => {
  try {
    const files = Array.isArray(req.files) ? req.files : [];
    if (!files.length) return res.status(400).json({ error: "At least one package image is required." });
    let ocr = {};
    try { ocr = JSON.parse(req.body?.ocr || "{}"); } catch { return res.status(400).json({ error: "Invalid OCR JSON payload." }); }

    const targets = buildTargets(ocr);
    const vision = await runVision(files, targets, req.body?.principalDisplayPanelAreaCm2, req.body?.surfaceType || "normal");
    const compliance = await evaluateRules(req, ocr, vision);

    return res.json({
      vision,
      compliance,
      rule: {
        ruleNumber: "7",
        basis: "principal_display_panel_area",
        calibrationReference: "Indian ₹10 coin, 27 mm diameter",
      },
    });
  } catch (error) {
    console.error("[font-size-compliance]", error);
    return res.status(502).json({ error: error?.message || "Font-size compliance workflow failed." });
  }
});

export default router;
