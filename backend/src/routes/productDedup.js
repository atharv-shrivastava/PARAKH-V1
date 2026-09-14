import express from "express";
import prisma from "../lib/prisma.js";
import { authenticate } from "../middleware/auth.js";
import { parakhIdFor, productFingerprint } from "../lib/productIdentity.js";

const router = express.Router();
router.use(authenticate);

function parseStoredOcr(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return {}; }
}

function identityInput(product) {
  return {
    ...product,
    ocrData: product.ocrData,
  };
}

function requestIdentity(body) {
  return {
    productName: body.productName,
    brandName: body.brandName,
    manufacturerName: body.manufacturerName,
    netQuantity: body.netQuantity,
    unit: body.unit,
    mrp: body.mrp,
    barcode: body.barcode,
    batchNumber: body.batchNumber,
    ocrData: body.ocrData,
    compliance: body.compliance,
  };
}

function candidateWhere(body) {
  const barcode = String(body.barcode || "").replace(/\D/g, "");
  const productName = String(body.productName || "").trim();
  if (barcode) return { barcode: { contains: barcode } };
  if (productName) {
    const firstToken = productName.split(/\s+/).filter(Boolean).slice(0, 3).join(" ");
    return { productName: { contains: firstToken || productName, mode: "insensitive" } };
  }
  return {};
}

async function findDuplicate(body) {
  const targetFingerprint = productFingerprint(requestIdentity(body));
  const where = candidateWhere(body);
  const selected = {
    id: true,
    brandName: true,
    manufacturerName: true,
    productName: true,
    ocrData: true,
    netQuantity: true,
    unit: true,
    mrp: true,
    barcode: true,
    imageUrl: true,
    imageUrls: true,
    complianceStatus: true,
    violationReason: true,
    sourceType: true,
    sourceUrl: true,
    sourceWebsiteName: true,
    ownerId: true,
    categoryId: true,
    createdAt: true,
    updatedAt: true,
  };

  const candidates = await prisma.product.findMany({ where, select: selected, orderBy: { createdAt: "asc" }, take: 5000 });
  let match = candidates.find((product) => productFingerprint(identityInput(product)) === targetFingerprint) || null;

  if (!match && candidates.length < 5000 && Object.keys(where).length) {
    const all = await prisma.product.findMany({ select: selected, orderBy: { createdAt: "asc" }, take: 5000 });
    match = all.find((product) => productFingerprint(identityInput(product)) === targetFingerprint) || null;
  }

  return match;
}

router.get("/:id", async (req, res, next) => {
  try {
    const product = await prisma.product.findFirst({
      where: { id: req.params.id, ...(req.user.role === "ADMIN" ? {} : { ownerId: req.user.id }) },
      include: {
        owner: { select: { id: true, name: true, email: true } },
        category: { include: { parent: { include: { parent: { include: { parent: true } } } } } },
        inspections: { include: { shop: true, worker: { select: { name: true } } }, orderBy: { inspectedAt: "desc" } },
      },
    });
    if (!product) return res.status(404).json({ error: "Product not found" });
    return res.json({ ...product, parakhId: parakhIdFor(identityInput(product)), productFingerprint: productFingerprint(identityInput(product)) });
  } catch (error) {
    next(error);
  }
});

router.post("/", async (req, res, next) => {
  try {
    const body = req.body || {};
    const duplicate = await findDuplicate(body);

    if (!duplicate) return next();

    const parakhId = parakhIdFor(identityInput(duplicate));
    return res.status(409).json({
      error: `COPY OF EXISTING PRODUCT. Same deterministic PARAKH ID: ${parakhId}. Product registration was not created again.`,
      status: "COPY",
      copy: true,
      duplicate: true,
      parakhId,
      productFingerprint: productFingerprint(identityInput(duplicate)),
      existingProductId: duplicate.id,
      existingProduct: duplicate,
    });
  } catch (error) {
    console.error("Product fingerprint deduplication check failed:", error);
    next(error);
  }
});

export default router;
