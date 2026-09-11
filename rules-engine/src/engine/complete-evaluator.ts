import { createHash } from 'node:crypto';
import type { EvaluationStatus, InspectionRequest, OverallInspectionResult, RuleDefinition } from '../../domain/types.js';
import { evaluateInspectionComplete as evaluateSpecializedInspection } from './legal-dealer-rules.js';
import { evaluateInspection as evaluateConfiguredRules } from './evaluator.js';
import { unitSalePriceFinding } from './unit-sale-price-evaluator.js';

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

function normalizeMissingEvidenceViolations(
  findings: OverallInspectionResult['findings'],
): OverallInspectionResult['findings'] {
  return findings.map((finding) => {
    const missingEvidence = Array.isArray(finding.missingEvidence) ? finding.missingEvidence : [];
    const evidenceUsed = Array.isArray(finding.evidenceUsed) ? finding.evidenceUsed : [];
    const message = String(finding.message ?? '').toLowerCase();

    // A generic EXISTS/VALID_* rule must not turn missing or low-confidence
    // evidence into a legal violation. A violation requires actual evidence
    // of non-compliance or an explicit inspector-recorded missing declaration.
    const isAutoMissingEvidenceFinding = finding.status === 'VIOLATION'
      && missingEvidence.length > 0
      && evidenceUsed.length === 0
      && /not established|could not be verified|could not be established/.test(message);

    if (!isAutoMissingEvidenceFinding) return finding;

    return {
      ...finding,
      status: 'UNABLE_TO_VERIFY',
      message: 'The required declaration could not be established from the submitted evidence. This is not proof that the declaration is absent; inspector verification is required.',
    };
  });
}

export function evaluateInspectionCompleteWithCurrentRules(
  r: InspectionRequest,
  rules?: RuleDefinition[],
): OverallInspectionResult {
  const specialized = evaluateSpecializedInspection(r);
  const configured = rules?.length ? evaluateConfiguredRules(r, rules) : null;
  const configuredIds = new Set((rules ?? []).map(rule => rule.ruleId));

  // Database-managed rule definitions replace the generic rule layer. The
  // specialized evaluators remain for advanced checks whose rule IDs are not
  // represented in the configurable rule catalog.
  const findings = configured
    ? [
        ...specialized.findings.filter(f => !configuredIds.has(f.ruleId)),
        ...configured.findings,
      ]
    : specialized.findings;

  const unitSalePrice = unitSalePriceFinding(r);
  if (unitSalePrice && !findings.some(f => f.findingId === unitSalePrice.findingId)) {
    findings.push(unitSalePrice);
  }

  const normalizedFindings = normalizeMissingEvidenceViolations(findings);
  const summary = summarize(normalizedFindings);
  const overallStatus: EvaluationStatus = summary.violations > 0
    ? 'VIOLATION'
    : summary.unableToVerify > 0
      ? 'UNABLE_TO_VERIFY'
      : summary.passed > 0
        ? 'PASS'
        : 'NOT_APPLICABLE';

  const result = {
    ...specialized,
    overallStatus,
    summary,
    findings: normalizedFindings,
    ruleSetVersion: configured ? `DB-${new Date().toISOString().slice(0, 10)}` : specialized.ruleSetVersion,
  };

  return { ...result, auditHash: createHash('sha256').update(canonical(result)).digest('hex') };
}
