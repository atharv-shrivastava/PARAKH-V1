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

// When local Qwen is configured, turn on the existing parallel semantic-provider
// orchestration so Gemini and Qwen are evaluated independently.
if (process.env.QWEN_OLLAMA_URL && process.env.PARAKH_SEMANTIC_VERIFY_ALL !== "true") {
  process.env.PARAKH_SEMANTIC_VERIFY_ALL = "true";
}

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
// Production OCR uses only local PaddleOCR + local semantic mapping.
app.use("/api/ocr", fastOcrRouter);
// Structured compliance evaluation is kept separate from OCR extraction.
app.use("/api/ocr", ocrRouter);

const PORT = Number(process.env.PORT || 5000);
app.listen(PORT, () => console.log(`PARAKH backend running on http://localhost:${PORT}`));
