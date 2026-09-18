import { getResponsibilityReference } from "./penalties";

function escapeRtf(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/{/g, "\\{")
    .replace(/}/g, "\\}");
}

function text(value) { return escapeRtf(value).replace(/\r?\n/g, "\\line "); }

function heading(value) {
  return `\\par\\sb180\\sa80\\cf2\\fs26\\b ${text(value.toUpperCase())}\\b0\\cf1\\fs22\\par`;
}

function field(label, value) {
  return `\\pard\\sa80\\b ${text(label)}\\b0\\tab ${text(value)}\\par`;
}

function bullet(value) {
  return `\\pard\\li360\\fi-180\\sa50 \\bullet\\tab ${text(value)}\\par`;
}

function parseOcrData(product) {
  if (product?.ocrData && typeof product.ocrData === "object") return product.ocrData;
  if (typeof product?.ocrData === "string") {
    try { return JSON.parse(product.ocrData); } catch { return null; }
  }
  return null;
}

function notice(lines) {
  return `\\pard\\sb120\\sa120\\brdrt\\brdrs\\brdrw10\\brdrb\\brdrs\\brdrw10\\brdrl\\brdrs\\brdrw10\\brdrr\\brdrs\\brdrw10\\li120\\ri120\\fs20\\b IMPORTANT LEGAL NOTICE\\b0\\par ${lines.map((line) => `${text(line)}\\par`).join("")}\\pard\\fs22`;
}

