import { createHash } from 'node:crypto';
import type {
  EvaluationStatus,
  Finding,
  InspectionRequest,
  OverallInspectionResult,
} from '../../domain/types.js';
import { evaluateInspection as evaluateBase } from './evaluator.js';
import { RULES } from '../legal/rules.js';
import { SOURCES } from '../legal/sources.js';
import { secondScheduleAppliesOn } from '../legal/second-schedule.js';
import { tableIIFinding } from './table-ii-evaluator.js';
import { unitSalePriceFinding } from './unit-sale-price-evaluator.js';
import { ecommerceCountryOriginFinding } from './ecommerce-country-origin-evaluator.js';
import { rule6DeclarationsFindings } from './rule-6-declarations-evaluator.js';
import { rules14To17Findings } from './rules-14-17-evaluator.js';
import { rule31AdvertisementFindings } from './rule-31-advertisement-evaluator.js';
import { rules32To34Findings } from './rules-32-34-evaluator.js';
import { sixthScheduleFindings } from './sixth-schedule-evaluator.js';
import { rules29To30Findings } from './rules-29-30-evaluator.js';
import { unverifiedRuleFindings } from '../legal/rule-review-status.js';
import { rule20Findings } from './rule-20-evaluator.js';

const SOURCE = SOURCES.PRINCIPAL_2011;

const SPECIALIZED_RULE_IDS = new Set([
  'PCR-R6-1-A', 'PCR-R6-1-B', 'PCR-R6-1-C', 'PCR-R6-1-D',
  'PCR-R6-1-E', 'PCR-R6-1-F', 'PCR-R6-1-G', 'PCR-R6-2', 'PCR-R12-6',
]);
const SPECIALIZED_RULE_NUMBERS = new Set([
  '6(1)(a)', '6(1)(b)', '6(1)(c)', '6(1)(d)', '6(1)(e)', '6(1)(f)', '6(1)(g)', '6(2)', '12(6)',
]);
const CONFIGURED_RULES_WITHOUT_SPECIALIZED_DUPLICATES = RULES.filter(rule =>
  !SPECIALIZED_RULE_IDS.has(rule.ruleId) && !SPECIALIZED_RULE_NUMBERS.has(String(rule.ruleNumber ?? '').trim()),
);

function path(input: unknown, key: string): unknown {
  return key.split('.').reduce<unknown>((value, part) => {
    if (value == null || typeof value !== 'object') return undefined;
    return (value as Record<string, unknown>)[part];
  }, input);
}

function evidenceValue(request: InspectionRequest, field: string): unknown {
  const direct = path(request, field);
  if (direct !== undefined) return direct;

  const evidence = request.evidence.find(
    (item) => item.field === field || item.field === field.replace(/^declarations\./, ''),
  );

  return evidence?.normalizedValue ?? evidence?.rawValue;
}

function currencyNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return undefined;

  const parsed = Number(value.replace(/₹|rs\.?/gi, '').trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}

function finding(
  id: string,
  code: string,
  ruleNumber: string,
  status: EvaluationStatus,
  field: string,
  message: string,
  reason?: string,
  missing?: string[],
): Finding {
  return {
    findingId: id,
    ruleId: code,
    ruleCode: code,
    ruleNumber,
    ruleVersion: 1,
    status,
    field,
    message,
    violationReason: reason,
    missingEvidence: missing,
    legalReferences: [SOURCE],
    severity: status === 'VIOLATION' ? 'CRITICAL' : 'HIGH',
    requiresLegalReview: false,
  };
}

const THIRD_SCHEDULE_KEYWORDS = ['soap', 'lotion', 'cream', 'camphor'];

const QUANTITY_AMBIGUITY_PATTERNS = [
  /\bapproximately\b/i,
  /\bapprox\.?\b/i,
  /\babout\b/i,
  /\baround\b/i,
  /\broughly\b/i,
  /\bnearly\b/i,
  /\bmore\s+or\s+less\b/i,
  /\bup\s+to\b/i,
];

const COUNT_WORDS = [
  'number',
  'unit',
  'piece',
  'pieces',
  'pair',
  'pairs',
  'set',
  'sets',
];

