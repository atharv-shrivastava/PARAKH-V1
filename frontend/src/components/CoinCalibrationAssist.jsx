import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import "../styles/coin-calibration.css";

const COIN_DIAMETER_MM = 27;
const OPENCV_SRC = "https://docs.opencv.org/4.x/opencv.js";

let openCvPromise = null;

function loadOpenCv() {
  if (typeof window === "undefined") return Promise.reject(new Error("OpenCV requires a browser runtime."));
  if (window.cv?.Mat) return Promise.resolve(window.cv);
  if (openCvPromise) return openCvPromise;

  openCvPromise = new Promise((resolve, reject) => {
    const finish = () => {
      const cv = window.cv;
      if (!cv) return reject(new Error("OpenCV loaded without a runtime."));
      resolve(cv);
    };

    const existing = document.querySelector('script[data-parakh-opencv="true"]');
    if (existing) {
      if (window.cv?.Mat) return finish();
      existing.addEventListener("load", finish, { once: true });
      existing.addEventListener("error", () => reject(new Error("Could not load OpenCV.")), { once: true });
      return;
    }

    const script = document.createElement("script");
    script.async = true;
    script.src = OPENCV_SRC;
    script.dataset.parakhOpencv = "true";
    script.onload = () => {
      const cv = window.cv;
      if (cv?.onRuntimeInitialized) {
        const previous = cv.onRuntimeInitialized;
        cv.onRuntimeInitialized = () => {
          if (typeof previous === "function") previous();
          finish();
        };
      } else {
        finish();
      }
    };
    script.onerror = () => reject(new Error("Could not load OpenCV."));
    document.head.appendChild(script);
  });

  return openCvPromise;
}

function getScanImages() {
  return Array.from(document.querySelectorAll(".scan-image-grid .scan-image-card img"))
    .slice(0, 4)
    .map((image) => image.src)
    .filter(Boolean);
}

async function imageToCanvas(src) {
  const response = await fetch(src);
  if (!response.ok) throw new Error("Could not load inspection image.");
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    bitmap.close();
    throw new Error("Could not prepare inspection image.");
  }
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas;
}

function detectCoin(cv, canvas) {
  const source = cv.imread(canvas);
  const gray = new cv.Mat();
  const blurred = new cv.Mat();
  const circles = new cv.Mat();

  try {
    cv.cvtColor(source, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blurred, new cv.Size(9, 9), 2, 2, cv.BORDER_DEFAULT);

    const minDimension = Math.min(canvas.width, canvas.height);
    const minRadius = Math.max(8, Math.round(minDimension * 0.012));
    const maxRadius = Math.max(minRadius + 4, Math.round(minDimension * 0.22));

    cv.HoughCircles(
      blurred,
      circles,
      cv.HOUGH_GRADIENT,
      1.2,
      Math.max(30, minDimension * 0.08),
      110,
      28,
      minRadius,
      maxRadius,
    );

    const values = circles.data32F;
    let best = null;
    for (let index = 0; index + 2 < values.length; index += 3) {
      const x = values[index];
      const y = values[index + 1];
      const radius = values[index + 2];
      if (![x, y, radius].every(Number.isFinite)) continue;
      if (x - radius < 0 || y - radius < 0 || x + radius >= canvas.width || y + radius >= canvas.height) continue;

      const innerRadius = Math.max(1, Math.round(radius * 0.82));
      const outerMask = new cv.Mat.zeros(canvas.height, canvas.width, cv.CV_8UC1);
      const innerMask = new cv.Mat.zeros(canvas.height, canvas.width, cv.CV_8UC1);

      try {
        cv.circle(outerMask, new cv.Point(x, y), Math.round(radius), new cv.Scalar(255), -1);
        cv.circle(innerMask, new cv.Point(x, y), innerRadius, new cv.Scalar(255), -1);
        const outerMean = cv.mean(gray, outerMask)[0];
        const innerMean = cv.mean(gray, innerMask)[0];
        const contrastScore = Math.min(1, Math.abs(outerMean - innerMean) / 35);
        const relativeRadius = radius / minDimension;
        const sizeScore = Math.max(0, 1 - Math.abs(relativeRadius - 0.035) / 0.12);
        const score = contrastScore * 0.6 + sizeScore * 0.4;
        const candidate = { x, y, radius, diameterPx: radius * 2, score };
        if (!best || candidate.score > best.score) best = candidate;
      } finally {
        outerMask.delete();
        innerMask.delete();
      }
    }

    return best;
  } finally {
    source.delete();
    gray.delete();
    blurred.delete();
    circles.delete();
  }
}

