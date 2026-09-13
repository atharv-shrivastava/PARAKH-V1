const TOKEN_KEY = "parakh_token";
const USER_KEY = "parakh_user";
const CACHE_PREFIX = "parakh_api_cache:";
const CACHE_TTL = 5 * 60 * 1000;
const API_URL = import.meta.env.VITE_API_URL || "http://localhost:5000/api";

const RULE_ENGINE_FIELDS = [
  "productName", "brandName", "manufacturer", "manufacturerAddress", "packer", "packerAddress",
  "marketer", "marketerAddress", "importer", "importerAddress", "netQuantity", "unit", "mrp",
  "currency", "dateOfManufacture", "dateOfPacking", "bestBefore", "expiryDate", "batchNumber",
  "consumerCarePhone", "consumerCareEmail", "countryOfOrigin", "fssaiLicenseNumber",
];

const NON_LOCALIZABLE_OCR_FIELDS = new Set([
  "manufacturer", "manufacturerAddress", "packer", "packerAddress", "marketer", "marketerAddress",
  "importer", "importerAddress", "consumerCarePhone", "consumerCareEmail", "fssaiLicenseNumber",
  "barcode", "mrp", "currency", "dateOfManufacture", "dateOfPacking", "bestBefore", "expiryDate",
  "batchNumber", "netQuantity",
]);

export function getToken() { return localStorage.getItem(TOKEN_KEY); }
export function getUser() { try { return JSON.parse(localStorage.getItem(USER_KEY) || "null"); } catch { return null; } }

function clearApiCache() {
  try {
    Object.keys(sessionStorage).filter((key) => key.startsWith(CACHE_PREFIX)).forEach((key) => sessionStorage.removeItem(key));
  } catch {}
}

export function invalidateApiCache() {
  clearApiCache();
  try { window.dispatchEvent(new CustomEvent("parakh:data-invalidated", { detail: { at: Date.now() } })); } catch {}
}

export function saveSession(token, user) {
  clearApiCache();
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearSession() {
  clearApiCache();
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

export function authHeaders(json = false) { return { ...(json ? { "Content-Type": "application/json" } : {}), ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}) }; }

function cacheKey(url) { return `${CACHE_PREFIX}${url}`; }

function cachedResponse(entry) {
  return new Response(entry.body, { status: entry.status, statusText: entry.statusText || "OK", headers: entry.headers || { "Content-Type": "application/json" } });
}

function readCached(url) {
  try {
    const raw = sessionStorage.getItem(cacheKey(url));
    if (!raw) return null;
    const entry = JSON.parse(raw);
    if (!entry?.savedAt || Date.now() - entry.savedAt > CACHE_TTL) {
      sessionStorage.removeItem(cacheKey(url));
      return null;
    }
    return entry;
  } catch { return null; }
}

async function cacheResponse(url, response) {
  try {
    if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) return response;
    const clone = response.clone();
    const body = await clone.text();
    sessionStorage.setItem(cacheKey(url), JSON.stringify({ savedAt: Date.now(), status: response.status, statusText: response.statusText, headers: { "Content-Type": response.headers.get("content-type") || "application/json" }, body }));
  } catch {}
  return response;
}

function isTransientPost(url) {
  return /\/api\/(ocr\/|translate(?:\/|$)|products\/ecommerce\/(?:analyze-url|evaluate))/.test(url);
}

function isDataKartLookup(url) {
  return /\/api\/datakart\/gtin\//.test(url);
}

async function preprocessOcrImage(file) {
  const source = await createImageBitmap(file, { imageOrientation: "from-image" }).catch(() => createImageBitmap(file));
  try {
    const sourceWidth = source.width || 1;
    const sourceHeight = source.height || 1;
    const maxSide = 2000;
    const scale = Math.min(1.75, maxSide / Math.max(sourceWidth, sourceHeight));
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("OCR preprocessing context unavailable.");
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.filter = "contrast(1.14) brightness(1.03) saturate(0.92)";
    context.drawImage(source, 0, 0, width, height);

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.88));
    if (!blob) throw new Error("OCR preprocessing failed to encode the image.");
    const processedName = file.name.replace(/\.[^.]+$/, "") + "-ocr.jpg";
    return new File([blob], processedName, { type: "image/jpeg", lastModified: Date.now() });
  } finally {
    source.close();
  }
}

