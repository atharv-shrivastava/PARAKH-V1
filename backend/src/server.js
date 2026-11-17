import "dotenv/config";
import express from "express";
import cors from "cors";
import categoriesRouter from "./routes/categories.js";
import productsRouter from "./routes/products.js";
import productDedupRouter from "./routes/productDedup.js";
import productLocationRouter from "./routes/productLocation.js";
import authRouter from "./routes/auth.js";
import shopsRouter from "./routes/shops.js";
import adminRouter from "./routes/admin.js";
import rulesRouter from "./routes/rules.js";
import translateRouter from "./routes/translate.js";
import analyticsRouter from "./routes/analytics.js";
import batchAlertsRouter from "./routes/batchAlerts.js";
import datakartRouter from "./routes/datakart.js";
import fastOcrRouter from "./ocr/fastRoutes.js";
import semanticTimingRouter from "./ocr/semanticTimingRoutes.js";
import ocrRouter from "./ocr/routes.js";
import ecommerceOcrRouter from "./routes/ecommerceOcr.js";
import fontSizeVisionRouter from "./routes/fontSizeVision.js";

const app = express();

async function checkBoundService(service, envName) {
  const baseUrl = process.env[envName];
  if (!baseUrl) return { service, status: "unconfigured" };

  try {
    const response = await fetch(new URL("/health", baseUrl), {
      signal: AbortSignal.timeout(6000),
    });
    const responseText = await response.text();
    let body = null;
    try { body = JSON.parse(responseText); } catch {}
    return {
      service,
      status: response.ok ? "ok" : "error",
      httpStatus: response.status,
      details: body ?? responseText.slice(0, 600),
    };
  } catch (error) {
    return {
      service,
      status: "unreachable",
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

app.use(cors({ origin: true }));
app.use(express.json({ limit: "25mb" }));

app.get("/", (_req, res) => res.json({ message: "PARAKH backend is running" }));
app.get("/health", (_req, res) => res.json({ status: "ok", service: "parakh-backend" }));
app.get("/api/health", async (_req, res) => {
  const services = await Promise.all([
    checkBoundService("rapidocr", "RAPID_OCR_URL"),
    checkBoundService("opencv-vision", "OPENCV_VISION_URL"),
    checkBoundService("rules-engine", "RULES_ENGINE_URL"),
  ]);
  const ready = services.every((item) => item.status === "ok");
  res.status(ready ? 200 : 503).json({
    status: ready ? "ok" : "degraded",
    service: "parakh-v1-unified",
    databaseConfigured: Boolean(process.env.DATABASE_URL),
    services,
  });
});
app.use("/api/auth", authRouter);
app.use("/api/categories", categoriesRouter);
app.use("/api/products", productDedupRouter);
app.use("/api/products", productsRouter);
app.use("/api/product-location", productLocationRouter);
app.use("/api/shops", shopsRouter);
app.use("/api/rules", rulesRouter);
app.use("/api/admin", adminRouter);
app.use("/api/analytics", analyticsRouter);
app.use("/api/batch-alerts", batchAlertsRouter);
app.use("/api/translate", translateRouter);
app.use("/api/datakart", datakartRouter);
app.use("/api/products/ecommerce-ocr", ecommerceOcrRouter);

// Production OCR uses RapidOCR + semantic verification.
app.use("/api/ocr", fastOcrRouter);
// Gemini vs Grok benchmark/timing endpoint.
app.use("/api/ocr", semanticTimingRouter);
// Structured compliance evaluation is kept separate from OCR extraction.
app.use("/api/ocr", ocrRouter);
// Calibrated OpenCV font-size measurement + Rule 7 compliance workflow.
app.use("/api/vision", fontSizeVisionRouter);

const PORT = Number(process.env.PORT || 5000);
export default app;

if (process.env.NODE_ENV !== "production" && process.env.VERCEL !== "1") {
  app.listen(PORT, () => console.log(`PARAKH backend running on http://localhost:${PORT}`));
}
