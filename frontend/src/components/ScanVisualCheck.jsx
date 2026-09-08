import { useEffect, useMemo, useState } from "react";
import "../styles/scan-visual-check.css";

const STORAGE_KEY = "parakhVisualInspection";
const DECLARATION_KEY = "parakhDeclarationEvidence";
const MAX_IMAGES = 4;
const MAX_ANALYSIS_SIDE = 1200;

// Only declarations that can directly affect the current compliance review are mapped.
const REQUIRED_TYPES = new Set([
  "PRODUCT_NAME",
  "MANUFACTURER",
  "ADDRESS",
  "PACKER",
  "IMPORTER",
  "NET_QUANTITY",
  "MRP",
  "DATE_OF_MANUFACTURE",
  "DATE_OF_PACKING",
  "BEST_BEFORE",
  "EXPIRY_DATE",
  "CONSUMER_CARE",
]);

const TYPE_LABELS = {
  PRODUCT_NAME: "Product name",
  MANUFACTURER: "Manufacturer",
  ADDRESS: "Address",
  PACKER: "Packer",
  IMPORTER: "Importer",
  NET_QUANTITY: "Net quantity",
  MRP: "MRP",
  DATE_OF_MANUFACTURE: "Manufacturing date",
  DATE_OF_PACKING: "Packing date",
  BEST_BEFORE: "Best before",
  EXPIRY_DATE: "Expiry date",
  CONSUMER_CARE: "Consumer care",
};

