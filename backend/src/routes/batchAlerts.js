import express from "express";
import crypto from "node:crypto";
import prisma from "../lib/prisma.js";
import { authenticate } from "../middleware/auth.js";

const router = express.Router();
router.use(authenticate);

const norm = (value) => String(value || "").trim();
const isAdmin = (req) => String(req.user?.role || "").toUpperCase() === "ADMIN";

async function upsertVerifiedBatchAlert({ productId, batchNumber, title, message, severity, userId, incidentId }) {
  const existing = await prisma.batchAlert.findUnique({
    where: { productId_batchNumber: { productId, batchNumber } },
  });

  const alert = existing
    ? await prisma.batchAlert.update({
        where: { id: existing.id },
        data: {
          title,
          message,
          severity: severity || existing.severity,
          status: "ACTIVE",
          verifiedById: userId,
          verifiedAt: new Date(),
        },
      })
    : await prisma.batchAlert.create({
        data: {
          id: crypto.randomUUID(),
          productId,
          batchNumber,
          title,
          message,
          severity: severity || "HIGH",
          status: "ACTIVE",
          createdById: userId,
          verifiedById: userId,
          verifiedAt: new Date(),
        },
      });

  if (incidentId) {
    await prisma.batchIncidentReport.update({
      where: { id: incidentId },
      data: { batchAlertId: alert.id },
    });
  }
  return alert;
}

router.get("/", async (req, res) => {
  try {
    const productId = norm(req.query.productId);
    const batchNumber = norm(req.query.batchNumber);
    const where = {
      status: String(req.query.status || "ACTIVE").toUpperCase(),
      ...(productId ? { productId } : {}),
      ...(batchNumber ? { batchNumber } : {}),
    };
    const alerts = await prisma.batchAlert.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: Math.min(Number(req.query.limit || 50), 200),
      include: { product: { select: { id: true, productName: true, brandName: true, manufacturerName: true, barcode: true } } },
    });
    res.json({ alerts, scope: "STATEWIDE" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to load batch alerts" });
  }
});

router.post("/incidents", async (req, res) => {
  try {
    const productId = norm(req.body?.productId);
    const batchNumber = norm(req.body?.batchNumber);
    const title = norm(req.body?.title) || "Serious batch incident reported";
    const description = norm(req.body?.description);
    const severity = norm(req.body?.severity).toUpperCase() || "HIGH";
    if (!productId || !batchNumber || !description) {
      return res.status(400).json({ error: "productId, batchNumber and description are required" });
    }

    const report = await prisma.batchIncidentReport.create({
      data: {
        id: crypto.randomUUID(),
        productId,
        batchNumber,
        inspectionId: norm(req.body?.inspectionId) || null,
        reportedById: req.user.id,
        title,
        description,
        severity,
        status: "REPORTED",
        evidenceUrl: norm(req.body?.evidenceUrl) || null,
      },
      include: { product: { select: { productName: true, brandName: true, manufacturerName: true } } },
    });

    if (isAdmin(req)) {
      const alert = await upsertVerifiedBatchAlert({
        productId,
        batchNumber,
        title,
        message: description,
        severity,
        userId: req.user.id,
        incidentId: report.id,
      });
      return res.status(201).json({ report: { ...report, status: "VERIFIED" }, alert });
    }

    res.status(201).json({ report });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to report batch incident" });
  }
});

router.get("/incidents", async (req, res) => {
  const mine = String(req.query.scope || "").toUpperCase() === "MINE";
  if (!isAdmin(req) && !mine) return res.status(403).json({ error: "Admin access required" });
  try {
    const reports = await prisma.batchIncidentReport.findMany({
      where: {
        status: String(req.query.status || (mine ? "REPORTED" : "REPORTED")).toUpperCase(),
        ...(mine ? { reportedById: req.user.id } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 200,
      include: {
        product: { select: { id: true, productName: true, brandName: true, manufacturerName: true, barcode: true } },
        reportedBy: { select: { id: true, name: true, email: true } },
        inspection: { select: { id: true, inspectedAt: true, shop: { select: { city: true, state: true, name: true } } } },
      },
    });
    res.json({ reports, scope: mine ? "OWN" : "STATEWIDE" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to load batch incident reports" });
  }
});

router.patch("/incidents/:id/verify", async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: "Admin access required" });
  try {
    const id = norm(req.params.id);
    const report = await prisma.batchIncidentReport.findUnique({ where: { id } });
    if (!report) return res.status(404).json({ error: "Incident report not found" });

    const verified = await prisma.batchIncidentReport.update({
      where: { id },
      data: { status: "VERIFIED" },
    });
    const alert = await upsertVerifiedBatchAlert({
      productId: verified.productId,
      batchNumber: verified.batchNumber,
      title: verified.title,
      message: verified.description,
      severity: verified.severity,
      userId: req.user.id,
      incidentId: verified.id,
    });
    res.json({ report: verified, alert });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to verify batch incident" });
  }
});

router.patch("/:id/resolve", async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: "Admin access required" });
  try {
    const alert = await prisma.batchAlert.update({
      where: { id: norm(req.params.id) },
      data: { status: "RESOLVED" },
    });
    res.json({ alert });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to resolve batch alert" });
  }
});

export default router;
