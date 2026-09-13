import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../lib/auth";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:5000/api";
const OCR_URL = API_URL.replace(/\/api\/?$/, "");

function normalizeIdentity(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function fieldText(result, key) {
  const field = result?.[key];
  if (field?.status !== "found") return "";
  return String(field.displayValue ?? field.value ?? "").trim();
}

function imageIdentity(result) {
  const brand = normalizeIdentity(fieldText(result, "brandName"));
  const product = normalizeIdentity(fieldText(result, "productName"));
  return { brand, product, label: [brand, product].filter(Boolean).join(" ") };
}

function tokenOverlap(left, right) {
  const a = new Set(normalizeIdentity(left).split(" ").filter(Boolean));
  const b = new Set(normalizeIdentity(right).split(" ").filter(Boolean));
  if (!a.size || !b.size) return 0;
  let shared = 0;
  a.forEach((token) => { if (b.has(token)) shared += 1; });
  return shared / Math.max(a.size, b.size);
}

function findMismatch(identities) {
  for (let i = 0; i < identities.length; i += 1) {
    for (let j = i + 1; j < identities.length; j += 1) {
      const left = identities[i];
      const right = identities[j];
      if (left.brand && right.brand && left.brand !== right.brand) return [i, j];
      if (left.product && right.product && tokenOverlap(left.product, right.product) < 0.34) return [i, j];
    }
  }
  return null;
}

async function getIdentityFromImage(src, index) {
  const response = await fetch(src);
  if (!response.ok) throw new Error(`Could not read image ${index + 1}.`);
  const blob = await response.blob();
  const file = new File([blob], `package-${index + 1}.jpg`, { type: blob.type || "image/jpeg" });
  const formData = new FormData();
  formData.append("images", file);
  formData.append("categoryOptions", "[]");
  const result = await apiFetch(`${OCR_URL}/api/ocr/analyze`, { method: "POST", body: formData });
  const data = await result.json().catch(() => ({}));
  if (!result.ok || !data.result) throw new Error(data.error?.message || data.error || data.message || "Could not identify package image.");
  return imageIdentity(data.result);
}

export default function ProductImageConsistencyGuard() {
  const checkingRef = useRef(false);
  const bypassNextClickRef = useRef(false);
  const [mismatch, setMismatch] = useState(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const getScanImages = () => Array.from(document.querySelectorAll(".scan-page .scan-image-card img"));
    const analyzeButtonSelector = ".scan-page .analyze-action-row button";

    const handleAnalyzeClick = async (event) => {
      if (event.target.closest?.(analyzeButtonSelector) == null) return;
      if (bypassNextClickRef.current) {
        bypassNextClickRef.current = false;
        return;
      }
      const imageNodes = getScanImages();
      if (imageNodes.length < 2 || checkingRef.current) return;

      event.preventDefault();
      event.stopImmediatePropagation();
      checkingRef.current = true;
      setChecking(true);
      setMismatch(null);
      setError("");

      try {
        const identities = await Promise.all(imageNodes.map((node, index) => getIdentityFromImage(node.currentSrc || node.src, index)));
        const mismatchPair = findMismatch(identities);
        if (mismatchPair) {
          setMismatch({ identities, pair: mismatchPair });
          return;
        }
        bypassNextClickRef.current = true;
        event.target.closest(analyzeButtonSelector)?.click();
      } catch (checkError) {
        setError(checkError.message || "Could not verify that the package images belong to the same product.");
        bypassNextClickRef.current = true;
        event.target.closest(analyzeButtonSelector)?.click();
      } finally {
        checkingRef.current = false;
        setChecking(false);
      }
    };

    document.addEventListener("click", handleAnalyzeClick, true);
    return () => document.removeEventListener("click", handleAnalyzeClick, true);
  }, []);

  if (mismatch) {
    const [leftIndex, rightIndex] = mismatch.pair;
    const left = mismatch.identities[leftIndex];
    const right = mismatch.identities[rightIndex];
    return <div className="camera-overlay" role="dialog" aria-modal="true" aria-labelledby="package-mismatch-title">
      <div className="camera-modal" style={{ maxWidth: 560 }}>
        <div className="camera-header">
          <h2 id="package-mismatch-title">Different products detected</h2>
        </div>
        <p style={{ margin: "12px 0", lineHeight: 1.5 }}>
          These uploaded package images appear to belong to different products. PARAKH V1 will not combine them into one compliance inspection.
        </p>
        <div className="ocr-status-grid">
          <div><strong>Image {leftIndex + 1}</strong><span>{left.label || "Product identity not clear"}</span></div>
          <div><strong>Image {rightIndex + 1}</strong><span>{right.label || "Product identity not clear"}</span></div>
        </div>
        <div className="status-message" style={{ marginTop: 12 }}>
          Remove or replace the incorrect image, then run analysis again.
        </div>
        <div className="camera-actions">
          <button type="button" className="primary-button" onClick={() => setMismatch(null)}>Review Images</button>
        </div>
      </div>
    </div>;
  }

  if (checking) {
    return <div className="camera-overlay" role="status" aria-live="polite"><div className="camera-modal" style={{ maxWidth: 440 }}><h2>Verifying package images…</h2><p style={{ lineHeight: 1.5 }}>Checking that the uploaded sides belong to the same product before compliance analysis.</p></div></div>;
  }

  if (error) {
    return <div className="status-message" style={{ marginTop: 12 }}>{error}</div>;
  }

  return null;
}
