import express from "express";
import prisma from "../lib/prisma.js";
import { authenticate } from "../middleware/auth.js";

const router = express.Router();
router.use(authenticate);

function scopeForUser(req) {
  return req.user.role === "ADMIN" ? {} : { workerId: req.user.id };
}

function sourceLabel(inspection) {
  if (String(inspection.product?.sourceType || "OFFLINE").toUpperCase() === "ECOMMERCE") {
    return inspection.product?.sourceWebsiteName || inspection.product?.sourceUrl || "E-commerce source";
  }
  return inspection.shop?.name || "Unknown shop";
}

function normalize(value) {
  return String(value || "").trim();
}

function monthKey(dateValue) {
  const date = new Date(dateValue);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 7);
}

function addCount(map, key) {
  const normalized = normalize(key) || "Unknown";
  map.set(normalized, (map.get(normalized) || 0) + 1);
}

function topList(map, labelKey, limit = 10) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([label, count]) => ({ [labelKey]: label, count }));
}

function parseOcrData(raw) {
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}

function fieldValue(data, key) {
  const candidates = [
    data?.ocr?.[key],
    data?.ocr?.ruleEngineInput?.[key],
    data?.[key],
  ];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === "object") {
      const value = candidate.value ?? candidate.raw;
      if (value != null && String(value).trim()) return String(value).trim();
    }
    if (candidate != null && typeof candidate !== "object" && String(candidate).trim()) return String(candidate).trim();
  }
  return "";
}

function enrichInspection(item) {
  const ocrData = parseOcrData(item.product?.ocrData);
  const ocrManufacturer = fieldValue(ocrData, "manufacturer");
  const ocrBatch = fieldValue(ocrData, "batchNumber");
  const ocrViolation = normalize(item.violationType) || (() => {
    const manual = Array.isArray(ocrData?.manualViolations) ? ocrData.manualViolations.find(Boolean) : null;
    const finding = ocrData?.compliance?.findings?.find((x) => String(x?.status || "").toUpperCase() === "VIOLATION");
    return normalize(manual?.message || finding?.ruleCode || finding?.ruleNumber);
  })();
  const ocrSeverity = normalize(item.violationSeverity) || normalize(ocrData?.compliance?.summary?.highestSeverity) || normalize(ocrData?.manualViolations?.[0]?.severity);
  return {
    ...item,
    manufacturerName: normalize(item.product?.manufacturerName) || ocrManufacturer || normalize(item.product?.brandName) || "Unknown manufacturer",
    batchNumberResolved: normalize(item.batchNumber) || ocrBatch,
    violationTypeResolved: ocrViolation,
    violationSeverityResolved: ocrSeverity || "UNSPECIFIED",
  };
}

