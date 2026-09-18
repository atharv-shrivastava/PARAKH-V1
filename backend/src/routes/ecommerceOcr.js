import express from "express";
import sharp from "sharp";
import { authenticate } from "../middleware/auth.js";

const router = express.Router();
router.use(authenticate);

function isPrivateHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  return host === "localhost" || host.endsWith(".local") || host === "::1" || host === "0.0.0.0" ||
    /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host);
}

function isSupportedNativeType(contentType) {
  return ["image/jpeg", "image/png", "image/webp"].includes(String(contentType || "").split(";")[0].trim().toLowerCase());
}

async function normalizeImage(buffer, contentType) {
  const normalizedType = String(contentType || "").split(";")[0].trim().toLowerCase();
  if (isSupportedNativeType(normalizedType)) {
    return { buffer, mediaType: normalizedType, extension: normalizedType === "image/png" ? "png" : normalizedType === "image/webp" ? "webp" : "jpg" };
  }

  const converted = await sharp(buffer, { failOn: "none" }).rotate().jpeg({ quality: 90, mozjpeg: true }).toBuffer();
  return { buffer: converted, mediaType: "image/jpeg", extension: "jpg" };
}

router.post("/images", async (req, res) => {
  try {
    const imageUrls = (Array.isArray(req.body?.imageUrls) ? req.body.imageUrls : Array.isArray(req.body?.images) ? req.body.images : []).slice(0, 6);
    if (!imageUrls.length) return res.status(400).json({ error: "At least one public product image URL is required." });

    const formData = new FormData();
    let added = 0;
    const skipped = [];

    for (const rawValue of imageUrls) {
      try {
        const imageUrl = new URL(String(rawValue || ""));
        if (!["http:", "https:"].includes(imageUrl.protocol) || isPrivateHost(imageUrl.hostname)) {
          skipped.push("private-or-invalid-url");
          continue;
        }

        const response = await fetch(imageUrl.href, {
          headers: {
            "user-agent": "PARAKH Compliance Inspection/1.0",
            accept: "image/avif,image/webp,image/jpeg,image/png,image/*,*/*;q=0.8",
          },
          signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) {
          skipped.push(`http-${response.status}`);
          continue;
        }

        const contentType = response.headers.get("content-type") || "application/octet-stream";
        const buffer = Buffer.from(await response.arrayBuffer());
        if (!buffer.length || buffer.length > 16 * 1024 * 1024) {
          skipped.push("empty-or-too-large");
          continue;
        }

        const normalized = await normalizeImage(buffer, contentType);
        formData.append("images", new Blob([normalized.buffer], { type: normalized.mediaType }), `ecommerce-${added + 1}.${normalized.extension}`);
        added += 1;
      } catch (error) {
        skipped.push(error?.message || "download-or-conversion-failed");
      }
    }

    if (!added) {
      return res.status(422).json({
        error: "No usable public product images were available for OCR. The source images may be blocked, unsupported, or invalid.",
        skipped,
      });
    }

    const baseUrl = String(process.env.INTERNAL_BASE_URL || `http://127.0.0.1:${Number(process.env.PORT || 5000)}`).replace(/\/$/, "");
    const response = await fetch(`${baseUrl}/api/ocr/analyze`, {
      method: "POST",
      body: formData,
      headers: req.headers.authorization ? { authorization: req.headers.authorization } : {},
      signal: AbortSignal.timeout(45000),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return res.status(response.status).json({ error: data?.error?.message || data?.error || "Shared OCR engine failed." });

    res.json({
      result: data.result || null,
      ocr: data.result || null,
      provider: data.provider || "local-rules",
      model: data.model || "local declaration mapper",
      semantic: data.semantic || data.result?.semantic || null,
      detectionProvider: data.detectionProvider || "paddleocr",
      detectionProviders: data.detectionProviders || ["paddleocr"],
      fallbackReason: data.fallbackReason || null,
      engine: "parakh-fast-ocr",
      imageCount: added,
      skipped,
    });
  } catch (error) {
    console.error("[ecommerce:ocr]", error);
    res.status(error?.name === "TimeoutError" ? 504 : 502).json({ error: error?.message || "E-commerce image OCR failed." });
  }
});

export default router;
