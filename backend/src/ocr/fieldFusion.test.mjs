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

test("three independent sources agreeing on a field increase confidence", () => {
  const result = fuseFieldSources([
    source("gemini_image", "₹120", 0.86, "gemini"),
    source("gemini_ocr_normalization", "120", 0.84, "gemini"),
    source("deterministic_regex", "MRP ₹120", 0.80, "regex/raw-ocr"),
  ]).mrp;

  assert.equal(result.status, "found");
  assert.equal(result.value, "₹120");
  assert.equal(result.fusion.agreementCount, 3);
  assert.equal(result.verification, "agreement-3-sources");
  assert.equal(result.fusion.candidateSources.length, 3);
  assert.ok(result.confidence > 0.86);
});

test("strong Gemini data wins when regex disagrees", () => {
  const result = fuseFieldSources([
    source("gemini_image", "₹120", 0.91, "gemini"),
    source("gemini_ocr_normalization", "₹120", 0.88, "gemini"),
    source("deterministic_regex", "₹180", 0.99, "regex/raw-ocr"),
  ]).mrp;

  assert.equal(result.status, "found");
  assert.equal(result.value, "₹120");
  assert.equal(result.verification, "agreement-2-sources");
  assert.deepEqual(
    result.fusion.candidateSources.sort(),
    ["gemini-image", "gemini-ocr-normalization"],
  );
});

test("Gemini OCR normalization fills a missing field before regex", () => {
  const result = fuseFieldSources([
    source("gemini_ocr_normalization", "₹150", 0.72, "gemini"),
  ]).mrp;

  assert.equal(result.status, "found");
  assert.equal(result.value, "₹150");
  assert.equal(result.verification, "fallback-priority");
  assert.equal(result.fusion.fallbackUsed, true);
  assert.deepEqual(result.fusion.fallbackOrder, [
    "gemini_image",
    "gemini_ocr_normalization",
    "deterministic_regex",
  ]);
});

test("regex is the last fallback when Gemini sources have no field value", () => {
  const result = fuseFieldSources([
    source("gemini_image", null, 0, "gemini", { status: "absent" }),
    source("gemini_ocr_normalization", null, 0, "gemini", { status: "absent" }),
    source("deterministic_regex", "MRP ₹180", 0.70, "regex/raw-ocr"),
  ]).mrp;

  assert.equal(result.status, "found");
  assert.equal(result.value, "MRP ₹180");
  assert.equal(result.verification, "fallback-priority");
  assert.equal(result.fusion.winnerSource, "regex/raw-ocr");
});

test("close conflicting sources remain ambiguous", () => {
  const result = fuseFieldSources([
    source("gemini_image", "₹120", 0.72, "gemini"),
    source("deterministic_regex", "₹180", 0.88, "regex/raw-ocr"),
  ]).mrp;

  assert.equal(result.status, "ambiguous");
  assert.equal(result.value, null);
  assert.equal(result.verification, "conflicting-evidence");
});
