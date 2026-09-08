import { useEffect, useMemo, useState } from "react";
import "../styles/scan-visual-check.css";
import "../styles/scan-theme.css";

const STORAGE_KEY = "parakhVisualInspection";
const DECLARATION_KEY = "parakhDeclarationEvidence";
const MAX_IMAGES = 4;
const MAX_ANALYSIS_SIDE = 900;
const REQUIRED_OVERLAY_TYPES = new Set([
  "PRODUCTNAME", "PRODUCT_NAME", "BRAND", "MANUFACTURER", "MANUFACTURERADDRESS",
  "PACKER", "PACKERADDRESS", "IMPORTER", "IMPORTERADDRESS",
  "NETQUANTITY", "UNIT", "MRP", "DATEOFMANUFACTURE", "DATEOFPACKING",
  "BESTBEFORE", "EXPIRYDATE", "CONSUMERCAREPHONE", "CONSUMERCAREEMAIL",
  "COUNTRYOFORIGIN", "BATCHNUMBER",
]);
const OVERLAY_COLORS = [
  "#ff4d6d", "#7c3aed", "#0ea5e9", "#10b981", "#f59e0b",
  "#ef4444", "#06b6d4", "#8b5cf6", "#14b8a6", "#f97316",
];

const DECLARATION_FIELD_TYPES = {
  productName: "PRODUCT_NAME",
  brandName: "BRAND",
  netQuantity: "NET_QUANTITY",
  unit: "NET_QUANTITY",
  mrp: "MRP",
  manufacturer: "MANUFACTURER",
  manufacturerAddress: "ADDRESS",
  packer: "PACKER",
  packerAddress: "ADDRESS",
  importer: "IMPORTER",
  importerAddress: "ADDRESS",
  countryOfOrigin: "COUNTRY_OF_ORIGIN",
  dateOfManufacture: "DATE_OF_MANUFACTURE",
  dateOfPacking: "DATE_OF_PACKING",
  bestBefore: "BEST_BEFORE",
  expiryDate: "EXPIRY_DATE",
  batchNumber: "BATCH_NUMBER",
  consumerCarePhone: "CONSUMER_CARE",
  consumerCareEmail: "CONSUMER_CARE",
  fssaiLicenseNumber: "FSSAI_LICENSE",
  barcode: "BARCODE",
};

function analyzePixels(data, width, height) {
  let sum = 0;
  let sumSq = 0;
  let darkPixels = 0;
  let edgeDarkPixels = 0;
  let edgeCount = 0;
  let edgeSamples = 0;
  const rowDensity = new Float32Array(height);
  const gray = new Float32Array(width * height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const g = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      gray[y * width + x] = g;
      sum += g;
      sumSq += g * g;
      if (g < 105) {
        darkPixels += 1;
        rowDensity[y] += 1;
        if (x < width * 0.04 || x > width * 0.96 || y < height * 0.04 || y > height * 0.96) edgeDarkPixels += 1;
      }
    }
  }

  for (let y = 1; y < height - 1; y += 3) {
    for (let x = 1; x < width - 1; x += 3) {
      const i = y * width + x;
      const gx = Math.abs(gray[i + 1] - gray[i - 1]);
      const gy = Math.abs(gray[i + width] - gray[i - width]);
      if (gx + gy > 55) edgeCount += 1;
      edgeSamples += 1;
    }
  }

  const lineBands = [];
  let bandStart = -1;
  for (let y = 0; y < height; y += 1) {
    const density = rowDensity[y] / Math.max(1, width);
    const textLike = density >= 0.008 && density <= 0.48;
    if (textLike && bandStart < 0) bandStart = y;
    if ((!textLike || y === height - 1) && bandStart >= 0) {
      const end = textLike && y === height - 1 ? y : y - 1;
      const bandHeight = end - bandStart + 1;
      if (bandHeight >= 2 && bandHeight <= Math.max(60, height * 0.12)) lineBands.push(bandHeight);
      bandStart = -1;
    }
  }

  const count = Math.max(1, width * height);
  const mean = sum / count;
  const contrast = Math.sqrt(Math.max(0, sumSq / count - mean * mean));
  const sampleCount = Math.max(1, edgeSamples);
  const sharpness = Math.min(100, Math.max(0, (edgeCount / sampleCount) * 360));
  const contrastScore = Math.min(100, Math.max(0, contrast * 2.2));
  const edgeScore = Math.min(100, (edgeCount / sampleCount) * 600);
  const readability = Math.round(Math.min(100, 0.45 * sharpness + 0.45 * contrastScore + 0.10 * edgeScore));
  const sortedHeights = [...lineBands].sort((a, b) => a - b);
  const medianLineHeight = sortedHeights.length ? sortedHeights[Math.floor(sortedHeights.length / 2)] : 0;
  const textCoverage = Math.round(Math.min(100, (darkPixels / count) * 100 * 4));
  const edgeCrowding = Math.round(Math.min(100, (edgeDarkPixels / Math.max(1, darkPixels)) * 100));
  const placement = edgeCrowding > 18 ? "REVIEW" : lineBands.length >= 2 ? "SCREENED" : "UNABLE_TO_VERIFY";

  return { width, height, readability, sharpness, contrast: contrastScore, textLines: lineBands.length, textCoverage, edgeCrowding, medianLineHeight, placement };
}

