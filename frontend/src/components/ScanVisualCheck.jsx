import { useEffect, useMemo, useState } from "react";
import "../styles/scan-visual-check.css";

const STORAGE_KEY = "parakhVisualInspection";
const DECLARATION_KEY = "parakhDeclarationEvidence";
const MAX_IMAGES = 4;
const MAX_ANALYSIS_SIDE = 1200;

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
  const lineBands = [];
  let bandStart = -1;

  for (let y = 0; y < height; y += 1) {
    const density = rowDensity[y] / Math.max(1, width);
    const textLike = density >= 0.008 && density <= 0.48;
    if (textLike && bandStart < 0) bandStart = y;
    if ((!textLike || y === height - 1) && bandStart >= 0) {
      const end = textLike && y === height - 1 ? y : y - 1;
      const bandHeight = end - bandStart + 1;
      if (bandHeight >= 2 && bandHeight <= Math.max(60, height * 0.12)) lineBands.push({ top: bandStart, height: bandHeight });
      bandStart = -1;
    }
  }

  for (let y = 1; y < height - 1; y += 2) {
    for (let x = 1; x < width - 1; x += 2) {
      const i = y * width + x;
      const c = gray[i];
      const left = gray[i - 1];
      const right = gray[i + 1];
      const up = gray[i - width];
      const down = gray[i + width];
      const gx = Math.abs(right - left);
      const gy = Math.abs(down - up);
      if (gx + gy > 55) edgeCount += 1;
      edgeSamples += 1;
      const lap = left + right + up + down - 4 * c;
      lapSum += lap;
      lapSq += lap * lap;
    }
  }

  const sampleCount = Math.max(1, edgeSamples);
  const lapVariance = Math.max(0, lapSq / sampleCount - Math.pow(lapSum / sampleCount, 2));
  const sharpness = Math.min(100, Math.max(0, lapVariance / 7));
  const contrastScore = Math.min(100, Math.max(0, contrast * 2.2));
  const edgeScore = Math.min(100, (edgeCount / sampleCount) * 600);
  const readability = Math.round(Math.min(100, 0.55 * sharpness + 0.35 * contrastScore + 0.10 * edgeScore));
  const medianLineHeight = lineBands.length ? [...lineBands.map((item) => item.height)].sort((a, b) => a - b)[Math.floor(lineBands.length / 2)] : 0;
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

