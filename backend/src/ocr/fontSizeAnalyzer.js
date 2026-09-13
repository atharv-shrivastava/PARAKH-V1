import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const execFileAsync = promisify(execFile);

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
  const candidates = [
    ocr?.detections,
    ocr?.ocrDetections,
    ocr?.textDetections,
    ocr?.rawDetections,
    ocr?.rawResults,
    ocr?.words,
    ocr?.ocrEvidence,
    ocr?.declarationEvidence,
  ];
  return candidates.filter(Array.isArray).flat();
}

function collectStructuredFieldDetections(ocr) {
  const detections = [];
  for (const [field, item] of Object.entries(ocr || {})) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const box = firstBox(item);
    if (!box) continue;
    const text = firstText(item);
    if (!text) continue;
    detections.push({
      field,
      text,
      bbox: box,
      imageIndex: Number.isFinite(Number(item.imageIndex)) ? Number(item.imageIndex) : 0,
      confidence: Number(item.confidence) || 0,
    });
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
  const merged = [...raw, ...structured];
  const seen = new Set();
  const detections = [];
  for (const item of merged) {
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

  const script = path.resolve(process.cwd(), "python", "font_size_measurement.py");
  const available = await fs.access(script).then(() => true).catch(() => false);
  if (!available) throw new Error(`OpenCV font-size script not found: ${script}`);

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "parakh-font-size-"));
  try {
    const payload = {
      images: paths.map((imagePath, imageIndex) => ({ path: imagePath, imageIndex })),
      detections,
      pixelsPerMm: normalizePixelsPerMm(pixelsPerMm),
    };
    const python = process.env.FONT_SIZE_PYTHON || "python3";
    const timeoutMs = Number(process.env.FONT_SIZE_TIMEOUT_MS || 15000);
    const { stdout } = await execFileAsync(python, [script], {
      input: undefined,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      env: process.env,
      windowsHide: true,
    });
    // execFile's promisified API does not expose stdin input directly, so use a
    // temporary JSON file plus the script's stdin contract through shell-free Python
    // invocation below when needed.
    void tempDir;
    return JSON.parse(stdout);
  } catch (error) {
    // Retry using the Node child process stdin path. This keeps the Python utility
    // shell-free and works consistently across Windows/Linux deployments.
    const inputPath = path.join(tempDir, "input.json");
    const outputPath = path.join(tempDir, "output.json");
    const payload = JSON.stringify({
      images: paths.map((imagePath, imageIndex) => ({ path: imagePath, imageIndex })),
      detections,
      pixelsPerMm: normalizePixelsPerMm(pixelsPerMm),
    });
    await fs.writeFile(inputPath, payload, "utf8");
    try {
      const python = process.env.FONT_SIZE_PYTHON || "python3";
      const timeoutMs = Number(process.env.FONT_SIZE_TIMEOUT_MS || 15000);
      const wrapper = `import json,sys; p=${JSON.stringify(inputPath)}; data=json.load(open(p, encoding='utf-8')); import subprocess; r=subprocess.run([sys.executable, ${JSON.stringify(script)}], input=json.dumps(data), text=True, capture_output=True, timeout=${Math.max(1, Math.floor(timeoutMs / 1000))}); sys.stdout.write(r.stdout); sys.stderr.write(r.stderr); sys.exit(r.returncode)`;
      const result = await execFileAsync(python, ["-c", wrapper], { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024, windowsHide: true });
      return JSON.parse(result.stdout);
    } catch (retryError) {
      return {
        status: "ERROR",
        measurements: [],
        byField: {},
        errors: [retryError?.stderr || retryError?.message || error?.message || "OpenCV measurement failed."],
        engineSafe: true,
      };
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}
