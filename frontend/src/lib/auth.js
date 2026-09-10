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

async function optimizeOcrBody(body) {
  if (!(body instanceof FormData)) return body;
  const entries = [...body.entries()];
  const optimized = new FormData();
  for (const [key, value] of entries) {
    if (!(typeof File !== "undefined" && value instanceof File && value.type.startsWith("image/"))) { optimized.append(key, value); continue; }
    try {
      const bitmap = await createImageBitmap(value);
      const maxSide = 1600;
      if (Math.max(bitmap.width, bitmap.height) <= maxSide && value.size <= 2 * 1024 * 1024) {
        bitmap.close(); optimized.append(key, value, value.name); continue;
      }
      const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext("2d");
      if (!context) { bitmap.close(); optimized.append(key, value, value.name); continue; }
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.78));
      if (blob && blob.size < value.size) optimized.append(key, new File([blob], value.name.replace(/\.[^.]+$/, ".jpg"), { type: "image/jpeg" }), value.name.replace(/\.[^.]+$/, ".jpg"));
      else optimized.append(key, value, value.name);
    } catch { optimized.append(key, value, value.name); }
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
  if (isRead && typeof window !== "undefined") {
    const cached = readCached(resolvedUrl);
    if (cached) return cachedResponse(cached);
  }
  const isRulesEngine = resolvedUrl.includes("/api/ocr/evaluate-structured");
  let body = resolvedUrl.includes("/api/ocr/analyze") ? await optimizeOcrBody(options.body) : options.body;
  if (isRulesEngine) body = sanitizeRulesEngineBody(body);
  const response = await fetch(resolvedUrl, { ...options, body, headers: { ...authHeaders(Boolean(body && typeof body === "string")), ...(options.headers || {}) } });
  if (response.status === 401) clearSession();
  if (response.ok && !isRead && !isTransientPost(resolvedUrl)) invalidateApiCache();
  if (response.ok && isRead) await cacheResponse(resolvedUrl, response);
  return response;
}