export function downloadProductRtf({ product, user, violations = [], penaltySummary = null }) {
  const inspection = product?.inspections?.[0];
  const shop = inspection?.shop;
  const officer = inspection?.worker?.name || product?.owner?.name || user?.name || "Not recorded";
  const location = [shop?.address, shop?.city, shop?.state].filter(Boolean).join(", ") || "Not recorded";
  const status = product?.complianceStatus || "NEEDS_REVIEW";
  const stored = parseOcrData(product);
  const compliance = stored?.compliance && typeof stored.compliance === "object" ? stored.compliance : null;
  const review = stored?.complianceReview && typeof stored.complianceReview === "object" ? stored.complianceReview : {};
  const allFindings = Array.isArray(compliance?.findings) ? compliance.findings : [];
  const officerDecisionMap = review.officerDecisionMap && typeof review.officerDecisionMap === "object" ? review.officerDecisionMap : {};
  const decisionFor = (finding) => {
    const id = String(finding?.findingId || "");
    if (review.acceptedFindingIds?.map?.(String).includes(id)) return "ACCEPTED";
    const raw = officerDecisionMap[id]?.decision ?? officerDecisionMap[id];
    return raw ? String(raw).replace(/_/g, " ").toUpperCase() : (String(finding?.status || "").toUpperCase() === "UNABLE_TO_VERIFY" ? "PENDING" : "NOT REVIEWED");
  };
  const decisionCounts = review.officerDecisionCounts && typeof review.officerDecisionCounts === "object" ? review.officerDecisionCounts : {};
  const manualViolations = Array.isArray(review.manualViolations) ? review.manualViolations : [];
  const hasUnknown = Boolean(penaltySummary?.hasUnknown);
  const minValue = hasUnknown ? "Not fully determinable" : penaltySummary ? `Rs. ${Number(penaltySummary.minTotal || 0).toLocaleString("en-IN")}` : "Not calculated";
  const maxValue = hasUnknown ? "Not fully determinable" : penaltySummary ? `Rs. ${Number(penaltySummary.maxTotal || 0).toLocaleString("en-IN")}` : "Not calculated";
  const parts = [
    "{\\rtf1\\ansi\\deff0",
    "{\\fonttbl{\\f0 Calibri;}{\\f1 Calibri Light;}}",
    "{\\colortbl;\\red31\\green41\\blue55;\\red37\\green99\\blue235;}",
    "\\viewkind4\\uc1\\paperw11907\\paperh16840\\margl1000\\margr1000\\margt900\\margb900\\f0\\fs22\\cf1",
    "\\qc\\f1\\fs38\\b PARAKH\\b0\\par",
    "\\fs18\\cf2\\b PRODUCT INSPECTION REPORT\\b0\\cf1\\par",
    `\\fs16 Generated: ${text(new Date().toLocaleString())}\\par\\pard\\fs22`,
    heading("Product Details"),
    field("Product", product?.productName || "Not recorded"),
    field("Brand", product?.brandName || "Not recorded"),
    field("Category", product?.category?.name || "Not recorded"),
    field("MRP", product?.mrp == null ? "Not recorded" : `Rs. ${product.mrp}`),
    field("Net Quantity", `${product?.netQuantity || "Not recorded"} ${product?.unit || ""}`.trim()),
    field("Barcode", product?.barcode || "Not recorded"),
    heading("Shop & Inspector"),
    field("Shop", shop?.name || "Not recorded"),
    field("Location", location),
    field("Inspector / User", officer),
    field("Compliance Status", status),
    heading("Accepted Violations"),
  ];
  if (violations.length) {
    violations.forEach((finding, index) => parts.push(bullet(`${index + 1}. Rule ${finding?.ruleNumber || finding?.ruleCode || "Unknown"}: ${finding?.message || finding?.violationReason || "Violation recorded"}`)));
  } else {
    parts.push(bullet("No accepted violations recorded."));
  }
  parts.push(heading("Officer Review Ledger"));
  parts.push(field("Officer Passed", decisionCounts.passed ?? compliance?.summary?.passed ?? 0));
  parts.push(field("Officer Violations", Number(decisionCounts.violations || 0) + manualViolations.length));
  parts.push(field("Not Applicable", decisionCounts.notApplicable ?? compliance?.summary?.notApplicable ?? 0));
  parts.push(field("Unable to Verify", decisionCounts.unresolved ?? compliance?.summary?.unableToVerify ?? 0));
  parts.push(field("Out of Scope", decisionCounts.outOfScope ?? compliance?.summary?.outOfScope ?? 0));
  parts.push(field("Officer Decisions Recorded", decisionCounts.recorded ?? 0));
  if (allFindings.length) {
    allFindings.forEach((finding, index) => {
      parts.push(bullet(`${index + 1}. Rule ${finding?.ruleNumber || finding?.ruleCode || "Unknown"} · ${decisionFor(finding)} · ${finding?.message || finding?.violationReason || "No finding message recorded."}`));
    });
  } else {
    parts.push(bullet("No Rules Engine findings were retained."));
  }
  manualViolations.forEach((finding, index) => {
    parts.push(bullet(`Manual violation ${index + 1}: Rule ${finding?.ruleNumber || finding?.ruleCode || "Unknown"} · ${finding?.message || finding?.violationReason || "Officer-recorded violation"}`));
  });
  parts.push(heading("Penalty Reference"));
  parts.push(field("Occurrence Reference", penaltySummary?.occurrence || "Not recorded"));
  parts.push(field("Minimum Indicated", minValue));
  parts.push(field("Maximum Indicated", maxValue));
  parts.push(heading("Penalty / Legal References"));
  if (penaltySummary?.rows?.length) {
    penaltySummary.rows.forEach((row, index) => {
      const title = row.finding?.ruleNumber || row.finding?.ruleCode || `Violation ${index + 1}`;
      const detail = row.detail?.label ? `Reference: ${row.detail.label}` : "No penalty provision configured or verified for this finding.";
      const provision = row.detail?.provision ? ` Legal reference: ${row.detail.provision}` : "";
      parts.push(field(title, `${detail}.${provision}`));
      parts.push(bullet(`Responsibility reference: ${getResponsibilityReference(row.finding)}`));
    });
  } else {
    parts.push(bullet("No penalty reference data is available for this report."));
  }
  parts.push(heading("Important Legal Notice"));
  parts.push(notice([
    "This report is an inspection support record. Penalty amounts, where shown, are indicative legal references only.",
    "PARAKH does not determine or impose a fine, establish guilt, or finally assign responsibility.",
    "Any penalty, compounding action, improvement notice, prosecution or other enforcement measure must be determined by the competent Legal Metrology authority under applicable law and procedure.",
    "Responsibility may require investigation of the manufacturer, packer, importer, retailer/dealer or another responsible person.",
  ]));
  parts.push(heading("Officer Sign-off"));
  parts.push(field("Officer", officer));
  parts.push(field("Inspection Date", new Date(inspection?.inspectedAt || product?.createdAt || Date.now()).toLocaleString()));
  parts.push("\\par\\sa120 Signature / remarks: ________________________________________________\\par");
  parts.push("\\par\\qc\\cf2\\fs16 PARAKH — Inspection support record\\cf1\\fs22\\par}");
  const body = parts.join("");
  const filename = `PARAKH-${String(product?.productName || "product").replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "") || "product"}.rtf`;
  const blob = new Blob([body], { type: "application/rtf" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}