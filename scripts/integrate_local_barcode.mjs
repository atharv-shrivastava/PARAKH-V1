import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const write = (file, value) => fs.writeFileSync(path.join(root, file), value, "utf8");
function replaceOnce(file, oldValue, newValue, label) {
  const value = read(file);
  if (!value.includes(oldValue)) throw new Error(`${label}: pattern not found`);
  write(file, value.replace(oldValue, newValue));
}

execFileSync("npm", ["install", "zxing-wasm@3.1.3", "--save"], { cwd: path.join(root, "backend"), stdio: "inherit" });

write("backend/src/ocr/barcodeDecoder.js", `import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareZXingModule, readBarcodes } from "zxing-wasm/reader";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const wasmPath = path.resolve(__dirname, "../../node_modules/zxing-wasm/dist/reader/zxing_reader.wasm");
const wasmBuffer = readFileSync(wasmPath);
await prepareZXingModule({
  fireImmediately: true,
  overrides: {
    wasmBinary: wasmBuffer.buffer.slice(wasmBuffer.byteOffset, wasmBuffer.byteOffset + wasmBuffer.byteLength),
  },
});

const RETAIL_FORMATS = ["EAN13", "EAN8", "UPCA", "UPCE", "ITF14", "CODE128"];

function normalizeGtin(value) {
  const digits = String(value ?? "").replace(/\\D/g, "");
  return [8, 12, 13, 14].includes(digits.length) ? digits : null;
}

async function decodeBytes(bytes) {
  const results = await readBarcodes(bytes, {
    tryHarder: true,
    formats: RETAIL_FORMATS,
    maxNumberOfSymbols: 1,
  });
  const first = results.find((item) => !item?.error && item?.text);
  return first ? normalizeGtin(first.text) : null;
}

export async function decodeBarcodeImage(filePath) {
  const original = readFileSync(filePath);
  try {
    const gtin = await decodeBytes(new Uint8Array(original));
    if (gtin) return { gtin, decoder: "ZXING-WASM", attempts: 1 };
  } catch (error) {
    console.warn("[Barcode] original decode failed:", error?.message || error);
  }

  try {
    const sharpModule = await import("sharp");
    const processed = await sharpModule.default(filePath)
      .rotate()
      .grayscale()
      .normalize()
      .png()
      .toBuffer();
    const gtin = await decodeBytes(new Uint8Array(processed));
    if (gtin) return { gtin, decoder: "ZXING-WASM-PREPROCESSED", attempts: 2 };
  } catch (error) {
    console.warn("[Barcode] preprocessed decode failed:", error?.message || error);
  }

  return { gtin: null, decoder: "ZXING-WASM", attempts: 2 };
}
`);