function rule11(request: InspectionRequest): Finding[] {
  const findings: Finding[] = [];
  const packaging = request.packaging;

  if (!packaging) return findings;

  if (packaging.netQuantityExcludesPackaging === false) {
    findings.push(
      finding(
        'PCR-R11-NET',
        'PCR-R11-1',
        '11(1)',
        'VIOLATION',
        'packaging.netQuantityExcludesPackaging',
        'The measured net quantity is not confirmed to exclude wrappers or other packaging material.',
        'Rule 11(1) requires net quantity to exclude wrappers or other packaging material.',
      ),
    );
  } else if (packaging.netQuantityExcludesPackaging === undefined && request.measurements) {
    findings.push(
      finding(
        'PCR-R11-NET-UNVERIFIED',
        'PCR-R11-1',
        '11(1)',
        'UNABLE_TO_VERIFY',
        'packaging.netQuantityExcludesPackaging',
        'Packaging exclusion was not established by the supplied evidence.',
        undefined,
        ['packaging.netQuantityExcludesPackaging'],
      ),
    );
  }

  const variation = packaging.environmentalVariation;
  const qualification = (packaging.quantityQualification ?? '').trim().toLowerCase();
  const whenPacked = qualification === 'when packed';

  if (variation === 'NONE' || variation === 'NEGLIGIBLE') {
    if (whenPacked) {
      findings.push(
        finding(
          'PCR-R11-QUALIFICATION',
          'PCR-R11-2',
          '11(2)-(3)',
          'VIOLATION',
          'packaging.quantityQualification',
          'The declaration uses “when packed” although the supplied variation classification does not permit that qualification.',
          'Rule 11(2)-(3) does not permit the “when packed” qualification for commodities with no or negligible environmental variation.',
        ),
      );
    } else if (variation === 'NEGLIGIBLE' && !request.measurements) {
      findings.push(
        finding(
          'PCR-R11-VARIATION-MEASURE',
          'PCR-R11-3',
          '11(3)',
          'UNABLE_TO_VERIFY',
          'measurements',
          'Negligible environmental variation was identified, but no quantity measurement was supplied to establish that the consumer receives not less than the declared quantity.',
          undefined,
          ['measurements'],
        ),
      );
    }
  } else if (variation === 'SIGNIFICANT' && whenPacked) {
    const commodity = request.productMetadata.commodityCategory.toLowerCase();
    const allowed = THIRD_SCHEDULE_KEYWORDS.some((keyword) => commodity.includes(keyword));

    if (!allowed) {
      findings.push(
        finding(
          'PCR-R11-THIRD-SCHEDULE',
          'PCR-R11-4',
          '11(4)',
          'VIOLATION',
          'packaging.quantityQualification',
          '“When packed” is used for a commodity not identified in the configured Third Schedule set.',
          'Rule 11(4) permits the qualification only for commodities specified in the Third Schedule.',
        ),
      );
    } else {
      findings.push(
        finding(
          'PCR-R11-THIRD-SCHEDULE-PASS',
          'PCR-R11-4',
          '11(4)',
          'PASS',
          'packaging.quantityQualification',
          'The “when packed” qualification is supported by the supplied significant-variation and Third Schedule evidence.',
        ),
      );
    }
  } else if (variation === 'UNKNOWN' || variation === undefined) {
    if (whenPacked || request.measurements) {
      findings.push(
        finding(
          'PCR-R11-VARIATION',
          'PCR-R11-VARIATION',
          '11',
          'UNABLE_TO_VERIFY',
          'packaging.environmentalVariation',
          'Environmental variation classification is required to determine the legally applicable Rule 11 quantity declaration treatment.',
          undefined,
          ['packaging.environmentalVariation'],
        ),
      );
    }
  }

  return findings;
}

function rule12_6(request: InspectionRequest): Finding[] {
  const raw =
    evidenceValue(request, 'declarations.quantityText') ??
    evidenceValue(request, 'quantityDeclarationText') ??
    evidenceValue(request, 'declarations.netQuantityText');

  if (raw === undefined || raw === null || String(raw).trim() === '') return [];

  const text = String(raw).trim();

  if (QUANTITY_AMBIGUITY_PATTERNS.some((pattern) => pattern.test(text))) {
    return [
      finding(
        'PCR-R12-6-VIOLATION',
        'PCR-R12-6',
        '12(6)',
        'VIOLATION',
        'declarations.quantityText',
        `The quantity declaration contains an expression that can create an exaggerated, misleading or inadequate expression as to quantity: “${text}”.`,
        'Rule 12(6) prohibits words or expressions that tend to create or are likely to create an exaggerated, misleading or inadequate expression as to quantity.',
      ),
    ];
  }

  return [
    finding(
      'PCR-R12-6-PASS',
      'PCR-R12-6',
      '12(6)',
      'PASS',
      'declarations.quantityText',
      'No configured misleading quantity-expression pattern was detected in the supplied quantity declaration.',
    ),
  ];
}

