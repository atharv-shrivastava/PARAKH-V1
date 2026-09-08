import express from "express";
import prisma from "../lib/prisma.js";
import { authenticate } from "../middleware/auth.js";

const router = express.Router();
router.use(authenticate);

router.get("/", async (_req, res) => {
  try {
    const rules = await prisma.complianceRule.findMany({
      where: { enabled: true },
      select: { id: true, ruleId: true, ruleCode: true, ruleNumber: true, title: true, defaultSeverity: true, definition: true },
      orderBy: { ruleCode: "asc" },
    });
    res.json(rules);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to load active compliance rules" });
  }
});

router.get("/active", async (_req, res) => {
  try {
    const rules = await prisma.complianceRule.findMany({
      where: { enabled: true },
      select: { id: true, ruleId: true, ruleCode: true, ruleNumber: true, title: true, defaultSeverity: true, definition: true },
      orderBy: { ruleCode: "asc" },
    });
    res.json(rules);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to load active compliance rules" });
  }
});

export default router;