function normalizeBoundingBox(box) {
  if (!box || typeof box !== "object") return null;
  const left = Number(box.left ?? box.x);
  const top = Number(box.top ?? box.y);
  const width = Number(box.width ?? box.w);
  const height = Number(box.height ?? box.h);
  if (![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;

  // PaddleOCR returns normalized coordinates in the 0..1 range.
  // Never divide by 100 here: doing so shifts valid boxes into the top-left corner.
  if ([left, top, width, height].every((value) => value >= 0 && value <= 1)) {
    const safeLeft = Math.min(1, left);
    const safeTop = Math.min(1, top);
    return {
      left: safeLeft,
      top: safeTop,
      width: Math.min(1 - safeLeft, width),
      height: Math.min(1 - safeTop, height),
    };
  }

  // Legacy pixel-coordinate evidence cannot be converted reliably without the
  // source image dimensions, so do not render a fabricated position.
  return null;
}

function declarationLabelStyle(box) {
  const nearTop = box.top < 0.08;
  const nearRight = box.left + box.width > 0.72;
  return {
    top: nearTop ? "calc(100% + 4px)" : "-22px",
    bottom: "auto",
    left: nearRight ? "auto" : "-2px",
    right: nearRight ? "-2px" : "auto",
    transform: nearRight ? "translateX(0)" : "none",
  };
}

function normalizeDeclaration(item, index) {
  if (!item || typeof item !== "object") return null;
  const rawImageIndex = Number(item.imageIndex ?? item.image ?? 0);
  const rawConfidence = Number(item.confidence);
  const confidence = rawConfidence > 1 ? rawConfidence / 100 : Number.isFinite(rawConfidence) ? rawConfidence : 0;
  return {
    ...item,
    imageIndex: Number.isFinite(rawImageIndex) && rawImageIndex >= 1 && item.imageIndex != null ? rawImageIndex - 1 : Math.max(0, rawImageIndex || 0),
    type: String(item.type || item.declarationType || "OTHER_DECLARATION").toUpperCase(),
    text: String(item.text ?? item.extractedText ?? item.value ?? ""),
    confidence: Math.max(0, Math.min(1, confidence)),
    boundingBox: normalizeBoundingBox(item.boundingBox || item.bbox || item.box),
    _index: index,
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

function readStoredDeclarations() {
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(DECLARATION_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.map(normalizeDeclaration).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function deriveDeclarationsFromOcrFields() {
  const fields = Array.from(document.querySelectorAll(".ocr-fields-grid > div"));
  if (!fields.length) return [];
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
      boundingBox: null,
      source: "ocr-fields-fallback",
    }, index));
    return accumulator;
  }, []).filter(Boolean);
}

export default function ScanVisualCheck() {
  const [results, setResults] = useState([]);
  const [declarations, setDeclarations] = useState(readStoredDeclarations);
  const [declarationMessage, setDeclarationMessage] = useState("");
  const [activeDeclarationImage, setActiveDeclarationImage] = useState(0);
  const [open, setOpen] = useState(true);
  const [referenceWidth, setReferenceWidth] = useState("");
  const [declarationBusy, setDeclarationBusy] = useState(false);

  useEffect(() => {
    const refreshDeclarations = (incoming = null) => {
      const providerEvidence = Array.isArray(incoming) ? incoming.map(normalizeDeclaration).filter(Boolean) : readStoredDeclarations();
      if (providerEvidence.length) {
        setDeclarations(providerEvidence);
        setDeclarationMessage(`${providerEvidence.length} declaration entr${providerEvidence.length === 1 ? "y was" : "ies were"} returned by OCR.`);
        setDeclarationBusy(false);
        return;
      }

      const derived = deriveDeclarationsFromOcrFields();
      if (derived.length) {
        setDeclarations(derived);
        setDeclarationMessage(`${derived.length} declaration entr${derived.length === 1 ? "y was" : "ies were"} recovered from the OCR fields. Location is shown as uncertain when no box was returned.`);
      } else {
        setDeclarations([]);
        setDeclarationMessage("OCR completed without declaration evidence.");
      }
      setDeclarationBusy(false);
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
        if (cancelled) return;
        setResults(next.filter(Boolean));
      })
      .catch(() => {
        if (!cancelled) setResults([]);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setActiveDeclarationImage((current) => Math.max(0, Math.min(current, Math.max(0, results.length - 1))));
  }, [results.length]);

  const average = results.length ? Math.round(results.reduce((sum, item) => sum + item.readability, 0) / results.length) : 0;
  const label = average >= 75 ? "Good" : average >= 50 ? "Fair" : "Poor";

  const estimatedMm = useMemo(() => {
    const widthMm = Number(referenceWidth);
    if (!Number.isFinite(widthMm) || widthMm <= 0) return null;
    const values = results.filter((item) => item.medianLineHeight > 0).map((item) => (item.medianLineHeight * widthMm) / item.width);
    if (!values.length) return null;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }, [referenceWidth, results]);

  const placementLabel = results.length === 0 ? "Needs review" : results.some((item) => item.placement === "REVIEW") ? "Review" : results.every((item) => item.placement === "SCREENED") ? "Screened" : "Needs review";
  const hasOcr = typeof document !== "undefined" && document.querySelectorAll(".ocr-fields-grid > div").length > 0;

  useEffect(() => {
    if (!results.length) return;
    const detail = {
      readability: average,
      readable: average >= 50,
      textDetected: results.some((item) => item.textLines > 0),
      placementReview: results.some((item) => item.placement === "REVIEW"),
      fontSizeCalibrated: estimatedMm !== null,
      estimatedTextHeightMm: estimatedMm,
      declarationCoverageScreened: hasOcr,
      imagesChecked: results.length,
      declarationEvidence: declarations,
      declarationModel: declarations.length ? (declarations.some((item) => item.source === "ocr-fields-fallback") ? "ocr-fields-fallback" : "ocr-provider-inline-evidence") : null,
    };
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(detail));
    window.dispatchEvent(new CustomEvent("parakh:visual-analysis", { detail }));
  }, [results, average, estimatedMm, hasOcr, declarations]);

  if (!results.length) return null;

  return (
    <section className="scan-visual-check">
      <div className="section-heading">
        <div>
          <h2>Visual inspection</h2>
          <p>Automatic screening for readability, text regions, declaration evidence and calibrated text-size estimation.</p>
        </div>
        <button type="button" className="secondary-button" onClick={() => setOpen((value) => !value)}>{open ? "Hide" : "Show"}</button>
      </div>

      {open && <>
        <div className="visual-check-summary">
          <div><strong>Readability</strong><span>{label} · {average}/100</span></div>
          <div><strong>Text detection</strong><span>{results.reduce((sum, item) => sum + item.textLines, 0)} text-line regions detected</span></div>
          <div><strong>Placement screening</strong><span>{placementLabel}</span></div>
          <div><strong>Declaration evidence</strong><span>{declarationBusy ? "Analyzing..." : declarations.length || "None returned"}</span></div>
        </div>

        <div className="visual-check-calibration">
          <label>
            <span>Known package face width (mm)</span>
            <input type="number" min="1" step="0.1" placeholder="Optional calibration" value={referenceWidth} onChange={(event) => setReferenceWidth(event.target.value)} />
          </label>
          <div>
            <strong>Estimated text height</strong>
            <span>{estimatedMm === null ? "Needs calibration" : `${estimatedMm.toFixed(2)} mm`}</span>
            <small>Estimate only. It is not a legal threshold by itself.</small>
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
            <span>Edge crowding {item.edgeCrowding}% · {item.placement === "REVIEW" ? "Review" : item.placement === "SCREENED" ? "Screened" : "Unable to verify"}</span>
            <span>Median detected line {item.medianLineHeight || "n/a"} px</span>
            <span>Calibrated size {estimatedMm === null ? "n/a" : `${(item.medianLineHeight * Number(referenceWidth) / item.width).toFixed(2)} mm`}</span>
          </div>)}
        </div>

        <div className="visual-declaration-header">
          <div>
            <h3>Declaration map</h3>
            <p>{declarationMessage || "Every semantic declaration returned by OCR is shown here. Bounding boxes are drawn only when the physical OCR provider supplied coordinates."}</p>
          </div>
        </div>
        <div className="visual-declaration-browser">
          <div className="visual-declaration-tabs" role="tablist" aria-label="Package images">
            {results.map((_item, imageIndex) => {
              const imageDeclarations = declarations.filter((item) => item.imageIndex === imageIndex);
              const selectedTab = activeDeclarationImage === imageIndex;
              return <button
                type="button"
                role="tab"
                aria-selected={selectedTab}
                className={selectedTab ? "visual-declaration-tab is-active" : "visual-declaration-tab"}
                key={`decl-tab-${imageIndex}`}
                onClick={() => setActiveDeclarationImage(imageIndex)}
              >
                Image {imageIndex + 1}
                <span>{imageDeclarations.length ? `${imageDeclarations.length} found` : "No declaration evidence"}</span>
              </button>;
            })}
          </div>
          {(() => {
            const imageIndex = Math.min(activeDeclarationImage, results.length - 1);
            const image = getScanImages()[imageIndex];
            const imageDeclarations = declarations.filter((item) => item.imageIndex === imageIndex && item.type !== "OCR_TEXT");
            return <div className="visual-declaration-card is-single">
              <div className="visual-declaration-canvas">
                <img src={image} alt={`Declaration map for package image ${imageIndex + 1}`} />
                {imageDeclarations.map((item, index) => item.boundingBox && <div
  className="visual-declaration-box"
  key={`${item.type}-${item._index ?? index}`}
  style={{
    left: `${item.boundingBox.left * 100}%`,
    top: `${item.boundingBox.top * 100}%`,
    width: `${item.boundingBox.width * 100}%`,
    height: `${item.boundingBox.height * 100}%`,
  }}
  title={item.text ? `${item.type.replaceAll("_", " ")} · ${item.text}` : item.type.replaceAll("_", " ")}
>
  <span style={declarationLabelStyle(item.boundingBox)}>{item.type.replaceAll("_", " ")}</span>
</div>)}
              </div>
              <div className="visual-declaration-list">
                {imageDeclarations.length ? imageDeclarations.map((item, index) => <div key={`${item.type}-${item._index ?? index}`}><strong>{item.type.replaceAll("_", " ")}</strong><span>{item.text || "Declaration detected"}</span><small>{item.boundingBox ? "localized" : "location uncertain"}</small></div>) : <div className="visual-declaration-empty"><strong>No semantic declaration evidence for this image.</strong><span>Physical OCR text is kept as evidence, but unclassified OCR lines are not presented as declarations.</span></div>}
              </div>
            </div>;
          })()}
        </div>

        <div className="visual-check-note">Declaration evidence is AI-assisted. Confidence is informational only and never filters a detected declaration out of the map. Bounding boxes are shown only when coordinates were actually returned. Missing coordinates are reported as location uncertain, not fabricated.</div>
      </>}
    </section>
  );
}
