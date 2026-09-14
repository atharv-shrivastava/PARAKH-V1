import express from "express";
import prisma from "../lib/prisma.js";
import { authenticate } from "../middleware/auth.js";

const router = express.Router();
router.use(authenticate);

function normalizeText(value) {
  return String(value || "")
    .normalize("NFKC")
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("en-IN");
}

function normalizeBarcode(value) {
  return String(value || "").replace(/\D/g, "");
}

function normalizeQuantity(value) {
  const match = String(value || "").replace(/,/g, "").match(/\d+(?:\.\d+)?/);
  return match ? match[0] : normalizeText(value);
}

function displayParakhId(product) {
  return product?.parakhId || (product?.id ? `PARAKH-${String(product.id).toUpperCase()}` : "Not available");
}

router.post("/", async (req, res, next) => {
  try {
    const body = req.body || {};
    const barcode = normalizeBarcode(body.barcode);
    const productName = normalizeText(body.productName);
    const brandName = normalizeText(body.brandName);
    const netQuantity = normalizeQuantity(body.netQuantity);
    const unit = normalizeText(body.unit);

    let existing = null;

    if (barcode) {
      const candidates = await prisma.product.findMany({
        where: { barcode: { contains: barcode } },
        orderBy: { createdAt: "asc" },
        take: 20,
      });
      existing = candidates.find((product) => normalizeBarcode(product.barcode) === barcode) || null;
    }

    if (!existing && productName && netQuantity && unit) {
      const candidates = await prisma.product.findMany({
        where: {
          productName: { equals: productName, mode: "insensitive" },
          unit: { equals: unit, mode: "insensitive" },
          ...(brandName ? { brandName: { equals: brandName, mode: "insensitive" } } : {}),
        },
        orderBy: { createdAt: "asc" },
        take: 20,
      });
      existing = candidates.find((product) => (
        normalizeText(product.productName) === productName &&
        normalizeQuantity(product.netQuantity) === netQuantity &&
        normalizeText(product.unit) === unit &&
        (!brandName || normalizeText(product.brandName) === brandName)
      )) || null;
    }

    if (!existing) return next();

    const parakhId = displayParakhId(existing);
    return res.status(409).json({
      error: `Product already registered. PARAKH ID: ${parakhId}`,
      duplicate: true,
      parakhId,
      existingProductId: existing.id,
      existingProduct: existing,
    });
  } catch (error) {
    console.error("Product deduplication check failed:", error);
    next();
  }
});

export default router;
