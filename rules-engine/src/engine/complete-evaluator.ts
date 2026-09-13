import { createHash } from 'node:crypto';
import type { EvaluationStatus, InspectionRequest, OverallInspectionResult, RuleDefinition } from '../../domain/types.js';
import { evaluateInspectionComplete as evaluateSpecializedInspection } from './legal-dealer-rules.js';
import { evaluateInspection as evaluateConfiguredRules } from './evaluator.js';
import { unitSalePriceFinding } from './unit-sale-price-evaluator.js';

const MIN_USABLE_FIELD_CONFIDENCE = 0.30;
const AUTHORITATIVE_SPECIALIZED_RULES = new Set(['PCR-R6-2']);

function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map(k => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
}

function summarize(findings: OverallInspectionResult['findings']) {
  return {
    totalRulesEvaluated: findings.length,
    passed: findings.filter(f => f.status === 'PASS').length,
    violations: findings.filter(f => f.status === 'VIOLATION').length,
    unableToVerify: findings.filter(f => f.status === 'UNABLE_TO_VERIFY').length,
    notApplicable: findings.filter(f => f.status === 'NOT_APPLICABLE').length,
  };
}

function evidenceForFinding(request: InspectionRequest, field: string) {
  return (request.evidence ?? []).filter((item) => item.field === field || item.field === field.replace(/^declarations\./, '') || field === 'declarations.dateOfManufacturePackingImport' && item.field === 'declarations.manufactureOrImportDate' || field === 'declarations.dateOfManufacturePackingImport' && item.field === 'declarations.dateOfPacking' || field === 'declarations.dateOfManufacturePackingImport' && item.field === 'declarations.dateOfManufacture');
}

function normalizeMissingDeclarationFindings(request: InspectionRequest, findings: OverallInspectionResult['findings']): OverallInspectionResult['findings'] {
  return findings.map((finding) => {
    if (finding.status !== 'UNABLE_TO_VERIFY') return finding;
    const field = String(finding.field ?? '');
    if (field.startsWith('visual.') || field.startsWith('rule23.') || AUTHORITATIVE_SPECIALIZED_RULES.has(finding.ruleId)) return finding;
    if (!field.startsWith('declarations.')) return finding;
    const evidence = evidenceForFinding(request, field);
    if (evidence.length > 0) return finding;
    return {
      ...finding,
      status: 'VIOLATION',
      violationReason: finding.violationReason ?? 'The required declaration was not established by OCR, Gemini or Grok evidence.',
      message: 'The required declaration was not established by the combined OCR, Gemini and Grok inspection evidence.',
    };
  });
}

function normalizePopulatedFieldFindings(request: InspectionRequest, findings: OverallInspectionResult['findings']): OverallInspectionResult['findings'] {
  return findings.map((finding) => {
    if (finding.status !== 'UNABLE_TO_VERIFY') return finding;
    if (String(finding.field ?? '').startsWith('visual.') || String(finding.field ?? '').startsWith('rule23.')) return finding;
    if (AUTHORITATIVE_SPECIALIZED_RULES.has(finding.ruleId)) return finding;
    const evidence = evidenceForFinding(request, String(finding.field ?? ''));
    const usableEvidence = evidence.filter((item) => item.normalizedValue !== undefined && item.normalizedValue !== null && String(item.normalizedValue).trim() !== '' && Number(item.confidence || 0) >= MIN_USABLE_FIELD_CONFIDENCE);
    if (!usableEvidence.length) return finding;
    return { ...finding, status: 'PASS', violationReason: undefined, message: 'Requirement satisfied from populated provider evidence.', evidenceUsed: usableEvidence, missingEvidence: [] };
  });
}

export function evaluateInspectionCompleteWithCurrentRules(r: InspectionRequest, rules?: RuleDefinition[]): OverallInspectionResult {
  const specialized = evaluateSpecializedInspection(r);
  const configured = rules?.length ? evaluateConfiguredRules(r, rules) : null;
  const configuredIds = new Set((rules ?? []).map(rule => rule.ruleId));
  const authoritativeSpecialized = specialized.findings.filter(f => AUTHORITATIVE_SPECIALIZED_RULES.has(f.ruleId));
  const specializedWithoutConfiguredDuplicates = specialized.findings.filter(f => !configuredIds.has(f.ruleId) && !AUTHORITATIVE_SPECIALIZED_RULES.has(f.ruleId));
  const configuredWithoutAuthoritativeDuplicates = configured?.findings.filter(f => !AUTHORITATIVE_SPECIALIZED_RULES.has(f.ruleId)) ?? [];
  const findings = [...specializedWithoutConfiguredDuplicates, ...authoritativeSpecialized, ...configuredWithoutAuthoritativeDuplicates];

  const unitSalePrice = unitSalePriceFinding(r);
  if (unitSalePrice && !findings.some(f => f.findingId === unitSalePrice.findingId)) findings.push(unitSalePrice);

  const normalizedFindings = normalizePopulatedFieldFindings(r, normalizeMissingDeclarationFindings(r, findings));
  const summary = summarize(normalizedFindings);
  const overallStatus: EvaluationStatus = summary.violations > 0 ? 'VIOLATION' : summary.unableToVerify > 0 ? 'UNABLE_TO_VERIFY' : summary.passed > 0 ? 'PASS' : 'NOT_APPLICABLE';
  const result = { ...specialized, overallStatus, summary, findings: normalizedFindings, ruleSetVersion: configured ? `DB-${new Date().toISOString().slice(0, 10)}` : specialized.ruleSetVersion };
  return { ...result, auditHash: createHash('sha256').update(canonical(result)).digest('hex') };
}
