import "dotenv/config";
import express from "express";
import cors from "cors";
import categoriesRouter from "./routes/categories.js";
import productsRouter from "./routes/products.js";
import authRouter from "./routes/auth.js";
import shopsRouter from "./routes/shops.js";
import adminRouter from "./routes/admin.js";
import rulesRouter from "./routes/rules.js";
import translateRouter from "./routes/translate.js";
import analyticsRouter from "./routes/analytics.js";
import fastOcrRouter from "./ocr/fastRoutes.js";
import ocrRouter from "./ocr/routes.js";
import ecommerceOcrRouter from "./routes/ecommerceOcr.js";
import { applyEvidenceConfidence } from "./ocr/evidenceConfidence.js";

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: "25mb" }));

app.get("/", (_req, res) => res.json({ message: "PARAKH backend is running" }));
app.get("/health", (_req, res) => res.json({ status: "ok", service: "parakh-backend" }));
app.use("/api/auth", authRouter);
app.use("/api/categories", categoriesRouter);
app.use("/api/products", productsRouter);
app.use("/api/shops", shopsRouter);
app.use("/api/rules", rulesRouter);
app.use("/api/admin", adminRouter);
app.use("/api/analytics", analyticsRouter);
app.use("/api/translate", translateRouter);
app.use("/api/products/ecommerce-ocr", ecommerceOcrRouter);

// Fuse RapidOCR + Gemini + DataKart after the OCR route has produced
// a structured result. DataKart is the strongest verification signal.
app.use("/api/ocr", (req, res, next) => {
  const originalJson = res.json.bind(res);
  res.json = (payload) => {
    if (req.path === "/analyze" && payload?.result) {
      void applyEvidenceConfidence(payload.result)
        .then((result) => originalJson({ ...payload, result }))
        .catch((error) => {
          console.error("[evidence-confidence]", error);
          originalJson(payload);
        });
      return res;
    }
    return originalJson(payload);
  };
  next();
});

// Production OCR uses RapidOCR + semantic verification.
app.use("/api/ocr", fastOcrRouter);
// Structured compliance evaluation is kept separate from OCR extraction.
app.use("/api/ocr", ocrRouter);

const PORT = Number(process.env.PORT || 5000);
app.listen(PORT, () => console.log(`PARAKH backend running on http://localhost:${PORT}`));
