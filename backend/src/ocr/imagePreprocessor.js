import sharp from "sharp";

const MAX_SIDE = Number(process.env.PARAKH_AI_MAX_IMAGE_SIDE || 0);
const JPEG_QUALITY = Math.max(90, Math.min(100, Number(process.env.PARAKH_AI_JPEG_QUALITY || 98)));
const PRESERVE_FORMAT = String(process.env.PARAKH_AI_PRESERVE_FORMAT || "true").toLowerCase() === "true";
const DETAIL_TILE_SIDE = Math.max(2048, Number(process.env.PARAKH_AI_DETAIL_TILE_SIDE || 4096));
const DETAIL_MIN_SIDE = Math.max(2000, Number(process.env.PARAKH_AI_DETAIL_MIN_SIDE || 2800));
const TEXT_RESCUE_MIN_SIDE = Math.max(1800, Number(process.env.PARAKH_AI_TEXT_RESCUE_MIN_SIDE || 2400));
const TEXT_RESCUE_TILE_SIDE = Math.max(2048, Number(process.env.PARAKH_AI_TEXT_RESCUE_TILE_SIDE || 4096));
const MAX_VISION_VIEWS = Math.max(2, Number(process.env.PARAKH_AI_MAX_VISION_VIEWS || 8));

function encodeJpeg(pipeline) {
  return pipeline
    .jpeg({ quality: JPEG_QUALITY, chromaSubsampling: "4:4:4", mozjpeg: true })
    .toBuffer();
}

function standardEnhancement(pipeline, { detail = false } = {}) {
  return pipeline
    .normalise({ lower: detail ? 0.5 : 1, upper: 99.5 })
    .sharpen({
      sigma: detail ? 0.9 : 0.8,
      m1: detail ? 1.0 : 0.9,
      m2: detail ? 2.4 : 2.0,
    });
}

/**
 * Text-rescue preprocessing deliberately keeps a separate colour-preserving
 * main view. This grayscale/CLAHE view is an additional OCR aid for small
 * declarations, uneven lighting, shadows and low-contrast print.
 */
function textRescueEnhancement(pipeline) {
  return pipeline
    .greyscale()
    .clahe({ width: 8, height: 8, maxSlope: 3 })
    .normalise({ lower: 0.5, upper: 99.5 })
    .sharpen({ sigma: 1.0, m1: 1.0, m2: 3.0 });
}

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

  pipeline = standardEnhancement(pipeline);

  let output;
  let outputMediaType;
  if (canPreserve && inputType === "image/png") {
    output = await pipeline.png({ compressionLevel: 2 }).toBuffer();
    outputMediaType = "image/png";
  } else if (canPreserve && inputType === "image/webp") {
    output = await pipeline.webp({ quality: 100, alphaQuality: 100, smartSubsample: false }).toBuffer();
    outputMediaType = "image/webp";
  } else {
    output = await encodeJpeg(pipeline);
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
    preprocessing: "orientation-normalise-sharpen",
  };
}

async function buildTextRescueView({ base64, mediaType = "image/jpeg" } = {}) {
  if (!base64) return null;

  const input = Buffer.from(base64, "base64");
  const source = sharp(input, { failOn: "none" }).rotate();
  const metadata = await source.metadata();
  const width = metadata.width || 0;
  const height = metadata.height || 0;
  if (!width || !height || Math.max(width, height) < TEXT_RESCUE_MIN_SIDE) return null;

  const output = await encodeJpeg(
    textRescueEnhancement(
      source
        .clone()
        .resize({
          width: TEXT_RESCUE_TILE_SIDE,
          height: TEXT_RESCUE_TILE_SIDE,
          fit: "inside",
          withoutEnlargement: true,
        }),
    ),
  );

  return {
    base64: output.toString("base64"),
    mediaType: "image/jpeg",
    originalMediaType: mediaType,
    originalWidth: width,
    originalHeight: height,
    outputBytes: output.length,
    viewType: "text-rescue",
    preprocessing: "grayscale-clahe-normalise-sharpen",
  };
}

async function buildDetailViews({ base64, mediaType = "image/jpeg" } = {}) {
  if (!base64) return [];

  const input = Buffer.from(base64, "base64");
  const source = sharp(input, { failOn: "none" }).rotate();
  const metadata = await source.metadata();
  const width = metadata.width || 0;
  const height = metadata.height || 0;
  if (!width || !height || Math.max(width, height) < DETAIL_MIN_SIDE) return [];

  const left = Math.round(width / 2);
  const top = Math.round(height / 2);
  const overlapX = Math.round(width * 0.08);
  const overlapY = Math.round(height * 0.08);
  const splitX = [0, Math.max(0, left - overlapX), Math.min(width, left + overlapX), width];
  const splitY = [0, Math.max(0, top - overlapY), Math.min(height, top + overlapY), height];
  const regions = [
    { left: splitX[0], top: splitY[0], right: splitX[2], bottom: splitY[2] },
    { left: splitX[1], top: splitY[0], right: splitX[3], bottom: splitY[2] },
    { left: splitX[0], top: splitY[1], right: splitX[2], bottom: splitY[3] },
    { left: splitX[1], top: splitY[1], right: splitX[3], bottom: splitY[3] },
  ];

  return Promise.all(regions.map(async (region, index) => {
    const cropWidth = Math.max(1, region.right - region.left);
    const cropHeight = Math.max(1, region.bottom - region.top);
    const output = await encodeJpeg(
      standardEnhancement(
        source
          .clone()
          .extract({ left: region.left, top: region.top, width: cropWidth, height: cropHeight })
          .resize({ width: DETAIL_TILE_SIDE, height: DETAIL_TILE_SIDE, fit: "inside", withoutEnlargement: true }),
        { detail: true },
      ),
    );
    return {
      base64: output.toString("base64"),
      mediaType: "image/jpeg",
      originalMediaType: mediaType,
      originalWidth: cropWidth,
      originalHeight: cropHeight,
      outputBytes: output.length,
      viewType: "detail-crop",
      viewIndex: index + 1,
      preprocessing: "crop-normalise-sharpen",
    };
  }));
}

export async function preprocessImagesForAI(images = []) {
  const prepared = await Promise.all(images.map(async (image) => ({
    main: await preprocessImageForAI(image),
    textRescue: await buildTextRescueView(image),
    details: await buildDetailViews(image),
  })));

  const views = [];
  for (const item of prepared) {
    views.push(item.main);
    if (item.textRescue) views.push(item.textRescue);
    views.push(...item.details);
    if (views.length >= MAX_VISION_VIEWS) break;
  }

  return views.filter(Boolean).slice(0, MAX_VISION_VIEWS);
}
