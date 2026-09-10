import express from "express";
import { authenticate } from "../middleware/auth.js";

const router = express.Router();
router.use(authenticate);

const DEFAULT_DATAKART_URL = "https://iaghrncbfpxpwcdgyuen.supabase.co";
const DEFAULT_TIMEOUT_MS = 4000;

function getConfig() {
  const baseUrl = String(process.env.DATAKART_SUPABASE_URL || DEFAULT_DATAKART_URL).replace(/\/$/, "");
  const key = String(process.env.DATAKART_SUPABASE_KEY || "").trim();
  const timeoutMs = Math.max(500, Number(process.env.DATAKART_TIMEOUT_MS || DEFAULT_TIMEOUT_MS));
  return { baseUrl, key, timeoutMs };
}

router.get("/gtin/:gtin", async (req, res) => {
  const gtin = String(req.params.gtin || "").replace(/\D/g, "");
  if (!gtin) return res.status(400).json({ found: false, gtin: null, product: null, status: "ERROR", error: "A GTIN is required." });

  const { baseUrl, key, timeoutMs } = getConfig();
  if (!key) {
    return res.status(503).json({
      found: false,
      gtin,
      product: null,
      status: "ERROR",
      error: "DataKart is not configured. Set DATAKART_SUPABASE_KEY in the backend environment.",
    });
  }

  const startedAt = Date.now();
  try {
    const query = new URLSearchParams({
      select: "*",
      gtin: `eq.${gtin}`,
      active: "eq.true",
      limit: "1",
    });

    console.info(`[DataKart] lookup gtin=${gtin}`);
    const response = await fetch(`${baseUrl}/rest/v1/products?${query.toString()}`, {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });

    const data = await response.json().catch(() => ({}));
    const elapsedMs = Date.now() - startedAt;
    if (!response.ok) {
      const detail = data?.message || data?.error || `DataKart query failed (${response.status}).`;
      console.error(`[DataKart] lookup failed gtin=${gtin} status=${response.status} elapsed=${elapsedMs}ms`);
      return res.status(502).json({ found: false, gtin, product: null, status: "ERROR", error: detail, source: "datakart-supabase" });
    }

    const product = Array.isArray(data) ? data[0] || null : null;
    if (!product) {
      console.info(`[DataKart] not found gtin=${gtin} elapsed=${elapsedMs}ms`);
      return res.status(404).json({ found: false, gtin, product: null, status: "NOT_FOUND", source: "datakart-supabase" });
    }

    console.info(`[DataKart] found gtin=${gtin} elapsed=${elapsedMs}ms`);
    return res.json({ found: true, gtin, product, status: "FOUND", source: "datakart-supabase" });
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
    console.error(`[DataKart] ${timedOut ? "timeout" : "error"} gtin=${gtin} elapsed=${elapsedMs}ms`, error);
    return res.status(504).json({
      found: false,
      gtin,
      product: null,
      status: timedOut ? "ERROR" : "ERROR",
      error: timedOut ? `DataKart lookup timed out after ${timeoutMs}ms.` : error?.message || "DataKart lookup failed.",
      source: "datakart-supabase",
    });
  }
});

export default router;
