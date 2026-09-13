import sharp from "sharp";

const MAX_SIDE = Math.max(768, Number(process.env.PARAKH_AI_MAX_IMAGE_SIDE || 1600));
const JPEG_QUALITY = Math.max(70, Math.min(96, Number(process.env.PARAKH_AI_JPEG_QUALITY || 90)));

/**
 * Normalize package photos before sending them to a vision/semantic model.
 *
 * This is deliberately conservative: auto-orient first, cap the largest side,
 * normalize exposure, then apply mild sharpening. We avoid aggressive
 * thresholding because it can destroy tiny legal declarations, punctuation,
 * Gujarati/Hindi/English mixed text, barcodes, and fine print.
 */
export async function preprocessImageForAI({ base64, mediaType = "image/jpeg" } = {}) {
  if (!base64) throw new Error("Cannot preprocess an empty image.");

  const input = Buffer.from(base64, "base64");
  const pipeline = sharp(input, { failOn: "none" })
    .rotate()
    .resize({
      width: MAX_SIDE,
      height: MAX_SIDE,
      fit: "inside",
      withoutEnlargement: true,
    })
    .normalise()
    .sharpen({ sigma: 0.8, m1: 0.9, m2: 2.0 });

  const output = await pipeline.jpeg({ quality: JPEG_QUALITY, chromaSubsampling: "4:4:4" }).toBuffer();
  return {
    base64: output.toString("base64"),
    mediaType: "image/jpeg",
    originalMediaType: mediaType,
  };
}

export async function preprocessImagesForAI(images = []) {
  return Promise.all(images.map((image) => preprocessImageForAI(image)));
}
