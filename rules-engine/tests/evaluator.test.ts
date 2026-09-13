import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateInspection } from '../src/engine/evaluator.js';
import type { InspectionRequest } from '../domain/types.js';

const base = (overrides: Partial<InspectionRequest> = {}): InspectionRequest => ({
  inspectionId: 'insp-001', productId: 'prod-001', inspectionDate: '2026-09-02', context: 'physical_package',
  productMetadata: { commodityCategory: 'food', consumerType: 'general', isImported: false, packageType: 'retail' },
  evidence: [
    { evidenceId: 'e1', field: 'declarations.manufacturerOrPacker', rawValue: 'Example Foods, Bhopal', confidence: 0.99, source: 'OCR', timestamp: '2026-09-02T10:00:00Z' },
    { evidenceId: 'e2', field: 'declarations.commonOrGenericName', rawValue: 'Potato Chips', confidence: 0.99, source: 'OCR', timestamp: '2026-09-02T10:00:00Z' },
    { evidenceId: 'e3', field: 'declarations.netQuantity', rawValue: '50 g', normalizedValue: 50, unit: 'g', confidence: 0.99, source: 'OCR', timestamp: '2026-09-02T10:00:00Z' },
    { evidenceId: 'e4', field: 'declarations.netQuantityUnit', rawValue: 'g', normalizedValue: 'g', confidence: 0.99, source: 'OCR', timestamp: '2026-09-02T10:00:00Z' },
    { evidenceId: 'e5', field: 'declarations.manufactureOrImportDate', rawValue: '08/2026', confidence: 0.98, source: 'OCR', timestamp: '2026-09-02T10:00:00Z' },
    { evidenceId: 'e6', field: 'declarations.retailSalePrice', rawValue: '₹20', normalizedValue: '₹20', confidence: 0.99, source: 'OCR', timestamp: '2026-09-02T10:00:00Z' },
    { evidenceId: 'e7', field: 'declarations.consumerComplaintContact', rawValue: 'Example Foods helpline', confidence: 0.98, source: 'OCR', timestamp: '2026-09-02T10:00:00Z' },
    { evidenceId: 'e8', field: 'declarations.completeAddress', rawValue: 'Bhopal, Madhya Pradesh', confidence: 0.99, source: 'OCR', timestamp: '2026-09-02T10:00:00Z' }
  ],
  visualFlags: {
    'visual.stickerCompliance': true,
    'visual.declarationLegibility': true,
    'visual.principalDisplayPanel': true,
    'visual.legibility': true,
    'declarations.quantityExpression': true
  },
  ...overrides
});

test('passes a well-supported core declaration set', () => {
  const result = evaluateInspection(base());
  assert.equal(result.overallStatus, 'PASS');
  assert.equal(result.auditHash.length, 64);
  assert.equal(result.summary.violations, 0);
});

test('missing evidence becomes a violation when a required declaration is absent from all providers', () => {
  const request = base({ evidence: base().evidence.filter(e => e.field !== 'declarations.retailSalePrice') });
  const result = evaluateInspection(request);
  const mrp = result.findings.find(f => f.ruleCode === 'PCR-R6-1-E-MRP');
  assert.equal(mrp?.status, 'VIOLATION');
});

test('present declaration evidence is accepted without value-format enforcement', () => {
  const request = base({ evidence: base().evidence.map(e => e.field === 'declarations.retailSalePrice' ? { ...e, rawValue: 'free', normalizedValue: 'free' } : e) });
  const result = evaluateInspection(request);
  const mrp = result.findings.find(f => f.ruleCode === 'PCR-R6-1-E-MRP');
  assert.equal(mrp?.status, 'PASS');
});

test('unresolved evidence conflict blocks a legal conclusion', () => {
  const request = base({ evidenceConflicts: [{ conflictId: 'c1', field: 'declarations.netQuantity', evidenceIds: ['e3','e9'], description: 'Two OCR values disagree.', status: 'UNRESOLVED' }] });
  const result = evaluateInspection(request);
  const net = result.findings.find(f => f.ruleCode === 'PCR-R6-1-C-NET-QUANTITY');
  assert.equal(net?.status, 'UNABLE_TO_VERIFY');
});

test('2026 e-commerce country-of-origin rule is selected by inspection date', () => {
  const request = base({ inspectionDate: '2026-08-01', context: 'ecommerce_listing', productMetadata: { commodityCategory: 'electronics', consumerType: 'general', isImported: true, packageType: 'retail' }, visualFlags: { 'ecommerce.countryOfOriginFilter': true } });
  const result = evaluateInspection(request);
  const f = result.findings.find(x => x.ruleCode === 'PCR-R6-10A-COUNTRY-OF-ORIGIN-FILTER');
  assert.equal(f?.status, 'PASS');
  assert.equal(f?.ruleVersion, 1);
});

test('industrial consumer is excluded from Chapter II gate', () => {
  const result = evaluateInspection(base({ productMetadata: { commodityCategory: 'food', consumerType: 'industrial', packageType: 'retail' } }));
  const f = result.findings.find(x => x.ruleCode === 'PCR-R3-APPLICABILITY');
  assert.equal(f?.status, 'NOT_APPLICABLE');
});

test('audit hash is deterministic', () => {
  const a = evaluateInspection(base());
  const b = evaluateInspection(base());
  assert.equal(a.auditHash, b.auditHash);
});