replaceOnce(
  "backend/src/ocr/fastRoutes.js",
  'import { applyEvidenceConfidence } from "./evidenceConfidence.js";\\n',
  'import { applyEvidenceConfidence } from "./evidenceConfidence.js";\\nimport { decodeBarcodeImage } from "./barcodeDecoder.js";\\n',
  "decoder import",
);
replaceOnce(
  "backend/src/ocr/fastRoutes.js",
  '    const barcodeImageProvided = Boolean(barcodeFile);\\n    const submittedBarcode = String(req.body?.barcodeGtin || "").replace(/\\\\D/g, "").trim();\\n    const uploadMs = Date.now() - startedAt;',
  '    const barcodeImageProvided = Boolean(barcodeFile);\\n    const uploadMs = Date.now() - startedAt;',
  "remove submitted barcode",
);
replaceOnce(
  "backend/src/ocr/fastRoutes.js",
  `    const rapidStart = Date.now();
    const rapid = await analyzeWithRapid(images);
    const rapidMs = Date.now() - rapidStart;`,
  `    const rapidStart = Date.now();
    const barcodeStart = Date.now();
    const barcodePromise = barcodeFile
      ? decodeBarcodeImage(barcodeFile.path)
      : Promise.resolve({ gtin: null, decoder: "NOT_PROVIDED", attempts: 0 });
    const [rapid, barcodeDecode] = await Promise.all([
      analyzeWithRapid(images),
      barcodePromise.catch((error) => ({ gtin: null, decoder: "ZXING-WASM", attempts: 0, error: error?.message || "Barcode decode failed." })),
    ]);
    const rapidMs = Date.now() - rapidStart;
    const barcodeMs = Date.now() - barcodeStart;
    const decodedBarcode = String(barcodeDecode?.gtin || "").replace(/\\D/g, "").trim() || null;`,
  "parallel barcode decode",
);
replaceOnce(
  "backend/src/ocr/fastRoutes.js",
  `    const structuredResult = buildStructuredResult(rapid, aiSemantic);
    if (submittedBarcode) {
      structuredResult.barcode = {
        value: submittedBarcode,
        raw: submittedBarcode,
        confidence: 1,
        evidence: submittedBarcode,
        status: "found",
        source: "BARCODE_IMAGE_DECODER",
      };
    }
    const result = await applyEvidenceConfidence(structuredResult, { barcodeImageProvided });`,
  `    const structuredResult = buildStructuredResult(rapid, aiSemantic);
    if (decodedBarcode) {
      structuredResult.barcode = {
        value: decodedBarcode,
        raw: decodedBarcode,
        confidence: 1,
        evidence: decodedBarcode,
        status: "found",
        source: barcodeDecode?.decoder || "ZXING-WASM",
      };
    }
    const majorityVoteResult = JSON.parse(JSON.stringify(structuredResult));
    const RULE_ENGINE_FIELDS = [
      "productName", "brandName", "manufacturer", "manufacturerAddress", "packer", "packerAddress",
      "marketer", "marketerAddress", "importer", "importerAddress", "netQuantity", "unit", "mrp",
      "currency", "dateOfManufacture", "dateOfPacking", "bestBefore", "expiryDate", "batchNumber",
      "consumerCarePhone", "consumerCareEmail", "countryOfOrigin", "fssaiLicenseNumber",
    ];
    const ruleEngineInput = Object.fromEntries(RULE_ENGINE_FIELDS.map((key) => {
      const field = majorityVoteResult?.[key];
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
    const result = await applyEvidenceConfidence(structuredResult, { barcodeImageProvided });`,
  "majority vote and rules input",
);
replaceOnce(
  "backend/src/ocr/fastRoutes.js",
  '    console.log(\\n      `[ocr:fast] images=${files.length} evidence=${rapid.evidence.length} rapid=${rapidMs}ms `',
  '    console.log(\\n      `[ocr:fast] images=${files.length} barcodeImage=${barcodeImageProvided ? "yes" : "no"} gtin=${decodedBarcode || "none"} barcode=${barcodeMs}ms evidence=${rapid.evidence.length} rapid=${rapidMs}ms `',
  "pipeline log",
);
replaceOnce(
  "backend/src/ocr/fastRoutes.js",
  `      result,
      provider: "rapidocr",`,
  `      result,
      majorityVote: majorityVoteResult,
      ruleEngineInput,
      barcode: {
        provided: barcodeImageProvided,
        gtin: decodedBarcode,
        decoder: barcodeDecode?.decoder || "NOT_PROVIDED",
        attempts: barcodeDecode?.attempts || 0,
        error: barcodeDecode?.error || null,
      },
      provider: "rapidocr",`,
  "response barcode metadata",
);
replaceOnce(
  "backend/src/ocr/fastRoutes.js",
  'timing: { uploadMs, rapidMs, semanticMs, geminiMs:',
  'timing: { uploadMs, rapidMs, barcodeMs, semanticMs, geminiMs:',
  "barcode timing",
);