async function inspectImageSource(src) {
  const response = await fetch(src);
  if (!response.ok) throw new Error("Could not load scan image.");
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, MAX_ANALYSIS_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    bitmap.close();
    throw new Error("Could not inspect image.");
  }
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return analyzePixels(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
}

function getScanImages() {
  return Array.from(document.querySelectorAll(".scan-image-grid .scan-image-card img"))
    .slice(0, MAX_IMAGES)
    .map((image) => image.src)
    .filter(Boolean);
}

function normalizeDeclaration(item, index) {
  if (!item || typeof item !== "object") return null;
  const rawImageIndex = Number(item.imageIndex ?? item.image ?? 0);
  const rawConfidence = Number(item.confidence);
  const confidence = rawConfidence > 1 ? rawConfidence / 100 : Number.isFinite(rawConfidence) ? rawConfidence : 0;
  return {
    id: String(item.id ?? `evidence-${index}`),
    imageIndex: Number.isFinite(rawImageIndex) && rawImageIndex >= 1 && item.imageIndex != null ? rawImageIndex - 1 : Math.max(0, rawImageIndex || 0),
    type: String(item.type || item.declarationType || "OTHER_DECLARATION").toUpperCase(),
    text: String(item.text ?? item.extractedText ?? item.value ?? "").trim(),
    confidence: Math.max(0, Math.min(1, confidence)),
    source: item.source || "ocr",
    status: item.status || "found",
    value: item.value ?? item.text ?? null,
    boundingBox: item.boundingBox || null,
    imageWidth: Number(item.imageWidth || 0),
    imageHeight: Number(item.imageHeight || 0),
  };
}

function labelToFieldKey(label) {
  return String(label || "")
    .trim()
    .replace(/[^a-zA-Z0-9 ]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .map((part, index) => index === 0 ? part.toLowerCase() : `${part[0].toUpperCase()}${part.slice(1).toLowerCase()}`)
    .join("");
}

function overlapRatio(a, b) {
  const ax2 = a.left + a.width;
  const ay2 = a.top + a.height;
  const bx2 = b.left + b.width;
  const by2 = b.top + b.height;
  const ix = Math.max(0, Math.min(ax2, bx2) - Math.max(a.left, b.left));
  const iy = Math.max(0, Math.min(ay2, by2) - Math.max(a.top, b.top));
  const intersection = ix * iy;
  const smaller = Math.max(1, Math.min(a.width * a.height, b.width * b.height));
  return intersection / smaller;
}

function buildOverlayDeclarations(items) {
  const candidates = items
    .filter((item) => REQUIRED_OVERLAY_TYPES.has(String(item.type || "").toUpperCase()))
    .filter((item) => item.status === "found" && item.text && item.boundingBox)
    .map((item, index) => ({ ...item, color: OVERLAY_COLORS[index % OVERLAY_COLORS.length] }))
    .sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0));

  const kept = [];
  for (const candidate of candidates) {
    if (!kept.some((existing) => existing.imageIndex === candidate.imageIndex && overlapRatio(existing.boundingBox, candidate.boundingBox) > 0.45)) {
      kept.push(candidate);
    }
  }
  return kept;
}

