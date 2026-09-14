import sharp from "sharp";

const MAX_SIDE = Number(process.env.PARAKH_AI_MAX_IMAGE_SIDE || 0);
const JPEG_QUALITY = Math.max(90, Math.min(100, Number(process.env.PARAKH_AI_JPEG_QUALITY || 98)));
const PRESERVE_FORMAT = String(process.env.PARAKH_AI_PRESERVE_FORMAT || "true").toLowerCase() === "true";

/**
 * Prepare package photos for vision models without throwing away source detail.
 * MAX_SIDE=0 means no resize.
 */
export async function preprocessImageForAI({ base64, mediaType = "image/jpeg" } = {}) {
  if (!base64) throw new Error("Cannot preprocess an empty image.");

  const input = Buffer.from(base64, "base64");
  const oriented = sharp(input, { failOn: "none" }).rotate();
  const metadata = await oriented.metadata();
  const inputType = String(mediaType || "image/jpeg").toLowerCase();
  const canPreserve = PRESERVE_FORMAT && ["image/jpeg", "image/png", "image/webp"].includes(inputType);

  let pipeline = oriented;
  if (MAX_SIDE > 0) {
    pipeline = pipeline.resize({
      width: MAX_SIDE,
      height: MAX_SIDE,
      fit: "inside",
      withoutEnlargement: true,
    });
  }

  pipeline = pipeline
    .normalise()
    .sharpen({ sigma: 0.8, m1: 0.9, m2: 2.0 });

  let output;
  let outputMediaType;
  if (canPreserve && inputType === "image/png") {
    output = await pipeline.png({ compressionLevel: 2 }).toBuffer();
    outputMediaType = "image/png";
  } else if (canPreserve && inputType === "image/webp") {
    output = await pipeline.webp({ quality: 100, alphaQuality: 100, smartSubsample: false }).toBuffer();
    outputMediaType = "image/webp";
  } else {
    output = await pipeline.jpeg({ quality: JPEG_QUALITY, chromaSubsampling: "4:4:4", mozjpeg: true }).toBuffer();
    outputMediaType = "image/jpeg";
  }

  return {
    base64: output.toString("base64"),
    mediaType: outputMediaType,
    originalMediaType: mediaType,
    originalWidth: metadata.width || null,
    originalHeight: metadata.height || null,
    outputBytes: output.length,
    maxSideApplied: MAX_SIDE > 0 ? MAX_SIDE : null,
  };
}

export async function preprocessImagesForAI(images = []) {
  return Promise.all(images.map((image) => preprocessImageForAI(image)));
}