replaceOnce(
  "backend/src/ocr/evidenceConfidence.js",
  'const FIELD_MAP = {',
  'import { searchMrpRange } from "./marketPriceSearch.js";\\n\\nconst FIELD_MAP = {',
  "MRP search import",
);
replaceOnce(
  "backend/src/ocr/evidenceConfidence.js",
  '  let dataKartError = null;\\n  const geminiAvailable',
  '  let dataKartError = null;\\n  let webMrpRange = null;\\n  const geminiAvailable',
  "MRP range state",
);
replaceOnce(
  "backend/src/ocr/evidenceConfidence.js",
  `  if (barcode) {
    try {
      dataKart = await fetchDataKartByGtin(barcode);
    } catch (error) {
      dataKartError = error?.message || "DataKart lookup failed.";
    }
  }

  const details = {};`,
  `  if (barcode) {
    try {
      dataKart = await fetchDataKartByGtin(barcode);
    } catch (error) {
      dataKartError = error?.message || "DataKart lookup failed.";
    }
  }

  if (!dataKart && !dataKartError) {
    try {
      webMrpRange = await searchMrpRange({
        productName: result?.productName?.value,
        brandName: result?.brandName?.value,
        netQuantity: result?.netQuantity?.value,
        unit: result?.unit?.value,
      });
    } catch (error) {
      webMrpRange = { status: "UNAVAILABLE", error: error?.message || "Web MRP search failed." };
    }
  }

  const details = {};`,
  "MRP web fallback",
);
replaceOnce(
  "backend/src/ocr/evidenceConfidence.js",
  `    next[fieldKey] = {
      ...fieldValue,
      confidence:`,
  `    next[fieldKey] = {
      ...fieldValue,
      ...(fieldKey === "mrp" && webMrpRange?.min != null && webMrpRange?.max != null ? { webMarketRange: webMrpRange } : {}),
      confidence:`,
  "MRP range field",
);
replaceOnce(
  "backend/src/ocr/evidenceConfidence.js",
  `    dataKartAvailable: Boolean(dataKart),
    dataKartError,
    fields: details,`,
  `    dataKartAvailable: Boolean(dataKart),
    dataKartError,
    webMrpRange,
    fields: details,`,
  "MRP range metadata",
);
replaceOnce(
  "backend/src/ocr/evidenceConfidence.js",
  '  const dataKartStatus = dataKart ? "REGISTERED" : dataKartError ? "UNAVAILABLE" : barcode ? "NOT_FOUND" : "NO_GTIN";',
  '  const dataKartStatus = dataKart ? "REGISTERED" : dataKartError ? "UNAVAILABLE" : barcodeImageProvided && !barcode ? "BARCODE_UNREADABLE" : barcode ? "NOT_FOUND" : "NO_GTIN";',
  "barcode unreadable status",
);
replaceOnce(
  "backend/src/ocr/evidenceConfidence.js",
  '  const dataKartMessage = dataKart ? "✓ Product found in DataKart" : dataKartError ? "? DataKart could not be reached" : barcode ? "✕ Product not found in DataKart" : "? Product could not be checked: no GTIN detected";',
  '  const dataKartMessage = dataKart ? "✓ Product found in DataKart" : dataKartError ? "? DataKart could not be reached" : dataKartStatus === "BARCODE_UNREADABLE" ? "? Barcode could not be decoded" : "✕ Product not found in DataKart";',
  "DataKart message",
);

replaceOnce(
  "frontend/src/pages/Scan.jsx",
  `  async function decodeBarcodeImage(file) {
    if (!("BarcodeDetector" in globalThis)) {
      throw new Error("Barcode scanning is not supported by this browser. Use a Chromium browser with BarcodeDetector support.");
    }
    const supported = typeof BarcodeDetector.getSupportedFormats === "function"
      ? await BarcodeDetector.getSupportedFormats()
      : [];
    const formats = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39", "itf", "codabar", "qr_code", "data_matrix"]
      .filter((format) => !supported.length || supported.includes(format));
    const detector = new BarcodeDetector(formats.length ? { formats } : undefined);
    const detected = await detector.detect(file);
    const raw = detected.find((item) => String(item?.rawValue || "").replace(/\\D/g, "").length >= 8)?.rawValue || detected[0]?.rawValue || "";
    const digits = String(raw).replace(/\\D/g, "");
    return [digits, digits.length === 12 ? `0${digits}` : ""].find((value) => /^(?:\\d{8}|\\d{12}|\\d{13}|\\d{14})$/.test(value)) || "";
  }

`,
  "",
  "remove browser barcode decoder",
);
replaceOnce(
  "frontend/src/pages/Scan.jsx",
  `    try {
      let extracted;
      let barcodeGtin = "";
      if (barcodeImage) {
        setMessage("Decoding dedicated barcode image for GTIN...");
        try {
          barcodeGtin = await decodeBarcodeImage(barcodeImage.file);
          setMessage(barcodeGtin
            ? \`Barcode decoded: GTIN \${barcodeGtin}. Running package OCR and DataKart verification...\`
            : "Barcode image could not be decoded. Continuing package analysis.");
        } catch (barcodeError) {
          setMessage(\`Barcode decoding unavailable: \${barcodeError.message}\`);
        }
      }
      try {
        const formData = new FormData();
        images.forEach(({ file }) => formData.append("images", file));
        if (barcodeImage) formData.append("barcodeImage", barcodeImage.file);
        if (barcodeGtin) formData.append("barcodeGtin", barcodeGtin);
        formData.append("categoryOptions", JSON.stringify(finalCategories.map((item) => ({ id: item.id, name: item.name, path: item.path.map((x) => x.name).join(" → ") }))));`,
  `    try {
      let extracted;
      try {
        const formData = new FormData();
        images.forEach(({ file }) => formData.append("images", file));
        if (barcodeImage) formData.append("barcodeImage", barcodeImage.file);
        formData.append("categoryOptions", JSON.stringify(finalCategories.map((item) => ({ id: item.id, name: item.name, path: item.path.map((x) => x.name).join(" → ") }))));`,
  "frontend barcode upload",
);