async function optimizeOcrBody(body) {
  if (!(body instanceof FormData)) return body;
  const entries = [...body.entries()];
  const optimized = new FormData();
  for (const [key, value] of entries) {
    if (!(typeof File !== "undefined" && value instanceof File && value.type.startsWith("image/"))) {
      optimized.append(key, value);
      continue;
    }
    try {
      const processed = await preprocessOcrImage(value);
      if (processed.size <= Math.max(value.size * 1.35, 2.5 * 1024 * 1024)) optimized.append(key, processed, processed.name);
      else optimized.append(key, value, value.name);
    } catch {
      try {
        const bitmap = await createImageBitmap(value, { imageOrientation: "from-image" }).catch(() => createImageBitmap(value));
        const maxSide = 2000;
        const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        const context = canvas.getContext("2d");
        if (!context) {
          bitmap.close();
          optimized.append(key, value, value.name);
          continue;
        }
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = "high";
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        bitmap.close();
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.86));
        if (blob && blob.size < value.size * 1.35) optimized.append(key, new File([blob], value.name.replace(/\.[^.]+$/, ".jpg"), { type: "image/jpeg" }), value.name.replace(/\.[^.]+$/, ".jpg"));
        else optimized.append(key, value, value.name);
      } catch {
        optimized.append(key, value, value.name);
      }
    }
  }
  return optimized;
}

function sanitizeRulesEngineBody(body) {
  if (typeof body !== "string") return body;
  try {
    const payload = JSON.parse(body);
    if (!payload?.ocr || typeof payload.ocr !== "object") return body;
    const source = payload.ocr?.ruleEngineInput || payload.ocr;
    payload.ocr = Object.fromEntries(RULE_ENGINE_FIELDS.map((key) => {
      const field = source?.[key];
      if (!field || typeof field !== "object") return [key, field];
      return [key, {
        value: field.value ?? null,
        raw: field.raw ?? null,
        evidence: field.evidence ?? null,
        confidence: field.confidence ?? 0,
        status: field.status || "absent",
        ...(field.imageIndex != null ? { imageIndex: field.imageIndex } : {}),
        ...(field.evidenceIndex != null ? { evidenceIndex: field.evidenceIndex } : {}),
      }];
    }));
    return JSON.stringify(payload);
  } catch {
    return body;
  }
}

async function localizeOcrFields(payload) {
  const target = String(localStorage.getItem("parakh_language") || "en").trim().toLowerCase();
  if (!target || target === "en" || !payload?.result || typeof payload.result !== "object") return payload;

  const candidates = [];
  for (const [key, field] of Object.entries(payload.result)) {
    if (NON_LOCALIZABLE_OCR_FIELDS.has(key) || !field || typeof field !== "object" || field.status !== "found") continue;
    const value = String(field.value ?? "").trim();
    if (!value || value.length < 2) continue;
    candidates.push({ key, value });
  }
  if (!candidates.length) return payload;

  try {
    const response = await fetch(`${API_URL}/translate`, {
      method: "POST",
      headers: { ...authHeaders(true), "Content-Type": "application/json" },
      body: JSON.stringify({ target, source: "auto", texts: candidates.map((item) => item.value) }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data?.translations) return payload;

    for (const { key, value } of candidates) {
      const localized = String(data.translations[value] ?? value).trim() || value;
      payload.result[key] = {
        ...payload.result[key],
        canonicalValue: value,
        displayValue: localized,
      };
    }
  } catch {
    // Localization is presentation-only. OCR results must remain usable when translation is unavailable.
  }
  return payload;
}

function normalizeIdentity(value) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[₹]/g, "rs")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function identityField(ocr, key) {
  const field = ocr?.[key];
  if (!field || typeof field !== "object") return "";
  return String(field.canonicalValue ?? field.value ?? field.displayValue ?? "").trim();
}

function extractViolationCodes(payload) {
  const compliance = payload?.ocrData?.compliance || payload?.compliance;
  const acceptedIds = Array.isArray(payload?.acceptedFindingIds)
    ? new Set(payload.acceptedFindingIds.map(String))
    : Array.isArray(payload?.ocrData?.complianceReview?.acceptedFindingIds)
      ? new Set(payload.ocrData.complianceReview.acceptedFindingIds.map(String))
      : null;
  const findings = Array.isArray(compliance?.findings) ? compliance.findings : [];
  const accepted = findings.filter((finding) => {
    if (String(finding?.status || "").toUpperCase() !== "VIOLATION") return false;
    return !acceptedIds || acceptedIds.has(String(finding?.findingId));
  });
  const manual = Array.isArray(payload?.ocrData?.manualViolations) ? payload.ocrData.manualViolations : [];
  return [...accepted, ...manual]
    .map((finding) => String(finding?.ruleCode || finding?.ruleNumber || finding?.findingId || "").trim())
    .filter(Boolean)
    .map(normalizeIdentity)
    .sort();
}

function buildParakhMaterial(payload) {
  const ocr = payload?.ocrData?.ocr || payload?.ocr || {};
  const batchNumber = identityField(ocr, "batchNumber");
  const gtin = String(payload?.barcode || identityField(ocr, "barcode") || "").replace(/\D/g, "");
  const stable = {
    brand: normalizeIdentity(payload?.brandName || identityField(ocr, "brandName") || identityField(ocr, "manufacturer")),
    product: normalizeIdentity(payload?.productName || identityField(ocr, "productName")),
    quantity: normalizeIdentity(payload?.netQuantity || identityField(ocr, "netQuantity")),
    unit: normalizeIdentity(payload?.unit || identityField(ocr, "unit")),
    mrp: normalizeIdentity(payload?.mrp || identityField(ocr, "mrp")),
    batch: normalizeIdentity(batchNumber),
    gtin,
  };
  const stableKey = [stable.gtin ? `gtin:${stable.gtin}` : "gtin:", `brand:${stable.brand}`, `product:${stable.product}`, `qty:${stable.quantity}`, `unit:${stable.unit}`, `mrp:${stable.mrp}`, `batch:${stable.batch}`].join("|");
  return { stable, stableKey, violationCodes: extractViolationCodes(payload) };
}

async function sha256Hex(text) {
  if (typeof crypto !== "undefined" && crypto.subtle) {
    const bytes = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest)).map((value) => value.toString(16).padStart(2, "0")).join("");
  }
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  return (hash >>> 0).toString(16).padStart(8, "0");
}

