from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def text(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def write(path: str, value: str) -> None:
    (ROOT / path).write_text(value, encoding="utf-8")


def replace_once(path: str, old: str, new: str, label: str) -> None:
    value = text(path)
    if old not in value:
        raise RuntimeError(f"{label}: pattern not found")
    write(path, value.replace(old, new, 1))


# Install local ZXing-C++/WASM barcode reader into the backend.
subprocess.run(["npm", "install", "zxing-wasm@3.1.3", "--save"], cwd=ROOT / "backend", check=True)

# Local barcode decoder: dedicated barcode image -> GTIN.
write("backend/src/ocr/barcodeDecoder.js", r'''import { readFileSync } from "node:fs";
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
  const digits = String(value ?? "").replace(/\D/g, "");
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
''')

# Backend: use the dedicated barcode file and never trust a browser-supplied GTIN.
replace_once(
    "backend/src/ocr/fastRoutes.js",
    'import { applyEvidenceConfidence } from "./evidenceConfidence.js";\n',
    'import { applyEvidenceConfidence } from "./evidenceConfidence.js";\nimport { decodeBarcodeImage } from "./barcodeDecoder.js";\n',
    "decoder import",
)
replace_once(
    "backend/src/ocr/fastRoutes.js",
    '    const barcodeImageProvided = Boolean(barcodeFile);\n    const submittedBarcode = String(req.body?.barcodeGtin || "").replace(/\\D/g, "").trim();\n    const uploadMs = Date.now() - startedAt;',
    '    const barcodeImageProvided = Boolean(barcodeFile);\n    const uploadMs = Date.now() - startedAt;',
    "remove submitted barcode",
)
replace_once(
    "backend/src/ocr/fastRoutes.js",
    '''    const rapidStart = Date.now();
    const rapid = await analyzeWithRapid(images);
    const rapidMs = Date.now() - rapidStart;''',
    '''    const rapidStart = Date.now();
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
    const decodedBarcode = String(barcodeDecode?.gtin || "").replace(/\\D/g, "").trim() || null;''',
    "parallel barcode decode",
)
replace_once(
    "backend/src/ocr/fastRoutes.js",
    '''    const structuredResult = buildStructuredResult(rapid, aiSemantic);
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
    const result = await applyEvidenceConfidence(structuredResult, { barcodeImageProvided });''',
    '''    const structuredResult = buildStructuredResult(rapid, aiSemantic);
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
    const result = await applyEvidenceConfidence(structuredResult, { barcodeImageProvided });''',
    "majority vote and rules input",
)
replace_once(
    "backend/src/ocr/fastRoutes.js",
    '`[ocr:fast] images=${files.length} evidence=${rapid.evidence.length} rapid=${rapidMs}ms `',
    '`[ocr:fast] images=${files.length} barcodeImage=${barcodeImageProvided ? "yes" : "no"} gtin=${decodedBarcode || "none"} barcode=${barcodeMs}ms evidence=${rapid.evidence.length} rapid=${rapidMs}ms `',
    "barcode logging",
)
replace_once(
    "backend/src/ocr/fastRoutes.js",
    '''      result,
      provider: "rapidocr",''',
    '''      result,
      majorityVote: majorityVoteResult,
      ruleEngineInput,
      barcode: {
        provided: barcodeImageProvided,
        gtin: decodedBarcode,
        decoder: barcodeDecode?.decoder || "NOT_PROVIDED",
        attempts: barcodeDecode?.attempts || 0,
        error: barcodeDecode?.error || null,
      },
      provider: "rapidocr",''',
    "barcode response metadata",
)
replace_once(
    "backend/src/ocr/fastRoutes.js",
    'timing: { uploadMs, rapidMs, semanticMs, geminiMs:',
    'timing: { uploadMs, rapidMs, barcodeMs, semanticMs, geminiMs:',
    "barcode timing",
)

# Evidence: DataKart compares against the consensus result; web fallback is MRP only.
replace_once(
    "backend/src/ocr/evidenceConfidence.js",
    'const FIELD_MAP = {',
    'import { searchMrpRange } from "./marketPriceSearch.js";\n\nconst FIELD_MAP = {',
    "MRP import",
)
replace_once(
    "backend/src/ocr/evidenceConfidence.js",
    '  let dataKartError = null;\n  const geminiAvailable',
    '  let dataKartError = null;\n  let webMrpRange = null;\n  const geminiAvailable',
    "MRP state",
)
replace_once(
    "backend/src/ocr/evidenceConfidence.js",
    '''  if (barcode) {
    try {
      dataKart = await fetchDataKartByGtin(barcode);
    } catch (error) {
      dataKartError = error?.message || "DataKart lookup failed.";
    }
  }

  const details = {};''',
    '''  if (barcode) {
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

  const details = {};''',
    "MRP fallback lookup",
)
replace_once(
    "backend/src/ocr/evidenceConfidence.js",
    '''    next[fieldKey] = {
      ...fieldValue,
      confidence:''',
    '''    next[fieldKey] = {
      ...fieldValue,
      ...(fieldKey === "mrp" && webMrpRange?.min != null && webMrpRange?.max != null ? { webMarketRange: webMrpRange } : {}),
      confidence:''',
    "MRP range field",
)
replace_once(
    "backend/src/ocr/evidenceConfidence.js",
    '''    dataKartAvailable: Boolean(dataKart),
    dataKartError,
    fields: details,''',
    '''    dataKartAvailable: Boolean(dataKart),
    dataKartError,
    webMrpRange,
    fields: details,''',
    "MRP range metadata",
)
replace_once(
    "backend/src/ocr/evidenceConfidence.js",
    '  const dataKartStatus = dataKart ? "REGISTERED" : dataKartError ? "UNAVAILABLE" : barcode ? "NOT_FOUND" : "NO_GTIN";',
    '  const dataKartStatus = dataKart ? "REGISTERED" : dataKartError ? "UNAVAILABLE" : barcodeImageProvided && !barcode ? "BARCODE_UNREADABLE" : barcode ? "NOT_FOUND" : "NO_GTIN";',
    "barcode unreadable status",
)
replace_once(
    "backend/src/ocr/evidenceConfidence.js",
    '  const dataKartMessage = dataKart ? "✓ Product found in DataKart" : dataKartError ? "? DataKart could not be reached" : barcode ? "✕ Product not found in DataKart" : "? Product could not be checked: no GTIN detected";',
    '  const dataKartMessage = dataKart ? "✓ Product found in DataKart" : dataKartError ? "? DataKart could not be reached" : dataKartStatus === "BARCODE_UNREADABLE" ? "? Barcode could not be decoded" : "✕ Product not found in DataKart";',
    "DataKart message",
)

write("backend/src/ocr/marketPriceSearch.js", r'''const USER_AGENT = "PARAKH-V1/1.0";

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function extractPrices(text) {
  const source = String(text ?? "");
  const values = [];
  const patterns = [
    /(?:mrp|m\.r\.p\.?|maximum retail price)[^₹\d]{0,20}₹\s*([0-9]{1,6}(?:\.[0-9]{1,2})?)/gi,
    /₹\s*([0-9]{1,6}(?:\.[0-9]{1,2})?)/g,
    /(?:rs\.?|inr)[\s:.-]*([0-9]{1,6}(?:\.[0-9]{1,2})?)/gi,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const value = Number(match[1]);
      if (Number.isFinite(value) && value >= 10 && value <= 10000) values.push(value);
    }
  }
  return values;
}

async function searchEngine(query) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const response = await fetch(url, {
    headers: { "user-agent": USER_AGENT, accept: "text/html" },
    signal: AbortSignal.timeout(6000),
  });
  if (!response.ok) throw new Error(`Web search returned HTTP ${response.status}`);
  return response.text();
}

export async function searchMrpRange({ productName, brandName, netQuantity, unit }) {
  const product = clean(productName);
  const brand = clean(brandName);
  const quantity = [clean(netQuantity), clean(unit)].filter(Boolean).join(" ");
  if (!product && !brand) return { status: "NO_QUERY" };

  const queries = [
    [brand, product, quantity].filter(Boolean).join(" "),
    [product, quantity, "MRP"].filter(Boolean).join(" "),
  ];
  const prices = [];
  const successfulQueries = [];
  for (const query of queries) {
    try {
      prices.push(...extractPrices(await searchEngine(query)));
      successfulQueries.push(query);
    } catch (error) {
      console.warn("[Web MRP]", query, error?.message || error);
    }
  }
  const unique = [...new Set(prices)].sort((a, b) => a - b);
  if (!unique.length) return { status: "NOT_FOUND", queries: successfulQueries };
  return {
    status: "FOUND",
    min: unique[0],
    max: unique[unique.length - 1],
    currency: "INR",
    label: `₹${unique[0]}–₹${unique[unique.length - 1]}`,
    queries: successfulQueries,
    disclaimer: "Indicative web MRP range; not used by the Rules Engine and not a legal MRP determination.",
  };
}
''')

# Frontend: remove browser BarcodeDetector. The backend owns the local decode.
scan = text("frontend/src/pages/Scan.jsx")
scan, removed = re.subn(
    r'\n  async function decodeBarcodeImage\(file\) \{.*?\n  \}\n\n(?=  async function openCamera)',
    "\n",
    scan,
    count=1,
    flags=re.S,
)
if removed != 1:
    raise RuntimeError("browser BarcodeDetector function not found")
old_block = re.compile(
    r'''    try \{\n      let extracted;\n      let barcodeGtin = "";\n      if \(barcodeImage\) \{.*?      try \{\n        const formData = new FormData\(\);\n        images\.forEach\(\(\{ file \}\) => formData\.append\("images", file\)\);\n        if \(barcodeImage\) formData\.append\("barcodeImage", barcodeImage\.file\);\n        if \(barcodeGtin\) formData\.append\("barcodeGtin", barcodeGtin\);\n        formData\.append\("categoryOptions", JSON\.stringify\(finalCategories\.map\(\(item\) => \(\{ id: item\.id, name: item\.name, path: item\.path\.map\(\(x\) => x\.name\)\.join\(" → "\) \}\)\)\)\);''',
    flags=re.S,
)
scan, replaced = old_block.subn(
    '''    try {
      let extracted;
      try {
        const formData = new FormData();
        images.forEach(({ file }) => formData.append("images", file));
        if (barcodeImage) formData.append("barcodeImage", barcodeImage.file);
        formData.append("categoryOptions", JSON.stringify(finalCategories.map((item) => ({ id: item.id, name: item.name, path: item.path.map((x) => x.name).join(" → ") }))));''',
    scan,
    count=1,
)
if replaced != 1:
    raise RuntimeError("frontend barcode analyze block not found")

if "function buildRulesEngineInput(result)" not in scan:
    helper = '''function buildRulesEngineInput(result) {
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

'''
    if "function verificationBadge(field) {" not in scan:
        raise RuntimeError("verification badge marker not found")
    scan = scan.replace("function verificationBadge(field) {", helper + "function verificationBadge(field) {", 1)

scan = scan.replace(
    '      setMessage("OCR complete. Running Legal Metrology Rules Engine...");',
    '      setMessage("OCR complete. Running Legal Metrology Rules Engine on majority-vote package fields...");',
    1,
)
scan = scan.replace(
    '          ocr: extracted,',
    '          ocr: buildRulesEngineInput(rapidData.ruleEngineInput || extracted),',
    1,
)
scan = scan.replace(
    '      {ocr.dataKartVerification?.status === "REGISTERED" ? "✓ Product found in DataKart" : ocr.dataKartVerification?.status === "NOT_FOUND" ? "✕ Product not found in DataKart" : ocr.dataKartVerification?.status === "UNAVAILABLE" ? "? DataKart could not be reached" : "✕ Product not detected in DataKart"}',
    '      {ocr.dataKartVerification?.message || "✕ Product not found in DataKart"}',
    1,
)

# Add the web MRP range directly beneath the editable MRP field without changing its value.
mrp_pattern = re.compile(
    r'(<input value=\{value\.value \?\? ""\} placeholder=\{value\.status === "found" \? "Review value" : value\.status\} onChange=\{\(e\) => updateOcrField\(key, e\.target\.value\)\} />)'
)
scan, mrp_count = mrp_pattern.subn(
    r'\1{key === "mrp" && value?.webMarketRange?.min != null && value?.webMarketRange?.max != null && ocr?.dataKartVerification?.status !== "REGISTERED" && <small style={{ display: "block", marginTop: 5, fontWeight: 700 }}>Web MRP range: ₹{value.webMarketRange.min}–₹{value.webMarketRange.max} <span style={{ fontWeight: 500 }}>(indicative only)</span></small>}',
    scan,
    count=1,
)
if mrp_count != 1:
    raise RuntimeError("MRP input UI marker not found")

write("frontend/src/pages/Scan.jsx", scan)

# Remove all temporary integration machinery from the final repository state.
for temp in [
    ".github/workflows/integrate-local-barcode.yml",
    ".github/workflows/install-local-barcode-reader.yml",
    ".github/workflows/one-shot-barcode-datakart.yml",
    ".github/workflows/barcode-datakart-finalize.yml",
    ".github/run-local-barcode.txt",
    "scripts/integrate_local_barcode.mjs",
    "scripts/integrate_local_barcode.py",
]:
    p = ROOT / temp
    if p.exists():
        p.unlink()

# Restore the normal CI workflow so the integration job is truly one-shot.
write(".github/workflows/app-ci.yml", '''name: PARAKH App CI

on:
  push:
    branches:
      - main
      - 'rules-engine/**'
  pull_request:
    paths:
      - 'frontend/**'
      - 'backend/**'
      - '.github/workflows/app-ci.yml'

jobs:
  frontend:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: frontend
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
          cache-dependency-path: frontend/package-lock.json
      - run: npm ci
      - run: npm run build

  backend:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: backend
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
          cache-dependency-path: backend/package-lock.json
      - run: npm ci
      - run: npx prisma generate
''')

# Static checks before commit.
checks = [
    ["node", "--check", "src/ocr/barcodeDecoder.js"],
    ["node", "--check", "src/ocr/evidenceConfidence.js"],
    ["node", "--check", "src/ocr/fastRoutes.js"],
    ["node", "--check", "src/ocr/marketPriceSearch.js"],
]
for command in checks:
    subprocess.run(command, cwd=ROOT / "backend", check=True)

# Validate the installed WASM decoder can initialize in Node.
subprocess.run(
    ["node", "--input-type=module", "-e", "import('./src/ocr/barcodeDecoder.js').then(() => console.log('ZXing local decoder import OK'))"],
    cwd=ROOT / "backend",
    check=True,
)

print("Local barcode/DataKart integration completed and validated.")
