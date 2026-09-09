import "dotenv/config";
import express from "express";
import crypto from "node:crypto";
import { authenticate } from "../middleware/auth.js";

const router = express.Router();

function fieldSource(fieldName) {
  const map = {
    productName: "PRODUCT_NAME", brandName: "BRAND", manufacturer: "MANUFACTURER", manufacturerAddress: "ADDRESS",
    packer: "PACKER", packerAddress: "ADDRESS", marketer: "MARKETER", importer: "IMPORTER", importerAddress: "ADDRESS",
    netQuantity: "NET_QUANTITY", unit: "NET_QUANTITY", mrp: "MRP", currency: "MRP",
    dateOfManufacture: "DATE_OF_MANUFACTURE", dateOfPacking: "DATE_OF_PACKING", bestBefore: "BEST_BEFORE",
    expiryDate: "EXPIRY_DATE", batchNumber: "BATCH_NUMBER", consumerCarePhone: "CONSUMER_CARE",
    consumerCareEmail: "CONSUMER_CARE", countryOfOrigin: "COUNTRY_OF_ORIGIN", fssaiLicenseNumber: "FSSAI_LICENSE",
    barcode: "BARCODE",
  };
  return map[fieldName] || fieldName.toUpperCase();
}

function addEvidence(evidence, field, item, sourceType = "OCR", explicitField = field) {
  if (!item || typeof item !== "object" || item.status !== "found" || item.value == null || String(item.value).trim() === "") return;
  evidence.push({
    evidenceId: `ocr-${field}-${crypto.randomUUID()}`,
    field: explicitField,
    rawValue: item.raw ?? item.evidence ?? item.value,
    normalizedValue: item.value,
    unit: field === "unit" ? String(item.value) : undefined,
    confidence: Math.max(0, Math.min(1, Number(item.confidence) || 0.45)),
    source: sourceType,
    sourceImageRef: item.imageIndex != null ? `image-${Number(item.imageIndex) + 1}` : undefined,
    timestamp: new Date().toISOString(),
    reliability: "HIGH",
  });
}

function makeRulesEvidence(ocr, datakartVerification = null) {
  const declarations = Array.isArray(ocr?.declarationEvidence) ? ocr.declarationEvidence : [];
  const evidence = [];

  for (const [field, item] of Object.entries(ocr || {})) {
    if (!item || typeof item !== "object" || item.status !== "found" || item.value == null || field === "semantic") continue;
    const type = fieldSource(field);
    const declaration = declarations.find((entry) => entry.type === type);
    evidence.push({
      evidenceId: `ocr-${field}-${crypto.randomUUID()}`,
      field,
      rawValue: item.raw ?? item.evidence ?? item.value,
      normalizedValue: item.value,
      unit: field === "unit" ? String(item.value) : undefined,
      confidence: Math.max(0, Math.min(1, Number(item.confidence) || 0.45)),
      source: "OCR",
      sourceImageRef: declaration ? `image-${Number(declaration.imageIndex) + 1}` : undefined,
      timestamp: new Date().toISOString(),
      reliability: "HIGH",
    });
  }

  addEvidence(evidence, "mrp", ocr.mrp, "OCR", "declarations.retailSalePrice");
  addEvidence(evidence, "netQuantity", ocr.netQuantity, "OCR", "declarations.netQuantity");
  addEvidence(evidence, "unit", ocr.unit, "OCR", "declarations.netQuantityUnit");
  addEvidence(evidence, "productName", ocr.productName, "OCR", "declarations.commonOrGenericName");
  addEvidence(evidence, "manufacturer", ocr.manufacturer, "OCR", "declarations.manufacturerOrPacker");
  addEvidence(evidence, "manufacturerAddress", ocr.manufacturerAddress, "OCR", "declarations.completeAddress");
  addEvidence(evidence, "packerAddress", ocr.packerAddress, "OCR", "declarations.completeAddress");
  addEvidence(evidence, "importerAddress", ocr.importerAddress, "OCR", "declarations.completeAddress");
  addEvidence(evidence, "dateOfManufacture", ocr.dateOfManufacture, "OCR", "declarations.manufactureOrImportDate");
  addEvidence(evidence, "dateOfPacking", ocr.dateOfPacking, "OCR", "declarations.manufactureOrImportDate");

  const consumerContactEvidence = ocr.consumerCarePhone?.status === "found" || ocr.consumerCareEmail?.status === "found";
  if (consumerContactEvidence) {
    const phone = ocr.consumerCarePhone?.value || "";
    const email = ocr.consumerCareEmail?.value || "";
    evidence.push({
      evidenceId: `ocr-consumer-contact-${crypto.randomUUID()}`,
      field: "declarations.consumerComplaintContact",
      rawValue: [phone, email].filter(Boolean).join(" / "),
      normalizedValue: [phone, email].filter(Boolean).join(" / "),
      confidence: Math.max(Number(ocr.consumerCarePhone?.confidence || 0), Number(ocr.consumerCareEmail?.confidence || 0)),
      source: "OCR",
      timestamp: new Date().toISOString(),
      reliability: "HIGH",
    });
  }

  if (datakartVerification?.found && datakartVerification.comparison) {
    for (const [field, comparison] of Object.entries(datakartVerification.comparison.comparisons || {})) {
      evidence.push({
        evidenceId: `datakart-${field}-${crypto.randomUUID()}`,
        field: `reference.${field}`,
        rawValue: comparison.referenceValue,
        normalizedValue: comparison.referenceValue,
        confidence: Number(comparison.score || 0),
        source: "DATAKART_REFERENCE",
        referenceGtin: datakartVerification.gtin,
        match: Boolean(comparison.match),
        timestamp: new Date().toISOString(),
        reliability: "REFERENCE",
      });
    }
  }

  return evidence;
}

async function evaluateRules(req, ocr) {
  const rulesEngineUrl = process.env.RULES_ENGINE_URL || "http://localhost:8090";
  const datakartVerification = req.body?.datakartVerification || null;
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
    evidence: makeRulesEvidence(ocr, datakartVerification),
    visualFlags: req.body?.visualFlags || {},
    referenceVerification: datakartVerification ? {
      source: "DataKart",
      gtin: datakartVerification.gtin || null,
      found: Boolean(datakartVerification.found),
      matchedFields: datakartVerification.comparison?.matchedFields || 0,
      comparedFields: datakartVerification.comparison?.comparedFields || 0,
      matchRate: datakartVerification.comparison?.matchRate ?? null,
      confidence: req.body?.verificationConfidence || null,
    } : null,
  };

  const response = await fetch(`${rulesEngineUrl}/api/rules-engine/evaluate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(Number(process.env.RULES_ENGINE_TIMEOUT_MS || "15000")),
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = data?.error || data?.message || data?.detail || `Rules Engine failed (${response.status}).`;
    throw new Error(`${detail} [status=${response.status}; url=${rulesEngineUrl}]`);
  }
  return data;
}

router.post("/evaluate-structured", authenticate, async (req, res) => {
  try {
    const ocr = req.body?.ocr;
    if (!ocr || typeof ocr !== "object") return res.status(400).json({ error: "Missing structured OCR result." });
    const compliance = await evaluateRules(req, ocr);
    res.json({ compliance, complianceError: null });
  } catch (error) {
    console.error("[ocr:evaluate-structured]", error);
    res.status(200).json({
      compliance: null,
      complianceError: { message: error?.message || "Rules Engine evaluation failed." },
    });
  }
});

export default router;