async function buildParakhIdentity(payload) {
  const material = buildParakhMaterial(payload);
  const stableFingerprint = await sha256Hex(material.stableKey);
  const violationDigest = await sha256Hex(material.violationCodes.join("|") || "no-violations");
  const parakhDigest = await sha256Hex(`${material.stableKey}|violations:${material.violationCodes.join(",")}`);
  return {
    version: 1,
    parakhId: `PRK-${parakhDigest.slice(0, 4).toUpperCase()}-${parakhDigest.slice(4, 8).toUpperCase()}-${parakhDigest.slice(8, 12).toUpperCase()}`,
    stableFingerprint,
    violationDigest: violationDigest.slice(0, 12).toUpperCase(),
    gtin: material.stable.gtin || null,
    mrp: material.stable.mrp || null,
    batchNumber: material.stable.batch || null,
    violationCodes: material.violationCodes,
  };
}

function duplicateCandidateMatches(product, current) {
  if (!product || !current) return false;
  const stored = (() => { try { return product.ocrData ? JSON.parse(product.ocrData) : null; } catch { return null; } })();
  const identity = stored?.parakhIdentity;
  if (identity?.stableFingerprint && identity.stableFingerprint === current.stableFingerprint) return true;
  const normalizeDigits = (value) => String(value ?? "").replace(/\D/g, "");
  const gtin = normalizeDigits(current.gtin);
  const productGtin = normalizeDigits(product.barcode);
  if (gtin && productGtin && gtin !== productGtin) return false;
  const currentBatch = normalizeIdentity(current.batchNumber);
  const storedBatch = normalizeIdentity(identity?.batchNumber);
  if (currentBatch || storedBatch) {
    if (!currentBatch || !storedBatch || currentBatch !== storedBatch) return false;
  }
  const sameText = (a, b) => normalizeIdentity(a) === normalizeIdentity(b);
  const sameMrp = Number.isFinite(Number(current.mrp)) && product.mrp != null ? Math.abs(Number(current.mrp) - Number(product.mrp)) < 0.01 : sameText(current.mrp, product.mrp);
  return sameText(current.productName, product.productName)
    && sameText(current.brandName, product.brandName)
    && sameText(current.netQuantity, product.netQuantity)
    && sameText(current.unit, product.unit)
    && sameMrp;
}