router.get("/dashboard", async (req, res) => {
  try {
    const inspectionWhere = scopeForUser(req);
    const [inspectionCount, violationCount, reviewCount, recentInspections] = await Promise.all([
      prisma.inspection.count({ where: inspectionWhere }),
      prisma.inspection.count({ where: { ...inspectionWhere, status: "VIOLATION" } }),
      prisma.inspection.count({ where: { ...inspectionWhere, status: { in: ["NEEDS_REVIEW", "UNABLE_TO_VERIFY"] } } }),
      prisma.inspection.findMany({
        where: inspectionWhere,
        orderBy: { inspectedAt: "desc" },
        take: 5000,
        select: {
          status: true,
          inspectedAt: true,
          shop: { select: { name: true } },
          product: { select: { brandName: true, manufacturerName: true, sourceType: true, sourceWebsiteName: true, sourceUrl: true, ocrData: true } },
        },
      }),
    ]);

    const monthly = new Map();
    const shopViolations = new Map();
    const brandViolations = new Map();
    const ruleViolations = new Map();

    for (const rawInspection of recentInspections) {
      const inspection = enrichInspection(rawInspection);
      const key = monthKey(inspection.inspectedAt);
      if (key) addCount(monthly, key);
      if (inspection.status !== "VIOLATION") continue;
      addCount(shopViolations, sourceLabel(inspection));
      addCount(brandViolations, inspection.product?.brandName || "Unknown brand");
      try {
        const stored = parseOcrData(inspection.product?.ocrData);
        for (const finding of stored?.compliance?.findings || []) {
          if (String(finding?.status || "").toUpperCase() !== "VIOLATION") continue;
          const rule = String(finding.ruleNumber || finding.ruleCode || finding.ruleId || "Unknown rule").trim();
          addCount(ruleViolations, rule);
        }
      } catch {}
    }

    const now = new Date();
    const inspectionTrend = [];
    for (let offset = 11; offset >= 0; offset -= 1) {
      const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1));
      const key = date.toISOString().slice(0, 7);
      inspectionTrend.push({ month: key, inspections: monthly.get(key) || 0 });
    }

    res.json({
      scope: req.user.role === "ADMIN" ? "PLATFORM" : "OWN",
      counts: { inspections: inspectionCount, violations: violationCount, review: reviewCount },
      inspectionTrend,
      highestViolatingShop: topList(shopViolations, "name", 1)[0] || null,
      highestViolatingBrand: topList(brandViolations, "name", 1)[0] || null,
      highestViolatingRule: topList(ruleViolations, "name", 1)[0] || null,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to load dashboard analytics" });
  }
});

