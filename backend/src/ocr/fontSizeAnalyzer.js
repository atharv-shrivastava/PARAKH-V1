import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const FIELD_ALIASES = {
  productName: ["productName", "commonOrGenericName"],
  manufacturer: ["manufacturer", "manufacturerOrPacker"],
  packer: ["packer", "manufacturerOrPacker"],
  importer: ["importer"],
  marketer: ["marketer"],
  netQuantity: ["netQuantity", "quantity"],
  mrp: ["mrp", "retailSalePrice", "maximumRetailPrice"],
  consumerCarePhone: ["consumerCarePhone", "consumerComplaintContact"],
  consumerCareEmail: ["consumerCareEmail", "consumerComplaintContact"],
  dateOfManufacture: ["dateOfManufacture", "manufactureOrImportDate"],
  dateOfPacking: ["dateOfPacking", "manufactureOrImportDate"],
  batchNumber: ["batchNumber", "batch"],
  countryOfOrigin: ["countryOfOrigin"],
};

function normalizeText(value) {
  return String(value ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function boxFrom(value) {
  if (!Array.isArray(value)) return null;
  if (value.length >= 4 && value.every((n) => Number.isFinite(Number(n)))) return value.slice(0, 4).map(Number);
  if (value.length >= 4 && value.every((p) => Array.isArray(p) && p.length >= 2)) {
    const xs = value.map((p) => Number(p[0])).filter(Number.isFinite);
    const ys = value.map((p) => Number(p[1])).filter(Number.isFinite);
    if (xs.length >= 4 && ys.length >= 4) return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }
  return null;
}

function firstBox(item) {
  if (!item || typeof item !== "object") return null;
  return boxFrom(item.bbox) || boxFrom(item.box) || boxFrom(item.boundingBox) || boxFrom(item.polygon) || boxFrom(item.points) || null;
}

function firstText(item) {
  return String(item?.text ?? item?.raw ?? item?.value ?? item?.evidence ?? "").trim();
}

function collectDetectionArrays(ocr) {
  return [ocr?.detections, ocr?.ocrDetections, ocr?.textDetections, ocr?.rawDetections, ocr?.rawResults, ocr?.words, ocr?.ocrEvidence, ocr?.declarationEvidence]
    .filter(Array.isArray).flat();
}

function collectStructuredFieldDetections(ocr) {
  const detections = [];
  for (const [field, item] of Object.entries(ocr || {})) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const box = firstBox(item);
    const text = firstText(item);
    if (!box || !text) continue;
    detections.push({ field, text, bbox: box, imageIndex: Number.isFinite(Number(item.imageIndex)) ? Number(item.imageIndex) : 0, confidence: Number(item.confidence) || 0 });
  }
  return detections;
}

function inferField(text, ocr) {
  const normalized = normalizeText(text);
  if (!normalized) return null;
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    for (const alias of aliases) {
      const item = ocr?.[alias];
      const value = normalizeText(item?.value ?? item?.displayValue ?? "");
      if (value && (normalized.includes(value) || value.includes(normalized))) return field;
    }
  }
  if (/m\.?r\.?p|maximum retail|retail sale/.test(normalized)) return "mrp";
  if (/net\s*(quantity|qty)|contents|volume|weight/.test(normalized)) return "netQuantity";
  if (/manufactur|mfd|mfg/.test(normalized)) return "manufacturer";
  if (/packer|packed by/.test(normalized)) return "packer";
  if (/importer|imported by/.test(normalized)) return "importer";
  if (/consumer|complaint|customer care/.test(normalized)) return "consumerCarePhone";
  if (/batch|lot/.test(normalized)) return "batchNumber";
  if (/best before|expiry|use by/.test(normalized)) return "expiryDate";
  if (/country of origin|made in/.test(normalized)) return "countryOfOrigin";
  return null;
}

function buildDetections(ocr) {
  const raw = collectDetectionArrays(ocr)
    .map((item) => ({
      field: item?.field || item?.type || null,
      text: firstText(item),
      bbox: firstBox(item),
      imageIndex: Number.isFinite(Number(item?.imageIndex)) ? Number(item.imageIndex) : 0,
      confidence: Number(item?.confidence) || 0,
    }))
    .filter((item) => item.text && item.bbox);
  const structured = collectStructuredFieldDetections(ocr);
  const seen = new Set();
  const detections = [];
  for (const item of [...raw, ...structured]) {
    const field = item.field && FIELD_ALIASES[item.field] ? item.field : (item.field || inferField(item.text, ocr));
    const key = JSON.stringify([field, item.text, item.imageIndex, item.bbox.map((n) => Math.round(n))]);
    if (seen.has(key)) continue;
    seen.add(key);
    detections.push({ ...item, field });
  }
  return detections;
}

function normalizePixelsPerMm(raw) {
  if (!raw || typeof raw !== "object") return {};
  const output = {};
  for (const [index, value] of Object.entries(raw)) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) output[String(index)] = n;
  }
  return output;
}

function runPythonJson({ python, script, payload, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [script], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: process.env });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
      if (!settled) { settled = true; reject(new Error(`OpenCV font-size analysis timed out after ${timeoutMs} ms.`)); }
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 10 * 1024 * 1024) child.kill();
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      clearTimeout(timer);
      if (!settled) { settled = true; reject(error); }
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code !== 0) return reject(new Error(stderr.trim() || `Python font-size process exited with code ${code}.`));
      try { resolve(JSON.parse(stdout)); }
      catch { reject(new Error(`OpenCV returned invalid JSON: ${stderr.trim() || stdout.slice(0, 500)}`)); }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

async function resolveScript() {
  const candidates = [
    path.resolve(process.cwd(), "python", "font_size_measurement.py"),
    path.resolve(process.cwd(), "backend", "python", "font_size_measurement.py"),
  ];
  for (const candidate of candidates) {
    if (await fs.access(candidate).then(() => true).catch(() => false)) return candidate;
  }
  throw new Error(`OpenCV font-size script not found. Checked: ${candidates.join(", ")}`);
}

export async function analyzeFontSize({ imagePaths, ocr, pixelsPerMm = {} }) {
  const paths = Array.isArray(imagePaths) ? imagePaths.filter(Boolean) : [];
  const detections = buildDetections(ocr);
  if (!paths.length || !detections.length) {
    return {
      status: "NO_MEASURABLE_TEXT",
      measurements: [],
      byField: {},
      errors: [],
      engineSafe: true,
      note: "No OCR text bounding boxes were available for OpenCV measurement.",
    };
  }

  const script = await resolveScript();
  const payload = {
    images: paths.map((imagePath, imageIndex) => ({ path: imagePath, imageIndex })),
    detections,
    pixelsPerMm: normalizePixelsPerMm(pixelsPerMm),
  };
  const python = process.env.FONT_SIZE_PYTHON || (process.platform === "win32" ? "python" : "python3");
  const timeoutMs = Number(process.env.FONT_SIZE_TIMEOUT_MS || 15000);
  return runPythonJson({ python, script, payload, timeoutMs });
}