async function checkAlreadyRegistered(payload) {
  const material = buildParakhMaterial({ ...payload, ocrData: { ...(payload?.ocrData || {}), ocr: payload?.ocr || payload?.ocrData?.ocr || {} } });
  const productName = String(material.stable.product || "").trim();
  if (productName.length < 3) return null;
  const query = encodeURIComponent(String(payload?.productName || identityField(payload?.ocr || payload?.ocrData?.ocr, "productName") || productName).trim());
  const response = await fetch(`${API_URL}/products/history?query=${query}&limit=50`, { headers: authHeaders(), cache: "no-store" });
  if (!response.ok) return null;
  const products = await response.json().catch(() => []);
  const current = {
    ...material.stable,
    productName: payload?.productName || identityField(payload?.ocr || payload?.ocrData?.ocr, "productName"),
    brandName: payload?.brandName || identityField(payload?.ocr || payload?.ocrData?.ocr, "brandName") || identityField(payload?.ocr || payload?.ocrData?.ocr, "manufacturer"),
    netQuantity: payload?.netQuantity || identityField(payload?.ocr || payload?.ocrData?.ocr, "netQuantity"),
    unit: payload?.unit || identityField(payload?.ocr || payload?.ocrData?.ocr, "unit"),
    mrp: payload?.mrp || identityField(payload?.ocr || payload?.ocrData?.ocr, "mrp"),
    batchNumber: identityField(payload?.ocr || payload?.ocrData?.ocr, "batchNumber"),
    gtin: String(payload?.barcode || identityField(payload?.ocr || payload?.ocrData?.ocr, "barcode") || "").replace(/\D/g, ""),
  };
  const match = Array.isArray(products) ? products.find((product) => duplicateCandidateMatches(product, current)) : null;
  if (!match) return null;
  let parakhId = null;
  try {
    const detailResponse = await fetch(`${API_URL}/products/${encodeURIComponent(match.id)}`, { headers: authHeaders(), cache: "no-store" });
    if (detailResponse.ok) {
      const detail = await detailResponse.json().catch(() => ({}));
      const stored = detail?.ocrData ? (typeof detail.ocrData === "string" ? JSON.parse(detail.ocrData) : detail.ocrData) : null;
      parakhId = stored?.parakhIdentity?.parakhId || null;
    }
  } catch {}
  return { product: match, parakhId };
}

