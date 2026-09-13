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

function normalizeMissingEvidenceViolations(findings: OverallInspectionResult['findings']): OverallInspectionResult['findings'] {
  return findings.map((finding) => {
    const evidenceUsed = Array.isArray(finding.evidenceUsed) ? finding.evidenceUsed : [];
    const message = String(finding.message ?? '').toLowerCase();
    const reason = String(finding.violationReason ?? '').toLowerCase();
    const describesUnverifiedEvidence = /not established|could not be verified|could not be established|was not supplied as evidence/.test(`${message} ${reason}`);
    const isAutoMissingEvidenceFinding = finding.status === 'VIOLATION' && evidenceUsed.length === 0 && describesUnverifiedEvidence;
    if (!isAutoMissingEvidenceFinding) return finding;
    return { ...finding, status: 'UNABLE_TO_VERIFY', violationReason: undefined, message: 'The required declaration could not be established from the submitted evidence. This is not proof that the declaration is absent; inspector verification is required.' };
  });
}

function evidenceForFinding(request: InspectionRequest, field: string) {
  return (request.evidence ?? []).filter((item) => item.field === field || item.field === field.replace(/^declarations\./, '') || field === 'declarations.dateOfManufacturePackingImport' && item.field === 'declarations.manufactureOrImportDate' || field === 'declarations.dateOfManufacturePackingImport' && item.field === 'declarations.dateOfPacking' || field === 'declarations.dateOfManufacturePackingImport' && item.field === 'declarations.dateOfManufacture');
}

function normalizePopulatedFieldFindings(request: InspectionRequest, findings: OverallInspectionResult['findings']): OverallInspectionResult['findings'] {
  return findings.map((finding) => {
    if (finding.status !== 'UNABLE_TO_VERIFY') return finding;
    if (String(finding.field ?? '').startsWith('visual.') || String(finding.field ?? '').startsWith('rule23.')) return finding;
    if (AUTHORITATIVE_SPECIALIZED_RULES.has(finding.ruleId)) return finding;
    const evidence = evidenceForFinding(request, String(finding.field ?? ''));
    const usableEvidence = evidence.filter((item) => item.normalizedValue !== undefined && item.normalizedValue !== null && String(item.normalizedValue).trim() !== '' && Number(item.confidence || 0) >= MIN_USABLE_FIELD_CONFIDENCE);
    if (!usableEvidence.length) return finding;
    return { ...finding, status: 'PASS', violationReason: undefined, message: 'Requirement satisfied from a populated declaration field. The officer may still review the extracted value before final submission.', evidenceUsed: usableEvidence, missingEvidence: [] };
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

  const normalizedFindings = normalizePopulatedFieldFindings(r, normalizeMissingEvidenceViolations(findings));
  const summary = summarize(normalizedFindings);
  const overallStatus: EvaluationStatus = summary.violations > 0 ? 'VIOLATION' : summary.unableToVerify > 0 ? 'UNABLE_TO_VERIFY' : summary.passed > 0 ? 'PASS' : 'NOT_APPLICABLE';
  const result = { ...specialized, overallStatus, summary, findings: normalizedFindings, ruleSetVersion: configured ? `DB-${new Date().toISOString().slice(0, 10)}` : specialized.ruleSetVersion };
  return { ...result, auditHash: createHash('sha256').update(canonical(result)).digest('hex') };
}