function analyzePixels(data, width, height) {
  let sum = 0;
  let sumSq = 0;
  let edgeCount = 0;
  let edgeSamples = 0;
  let lapSum = 0;
  let lapSq = 0;
  let darkPixels = 0;
  let edgeDarkPixels = 0;
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

  const count = Math.max(1, width * height);
  const contrast = Math.sqrt(Math.max(0, sumSq / count - Math.pow(sum / count, 2)));
  const bands = [];
  let bandStart = -1;
  for (let y = 0; y < height; y += 1) {
    const density = rowDensity[y] / Math.max(1, width);
    const textLike = density >= 0.008 && density <= 0.48;
    if (textLike && bandStart < 0) bandStart = y;
    if ((!textLike || y === height - 1) && bandStart >= 0) {
      const end = textLike && y === height - 1 ? y : y - 1;
      const bandHeight = end - bandStart + 1;
      if (bandHeight >= 2 && bandHeight <= Math.max(60, height * 0.12)) bands.push(bandHeight);
      bandStart = -1;
    }
  }

  for (let y = 1; y < height - 1; y += 2) {
    for (let x = 1; x < width - 1; x += 2) {
      const i = y * width + x;
      const gx = Math.abs(gray[i + 1] - gray[i - 1]);
      const gy = Math.abs(gray[i + width] - gray[i - width]);
      if (gx + gy > 55) edgeCount += 1;
      edgeSamples += 1;
      const lap = gray[i - 1] + gray[i + 1] + gray[i - width] + gray[i + width] - 4 * gray[i];
      lapSum += lap;
      lapSq += lap * lap;
    }
  }

  const samples = Math.max(1, edgeSamples);
  const lapVariance = Math.max(0, lapSq / samples - Math.pow(lapSum / samples, 2));
  const sharpness = Math.min(100, Math.max(0, lapVariance / 7));
  const contrastScore = Math.min(100, Math.max(0, contrast * 2.2));
  const edgeScore = Math.min(100, (edgeCount / samples) * 600);
  const readability = Math.round(Math.min(100, 0.55 * sharpness + 0.35 * contrastScore + 0.1 * edgeScore));
  const medianLineHeight = bands.length ? [...bands].sort((a, b) => a - b)[Math.floor(bands.length / 2)] : 0;
  const textCoverage = Math.round(Math.min(100, (darkPixels / count) * 100 * 4));
  const edgeCrowding = Math.round(Math.min(100, (edgeDarkPixels / Math.max(1, darkPixels)) * 100));
  const placement = edgeCrowding > 18 ? "REVIEW" : bands.length >= 2 ? "SCREENED" : "UNABLE_TO_VERIFY";
  return { width, height, readability, sharpness, contrast: contrastScore, textLines: bands.length, textCoverage, edgeCrowding, medianLineHeight, placement };
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

function normalizeBoundingBox(box, imageWidth, imageHeight) {
  if (!box) return null;
  let left;
  let top;
  let width;
  let height;

  if (Array.isArray(box)) {
    if (box.length === 4 && box.every((point) => Array.isArray(point) && point.length >= 2)) {
      const points = box.map((point) => [Number(point[0]), Number(point[1])]);
      const xs = points.map(([x]) => x).filter(Number.isFinite);
      const ys = points.map(([, y]) => y).filter(Number.isFinite);
      if (xs.length === 4 && ys.length === 4) {
        left = Math.min(...xs);
        top = Math.min(...ys);
        width = Math.max(...xs) - left;
        height = Math.max(...ys) - top;
      }
    } else if (box.length >= 4 && box.slice(0, 4).every((value) => Number.isFinite(Number(value)))) {
      const values = box.slice(0, 4).map(Number);
      left = values[0];
      top = values[1];
      width = values[2] - values[0];
      height = values[3] - values[1];
      if (width <= 0 || height <= 0) {
        width = values[2];
        height = values[3];
      }
    }
  } else if (typeof box === "object") {
    left = Number(box.left ?? box.x ?? box.x1);
    top = Number(box.top ?? box.y ?? box.y1);
    width = Number(box.width ?? box.w);
    height = Number(box.height ?? box.h);
    const right = Number(box.right ?? box.x2);
    const bottom = Number(box.bottom ?? box.y2);
    if ((!Number.isFinite(width) || width <= 0) && Number.isFinite(right)) width = right - left;
    if ((!Number.isFinite(height) || height <= 0) && Number.isFinite(bottom)) height = bottom - top;
  }

  if (![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;

  if ([left, top, width, height].every((value) => value >= 0 && value <= 1)) {
    const safeLeft = Math.min(1, Math.max(0, left));
    const safeTop = Math.min(1, Math.max(0, top));
    return {
      left: safeLeft,
      top: safeTop,
      width: Math.min(1 - safeLeft, width),
      height: Math.min(1 - safeTop, height),
    };
  }

  const w = Number(imageWidth);
  const h = Number(imageHeight);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  const safeLeft = Math.min(w, Math.max(0, left));
  const safeTop = Math.min(h, Math.max(0, top));
  const safeWidth = Math.min(w - safeLeft, Math.max(0, width));
  const safeHeight = Math.min(h - safeTop, Math.max(0, height));
  if (safeWidth <= 0 || safeHeight <= 0) return null;
  return { left: safeLeft / w, top: safeTop / h, width: safeWidth / w, height: safeHeight / h };
}

function normalizeDeclaration(item, index) {
  if (!item || typeof item !== "object") return null;
  // Backend declaration evidence is already normalized to zero-based image indexes.
  // Do not subtract again here. RapidOCR itself is one-based, but fastRoutes converts
  // it before this component receives the result.
  const rawImageIndex = Number(item.imageIndex ?? item.image ?? 0);
  const confidenceRaw = Number(item.confidence);
  const confidence = confidenceRaw > 1 ? confidenceRaw / 100 : Number.isFinite(confidenceRaw) ? confidenceRaw : 0;
  const type = String(item.type || item.declarationType || "OTHER_DECLARATION").toUpperCase();
  if (!REQUIRED_TYPES.has(type)) return null;
  return {
    ...item,
    imageIndex: Number.isInteger(rawImageIndex) && rawImageIndex >= 0 ? rawImageIndex : 0,
    type,
    text: String(item.text ?? item.extractedText ?? item.value ?? "").trim(),
    confidence: Math.max(0, Math.min(1, confidence)),
    boundingBox: normalizeBoundingBox(item.boundingBox || item.bbox || item.box, item.imageWidth, item.imageHeight),
    _index: index,
  };
}

function dedupeDeclarations(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = `${item.imageIndex}|${item.type}|${String(item.text).toLowerCase().replace(/\s+/g, " ").trim()}|${item.value ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function readStoredDeclarations() {
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(DECLARATION_KEY) || "[]");
    return Array.isArray(parsed) ? dedupeDeclarations(parsed.map(normalizeDeclaration).filter(Boolean)) : [];
  } catch {
    return [];
  }
}

export default function ScanVisualCheck() {
  const [results, setResults] = useState([]);
  const [declarations, setDeclarations] = useState(readStoredDeclarations);
  const [activeDeclarationImage, setActiveDeclarationImage] = useState(0);
  const [selectedDeclarationKey, setSelectedDeclarationKey] = useState(null);
  const [open, setOpen] = useState(true);
  const [referenceWidth, setReferenceWidth] = useState("");
  const [calibratedWidth, setCalibratedWidth] = useState("");
  const [calibrationMessage, setCalibrationMessage] = useState("");

  useEffect(() => {
    const refreshDeclarations = (incoming) => {
      const next = Array.isArray(incoming) ? dedupeDeclarations(incoming.map(normalizeDeclaration).filter(Boolean)) : readStoredDeclarations();
      setDeclarations(next);
      if (next.length && !next.some((item) => item.boundingBox)) {
        console.warn("[Parakh] Semantic declarations returned without usable OCR geometry", next);
      }
    };
    refreshDeclarations();
    const handleEvidence = (event) => refreshDeclarations(event.detail);
    window.addEventListener("parakh:declaration-evidence", handleEvidence);
    return () => window.removeEventListener("parakh:declaration-evidence", handleEvidence);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const sources = getScanImages();
    if (!sources.length) return undefined;
    Promise.all(sources.map((src) => inspectImageSource(src).catch(() => null))).then((next) => {
      if (!cancelled) setResults(next.filter(Boolean));
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!selectedDeclarationKey) return;
    const node = document.querySelector(`[data-declaration-key="${CSS.escape(selectedDeclarationKey)}"]`);
    node?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [selectedDeclarationKey]);

  const average = results.length ? Math.round(results.reduce((sum, item) => sum + item.readability, 0) / results.length) : 0;
  const readabilityLabel = average >= 75 ? "Good" : average >= 50 ? "Fair" : "Poor";
  const estimatedMm = useMemo(() => {
    const widthMm = Number(calibratedWidth);
    if (!Number.isFinite(widthMm) || widthMm <= 0) return null;
    const values = results.filter((item) => item.medianLineHeight > 0).map((item) => (item.medianLineHeight * widthMm) / item.width);
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  }, [calibratedWidth, results]);

  useEffect(() => {
    if (!results.length) return;
    const detail = {
      readability: average,
      readable: average >= 50,
      textDetected: results.some((item) => item.textLines > 0),
      placementReview: results.some((item) => item.placement === "REVIEW"),
      fontSizeCalibrated: estimatedMm !== null,
      calibrationWidthMm: calibratedWidth ? Number(calibratedWidth) : null,
      estimatedTextHeightMm: estimatedMm,
      declarationCoverageScreened: declarations.length > 0,
      imagesChecked: results.length,
      declarationEvidence: declarations,
      declarationModel: declarations.length ? "semantic-required-evidence" : null,
    };
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(detail));
    window.dispatchEvent(new CustomEvent("parakh:visual-analysis", { detail }));
  }, [results, average, estimatedMm, declarations, calibratedWidth]);

  if (!results.length) return null;

  return (
    <section className="scan-visual-check">
      <div className="section-heading">
        <div>
          <h2>Visual inspection</h2>
          <p>Screen readability, calibrated text size and rule-relevant declaration evidence.</p>
        </div>
        <button type="button" className="secondary-button" onClick={() => setOpen((value) => !value)}>{open ? "Hide" : "Show"}</button>
      </div>

      {open && <>
        <div className="visual-check-summary">
          <div><strong>Readability</strong><span>{readabilityLabel} · {average}/100</span></div>
          <div><strong>Text detection</strong><span>{results.reduce((sum, item) => sum + item.textLines, 0)} text-line regions</span></div>
          <div><strong>Placement screening</strong><span>{results.some((item) => item.placement === "REVIEW") ? "Review" : "Screened"}</span></div>
          <div><strong>Required evidence</strong><span>{declarations.length} mapped declaration{declarations.length === 1 ? "" : "s"}</span></div>
        </div>

        <div className="visual-check-calibration">
          <div className="visual-calibration-card">
            <span className="visual-calibration-label">Known package face width (mm)</span>
            <div className="visual-calibration-row">
              <input type="number" min="1" step="0.1" placeholder="Enter measured width" value={referenceWidth} onChange={(event) => setReferenceWidth(event.target.value)} />
              <button type="button" className="primary-button visual-calibration-button" disabled={!Number(referenceWidth) || Number(referenceWidth) <= 0} onClick={() => { setCalibratedWidth(referenceWidth); setCalibrationMessage(`Calibration applied at ${Number(referenceWidth).toFixed(1)} mm.`); }}>Calibrate</button>
              {calibratedWidth && <button type="button" className="secondary-button visual-calibration-button" onClick={() => { setCalibratedWidth(""); setCalibrationMessage("Calibration cleared."); }}>Clear</button>}
            </div>
            {calibrationMessage && <small className="visual-calibration-status">{calibrationMessage}</small>}
          </div>
          <div className="visual-calibration-card visual-calibration-result">
            <strong>Estimated text height</strong>
            <span>{estimatedMm === null ? "Needs calibration" : `${estimatedMm.toFixed(2)} mm`}</span>
            <small>Assistive estimate only. Final statutory measurement remains with the inspector.</small>
          </div>
        </div>

        <div className="visual-check-grid">
          {results.map((item, index) => <div className="visual-check-card" key={`${item.width}-${item.height}-${index}`}>
            <strong>Image {index + 1}</strong>
            <span>{item.width} × {item.height}px</span>
            <span>Readability {item.readability}/100</span>
            <span>Sharpness {Math.round(item.sharpness)}/100</span>
            <span>Contrast {Math.round(item.contrast)}/100</span>
            <span>Text regions {item.textLines}</span>
            <span>Text coverage {item.textCoverage}%</span>
            <span>Edge crowding {item.edgeCrowding}% · {item.placement === "REVIEW" ? "Review" : "Screened"}</span>
            <span>Median line {item.medianLineHeight || "n/a"} px</span>
            <span>Calibrated size {estimatedMm === null ? "n/a" : `${(item.medianLineHeight * Number(calibratedWidth) / item.width).toFixed(2)} mm`}</span>
          </div>)}
        </div>

        <div className="visual-declaration-header">
          <div>
            <h3>Declaration map</h3>
            <p>Only rule-relevant declarations are mapped. Click a colored box or evidence row to focus the same evidence.</p>
          </div>
          <span className="visual-declaration-count">{declarations.length} mapped</span>
        </div>

        <div className="visual-declaration-browser">
          <div className="visual-declaration-tabs" role="tablist" aria-label="Package images">
            {results.map((_item, imageIndex) => {
              const count = declarations.filter((item) => item.imageIndex === imageIndex).length;
              const active = activeDeclarationImage === imageIndex;
              return <button type="button" role="tab" aria-selected={active} className={active ? "visual-declaration-tab is-active" : "visual-declaration-tab"} key={`decl-tab-${imageIndex}`} onClick={() => setActiveDeclarationImage(imageIndex)}>
                Image {imageIndex + 1}<span>{count} mapped</span>
              </button>;
            })}
          </div>

          {(() => {
            const imageIndex = Math.min(activeDeclarationImage, results.length - 1);
            const image = getScanImages()[imageIndex];
            const imageDeclarations = declarations.filter((item) => item.imageIndex === imageIndex);
            return <div className="visual-declaration-card is-single">
              <div className="visual-declaration-canvas">
                <img src={image} alt={`Declaration map for package image ${imageIndex + 1}`} />
                {imageDeclarations.map((item, index) => {
                  if (!item.boundingBox) return null;
                  const key = `${item.imageIndex}-${item.type}-${index}`;
                  const selected = selectedDeclarationKey === key;
                  return <button type="button" className={`visual-declaration-box declaration-${item.type}${selected ? " is-selected" : ""}`} key={key} data-declaration-key={key} aria-label={`${TYPE_LABELS[item.type] || item.type}: ${item.value ?? item.text}`} title={`${TYPE_LABELS[item.type] || item.type}: ${item.value ?? item.text}`} onClick={() => setSelectedDeclarationKey(key)} style={{ left: `${item.boundingBox.left * 100}%`, top: `${item.boundingBox.top * 100}%`, width: `${item.boundingBox.width * 100}%`, height: `${item.boundingBox.height * 100}%` }}>
                    <span>{TYPE_LABELS[item.type] || item.type.replaceAll("_", " ")}</span>
                  </button>;
                })}
                {!imageDeclarations.some((item) => item.boundingBox) && <div className="visual-declaration-no-box">No verified OCR geometry was returned for this image.</div>}
              </div>

              <div className="visual-declaration-list">
                {imageDeclarations.length ? imageDeclarations.map((item, index) => {
                  const key = `${item.imageIndex}-${item.type}-${index}`;
                  const selected = selectedDeclarationKey === key;
                  return <button type="button" className={`visual-declaration-item${selected ? " is-selected" : ""}`} key={key} onClick={() => { setSelectedDeclarationKey(key); if (!item.boundingBox) setActiveDeclarationImage(item.imageIndex); }}>
                    <span className="visual-declaration-type">{TYPE_LABELS[item.type] || item.type.replaceAll("_", " ")}</span>
                    <strong>{item.value ?? item.text ?? "Declaration detected"}</strong>
                    {item.value && item.text && String(item.value).trim() !== String(item.text).trim() && <small>OCR evidence: {item.text}</small>}
                    <small>{item.boundingBox ? "Verified OCR position · Click to focus" : "Semantic evidence without verified OCR position"}</small>
                  </button>;
                }) : <div className="visual-declaration-empty"><strong>No rule-relevant declaration evidence for this image.</strong><span>Unclassified OCR text remains available in the raw extraction.</span></div>}
              </div>
            </div>;
          })()}
        </div>

        <div className="visual-check-note">Boxes are rendered only from OCR geometry associated with a required field. PARAKH does not fabricate coordinates from semantic text.</div>
      </>}
    </section>
  );
}