function rule13_5_ii(request: InspectionRequest): Finding[] {
  const soldByNumber =
    evidenceValue(request, 'productMetadata.soldByNumber') ??
    evidenceValue(request, 'soldByNumber') ??
    evidenceValue(request, 'declarations.soldByNumber');

  const soldByNumberBoolean = soldByNumber === true || String(soldByNumber).toLowerCase() === 'true';
  if (!soldByNumberBoolean) return [];

  const raw =
    evidenceValue(request, 'declarations.quantityText') ??
    evidenceValue(request, 'quantityDeclarationText') ??
    evidenceValue(request, 'declarations.netQuantityText');

  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return [
      finding(
        'PCR-R13-5-II-UNVERIFIED',
        'PCR-R13-5-II',
        '13(5)(ii)',
        'UNABLE_TO_VERIFY',
        'declarations.quantityText',
        'The package is identified as an item sold by number, but the quantity declaration text was not supplied.',
        undefined,
        ['declarations.quantityText'],
      ),
    ];
  }

  const text = String(raw).trim();
  const hasNumber = /\d/.test(text);
  const hasCountWord = COUNT_WORDS.some((word) => new RegExp('\\b' + word + '\\b', 'i').test(text));

  if (!hasNumber) {
    return [
      finding(
        'PCR-R13-5-II-VIOLATION',
        'PCR-R13-5-II',
        '13(5)(ii)',
        'VIOLATION',
        'declarations.quantityText',
        `The quantity declaration “${text}” does not state a numerical quantity for an item sold by number.`,
        'Rule 13(5)(ii) requires the number, unit, piece, pair, set or another word representing the quantity to be mentioned.',
      ),
    ];
  }

  if (!hasCountWord) {
    return [
      finding(
        'PCR-R13-5-II-UNVERIFIED',
        'PCR-R13-5-II',
        '13(5)(ii)',
        'UNABLE_TO_VERIFY',
        'declarations.quantityText',
        `The numerical declaration “${text}” does not contain a recognised number/unit/piece/pair/set quantity word; another legally valid quantity word may be present and requires verification.`,
        undefined,
        ['declarations.quantityUnitWord'],
      ),
    ];
  }

  return [
    finding(
      'PCR-R13-5-II-PASS',
      'PCR-R13-5-II',
      '13(5)(ii)',
      'PASS',
      'declarations.quantityText',
      'The item is sold by number and the quantity declaration contains a numerical quantity with a recognised number/unit/piece/pair/set word.',
    ),
  ];
}