function detectPackageMask(cv, canvas, coin) {
  const source = cv.imread(canvas);
  const gray = new cv.Mat();
  const blurred = new cv.Mat();
  const edges = new cv.Mat();
  const closed = new cv.Mat();
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  const mask = new cv.Mat.zeros(canvas.height, canvas.width, cv.CV_8UC1);

  try {
    cv.cvtColor(source, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blurred, new cv.Size(7, 7), 1.5, 1.5, cv.BORDER_DEFAULT);
    cv.Canny(blurred, edges, 50, 140);

    const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(9, 9));
    try {
      cv.morphologyEx(edges, closed, cv.MORPH_CLOSE, kernel);
    } finally {
      kernel.delete();
    }

    cv.findContours(closed, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    const imageArea = canvas.width * canvas.height;
    const candidates = [];
    for (let index = 0; index < contours.size(); index += 1) {
      const contour = contours.get(index);
      try {
        const area = Math.abs(cv.contourArea(contour));
        if (area < imageArea * 0.06 || area > imageArea * 0.94) continue;

        const perimeter = cv.arcLength(contour, true);
        if (!Number.isFinite(perimeter) || perimeter <= 0) continue;

        const rect = cv.boundingRect(contour);
        const rectArea = Math.max(1, rect.width * rect.height);
        const fillRatio = area / rectArea;
        const circularity = Math.min(1, (4 * Math.PI * area) / Math.max(1, perimeter * perimeter));
        const centerX = rect.x + rect.width / 2;
        const centerY = rect.y + rect.height / 2;
        const imageCenterX = canvas.width / 2;
        const imageCenterY = canvas.height / 2;
        const centerDistance = Math.hypot(centerX - imageCenterX, centerY - imageCenterY);
        const centerScore = 1 - Math.min(1, centerDistance / Math.max(canvas.width, canvas.height));

        let shapeScore = 0;
        const approx = new cv.Mat();
        try {
          const epsilon = Math.max(2, perimeter * 0.025);
          cv.approxPolyDP(contour, approx, epsilon, true);
          if (approx.rows === 4) shapeScore = 1;
          else if (circularity > 0.65 || fillRatio > 0.72) shapeScore = 0.85;
          else if (approx.rows >= 5) shapeScore = 0.45;
        } finally {
          approx.delete();
        }

        const coinPenalty = coin
          ? Math.min(1, Math.max(0, (Math.hypot(centerX - coin.x, centerY - coin.y) < coin.radius * 2.5 ? 0.35 : 0)))
          : 0;
        const areaScore = Math.min(1, area / (imageArea * 0.7));
        const score = areaScore * 0.4 + shapeScore * 0.28 + fillRatio * 0.12 + circularity * 0.1 + centerScore * 0.1 - coinPenalty;
        candidates.push({ index, score, area, shape: approxShape(shapeScore) });
      } finally {
        contour.delete();
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];
    if (!best) return null;

    const bestContour = contours.get(best.index);
    try {
      cv.drawContours(mask, contours, best.index, new cv.Scalar(255), -1);
    } finally {
      bestContour.delete();
    }

    const maskPixels = mask.data;
    let covered = 0;
    for (let index = 0; index < maskPixels.length; index += 1) if (maskPixels[index] > 0) covered += 1;
    if (covered < imageArea * 0.05) return null;

    return { mask, score: best.score, coverage: covered / imageArea, shape: best.shape };
  } catch {
    mask.delete();
    return null;
  } finally {
    source.delete();
    gray.delete();
    blurred.delete();
    edges.delete();
    closed.delete();
    contours.delete();
    hierarchy.delete();
  }
}

function approxShape(shapeScore) {
  if (shapeScore >= 0.95) return "quadrilateral";
  if (shapeScore >= 0.8) return "round-or-oval";
  return "irregular-package";
}

function estimateTextHeightPx(canvas, coin, packageMask) {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  const { data, width, height } = context.getImageData(0, 0, canvas.width, canvas.height);
  const maskData = packageMask?.data;
  const rowDensity = new Float32Array(height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (maskData && maskData[y * width + x] === 0) continue;
      if (coin && Math.hypot(x - coin.x, y - coin.y) < coin.radius * 1.3) continue;
      const offset = (y * width + x) * 4;
      const gray = 0.2126 * data[offset] + 0.7152 * data[offset + 1] + 0.0722 * data[offset + 2];
      if (gray < 105) rowDensity[y] += 1;
    }
  }

  const visibleWidth = maskData
    ? Math.max(1, Math.max(...Array.from({ length: height }, (_, y) => rowDensity[y] > 0 ? rowDensity[y] / 0.48 : 0)))
    : width;
  const bands = [];
  let start = -1;
  for (let y = 0; y < height; y += 1) {
    const density = rowDensity[y] / Math.max(1, Math.min(width, visibleWidth));
    const textLike = density >= 0.008 && density <= 0.48;
    if (textLike && start < 0) start = y;
    if ((!textLike || y === height - 1) && start >= 0) {
      const end = textLike && y === height - 1 ? y : y - 1;
      const bandHeight = end - start + 1;
      if (bandHeight >= 2 && bandHeight <= Math.max(60, height * 0.12)) bands.push(bandHeight);
      start = -1;
    }
  }

  if (!bands.length) return null;
  bands.sort((a, b) => a - b);
  return bands[Math.floor(bands.length / 2)];
}