function showImageMismatchPopup(payload) {
  if (typeof document === "undefined") return;
  if (document.querySelector("[data-parakh-image-mismatch-popup]")) return;

  const overlay = document.createElement("div");
  overlay.dataset.parakhImageMismatchPopup = "true";
  overlay.style.cssText = "position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(3,7,18,.72);backdrop-filter:blur(8px);";

  const card = document.createElement("div");
  card.style.cssText = "width:min(520px,100%);border:1px solid rgba(255,255,255,.14);border-radius:20px;background:#111827;color:#fff;box-shadow:0 24px 80px rgba(0,0,0,.45);padding:28px;";

  const title = document.createElement("h2");
  title.textContent = "Images belong to different products";
  title.style.cssText = "margin:0 0 10px;font-size:22px;line-height:1.2;";

  const body = document.createElement("p");
  body.textContent = payload?.error?.message || "The uploaded package images do not appear to show the same product. Analysis has been stopped. Upload images from the same package and try again.";
  body.style.cssText = "margin:0;color:#cbd5e1;line-height:1.6;font-size:15px;";

  const hint = document.createElement("p");
  hint.textContent = "Example: front of Kurkure + back of Lays will be rejected.";
  hint.style.cssText = "margin:14px 0 22px;color:#94a3b8;font-size:13px;";

  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Close";
  button.style.cssText = "border:0;border-radius:12px;padding:11px 18px;background:#fff;color:#111827;font-weight:700;cursor:pointer;";
  button.addEventListener("click", () => overlay.remove());

  card.append(title, body, hint, button);
  overlay.appendChild(card);
  overlay.addEventListener("click", (event) => { if (event.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
}

function showDuplicateProductPopup(payload) {
  if (typeof document === "undefined") return;
  if (document.querySelector("[data-parakh-duplicate-product-popup]")) return;
  const overlay = document.createElement("div");
  overlay.dataset.parakhDuplicateProductPopup = "true";
  overlay.style.cssText = "position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(3,7,18,.72);backdrop-filter:blur(8px);";
  const card = document.createElement("div");
  card.style.cssText = "width:min(520px,100%);border:1px solid rgba(255,255,255,.14);border-radius:20px;background:#111827;color:#fff;box-shadow:0 24px 80px rgba(0,0,0,.45);padding:28px;";
  const title = document.createElement("h2");
  title.textContent = "Product already registered";
  title.style.cssText = "margin:0 0 10px;font-size:22px;line-height:1.2;";
  const body = document.createElement("p");
  body.textContent = payload?.error?.message || "This product is already registered in PARAKH. Rescanning the same registered product has been blocked.";
  body.style.cssText = "margin:0;color:#cbd5e1;line-height:1.6;font-size:15px;";
  const hint = document.createElement("p");
  hint.textContent = payload?.error?.parakhId ? `Existing PARAKH ID: ${payload.error.parakhId}` : "The existing inspection record can be opened from Reports or Products.";
  hint.style.cssText = "margin:14px 0 22px;color:#94a3b8;font-size:13px;font-weight:600;";
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Close";
  button.style.cssText = "border:0;border-radius:12px;padding:11px 18px;background:#fff;color:#111827;font-weight:700;cursor:pointer;";
  button.addEventListener("click", () => overlay.remove());
  card.append(title, body, hint, button);
  overlay.appendChild(card);
  overlay.addEventListener("click", (event) => { if (event.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
}

async function sanitizeOcrResponse(response) {
  if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) return response;
  try {
    const payload = await response.clone().json();
    if (payload?.error?.code === "IMAGE_MISMATCH") showImageMismatchPopup(payload);
    if (payload?.result && typeof payload.result === "object") {
      try {
        const duplicate = await checkAlreadyRegistered(payload.result);
        if (duplicate) {
          const parakhId = duplicate.parakhId || "the existing registration";
          showDuplicateProductPopup({ error: { code: "PARAKH_DUPLICATE", parakhId, message: `This product is already registered in PARAKH as ${parakhId}. Rescanning the same registered product is blocked.` } });
          return new Response(JSON.stringify({ error: { code: "PARAKH_DUPLICATE", parakhId, message: `This product is already registered in PARAKH as ${parakhId}. Rescanning the same registered product is blocked.` } }), { status: 409, headers: { "Content-Type": "application/json" } });
        }
      } catch {}
      await localizeOcrFields(payload);
      delete payload.result.barcode;
      delete payload.result.gtin;
      delete payload.result.barcodeConfidence;
      delete payload.result.gtinConfidence;
    }
    return new Response(JSON.stringify(payload), {
      status: response.status,
      statusText: response.statusText,
      headers: { "Content-Type": "application/json" },
    });
  } catch {
    return response;
  }
}

export async function apiFetch(url, options = {}) {
  const rawUrl = String(url);
  let resolvedUrl = rawUrl;
  if (rawUrl.startsWith("http://localhost:5000/api")) {
    resolvedUrl = rawUrl.replace("http://localhost:5000/api", API_URL);
  } else if (rawUrl.startsWith("http://localhost:8080/api/ocr/evaluate-structured")) {
    resolvedUrl = `${API_URL}/ocr/evaluate-structured`;
  }
  const method = String(options.method || "GET").toUpperCase();
  const isRead = ["GET", "HEAD"].includes(method);
  const dataKartLookup = isDataKartLookup(resolvedUrl);
  if (isRead && !dataKartLookup && typeof window !== "undefined") {
    const cached = readCached(resolvedUrl);
    if (cached) return cachedResponse(cached);
  }
  const isRulesEngine = resolvedUrl.includes("/api/ocr/evaluate-structured");
  const isOcrAnalyze = resolvedUrl.includes("/api/ocr/analyze");
  const isProductRegistration = method === "POST" && resolvedUrl.endsWith("/api/products");
  let body = isOcrAnalyze ? await optimizeOcrBody(options.body) : options.body;
  if (isRulesEngine) body = sanitizeRulesEngineBody(body);
  if (isProductRegistration && typeof body === "string") {
    try {
      const payload = JSON.parse(body);
      const parsedOcr = payload?.ocrData && typeof payload.ocrData === "object" ? payload.ocrData : payload?.ocrData ? JSON.parse(payload.ocrData) : {};
      const identity = await buildParakhIdentity({ ...payload, ocrData: parsedOcr });
      body = JSON.stringify({ ...payload, ocrData: { ...parsedOcr, parakhIdentity: identity } });
    } catch {}
  }
  const response = await fetch(resolvedUrl, {
    ...options,
    cache: dataKartLookup ? "no-store" : options.cache,
    body,
    headers: { ...authHeaders(Boolean(body && typeof body === "string")), ...(options.headers || {}) },
  });
  if (response.status === 401) clearSession();
  if (response.ok && !isRead && !isTransientPost(resolvedUrl)) invalidateApiCache();
  if (response.ok && isRead && !dataKartLookup) await cacheResponse(resolvedUrl, response);
  return isOcrAnalyze ? sanitizeOcrResponse(response) : response;
}