function rule18(request: InspectionRequest): Finding[] {
  const findings: Finding[] = [];
  const hasTransactionEvidence =
    request.transaction !== undefined || evidenceValue(request, 'transaction.salePrice') !== undefined;

  if (!hasTransactionEvidence) return findings;

  const sale = currencyNumber(evidenceValue(request, 'transaction.salePrice'));
  const mrp = currencyNumber(
    evidenceValue(request, 'declarations.retailSalePrice') ??
      evidenceValue(request, 'transaction.mrp'),
  );

  if (sale === undefined) {
    findings.push(
      finding(
        'PCR-R18-2-UNVERIFIED',
        'PCR-R18-2',
        '18(2)',
        'UNABLE_TO_VERIFY',
        'transaction.salePrice',
        'The actual sale price was not supplied, so compliance with the MRP ceiling cannot be verified.',
        undefined,
        ['transaction.salePrice'],
      ),
    );
  } else if (mrp === undefined) {
    findings.push(
      finding(
        'PCR-R18-2-MRP-UNVERIFIED',
        'PCR-R18-2',
        '18(2)',
        'UNABLE_TO_VERIFY',
        'declarations.retailSalePrice',
        'The applicable retail sale price declaration was not supplied, so the sale-price ceiling cannot be verified.',
        undefined,
        ['declarations.retailSalePrice'],
      ),
    );
  } else if (sale > mrp) {
    findings.push(
      finding(
        'PCR-R18-2-VIOLATION',
        'PCR-R18-2',
        '18(2)',
        'VIOLATION',
        'transaction.salePrice',
        `The sale price (${sale}) exceeds the declared retail sale price (${mrp}).`,
        'Rule 18(2) prohibits sale of a packaged commodity above its retail sale price.',
      ),
    );
  } else {
    findings.push(
      finding(
        'PCR-R18-2-PASS',
        'PCR-R18-2',
        '18(2)',
        'PASS',
        'transaction.salePrice',
        `The sale price (${sale}) does not exceed the declared retail sale price (${mrp}).`,
      ),
    );
  }

  const conflict = request.transaction?.identicalPackagePriceConflict;

  if (conflict === true) {
    findings.push(
      finding(
        'PCR-R18-2A-VIOLATION',
        'PCR-R18-2A',
        '18(2A)',
        'VIOLATION',
        'transaction.identicalPackagePriceConflict',
        'Identical pre-packaged commodities were supplied with different MRPs through the inspected pricing evidence.',
        'Rule 18(2A) prohibits declaring different MRPs on identical pre-packaged commodities through restrictive or unfair trade practices, subject to the rule and applicable law.',
      ),
    );
  } else if (conflict === false) {
    findings.push(
      finding(
        'PCR-R18-2A-PASS',
        'PCR-R18-2A',
        '18(2A)',
        'PASS',
        'transaction.identicalPackagePriceConflict',
        'No conflicting MRP evidence was identified for the identical packages in the supplied inspection evidence.',
      ),
    );
  } else {
    findings.push(
      finding(
        'PCR-R18-2A-UNVERIFIED',
        'PCR-R18-2A',
        '18(2A)',
        'UNABLE_TO_VERIFY',
        'transaction.identicalPackagePriceConflict',
        'No evidence was supplied to determine whether identical pre-packaged commodities carry different MRPs.',
        undefined,
        ['transaction.identicalPackagePriceConflict'],
      ),
    );
  }

  return findings;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;

  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
    .join(',')}}`;
}

export function evaluateInspectionComplete(request: InspectionRequest): OverallInspectionResult {
  const base = evaluateBase(request, CONFIGURED_RULES_WITHOUT_SPECIALIZED_DUPLICATES);

  const historicalFindings = secondScheduleAppliesOn(request.inspectionDate)
    ? base.findings
    : base.findings.filter((item) => item.ruleCode !== 'PCR-R5-SCHEDULE-II');

  const tableII = tableIIFinding(request);
  const unitSalePrice = unitSalePriceFinding(request);
  const ecommerceCountryOrigin = ecommerceCountryOriginFinding(request);
  const rule6 = rule6DeclarationsFindings(request);
  const rules14To17 = rules14To17Findings(request);
  const rule31 = rule31AdvertisementFindings(request);
  const rules32To34 = rules32To34Findings(request);
  const sixthSchedule = sixthScheduleFindings(request);
  const rules29To30 = rules29To30Findings(request);
  const legalReview = unverifiedRuleFindings(request);
  const rule20 = rule20Findings(request);

  const addedFindings = [
    ...rule6,
    ...rule11(request),
    ...rule12_6(request),
    ...rule13_5_ii(request),
    ...rule18(request),
    ...rules14To17,
    ...rule31,
    ...rules29To30,
    ...rule20,
    ...rules32To34,
    ...sixthSchedule,
    ...legalReview,
  ];

  if (tableII) addedFindings.push(tableII);
  if (unitSalePrice) addedFindings.push(unitSalePrice);
  if (ecommerceCountryOrigin) addedFindings.push(ecommerceCountryOrigin);

  const findings = [...historicalFindings, ...addedFindings];

  const summary = {
    totalRulesEvaluated: findings.length,
    passed: findings.filter((item) => item.status === 'PASS').length,
    violations: findings.filter((item) => item.status === 'VIOLATION').length,
    unableToVerify: findings.filter((item) => item.status === 'UNABLE_TO_VERIFY').length,
    notApplicable: findings.filter((item) => item.status === 'NOT_APPLICABLE').length,
  };

  const overallStatus: EvaluationStatus =
    summary.violations > 0
      ? 'VIOLATION'
      : summary.unableToVerify > 0
        ? 'UNABLE_TO_VERIFY'
        : summary.passed > 0
          ? 'PASS'
          : 'NOT_APPLICABLE';

  const result = {
    ...base,
    overallStatus,
    summary,
    findings,
  };

  return {
    ...result,
    auditHash: createHash('sha256').update(canonical(result)).digest('hex'),
  };
}