async function analyzeImages(cv) {
  const sources = getScanImages();
  if (!sources.length) return { detected: false, message: "Add a package image first." };

  const analyses = [];
  for (let imageIndex = 0; imageIndex < sources.length; imageIndex += 1) {
    try {
      const canvas = await imageToCanvas(sources[imageIndex]);
      const coin = detectCoin(cv, canvas);
      const packageResult = detectPackageMask(cv, canvas, coin);
      const textHeightPx = estimateTextHeightPx(canvas, coin, packageResult?.mask ?? null);
      const estimatedTextHeightMm = coin && textHeightPx
        ? (textHeightPx * COIN_DIAMETER_MM) / coin.diameterPx
        : null;

      packageResult?.mask.delete();
      analyses.push({
        imageIndex,
        coin,
        packageDetected: Boolean(packageResult),
        packageCoverage: packageResult?.coverage ?? null,
        packageShape: packageResult?.shape ?? null,
        textHeightPx,
        estimatedTextHeightMm,
      });
    } catch {
      analyses.push({ imageIndex, coin: null, packageDetected: false, estimatedTextHeightMm: null });
    }
  }

  const detected = analyses.filter((item) => item.coin);
  if (!detected.length) {
    return {
      detected: false,
      analyses,
      message: "No ₹10 coin reference was detected. Place a ₹10 coin beside the package and analyze again.",
    };
  }

  const measurable = detected.filter((item) => Number.isFinite(item.estimatedTextHeightMm));
  const estimatedTextHeightMm = measurable.length
    ? measurable.reduce((sum, item) => sum + item.estimatedTextHeightMm, 0) / measurable.length
    : null;
  const averageCoinDiameterPx = detected.reduce((sum, item) => sum + item.coin.diameterPx, 0) / detected.length;
  const packageDetectedCount = analyses.filter((item) => item.packageDetected).length;

  return {
    detected: true,
    analyses,
    coinDiameterPx: averageCoinDiameterPx,
    scalePxPerMm: averageCoinDiameterPx / COIN_DIAMETER_MM,
    estimatedTextHeightMm,
    packageDetected: packageDetectedCount > 0,
    packageDetectedCount,
    message: `₹10 coin reference detected on ${detected.length} image${detected.length === 1 ? "" : "s"}.`,
  };
}

