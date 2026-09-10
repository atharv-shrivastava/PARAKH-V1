import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const scanPath = path.resolve(here, "../src/pages/ScanV2.jsx");
let source = await fs.readFile(scanPath, "utf8");

const VERIFICATION_STATES = [
  ["barcodeFile", "setBarcodeFile", "null"],
  ["barcodePreviewUrl", "setBarcodePreviewUrl", '""'],
  ["manualGtin", "setManualGtin", '""'],
  ["barcodeResult", "setBarcodeResult", "null"],
  ["datakartVerification", "setDatakartVerification", "null"],
  ["verificationConfidence", "setVerificationConfidence", "null"],
];

// ScanV2 has evolved over several generated integrations. Before Vite parses it,
// collapse accidental duplicate verification state declarations to one canonical copy.
function dedupeState(name, setter, initialValue) {
  const declaration = new RegExp(
    `^[ \\t]*const\\s*\\[${name}\\s*,\\s*${setter}\\]\\s*=\\s*useState\\(\\s*${initialValue.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\s*\\);?[ \\t]*\\r?\\n?`,
    "gm"
  );
  const matches = [...source.matchAll(declaration)];
  if (matches.length <= 1) return;
  let seen = false;
  source = source.replace(declaration, (match) => {
    if (!seen) {
      seen = true;
      return match;
    }
    return "";
  });
}

for (const [name, setter, initialValue] of VERIFICATION_STATES) {
  dedupeState(name, setter, initialValue);
}

// Remove accidental duplicate copies of the generated integration marker.
source = source.replace(/(?:\r?\n)?\/\* PARAKH_SCAN_V2_INTEGRATION \*\/(?:\r?\n)?/g, "\n");
source = source.replace(/\n{3,}/g, "\n\n").trimEnd();
source += "\n\n/* PARAKH_SCAN_V2_INTEGRATION */\n";

await fs.writeFile(scanPath, source, "utf8");
console.log("PARAKH Scan V2 preparation complete: duplicate verification state declarations normalized.");
