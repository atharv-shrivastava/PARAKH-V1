import express from "express";
import { authenticate } from "../middleware/auth.js";

const router = express.Router();
router.use(authenticate);

const DEFAULT_DATAKART_URL = "https://iaghrncbfpxpwcdgyuen.supabase.co";

function getConfig() {
  const baseUrl = String(process.env.DATAKART_SUPABASE_URL || DEFAULT_DATAKART_URL).replace(/\/$/, "");
  const key = String(process.env.DATAKART_SUPABASE_KEY || "").trim();
  return { baseUrl, key };
}

router.get("/gtin/:gtin", async (req, res) => {
  const gtin = String(req.params.gtin || "").replace(/\D/g, "");
  if (!gtin) return res.status(400).json({ error: "A GTIN is required." });

  const { baseUrl, key } = getConfig();
  if (!key) {
    return res.status(503).json({
      error: "DataKart is not configured. Set DATAKART_SUPABASE_KEY in the backend environment."
    });
  }

  try {
    const query = new URLSearchParams({
      select: "*",
      gtin: `eq.${gtin}`,
      active: "eq.true",
      limit: "1",
    });

    const response = await fetch(`${baseUrl}/rest/v1/products?${query.toString()}`, {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(Number(process.env.DATAKART_TIMEOUT_MS || "4000")),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = data?.message || data?.error || `DataKart query failed (${response.status}).`;
      return res.status(502).json({ error: detail });
    }

    const product = Array.isArray(data) ? data[0] || null : null;
    if (!product) return res.status(404).json({ found: false, gtin, product: null, source: "datakart-supabase" });

    return res.json({ found: true, gtin, product, source: "datakart-supabase" });
  } catch (error) {
    console.error("[datakart:gtin]", error);
    return res.status(502).json({ error: error?.message || "DataKart lookup failed." });
  }
});

export default router;
