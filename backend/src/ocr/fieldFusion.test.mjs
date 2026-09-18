import test from "node:test";
import assert from "node:assert/strict";
import { fuseFieldSources } from "./fieldFusion.js";

function source(sourceKind, value, confidenceValue, provider, extra = {}) {
  return {
    enabled: true,
    provider,
    sourceKind,
    fields: {
      mrp: {
        value,
        displayValue: value,
        raw: value,
        evidence: value,
        confidence: confidenceValue,
        status: "found",
        ...extra,
      },
    },
  };
}

test("agreed independent sources increase confidence and preserve provenance", () => {
  const result = fuseFieldSources([
    source("gemini_image", "₹120", 0.86, "gemini"),
    source("gemini_ocr_normalization", "120", 0.84, "gemini"),
    source("deterministic_regex", "MRP ₹120", 0.80, "regex/raw-ocr"),
  ]).mrp;

  assert.equal(result.status, "found");
  assert.equal(result.value, "₹120");
  assert.equal(result.fusion.agreementCount, 3);
  assert.equal(result.verification, "agreement-3-sources");
  assert.ok(result.confidence > 0.86);
});

test("strong semantic evidence is not overwritten by regex disagreement", () => {
  const result = fuseFieldSources([
    source("gemini_image", "₹120", 0.91, "gemini"),
    source("gemini_ocr_normalization", "₹120", 0.88, "gemini"),
    source("deterministic_regex", "₹180", 0.99, "regex/raw-ocr"),
  ]).mrp;

  assert.equal(result.status, "found");
  assert.equal(result.value, "₹120");
  assert.deepEqual(result.fusion.candidateSources.sort(), ["gemini-image", "gemini-ocr-normalization"]);
});

test("close conflicting evidence is marked ambiguous", () => {
  const result = fuseFieldSources([
    source("gemini_image", "₹120", 0.72, "gemini"),
    source("deterministic_regex", "₹180", 0.88, "regex/raw-ocr"),
  ]).mrp;

  assert.equal(result.status, "ambiguous");
  assert.equal(result.value, null);
  assert.equal(result.verification, "conflicting-evidence");
});
