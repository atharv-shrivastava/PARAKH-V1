import { createHash } from 'node:crypto';
import type { EvaluationStatus, InspectionRequest, OverallInspectionResult, RuleDefinition } from '../../domain/types.js';
import { evaluateInspectionComplete as evaluateSpecializedInspection } from './legal-dealer-rules.js';
import { evaluateInspection as evaluateConfiguredRules } from './evaluator.js';
import { unitSalePriceFinding } from './unit-sale-price-evaluator.js';

const AUTHORITATIVE_SPECIALIZED_RULES = new Set([
  'PCR-R6-1-A',
  'PCR-R6-1-B',
  'PCR-R6-1-C',
  'PCR-R6-1-D',
  'PCR-R6-1-E',
  'PCR-R6-1-F',
  'PCR-R6-1-G',
  'PCR-R6-2',
]);

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
    outOfScope: findings.filter(f => f.status === 'OUT_OF_SCOPE').length,
  };
}

function evidenceForFinding(request: InspectionRequest, field: string) {
  return (request.evidence ?? []).filter(item =>
    item.field === field ||
    item.field === field.replace(/^declarations\./, '') ||
    (field === 'declarations.dateOfManufacturePackingImport' && item.field === 'declarations.manufactureOrImportDate') ||
    (field === 'declarations.dateOfManufacturePackingImport' && item.field === 'declarations.dateOfPacking') ||
    (field === 'declarations.dateOfManufacturePackingImport' && item.field === 'declarations.dateOfManufacture')
  );
}

function attachAuditEvidence(request: InspectionRequest, findings: OverallInspectionResult['findings']) {
  return findings.map(finding => {
    if (finding.status !== 'PASS' || finding.evidenceUsed?.length) return finding;
    const evidence = evidenceForFinding(request, String(finding.field ?? ''));
    return evidence.length ? { ...finding, evidenceUsed: evidence } : finding;
  });
}

export function evaluateInspectionCompleteWithCurrentRulesV2(r: InspectionRequest, rules?: RuleDefinition[]): OverallInspectionResult {
  const specialized = evaluateSpecializedInspection(r);
  const configured = rules?.length ? evaluateConfiguredRules(r, rules) : null;
  const configuredIds = new Set((rules ?? []).map(rule => rule.ruleId));

  const isAuthoritative = (finding: { ruleId: string; ruleCode: string }) =>
    AUTHORITATIVE_SPECIALIZED_RULES.has(finding.ruleId) ||
    AUTHORITATIVE_SPECIALIZED_RULES.has(finding.ruleCode);

  const specializedAuthoritative = specialized.findings.filter(isAuthoritative);
  const specializedOther = specialized.findings.filter(
    f => !configuredIds.has(f.ruleId) && !isAuthoritative(f),
  );
  const configuredOther = configured?.findings.filter(f => !isAuthoritative(f)) ?? [];

  const findings = [...specializedOther, ...specializedAuthoritative, ...configuredOther];
  const unitSalePrice = unitSalePriceFinding(r);
  if (unitSalePrice && !findings.some(f => f.findingId === unitSalePrice.findingId)) findings.push(unitSalePrice);

  const finalFindings = attachAuditEvidence(r, findings);
  const summary = summarize(finalFindings);
  const overallStatus: EvaluationStatus = summary.violations > 0
    ? 'VIOLATION'
    : summary.unableToVerify > 0
      ? 'UNABLE_TO_VERIFY'
      : summary.passed > 0
        ? 'PASS'
        : summary.outOfScope > 0
          ? 'OUT_OF_SCOPE'
          : 'NOT_APPLICABLE';

  const result = {
    ...specialized,
    overallStatus,
    summary,
    findings: finalFindings,
    ruleSetVersion: configured ? `DB-${new Date().toISOString().slice(0, 10)}` : specialized.ruleSetVersion,
  };

  return { ...result, auditHash: createHash('sha256').update(canonical(result)).digest('hex') };
}