router.get("/intelligence", async (req, res) => {
  try {
    const manufacturer = normalize(req.query.manufacturer).toLowerCase();
    const product = normalize(req.query.product).toLowerCase();
    const gtin = normalize(req.query.gtin).toLowerCase();
    const batch = normalize(req.query.batch).toLowerCase();
    const violation = normalize(req.query.violation).toLowerCase();
    const district = normalize(req.query.district);
    const state = normalize(req.query.state);
    const from = normalize(req.query.from);
    const to = normalize(req.query.to);
    const verifiedOnly = String(req.query.verified || "false").toLowerCase() === "true";
    const now = new Date();

    const where = {
      ...(verifiedOnly ? { isVerified: true } : {}),
      ...(district || state ? { shop: {
        ...(district ? { city: { contains: district, mode: "insensitive" } } : {}),
        ...(state ? { state: { contains: state, mode: "insensitive" } } : {}),
      } } : {}),
      ...(from || to ? { inspectedAt: {
        ...(from ? { gte: new Date(from) } : {}),
        ...(to ? { lte: new Date(to.includes("T") ? to : `${to}T23:59:59.999Z`) } : {}),
      } } : {}),
    };

    const rawInspections = await prisma.inspection.findMany({
      where,
      orderBy: { inspectedAt: "desc" },
      take: 10000,
      select: {
        id: true,
        status: true,
        violationType: true,
        violationSeverity: true,
        isVerified: true,
        inspectedAt: true,
        batchNumber: true,
        shop: { select: { name: true, city: true, state: true } },
        product: { select: { id: true, productName: true, brandName: true, manufacturerName: true, barcode: true, ocrData: true } },
      },
    });

    const inspections = rawInspections.map(enrichInspection).filter((item) => {
      const haystack = {
        manufacturer: item.manufacturerName.toLowerCase(),
        product: normalize(item.product?.productName).toLowerCase(),
        gtin: normalize(item.product?.barcode).toLowerCase(),
        batch: normalize(item.batchNumberResolved).toLowerCase(),
        violation: normalize(item.violationTypeResolved).toLowerCase(),
      };
      return (!manufacturer || haystack.manufacturer.includes(manufacturer)) &&
        (!product || haystack.product.includes(product)) &&
        (!gtin || haystack.gtin.includes(gtin)) &&
        (!batch || haystack.batch.includes(batch)) &&
        (!violation || haystack.violation.includes(violation));
    });

    const recordedViolations = inspections.filter((x) => x.status === "VIOLATION");
    const verifiedViolations = recordedViolations.filter((x) => x.isVerified);
    const batches = new Set(recordedViolations.filter((x) => x.batchNumberResolved).map((x) => `${x.product?.id || ""}:${x.batchNumberResolved.toLowerCase()}`));

    const manufacturerStats = new Map();
    const districtStats = new Map();
    const stateStats = new Map();
    const violationStats = new Map();
    const productStats = new Map();
    const monthlyStats = new Map();
    const affectedBatchStats = new Map();
    const severityStats = new Map();

    for (const item of inspections) {
      const month = monthKey(item.inspectedAt);
      if (month) monthlyStats.set(month, (monthlyStats.get(month) || 0) + 1);
      if (item.status !== "VIOLATION") continue;
      addCount(manufacturerStats, item.manufacturerName);
      addCount(districtStats, item.shop?.city || "Unknown district");
      addCount(stateStats, item.shop?.state || "Unknown state");
      addCount(violationStats, item.violationTypeResolved || "Unclassified violation");
      addCount(productStats, item.product?.productName || "Unknown product");
      addCount(severityStats, item.violationSeverityResolved);
      if (item.batchNumberResolved) addCount(affectedBatchStats, item.batchNumberResolved);
    }

    const manufacturerLeaderboard = [...manufacturerStats.entries()]
      .map(([name, count]) => {
        const manufacturerInspections = inspections.filter((x) => x.manufacturerName === name).length;
        const violationRate = manufacturerInspections ? Number(((count / manufacturerInspections) * 100).toFixed(1)) : 0;
        const verified = recordedViolations.filter((x) => x.manufacturerName === name && x.isVerified).length;
        return { manufacturer: name, violations: count, verifiedViolations: verified, inspections: manufacturerInspections, violationRate };
      })
      .sort((a, b) => b.violations - a.violations || b.violationRate - a.violationRate)
      .slice(0, 15);

    const trend = [];
    for (let offset = 11; offset >= 0; offset -= 1) {
      const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1));
      const key = date.toISOString().slice(0, 7);
      trend.push({ month: key, inspections: monthlyStats.get(key) || 0 });
    }

    const myInspectionWhere = { workerId: req.user.id };
    const myInspectionsRaw = await prisma.inspection.findMany({
      where: myInspectionWhere,
      orderBy: { inspectedAt: "desc" },
      take: 100,
      select: {
        id: true,
        status: true,
        isVerified: true,
        inspectedAt: true,
        batchNumber: true,
        shop: { select: { name: true, city: true, state: true } },
        product: { select: { id: true, productName: true, brandName: true, barcode: true, manufacturerName: true } },
      },
    });
    const myInspections = myInspectionsRaw.map((item) => ({
      id: item.id,
      status: item.status,
      isVerified: item.isVerified,
      inspectedAt: item.inspectedAt,
      batchNumber: item.batchNumber,
      shop: item.shop,
      product: item.product,
    }));

    res.json({
      filters: { manufacturer, product, gtin, batch, violation, district, state, from, to, verifiedOnly },
      counts: {
        inspections: inspections.length,
        recordedViolations: recordedViolations.length,
        verifiedViolations: verifiedViolations.length,
        affectedBatches: batches.size,
        violationRate: inspections.length ? Number(((recordedViolations.length / inspections.length) * 100).toFixed(1)) : 0,
      },
      manufacturerLeaderboard,
      districtViolations: topList(districtStats, "district", 15),
      stateViolations: topList(stateStats, "state", 15),
      violationTypes: topList(violationStats, "violation", 15),
      productViolations: topList(productStats, "product", 15),
      severityBreakdown: topList(severityStats, "severity", 10),
      affectedBatches: topList(affectedBatchStats, "batch", 15),
      trend,
      inspections: req.user.role === "ADMIN" ? inspections.slice(0, 100) : [],
      myInspections,
      verifiedInspectionIds: verifiedViolations.map((x) => x.id),
      scope: "STATEWIDE",
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to load compliance intelligence" });
  }
});

export default router;
