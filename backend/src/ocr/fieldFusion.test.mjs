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

test("Gemini and regex agreeing increases field confidence", () => {
  const result = fuseFieldSources([
    source("gemini_image", "₹120", 0.86, "gemini"),
    source("deterministic_regex", "MRP ₹120", 0.80, "regex/raw-ocr"),
  ]).mrp;

  assert.equal(result.status, "found");
  assert.equal(result.value, "₹120");
  assert.equal(result.verification, "agreement-2-sources");
  assert.deepEqual(result.fusion.candidateSources, ["gemini-image", "regex/raw-ocr"]);
  assert.ok(result.confidence > 0.86);
});

test("high-confidence Gemini visual extraction wins an OCR disagreement", () => {
  const result = fuseFieldSources([
    source("gemini_image", "₹120", 0.91, "gemini"),
    source("deterministic_regex", "MRP ₹180", 0.99, "regex/raw-ocr"),
  ]).mrp;

  assert.equal(result.status, "found");
  assert.equal(result.value, "₹120");
  assert.equal(result.verification, "gemini-visual-priority-conflict-with-ocr");
  assert.equal(result.fusion.conflict, true);
});

test("low-confidence Gemini versus conflicting OCR stays ambiguous", () => {
  const result = fuseFieldSources([
    source("gemini_image", "₹120", 0.61, "gemini"),
    source("deterministic_regex", "MRP ₹180", 0.88, "regex/raw-ocr"),
  ]).mrp;

  assert.equal(result.status, "ambiguous");
  assert.equal(result.value, null);
  assert.equal(result.verification, "conflicting-evidence");
});

test("Gemini fills a missing OCR field", () => {
  const result = fuseFieldSources([
    source("gemini_image", "₹150", 0.72, "gemini"),
    source("deterministic_regex", null, 0, "regex/raw-ocr", { status: "absent" }),
  ]).mrp;

  assert.equal(result.status, "found");
  assert.equal(result.value, "₹150");
  assert.equal(result.verification, "gemini-visual-extraction");
  assert.equal(result.fusion.winnerSource, "gemini-image");
});

test("regex is the fallback when Gemini has no usable value", () => {
  const result = fuseFieldSources([
    source("gemini_image", null, 0, "gemini", { status: "absent" }),
    source("deterministic_regex", "MRP ₹180", 0.70, "regex/raw-ocr"),
  ]).mrp;

  assert.equal(result.status, "found");
  assert.equal(result.value, "MRP ₹180");
  assert.equal(result.verification, "regex-fallback-no-gemini-value");
  assert.equal(result.fusion.fallbackUsed, true);
});

test("empty sources remain absent", () => {
  const result = fuseFieldSources([
    source("gemini_image", null, 0, "gemini", { status: "absent" }),
    source("deterministic_regex", null, 0, "regex/raw-ocr", { status: "absent" }),
  ]).mrp;

  assert.equal(result.status, "absent");
  assert.equal(result.value, null);
});