replaceOnce(
  "frontend/src/pages/Scan.jsx",
  'function verificationBadge(field) {',
  `function buildRulesEngineInput(result) {
  const allowed = [
    "productName", "brandName", "manufacturer", "manufacturerAddress", "packer", "packerAddress",
    "marketer", "marketerAddress", "importer", "importerAddress", "netQuantity", "unit", "mrp",
    "currency", "dateOfManufacture", "dateOfPacking", "bestBefore", "expiryDate", "batchNumber",
    "consumerCarePhone", "consumerCareEmail", "countryOfOrigin", "fssaiLicenseNumber",
  ];
  return Object.fromEntries(allowed.map((key) => {
    const field = result?.[key];
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
}

function verificationBadge(field) {`,
  "rules input helper",
);
replaceOnce(
  "frontend/src/pages/Scan.jsx",
  '      setMessage("OCR complete. Running Legal Metrology Rules Engine...");',
  '      setMessage("OCR complete. Running Legal Metrology Rules Engine on majority-vote package fields...");',
  "rules status",
);
replaceOnce(
  "frontend/src/pages/Scan.jsx",
  '          ocr: extracted,',
  '          ocr: buildRulesEngineInput(rapidData.ruleEngineInput || extracted),',
  "rules engine input",
);
replaceOnce(
  "frontend/src/pages/Scan.jsx",
  'ocr.dataKartVerification?.status === "REGISTERED" ? "#15803d" : ocr.dataKartVerification?.status === "NOT_FOUND" ? "#b91c1c" : "#a16207"',
  'ocr.dataKartVerification?.status === "REGISTERED" ? "#15803d" : ["NOT_FOUND", "NO_GTIN"].includes(ocr.dataKartVerification?.status) ? "#b91c1c" : "#a16207"',
  "DataKart color",
);
replaceOnce(
  "frontend/src/pages/Scan.jsx",
  '      {ocr.dataKartVerification?.status === "REGISTERED" ? "✓ Product found in DataKart" : ocr.dataKartVerification?.status === "NOT_FOUND" ? "✕ Product not found in DataKart" : ocr.dataKartVerification?.status === "UNAVAILABLE" ? "? DataKart could not be reached" : "✕ Product not detected in DataKart"}',
  '      {ocr.dataKartVerification?.message || "✕ Product not found in DataKart"}',
  "DataKart message UI",
);

const mrpInputPattern = /(<input value=\{value\.value \?\? ""\} placeholder=\{value\.status === "found" \? "Review value" : value\.status\} onChange=\{\(e\) => updateOcrField\(key, e\.target\.value\)\} \/>)/;
const scan = read("frontend/src/pages/Scan.jsx");
if (!mrpInputPattern.test(scan)) throw new Error("MRP input pattern not found");
write("frontend/src/pages/Scan.jsx", scan.replace(mrpInputPattern, '$1{key === "mrp" && value?.webMarketRange?.min != null && value?.webMarketRange?.max != null && ocr?.dataKartVerification?.status !== "REGISTERED" && <small style={{ display: "block", marginTop: 5, fontWeight: 700 }}>Web MRP range: ₹{value.webMarketRange.min}–₹{value.webMarketRange.max} <span style={{ fontWeight: 500 }}>(indicative only)</span></small>}'));

execFileSync("node", ["--check", "src/ocr/barcodeDecoder.js"], { cwd: path.join(root, "backend"), stdio: "inherit" });
execFileSync("node", ["--check", "src/ocr/evidenceConfidence.js"], { cwd: path.join(root, "backend"), stdio: "inherit" });
execFileSync("node", ["--check", "src/ocr/fastRoutes.js"], { cwd: path.join(root, "backend"), stdio: "inherit" });
execFileSync("node", ["--check", "src/ocr/marketPriceSearch.js"], { cwd: path.join(root, "backend"), stdio: "inherit" });
console.log("Local barcode/DataKart integration syntax checks passed.");
