import express from "express";
import prisma from "../lib/prisma.js";
import { authenticate } from "../middleware/auth.js";

const router = express.Router();
router.use(authenticate);

function locationFilter(value) {
  const location = String(value || "").trim();
  if (!location) return undefined;
  return {
    inspections: {
      some: {
        shop: {
          OR: [
            { name: { contains: location, mode: "insensitive" } },
            { address: { contains: location, mode: "insensitive" } },
            { city: { contains: location, mode: "insensitive" } },
            { state: { contains: location, mode: "insensitive" } },
          ],
        },
      },
    },
  };
}

router.get("/", async (req, res) => {
  try {
    const location = String(req.query.location || "").trim();
    const sourceType = String(req.query.sourceType || "ALL").toUpperCase();
    const status = String(req.query.status || "ALL").toUpperCase();
    const query = String(req.query.query || "").trim();
    const limitValue = Number(req.query.limit || 50);
    const limit = Number.isFinite(limitValue) ? Math.min(100, Math.max(1, limitValue)) : 50;
    const ownerScope = req.user.role === "ADMIN" ? {} : { ownerId: req.user.id };

    const where = {
      ...ownerScope,
      ...(sourceType !== "ALL" ? { sourceType } : {}),
      ...(status !== "ALL" ? { complianceStatus: status } : {}),
      ...locationFilter(location),
      ...(query ? {
        OR: [
          { productName: { contains: query, mode: "insensitive" } },
          { brandName: { contains: query, mode: "insensitive" } },
          { barcode: { contains: query, mode: "insensitive" } },
          { category: { name: { contains: query, mode: "insensitive" } } },
        ],
      } : {}),
    };

    const products = await prisma.product.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
      select: {
        id: true,
        productName: true,
        brandName: true,
        netQuantity: true,
        unit: true,
        mrp: true,
        barcode: true,
        complianceStatus: true,
        createdAt: true,
        sourceType: true,
        sourceUrl: true,
        sourceWebsiteName: true,
        category: { select: { id: true, name: true } },
        inspections: {
          orderBy: { inspectedAt: "desc" },
          take: 1,
          select: {
            inspectedAt: true,
            shop: { select: { id: true, name: true, address: true, city: true, state: true, latitude: true, longitude: true, sourceType: true } },
          },
        },
      },
    });

    res.json({ location, products });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to filter products by location" });
  }
});

export default router;