function readStoredDeclarations() {
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(DECLARATION_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.map(normalizeDeclaration).filter((item) => item?.text) : [];
  } catch {
    return [];
  }
}

function deriveDeclarationsFromOcrFields() {
  const fields = Array.from(document.querySelectorAll(".ocr-fields-grid > div"));
  return fields.reduce((accumulator, fieldNode, index) => {
    const label = fieldNode.querySelector("strong")?.textContent || "";
    const value = fieldNode.querySelector("span")?.textContent?.trim() || "";
    const confidenceText = fieldNode.querySelector("small")?.textContent || "";
    if (!value) return accumulator;

    const fieldKey = labelToFieldKey(label);
    const type = DECLARATION_FIELD_TYPES[fieldKey] || "OTHER_DECLARATION";
    const parsedConfidence = Number(confidenceText.match(/([0-9]+(?:\.[0-9]+)?)\s*%/)?.[1] || 0);
    accumulator.push(normalizeDeclaration({
      imageIndex: 0,
      type,
      text: value,
      confidence: parsedConfidence / 100,
      source: "ocr-fields-fallback",
    }, index));
    return accumulator;
  }, []).filter(Boolean);
}

export default function ScanVisualCheck() {
  const [results, setResults] = useState([]);
  const [declarations, setDeclarations] = useState(readStoredDeclarations);
  const [open, setOpen] = useState(true);
  const [referenceWidth, setReferenceWidth] = useState("");

  useEffect(() => {
    const refreshDeclarations = (incoming = null) => {
      const providerEvidence = Array.isArray(incoming)
        ? incoming.map(normalizeDeclaration).filter((item) => item?.text)
        : readStoredDeclarations();
      setDeclarations(providerEvidence.length ? providerEvidence : deriveDeclarationsFromOcrFields());
    };

    refreshDeclarations();
    const handleEvidence = (event) => refreshDeclarations(event.detail);
    window.addEventListener("parakh:declaration-evidence", handleEvidence);

    const observer = new MutationObserver(() => {
      if (!readStoredDeclarations().length && !declarations.length) refreshDeclarations();
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });

    return () => {
      window.removeEventListener("parakh:declaration-evidence", handleEvidence);
      observer.disconnect();
    };
  }, [declarations.length]);

  useEffect(() => {
    let cancelled = false;
    const sources = getScanImages();
    if (!sources.length) return undefined;

    Promise.all(sources.map((src) => inspectImageSource(src).catch(() => null)))
      .then((next) => {
        if (!cancelled) setResults(next.filter(Boolean));
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const average = results.length
    ? Math.round(results.reduce((sum, item) => sum + item.readability, 0) / results.length)
    : 0;
  const label = average >= 75 ? "Good" : average >= 50 ? "Fair" : "Needs review";

  const estimatedMm = useMemo(() => {
    const widthMm = Number(referenceWidth);
    if (!Number.isFinite(widthMm) || widthMm <= 0) return null;
    const values = results.filter((item) => item.medianLineHeight > 0).map((item) => (item.medianLineHeight * widthMm) / item.width);
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  }, [referenceWidth, results]);

  const overlayDeclarations = useMemo(() => buildOverlayDeclarations(declarations), [declarations]);

  const placementLabel = results.some((item) => item.placement === "REVIEW")
    ? "Review"
    : results.length && results.every((item) => item.placement === "SCREENED")
      ? "Screened"
      : "Needs review";

  useEffect(() => {
    if (!results.length) return;
    const detail = {
      readability: average,
      readable: average >= 50,
      textDetected: results.some((item) => item.textLines > 0),
      placementReview: results.some((item) => item.placement === "REVIEW"),
      fontSizeCalibrated: estimatedMm !== null,
      estimatedTextHeightMm: estimatedMm,
      declarationCoverageScreened: declarations.length > 0,
      imagesChecked: results.length,
      declarationEvidence: declarations,
      declarationModel: declarations.length ? "ocr-evidence" : null,
    };
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(detail));
    window.dispatchEvent(new CustomEvent("parakh:visual-analysis", { detail }));
  }, [results, average, estimatedMm, declarations]);

  if (!results.length) return null;

  return (
    <section className="scan-visual-check">
      <div className="section-heading">
        <div>
          <h2>Visual inspection</h2>
          <p>Automatic screening for readability, declaration evidence, placement concerns and approximate text size.</p>
        </div>
        <button type="button" className="secondary-button" onClick={() => setOpen((value) => !value)}>
          {open ? "Hide" : "Show"}
        </button>
      </div>

      {open && (
        <>
          <div className="visual-check-summary">
            <div><strong>Readability</strong><span>{average}/100 · {label}</span></div>
            <div><strong>Placement screening</strong><span>{placementLabel}</span></div>
            <div><strong>Declarations detected</strong><span>{declarations.length}</span></div>
            <div><strong>Images checked</strong><span>{results.length}</span></div>
          </div>

          <div className="visual-check-grid">
            {results.map((item, index) => (
              <div className="visual-check-card" key={`${item.width}-${item.height}-${index}`}>
                <strong>Image {index + 1}</strong>
                <span>{item.width} × {item.height}px</span>
                <span>Readability {item.readability}/100</span>
                <span>Sharpness {Math.round(item.sharpness)}/100</span>
                <span>Contrast {Math.round(item.contrast)}/100</span>
                <span>Text regions {item.textLines}</span>
                <span>Text coverage {item.textCoverage}%</span>
                <span>Placement: {item.placement === "REVIEW" ? "Review" : item.placement === "SCREENED" ? "Screened" : "Unable to verify"}</span>
                <span>Median detected line {item.medianLineHeight || "n/a"} px</span>
              </div>
            ))}
          </div>

          <div className="visual-check-calibration">
            <label htmlFor="parakh-reference-width">Reference package width (mm), optional</label>
            <input
              id="parakh-reference-width"
              type="number"
              min="1"
              step="0.1"
              value={referenceWidth}
              onChange={(event) => setReferenceWidth(event.target.value)}
              placeholder="e.g. 80"
            />
            <span>Approximate detected text height: {estimatedMm === null ? "Not calibrated" : `${estimatedMm.toFixed(2)} mm`}</span>
          </div>

          <div className="visual-check-declarations">
            <h3>Declaration evidence</h3>
            <p>Only rule-relevant, successfully mapped declarations are shown on the image. Click a colored box to inspect the field.</p>
            {declarations.length ? declarations.map((item, index) => (
              <div className="declaration-evidence-row" key={item.id + "-" + index}>
                <strong>{item.type.replaceAll("_", " ")}</strong>
                <span>{item.text}</span>
                <small>Image {item.imageIndex + 1} · {Math.round(item.confidence * 100)}%</small>
              </div>
            )) : <span>No declaration evidence was returned.</span>}
              <div className="declaration-evidence-row" key={`${item.id}-${index}`}>
                <strong>{item.type.replaceAll("_", " ")}</strong>
                <span>{item.text}</span>
                <small>Image {item.imageIndex + 1} · {Math.round(item.confidence * 100)}%</small>
              </div>
            )) : <span>No declaration evidence was returned.</span>}
          </div>
        </>
      )}
    </section>
  );
}
