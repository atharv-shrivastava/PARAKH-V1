import { jsPDF } from "jspdf";
import { getResponsibilityReference } from "./penalties";

function safe(value) {
  return String(value ?? "Not recorded");
}

function imageFormat(src) {
  const match = String(src || "").match(/^data:image\/([^;]+);/i);
  const type = match?.[1]?.toLowerCase();
  return type === "png" ? "PNG" : "JPEG";
}

function parseImages(product) {
  const value = product?.imageUrls;
  if (Array.isArray(value)) return value.filter((x) => typeof x === "string" && x.startsWith("data:image/"));
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string" && x.startsWith("data:image/")) : [];
    } catch { return []; }
  }
  return product?.imageUrl?.startsWith("data:image/") ? [product.imageUrl] : [];
}

function parseOcrData(product) {
  if (product?.ocrData && typeof product.ocrData === "object") return product.ocrData;
  if (typeof product?.ocrData === "string") {
    try { return JSON.parse(product.ocrData); } catch { return null; }
  }
  return null;
}

function drawSectionHeader(doc, title, y) {
  doc.setFillColor(245, 247, 250);
  doc.roundedRect(40, y - 15, 515, 28, 4, 4, "F");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  doc.setTextColor(30, 41, 59);
  doc.text(title, 52, y + 2);
  return y + 22;
}

function drawField(doc, label, value, x, y, width) {
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8);
  doc.setTextColor(100, 116, 139);
  doc.text(label.toUpperCase(), x, y);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(15, 23, 42);
  const lines = doc.splitTextToSize(safe(value), width - 8);
  doc.text(lines, x, y + 13);
  return y + 13 + Math.max(1, lines.length) * 11;
}

function addPageFooter(doc) {
  const pages = doc.getNumberOfPages();
  for (let page = 1; page <= pages; page += 1) {
    doc.setPage(page);
    doc.setDrawColor(203, 213, 225);
    doc.line(40, 815, 555, 815);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(100, 116, 139);
    doc.text("PARAKH - Legal Metrology Inspection Record", 40, 830);
    doc.text(`Page ${page} of ${pages}`, 555, 830, { align: "right" });
  }
}