export default function CoinCalibrationAssist() {
  const [host, setHost] = useState(null);
  const [state, setState] = useState({ status: "idle" });

  useEffect(() => {
    if (!/\/scan(?:\/|$)/i.test(window.location.pathname)) return undefined;

    let observer;
    const locate = () => {
      const nextHost = document.querySelector(".visual-check-calibration");
      if (nextHost) {
        setHost(nextHost);
        observer?.disconnect();
      }
    };

    locate();
    observer = new MutationObserver(locate);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer?.disconnect();
  }, []);

  useEffect(() => {
    if (!host) return undefined;
    let cancelled = false;

    setState({ status: "loading" });
    loadOpenCv()
      .then((cv) => analyzeImages(cv))
      .then((result) => {
        if (cancelled) return;
        const existing = JSON.parse(window.sessionStorage.getItem("parakhVisualInspection") || "{}");
        const detail = {
          ...existing,
          fontSizeCalibrated: Boolean(result.estimatedTextHeightMm),
          calibrationWidthMm: COIN_DIAMETER_MM,
          estimatedTextHeightMm: result.estimatedTextHeightMm ?? null,
          coinReference: "INR_10_COIN",
          coinReferenceDiameterMm: COIN_DIAMETER_MM,
          coinDiameterPx: result.coinDiameterPx ?? null,
          scalePxPerMm: result.scalePxPerMm ?? null,
          coinReferenceDetected: Boolean(result.detected),
          packageDetected: Boolean(result.packageDetected),
          packageDetectedCount: result.packageDetectedCount ?? 0,
          packageMaskUsed: Boolean(result.packageDetected),
        };
        setState({ status: "ready", ...result });
        window.sessionStorage.setItem("parakhCoinCalibration", JSON.stringify(detail));
        window.sessionStorage.setItem("parakhVisualInspection", JSON.stringify(detail));
        window.dispatchEvent(new CustomEvent("parakh:coin-calibration", { detail }));
        window.dispatchEvent(new CustomEvent("parakh:visual-analysis", { detail }));
      })
      .catch((error) => {
        if (!cancelled) setState({ status: "error", message: error.message || "OpenCV calibration unavailable." });
      });

    return () => { cancelled = true; };
  }, [host]);

  if (!host || !/\/scan(?:\/|$)/i.test(window.location.pathname)) return null;

  return createPortal(
    <div className="coin-reference-calibration">
      <strong>Estimated text height</strong>
      {state.status === "loading" && <span>Separating package from surroundings with OpenCV...</span>}
      {state.status === "ready" && state.detected && <>
        <span>{state.estimatedTextHeightMm == null ? "Coin found · no text measurement" : `${state.estimatedTextHeightMm.toFixed(2)} mm`}</span>
        <small>
          {state.packageDetected ? `Package isolated on ${state.packageDetectedCount} image${state.packageDetectedCount === 1 ? "" : "s"}. ` : "Package boundary not confidently isolated. "}
          {state.message} Reference diameter: 27.0 mm. Assistive estimate only. Final statutory measurement remains with the inspector.
        </small>
      </>}
      {state.status === "ready" && !state.detected && <small>{state.message}</small>}
      {state.status === "error" && <small>{state.message}</small>}
    </div>,
    host,
  );
}
