import express from "express";
import prisma from "../lib/prisma.js";
import { authenticate } from "../middleware/auth.js";

const router = express.Router();
router.use(authenticate);

function toNumber(value) {
  const n = Number.parseFloat(String(value ?? "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function verifyProduct({ brandName, productName, netQuantity, unit, mrp }) {
  const missing = [];
  if (!brandName?.trim()) missing.push("manufacturer/brand information");
  if (!productName?.trim()) missing.push("product name");
  if (!netQuantity?.trim()) missing.push("net quantity");
  if (!unit?.trim()) missing.push("quantity unit");
  if (mrp === undefined || mrp === null || mrp === "" || Number.isNaN(Number(mrp))) missing.push("MRP");
  return missing.length ? { status: "VIOLATION", reason: `Missing declaration(s) requiring inspection: ${missing.join(", ")}.` } : { status: "OKAY", reason: "Automated OCR and Rules Engine assessment completed; final legal verification remains with the inspector." };
}

function visibility(req) { return req.user.role === "ADMIN" ? {} : { ownerId: req.user.id }; }

function calculateReviewedCompliance({ compliance, ocr, acceptedFindingIds }) {
  const findings = Array.isArray(compliance?.findings) ? compliance.findings : [];
  const engineViolations = findings.filter((finding) => finding?.status === "VIOLATION");
  const hasReviewSelection = Array.isArray(acceptedFindingIds);
  const acceptedSet = hasReviewSelection ? new Set(acceptedFindingIds.map(String)) : null;
  const acceptedViolations = acceptedSet ? engineViolations.filter((finding) => acceptedSet.has(String(finding.findingId))) : engineViolations;
  const rejectedViolations = hasReviewSelection ? engineViolations.filter((finding) => !acceptedSet.has(String(finding.findingId))) : [];
  const needsReview = Boolean(ocr?.needsReview) || Number(compliance?.summary?.unableToVerify || 0) > 0;
  const status = acceptedViolations.length > 0 ? "VIOLATION" : needsReview ? "NEEDS_REVIEW" : "OKAY";
  const reason = acceptedViolations.length > 0
    ? `Inspector accepted ${acceptedViolations.length} Rules Engine violation(s): ${acceptedViolations.map((x) => x.message || x.violationReason || x.ruleCode).join(" | ")}`
    : needsReview
      ? "Inspector review remains required because one or more OCR/rule checks could not be verified."
      : hasReviewSelection && rejectedViolations.length > 0
        ? "Rules Engine findings were reviewed; detected violations were not accepted by the inspector."
        : "Automated OCR and Rules Engine assessment completed; final legal verification remains with the inspector.";
  return { status, reason, engineViolations, acceptedViolations, rejectedViolations };
}

function sourceValue(value) { return String(value || "OFFLINE").toUpperCase() === "ECOMMERCE" ? "ECOMMERCE" : "OFFLINE"; }

const historySelect = {
  id: true, productName: true, brandName: true, netQuantity: true, unit: true, mrp: true, barcode: true,
  complianceStatus: true, violationReason: true, createdAt: true, sourceType: true, sourceUrl: true, sourceWebsiteName: true,
  owner: { select: { id: true, name: true, email: true } },
  category: { select: { id: true, name: true } },
  inspections: { select: { inspectedAt: true, shop: { select: { id: true, name: true, address: true, city: true, state: true, sourceType: true } }, worker: { select: { id: true, name: true } } }, orderBy: { inspectedAt: "desc" }, take: 1 }
};

router.get("/history", async (req, res) => {
  try {
    const { query = "", status = "ALL", sourceType = "ALL" } = req.query;
    const search = String(query).trim();
    const source = String(sourceType || "ALL").toUpperCase();
    const requestedLimit = Number(req.query.limit);
    const limit = Number.isFinite(requestedLimit) ? Math.min(100, Math.max(1, requestedLimit)) : 50;
    const where = {
      ...visibility(req),
      ...(status !== "ALL" ? { complianceStatus: status } : {}),
      ...(source !== "ALL" ? { sourceType: sourceValue(source) } : {}),
      ...(search ? { OR: [
        { productName: { contains: search, mode: "insensitive" } },
        { brandName: { contains: search, mode: "insensitive" } },
        { barcode: { contains: search, mode: "insensitive" } },
        { sourceWebsiteName: { contains: search, mode: "insensitive" } },
        { category: { name: { contains: search, mode: "insensitive" } } },
        { inspections: { some: { shop: { name: { contains: search, mode: "insensitive" } } } } }
      ] } : {})
    };
    const data = await prisma.product.findMany({ where, select: historySelect, orderBy: { createdAt: "desc" }, take: limit });
    res.json(data);
  } catch (e) { console.error(e); res.status(500).json({ error: "Failed to fetch inspection history" }); }
});

router.get("/", async (req, res) => {
  try {
    const { categoryId, status = "ALL", sourceType = "ALL", brandName, productName, unit, minQuantity, maxQuantity, shopName, minMrp, maxMrp } = req.query;
    const source = String(sourceType || "ALL").toUpperCase();
    const requestedLimit = Number(req.query.limit);
    const limit = Number.isFinite(requestedLimit) ? Math.min(100, Math.max(1, requestedLimit)) : 50;
    const where = {
      ...visibility(req),
      ...(categoryId ? { categoryId } : {}),
      ...(status !== "ALL" ? { complianceStatus: status } : {}),
      ...(source !== "ALL" ? { sourceType: sourceValue(source) } : {}),
      ...(brandName ? { brandName: { contains: brandName, mode: "insensitive" } } : {}),
      ...(productName ? { productName: { contains: productName, mode: "insensitive" } } : {}),
      ...(unit ? { unit: { equals: unit, mode: "insensitive" } } : {}),
      ...(minMrp || maxMrp ? { mrp: { ...(minMrp ? { gte: Number(minMrp) } : {}), ...(maxMrp ? { lte: Number(maxMrp) } : {}) } } : {}),
      ...(shopName ? { inspections: { some: { shop: { name: { contains: shopName, mode: "insensitive" } } } } } : {})
    };
    const data = await prisma.product.findMany({
      where,
      select: { id: true, productName: true, brandName: true, netQuantity: true, unit: true, mrp: true, complianceStatus: true, createdAt: true, sourceType: true, sourceUrl: true, sourceWebsiteName: true, owner: { select: { name: true } }, category: { select: { id: true, name: true } }, inspections: { select: { inspectedAt: true, shop: { select: { id: true, name: true, sourceType: true } } }, orderBy: { inspectedAt: "desc" }, take: 1 } },
      orderBy: { createdAt: "desc" }, take: limit
    });
    const minQ = minQuantity ? Number(minQuantity) : null;
    const maxQ = maxQuantity ? Number(maxQuantity) : null;
    res.json(data.filter((p) => {
      const q = toNumber(p.netQuantity);
      return (minQ === null || (q !== null && q >= minQ)) && (maxQ === null || (q !== null && q <= maxQ));
    }));
  } catch (e) { console.error(e); res.status(500).json({ error: "Failed to fetch products" }); }
});

router.post("/ecommerce/analyze-url", async (req, res) => {
  try {
    const rawUrl = String(req.body?.url || "").trim();
    if (!/^https?:\/\/[^\s]+$/i.test(rawUrl)) return res.status(400).json({ error: "A valid public HTTP/HTTPS listing URL is required." });

    function isPrivateHost(hostname) {
      const host = String(hostname || "").toLowerCase();
      return host === "localhost" || host.endsWith(".local") || host === "::1" || host === "0.0.0.0" ||
        /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[0-1])\./.test(host);
    }

    async function fetchPublicPage(initialUrl) {
      let current = new URL(initialUrl);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        if (!["http:", "https:"].includes(current.protocol) || isPrivateHost(current.hostname)) throw new Error("Private or unsupported listing URLs are not allowed.");
        const response = await fetch(current.href, { headers: { "user-agent": "PARAKH Compliance Inspection/1.0", accept: "text/html,application/xhtml+xml" }, redirect: "manual", signal: AbortSignal.timeout(15000) });
        if ([301,302,303,307,308].includes(response.status)) {
          const location = response.headers.get("location");
          if (!location) throw new Error("Listing server returned an invalid redirect.");
          current = new URL(location, current.href); continue;
        }
        return { response, finalUrl: current.href };
      }
      throw new Error("Too many listing-page redirects.");
    }

    const { response, finalUrl } = await fetchPublicPage(rawUrl);
    if (!response.ok) return res.status(400).json({ error: "Listing page returned HTTP " + response.status + "." });
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html")) return res.status(400).json({ error: "The supplied URL did not return an HTML listing page." });
    const html = (await response.text()).slice(0, 5000000);
    const decode = (value) => String(value || "").replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">");
    const pageText = decode(html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()).slice(0, 120000);
    const meta = {};
    for (const match of html.matchAll(/<meta\s+[^>]*?(?:property|name)=["']([^"']+)["'][^>]*?content=["']([^"']*)["'][^>]*>/gi)) meta[String(match[1]).toLowerCase()] = decode(match[2]);
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? decode(titleMatch[1]).replace(/\s+/g, " ").trim() : "";
    const jsonLd = [];
    for (const match of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) { try { jsonLd.push(JSON.parse(match[1])); } catch {} }
    const flatLd = jsonLd.flatMap((item) => Array.isArray(item) ? item : [item]);
    const productLd = flatLd.find((item) => item && typeof item === "object" && (item["@type"] === "Product" || (Array.isArray(item["@type"]) && item["@type"].includes("Product")))) || {};
    const offers = productLd.offers && typeof productLd.offers === "object" ? productLd.offers : {};
    const images = [];
    const addImage = (value) => { const u = decode(String(value || "")); if (/^https?:\/\//i.test(u) && !images.includes(u)) images.push(u); };
    const imageValues = Array.isArray(productLd.image) ? productLd.image : [productLd.image];
    imageValues.forEach(addImage); addImage(meta["og:image"]); addImage(meta["twitter:image"]);
    for (const match of html.matchAll(/<(?:img|source)[^>]+(?:src|data-src|srcset)=["']([^"']+)["'][^>]*>/gi)) { const raw = match[1].split(",")[0].trim().split(/\s+/)[0]; try { addImage(new URL(raw, finalUrl).href); } catch {} if (images.length >= 6) break; }
    const websiteName = new URL(finalUrl).hostname.replace(/^www\./i, "");
    const listing = {
      url: finalUrl, websiteName, title, text: pageText,
      productName: decode(productLd.name || meta["og:title"] || title),
      brand: decode(productLd.brand?.name || productLd.brand || ""),
      description: decode(productLd.description || meta["description"] || ""),
      sku: productLd.sku || productLd.mpn || "",
      gtin: productLd.gtin || productLd.gtin13 || productLd.gtin12 || productLd.gtin8 || "",
      mrp: offers.price || offers.lowPrice || "", currency: offers.priceCurrency || "", imageUrls: images,
      countryOfOrigin: /country\s+of\s+origin/i.test(pageText) ? (pageText.match(/country\s+of\s+origin\s*[:\-]\s*([A-Za-z][A-Za-z .'-]{2,40})/i)?.[1] || "") : "",
      filterEvidence: /(?:country\s+of\s+origin).{0,160}(?:filter|sort|search|select)/i.test(pageText) || /(?:filter|sort|search).{0,160}(?:country\s+of\s+origin)/i.test(pageText),
      sourceTitle: meta["og:title"] || title,
    };
    const ocrForm = new FormData(); let downloadableCount = 0;
    for (const imageUrl of images.slice(0, 6)) {
      try {
        const imageResponse = await fetch(imageUrl, { headers: { "user-agent": "PARAKH Compliance Inspection/1.0", accept: "image/*" }, signal: AbortSignal.timeout(10000) });
        const type = imageResponse.headers.get("content-type") || "";
        if (!imageResponse.ok || !type.startsWith("image/")) continue;
        const buffer = Buffer.from(await imageResponse.arrayBuffer());
        if (buffer.length > 12 * 1024 * 1024) continue;
        ocrForm.append("images", new Blob([buffer], { type }), "listing-" + (downloadableCount + 1) + ".jpg"); downloadableCount += 1;
      } catch {}
    }
    let ocr = null;
    if (downloadableCount > 0) {
      try { const ocrResponse = await fetch(`${process.env.RAPID_OCR_URL || process.env.PADDLE_OCR_URL || "http://localhost:8080"}/api/ocr/analyze`, { method: "POST", body: ocrForm, signal: AbortSignal.timeout(30000) }); const ocrPayload = await ocrResponse.json().catch(() => ({})); if (ocrResponse.ok && ocrPayload.result) ocr = ocrPayload.result; } catch {}
    }
    const result = await evaluateEcommerce({ listing, ocr, overrides: {} });
    res.json({ ...result, source: "public_listing_url" });
  } catch (e) { console.error(e); res.status(502).json({ error: e?.message || "Could not inspect the listing URL." }); }
});

async function evaluateEcommerce({ listing, ocr, overrides = {} }) {
  const productName = String(overrides.productName ?? listing?.productName ?? ocr?.productName?.value ?? "").trim();
  const brandName = String(overrides.brandName ?? listing?.brand ?? ocr?.brandName?.value ?? "").trim();
  const description = String(overrides.description ?? listing?.description ?? "").trim();
  const netQuantity = String(overrides.netQuantity ?? ocr?.netQuantity?.value ?? "").trim();
  const unit = String(overrides.unit ?? ocr?.unit?.value ?? "").trim();
  const mrp = overrides.mrp ?? listing?.mrp ?? ocr?.mrp?.value ?? "";
  const barcode = String(overrides.barcode ?? listing?.gtin ?? ocr?.barcode?.value ?? "").trim();
  const sku = String(overrides.sku ?? listing?.sku ?? "").trim();
  const countryOfOrigin = String(overrides.countryOfOrigin ?? listing?.countryOfOrigin ?? ocr?.countryOfOrigin?.value ?? "").trim();
  const filterEvidence = overrides.filterEvidence ?? Boolean(listing?.filterEvidence);
  const evidence = [
    { evidenceId: crypto.randomUUID(), field: "declarations.productName", rawValue: productName, normalizedValue: productName, confidence: productName ? 0.95 : 0, source: listing?.productName ? "DATABASE" : "OCR", timestamp: new Date().toISOString() },
    { evidenceId: crypto.randomUUID(), field: "declarations.brandName", rawValue: brandName, normalizedValue: brandName, confidence: brandName ? 0.9 : 0, source: listing?.brand ? "DATABASE" : "OCR", timestamp: new Date().toISOString() },
    { evidenceId: crypto.randomUUID(), field: "declarations.countryOfOrigin", rawValue: countryOfOrigin || null, normalizedValue: countryOfOrigin || null, confidence: countryOfOrigin ? 0.9 : 0, source: countryOfOrigin ? (listing?.countryOfOrigin ? "DATABASE" : "OCR") : "OCR", timestamp: new Date().toISOString() },
    { evidenceId: crypto.randomUUID(), field: "ecommerce.countryOfOriginFilter", rawValue: filterEvidence, normalizedValue: filterEvidence, confidence: filterEvidence ? 0.75 : 0.35, source: "DATABASE", timestamp: new Date().toISOString(), reliability: filterEvidence ? "MEDIUM" : "LOW" },
  ];
  const ruleRequest = {
    inspectionId: crypto.randomUUID(), productId: crypto.randomUUID(), inspectionDate: new Date().toISOString().slice(0, 10), context: "ecommerce_listing",
    productMetadata: { brandName: brandName || undefined, genericName: productName || undefined, commodityCategory: listing?.category || productName || "packaged commodity", consumerType: "general", isImported: undefined, countryOfOrigin: countryOfOrigin || undefined, packageType: "retail" },
    evidence, declarations: { productName, brandName, countryOfOrigin },
    administrative: { sourceUrl: listing?.url, sourceType: "public_ecommerce_listing", listingTitle: listing?.sourceTitle || listing?.title },
  };
  let compliance = null;
  try { const engineResponse = await fetch("http://localhost:8090/api/rules-engine/evaluate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(ruleRequest), signal: AbortSignal.timeout(15000) }); compliance = await engineResponse.json().catch(() => null); } catch {}
  return { listing: { ...listing, productName, brand: brandName, description, netQuantity, unit, mrp, gtin: barcode, sku, countryOfOrigin, filterEvidence }, ocr, compliance };
}

router.post("/ecommerce/evaluate", async (req, res) => {
  try {
    const { listing, ocr, overrides } = req.body || {};
    if (!listing?.url) return res.status(400).json({ error: "Listing data is required." });
    const result = await evaluateEcommerce({ listing, ocr, overrides: overrides || {} });
    res.json(result);
  } catch (e) { console.error(e); res.status(500).json({ error: e?.message || "Could not evaluate edited listing data." }); }
});

router.get("/analytics/summary", async (req, res) => {
  try {
    const visibilityWhere = visibility(req);
    const [products, shops, inspections, statusGroups, categoryGroups, brandGroups] = await Promise.all([
      prisma.product.count({ where: visibilityWhere }), prisma.shop.count({ where: req.user.role === "ADMIN" ? {} : { ownerId: req.user.id } }), prisma.inspection.count({ where: req.user.role === "ADMIN" ? {} : { workerId: req.user.id } }),
      prisma.product.groupBy({ by: ["complianceStatus"], where: visibilityWhere, _count: { _all: true } }), prisma.product.groupBy({ by: ["categoryId"], where: visibilityWhere, _count: { _all: true }, orderBy: { _count: { categoryId: "desc" } }, take: 8 }), prisma.product.groupBy({ by: ["brandName"], where: { ...visibilityWhere, brandName: { not: null } }, _count: { _all: true }, orderBy: { _count: { brandName: "desc" } }, take: 8 })
    ]);
    const categoryIds = categoryGroups.map((x) => x.categoryId); const categoryRows = categoryIds.length ? await prisma.category.findMany({ where: { id: { in: categoryIds } }, select: { id: true, name: true } }) : []; const categoryNames = new Map(categoryRows.map((x) => [x.id, x.name]));
    const violationRows = await prisma.product.findMany({ where: { ...visibilityWhere, complianceStatus: "VIOLATION" }, select: { ocrData: true, createdAt: true, brandName: true, categoryId: true, inspections: { select: { shopId: true, inspectedAt: true, shop: { select: { name: true, city: true, state: true } } } } }, take: 1000 });
    const ruleCounts = {}, locationCounts = {}, trend = {}, shopViolations = {}; let repeatProducts = 0;
    for (const product of violationRows) {
      const inspectionsForProduct = product.inspections || []; if (inspectionsForProduct.length > 1) repeatProducts += 1;
      for (const inspection of inspectionsForProduct) { const loc = [inspection.shop?.city, inspection.shop?.state].filter(Boolean).join(", ") || "Unknown"; locationCounts[loc] = (locationCounts[loc] || 0) + 1; const month = new Date(inspection.inspectedAt).toISOString().slice(0, 7); trend[month] = (trend[month] || 0) + 1; if (inspection.shop?.name) shopViolations[inspection.shop.name] = (shopViolations[inspection.shop.name] || 0) + 1; }
      try { const stored = product.ocrData ? JSON.parse(product.ocrData) : null; for (const finding of stored?.compliance?.findings || []) if (String(finding?.status).toUpperCase() === "VIOLATION") { const rule = finding.ruleNumber || finding.ruleCode || "Unknown"; ruleCounts[rule] = (ruleCounts[rule] || 0) + 1; } } catch {}
    }
    res.json({ scope: req.user.role === "ADMIN" ? "PLATFORM" : "OWN", counts: { products, shops, inspections, compliant: statusGroups.find((x) => x.complianceStatus === "OKAY")?._count._all || 0, violations: statusGroups.find((x) => x.complianceStatus === "VIOLATION")?._count._all || 0, review: (statusGroups.find((x) => x.complianceStatus === "NEEDS_REVIEW")?._count._all || 0) + (statusGroups.find((x) => x.complianceStatus === "UNABLE_TO_VERIFY")?._count._all || 0) }, topCategories: categoryGroups.map((x) => ({ categoryId: x.categoryId, name: categoryNames.get(x.categoryId) || "Unknown", products: x._count._all })), topBrands: brandGroups.map((x) => ({ brand: x.brandName, products: x._count._all })), topRules: Object.entries(ruleCounts).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([rule,count])=>({rule,count})), topLocations: Object.entries(locationCounts).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([location,inspections])=>({location,inspections})), violationTrend: Object.entries(trend).sort((a,b)=>a[0].localeCompare(b[0])).slice(-12).map(([month,violations])=>({month,violations})), topShops: Object.entries(shopViolations).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([shop,violations])=>({shop,violations})), repeatProducts });
  } catch (e) { console.error(e); res.status(500).json({ error: "Failed to load analytics" }); }
});

router.get("/:id", async (req, res) => { try { const product = await prisma.product.findFirst({ where: { id: req.params.id, ...visibility(req) }, include: { owner: { select: { id: true, name: true, email: true } }, category: { include: { parent: { include: { parent: { include: { parent: true } } } } } }, inspections: { include: { shop: true, worker: { select: { name: true } } }, orderBy: { inspectedAt: "desc" } } } }); if (!product) return res.status(404).json({ error: "Product not found" }); res.json(product); } catch (e) { console.error(e); res.status(500).json({ error: "Failed to fetch product" }); } });

router.post("/", async (req, res) => {
  try {
    const { categoryId, brandName, productName, description, netQuantity, unit, mrp, barcode, imageUrl, imageUrls, ocrData, complianceStatus, violationReason, acceptedFindingIds, shopName, shopAddress, shopCity, shopState, inspectionDate, notes, sourceType, sourceUrl, sourceWebsiteName } = req.body;
    const normalizedSource = sourceValue(sourceType);
    if (!categoryId || !productName?.trim() || !shopName?.trim()) return res.status(400).json({ error: "Category, product name and shop/website name are required" });
    const category = await prisma.category.findFirst({ where: { id: categoryId, OR: [{ isSystem: true }, { ownerId: req.user.id }] }, include: { children: true } });
    if (!category) return res.status(404).json({ error: "Category not found" });
    if (!category.isFinalProductType) return res.status(400).json({ error: "Only final categories can contain registered products" });
    const parsedMrp = mrp === "" || mrp === undefined || mrp === null ? null : Number(mrp);
    if (parsedMrp !== null && (!Number.isFinite(parsedMrp) || parsedMrp < 0)) return res.status(400).json({ error: "MRP must be a valid non-negative number" });
    let parsedImages = [];
    try { if (Array.isArray(imageUrls)) parsedImages = imageUrls.filter((x) => typeof x === "string" && x); else if (imageUrls) parsedImages = JSON.parse(imageUrls); if (!Array.isArray(parsedImages)) throw new Error("imageUrls must be an array"); } catch { return res.status(400).json({ error: "Invalid imageUrls payload" }); }
    let parsedOcrData = ocrData; if (typeof ocrData === "string") { try { parsedOcrData = JSON.parse(ocrData); } catch {} }
    const review = calculateReviewedCompliance({ compliance: parsedOcrData?.compliance, ocr: parsedOcrData?.ocr, acceptedFindingIds });
    const verification = verifyProduct({ brandName, productName, netQuantity, unit, mrp: parsedMrp });
    const hasEngineReviewData = Boolean(parsedOcrData?.compliance);
    const finalStatus = hasEngineReviewData ? review.status : (new Set(["OKAY", "VIOLATION", "NEEDS_REVIEW"]).has(complianceStatus) ? complianceStatus : verification.status);
    const reason = hasEngineReviewData ? review.reason : (typeof violationReason === "string" && violationReason.trim() ? violationReason.trim() : verification.reason);
    const enrichedOcrData = parsedOcrData && typeof parsedOcrData === "object" ? { ...parsedOcrData, complianceReview: { engineViolationCount: review.engineViolations.length, acceptedFindingIds: review.acceptedViolations.map((x) => x.findingId), rejectedFindingIds: review.rejectedViolations.map((x) => x.findingId), reviewedAt: new Date().toISOString() } } : parsedOcrData;
    const inspectedAt = inspectionDate ? new Date(inspectionDate) : new Date(); if (Number.isNaN(inspectedAt.getTime())) return res.status(400).json({ error: "Invalid inspection date" });
    const result = await prisma.$transaction(async (tx) => {
      const product = await tx.product.create({ data: { categoryId, ownerId: req.user.id, brandName: brandName?.trim() || null, productName: productName.trim(), description: description?.trim() || null, ocrData: enrichedOcrData ? JSON.stringify(enrichedOcrData) : null, netQuantity: netQuantity?.trim() || null, unit: unit?.trim() || null, mrp: parsedMrp, barcode: barcode?.trim() || null, imageUrl: imageUrl?.trim() || parsedImages[0] || null, imageUrls: parsedImages, complianceStatus: finalStatus, violationReason: reason, sourceType: normalizedSource, sourceUrl: sourceUrl?.trim() || null, sourceWebsiteName: sourceWebsiteName?.trim() || null } });
      const shop = await tx.shop.create({ data: { name: shopName.trim(), address: shopAddress?.trim() || null, city: shopCity?.trim() || null, state: shopState?.trim() || null, sourceType: normalizedSource, ownerId: req.user.id } });
      const inspection = await tx.inspection.create({ data: { status: finalStatus, notes: notes?.trim() || reason, inspectedAt, workerId: req.user.id, shopId: shop.id, productId: product.id } });
      return { product, shop, inspection };
    });
    res.status(201).json({ id: result.product.id, product: { id: result.product.id }, inspection: { id: result.inspection.id, status: result.inspection.status } });
  } catch (e) { console.error(e); res.status(500).json({ error: e?.message || "Failed to register product" }); }
});

router.delete("/:id", async (req, res) => { try { const product = await prisma.product.findFirst({ where: { id: req.params.id, ...visibility(req) } }); if (!product) return res.status(404).json({ error: "Product not found" }); await prisma.$transaction(async (tx) => { await tx.inspection.deleteMany({ where: { productId: product.id } }); await tx.product.delete({ where: { id: product.id } }); }); res.json({ message: "Product deleted successfully" }); } catch (e) { console.error(e); res.status(500).json({ error: "Failed to delete product" }); } });

export default router;