export async function downloadProductPdf({ product, user, violations = [], penaltySummary = null }) {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const left = 40;
  const right = 555;
  const shop = product?.inspections?.[0]?.shop;
  const inspection = product?.inspections?.[0];
  const images = parseImages(product);
  const stored = parseOcrData(product);
  const compliance = stored?.compliance && typeof stored.compliance === "object" ? stored.compliance : null;
  const review = stored?.complianceReview && typeof stored.complianceReview === "object" ? stored.complianceReview : {};
  const allFindings = Array.isArray(compliance?.findings) ? compliance.findings : [];
  const acceptedIds = new Set(Array.isArray(review.acceptedFindingIds) ? review.acceptedFindingIds.map(String) : []);
  const rejectedIds = new Set(Array.isArray(review.rejectedFindingIds) ? review.rejectedFindingIds.map(String) : []);
  const unableDecisions = review.unableToVerifyDecisions && typeof review.unableToVerifyDecisions === "object" ? review.unableToVerifyDecisions : {};
  const officerDecision = (finding) => {
    const id = String(finding?.findingId || "");
    if (acceptedIds.has(id)) return "ACCEPTED";
    if (rejectedIds.has(id)) return "NOT ACCEPTED";
    if (String(finding?.status || "").toUpperCase() === "UNABLE_TO_VERIFY") return String(unableDecisions[id] || "PENDING").toUpperCase();
    return "NOT REVIEWED";
  };
  const path = [
    product?.category?.parent?.parent?.parent,
    product?.category?.parent?.parent,
    product?.category?.parent,
    product?.category,
  ].filter(Boolean).map((x) => x.name).join(" > ");
  const officer = inspection?.worker?.name || product?.owner?.name || user?.name || "Not recorded";
  const officerEmail = product?.owner?.email || user?.email || "Not recorded";
  const registeredAt = new Date(product?.createdAt || Date.now());
  const inspectedAt = new Date(inspection?.inspectedAt || product?.createdAt || Date.now());

  doc.setTextColor(15, 23, 42);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(22);
  doc.text("PARAKH", left, 52);
  doc.setFontSize(10);
  doc.setTextColor(100, 116, 139);
  doc.text("PRODUCT INSPECTION REPORT", left, 69);
  doc.setFont("helvetica", "normal");
  doc.text(`Generated: ${new Date().toLocaleString()}`, right, 52, { align: "right" });

  let y = 98;
  y = drawSectionHeader(doc, "Product Details", y);
  const rowStart = y;
  drawField(doc, "Product", product.productName, left, rowStart, 250);
  drawField(doc, "Brand / Manufacturer", product.brandName, 305, rowStart, 250);
  drawField(doc, "Category", path || product.category?.name, left, rowStart + 55, 250);
  drawField(doc, "MRP", product.mrp == null ? "Not recorded" : `Rs. ${product.mrp}`, 305, rowStart + 55, 250);
  drawField(doc, "Net Quantity", [product.netQuantity, product.unit].filter(Boolean).join(" ") || "Not recorded", left, rowStart + 110, 250);
  drawField(doc, "Barcode", product.barcode, 305, rowStart + 110, 250);
  drawField(doc, "Registered At", registeredAt.toLocaleString(), left, rowStart + 165, 250);
  drawField(doc, "Inspection At", inspectedAt.toLocaleString(), 305, rowStart + 165, 250);

  y = rowStart + 225;
  y = drawSectionHeader(doc, "Shop & Inspector", y);
  drawField(doc, "Shop", shop?.name, left, y, 250);
  drawField(doc, "Location", [shop?.address, shop?.city, shop?.state].filter(Boolean).join(", "), 305, y, 250);
  drawField(doc, "Inspector / User", officer, left, y + 55, 250);
  drawField(doc, "Email", officerEmail, 305, y + 55, 250);
  drawField(doc, "Role", user?.role || "USER", left, y + 110, 250);
  drawField(doc, "Compliance Status", product.complianceStatus || "NEEDS_REVIEW", 305, y + 110, 250);

  y += 170;
  y = drawSectionHeader(doc, "Rules Violated by This Product", y);
  if (!violations.length) {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.setTextColor(51, 65, 85);
    doc.text("No Rules Engine violations were accepted by the inspector.", left, y + 8);
    y += 30;
  } else {
    violations.forEach((finding, index) => {
      if (y > 770) { doc.addPage(); y = 55; }
      doc.setFillColor(254, 242, 242);
      const lines = doc.splitTextToSize(
        `${finding.ruleNumber || `Rule ${index + 1}`}: ${finding.message || finding.violationReason || "Violation recorded"}`,
        490,
      );
      const boxHeight = 14 + lines.length * 13;
      doc.roundedRect(left, y, 515, boxHeight, 4, 4, "F");
      doc.setFont("helvetica", "normal");
      doc.setFontSize(10);
      doc.setTextColor(127, 29, 29);
      doc.text(lines, left + 10, y + 15);
      y += boxHeight + 8;
    });
  }

  if (y > 680) { doc.addPage(); y = 55; }
  y = drawSectionHeader(doc, "Officer Review Ledger", y);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(71, 85, 105);
  doc.text(`Engine findings recorded: ${allFindings.length}`, left, y + 8);
  doc.text(`Review timestamp: ${safe(review.reviewedAt || "Not recorded")}`, 305, y + 8);
  y += 24;
  if (!allFindings.length) {
    doc.text("No engine findings were retained for officer review.", left, y + 8);
    y += 24;
  } else {
    allFindings.forEach((finding, index) => {
      if (y > 765) { doc.addPage(); y = 55; }
      const decision = officerDecision(finding);
      const header = `${finding.ruleNumber || finding.ruleCode || `Rule ${index + 1}`} · ${String(finding.status || "UNKNOWN").toUpperCase()} · Officer: ${decision}`;
      const message = finding.message || finding.violationReason || "No finding message recorded.";
      const lines = doc.splitTextToSize(`${header}\n${message}`, 490);
      const boxHeight = 16 + lines.length * 12;
      doc.setFillColor(decision === "ACCEPTED" || decision === "FAIL" ? 254 : 248, decision === "ACCEPTED" || decision === "FAIL" ? 242 : 250, decision === "ACCEPTED" || decision === "FAIL" ? 242 : 252);
      doc.roundedRect(left, y, 515, boxHeight, 4, 4, "F");
      doc.setFont("helvetica", "bold");
      doc.setFontSize(9);
      doc.setTextColor(30, 41, 59);
      doc.text(lines, left + 10, y + 14);
      y += boxHeight + 7;
    });
  }
  const manualDecisions = Array.isArray(review.manualDecisions) ? review.manualDecisions : [];
  if (manualDecisions.length) {
    doc.setFont("helvetica", "bold"); doc.setFontSize(9); doc.setTextColor(30, 41, 59);
    doc.text("Manual officer decisions", left, y + 4);
    y += 18;
    manualDecisions.forEach((decision) => {
      if (y > 770) { doc.addPage(); y = 55; }
      const text = `${decision.ruleNumber || decision.ruleCode || "Rule"} · ${decision.decision || "RECORDED"} · ${decision.reason || "No reason recorded."}`;
      const lines = doc.splitTextToSize(text, 500);
      doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(71, 85, 105);
      doc.text(lines, left, y);
      y += Math.max(15, lines.length * 11 + 4);
    });
  }

  if (y > 680) { doc.addPage(); y = 55; }
  y = drawSectionHeader(doc, "Penalty Reference", y);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(71, 85, 105);
  doc.text("Inspector-selected occurrence reference: " + safe(penaltySummary?.occurrence || "Not recorded"), left, y + 8);
  y += 24;
  const hasUnknown = Boolean(penaltySummary?.hasUnknown);
  drawField(doc, "Minimum indicated", hasUnknown ? "Not fully determinable" : penaltySummary ? `₹${Number(penaltySummary.minTotal || 0).toLocaleString("en-IN")}` : "Not calculated", left, y, 250);
  drawField(doc, "Maximum indicated", hasUnknown ? "Not fully determinable" : penaltySummary ? `₹${Number(penaltySummary.maxTotal || 0).toLocaleString("en-IN")}` : "Not calculated", 305, y, 250);
  y += 48;
  if (penaltySummary?.rows?.length) {
    penaltySummary.rows.forEach((row, index) => {
      if (y > 775) { doc.addPage(); y = 55; }
      const title = row.finding?.ruleNumber || row.finding?.ruleCode || `Violation ${index + 1}`;
      const detail = row.detail?.label ? `Reference: ${row.detail.label}` : "No penalty provision configured or verified for this finding.";
      doc.setFont("helvetica", "bold"); doc.setFontSize(9); doc.setTextColor(30, 41, 59);
      doc.text(title, left, y);
      doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(71, 85, 105);
      const detailLines = doc.splitTextToSize(`${detail}${row.detail?.provision ? ` (Legal reference: ${row.detail.provision})` : ""}`, 500);
      doc.text(detailLines, left + 80, y);
      const responsibilityLines = doc.splitTextToSize(`Responsibility reference: ${getResponsibilityReference(row.finding)}`, 500);
      doc.setFont("helvetica", "italic");
      doc.text(responsibilityLines, left + 80, y + Math.max(12, detailLines.length * 11));
      y += Math.max(30, detailLines.length * 11 + responsibilityLines.length * 11 + 4);
    });
  }
  doc.setFont("helvetica", "italic");
  doc.setFontSize(8);
  doc.setTextColor(100, 116, 139);
  const caveat = doc.splitTextToSize("This section provides indicative statutory reference information for inspection support only. PARAKH does not determine or impose a fine. Actual penalty, compounding amount, improvement notice, prosecution or other enforcement action is determined by the competent Legal Metrology authority under applicable law and procedure. Responsibility is also not adjudicated by PARAKH and may require investigation of the manufacturer, packer, importer, retailer/dealer or another responsible person.", 510);
  doc.text(caveat, left, y + 10);
  y += 28 + caveat.length * 10;

  if (y > 680) { doc.addPage(); y = 55; }
  y = drawSectionHeader(doc, "Evidence Images", y);
  let imageX = left;
  let imageY = y;
  const imageSize = 118;
  images.forEach((src, index) => {
    if (imageX + imageSize > right) { imageX = left; imageY += imageSize + 20; }
    if (imageY + imageSize > 780) { doc.addPage(); imageY = 55; imageX = left; }
    try {
      doc.addImage(src, imageFormat(src), imageX, imageY, imageSize, imageSize, undefined, "MEDIUM");
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8);
      doc.setTextColor(100, 116, 139);
      doc.text(`Image ${index + 1}`, imageX, imageY + imageSize + 11);
    } catch {
      doc.setFontSize(8);
      doc.text(`Image ${index + 1} unavailable`, imageX, imageY + 20);
    }
    imageX += imageSize + 12;
  });

  imageY += images.length ? imageSize + 35 : 35;
  if (imageY > 720) { doc.addPage(); imageY = 55; }
  y = drawSectionHeader(doc, "Inspection Officer Sign-off", imageY);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(51, 65, 85);
  doc.text("I have reviewed the product inspection information, accepted findings and officer review decisions recorded above.", left, y + 8);
  doc.setDrawColor(71, 85, 105);
  doc.line(left, y + 75, 280, y + 75);
  doc.line(330, y + 75, right, y + 75);
  doc.line(left, y + 125, 280, y + 125);
  doc.line(330, y + 125, right, y + 125);
  doc.setFontSize(9);
  doc.setTextColor(100, 116, 139);
  doc.text("Inspection Officer Signature", left, y + 90);
  doc.text("Date & Time", 330, y + 90);
  doc.text("Officer Name", left, y + 140);
  doc.text("Official Stamp (optional)", 330, y + 140);

  addPageFooter(doc);
  const filename = `PARAKH-${String(product.productName || "product").replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "") || "product"}.pdf`;
  doc.save(filename);
}
