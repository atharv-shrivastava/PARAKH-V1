import type { Finding, InspectionRequest } from '../../domain/types.js';
import { SOURCES } from '../legal/sources.js';

const SOURCE = SOURCES.AMEND_2021_779E;
const EFFECTIVE_FROM = '2024-01-01';

function valueAt(input: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => value != null && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined, input);
}
function evidenceValue(r: InspectionRequest, ...fields: string[]): unknown {
  for (const field of fields) {
    const direct = valueAt(r, field);
    if (direct !== undefined) return direct;
    const item = r.evidence.find(e => e.field === field || e.field === field.replace(/^declarations\./, ''));
    if (item) return item.normalizedValue ?? item.rawValue;
  }
  return undefined;
}
function quantity(r: InspectionRequest): { value?: number; unit?: string } {
  const direct = valueAt(r, 'declarations.netQuantity');
  const measurement = r.measurements;
  const value = typeof direct === 'number' ? direct : measurement?.declaredQuantity;
  const unitValue = valueAt(r, 'declarations.netQuantityUnit');
  const unit = typeof unitValue === 'string' ? unitValue : measurement?.declaredUnit;
  return { value, unit };
}
function finding(status: Finding['status'], message: string, reason?: string, missingEvidence?: string[]): Finding {
  return { findingId:`PCR-R6-11-${status}`, ruleId:'PCR-R6-11', ruleCode:'PCR-R6-11-UNIT-SALE-PRICE', ruleNumber:'6(11)', ruleVersion:1, status, field:'declarations.unitSalePrice', message, violationReason:reason, missingEvidence, legalReferences:[SOURCE], severity:status === 'VIOLATION' ? 'CRITICAL' : 'HIGH', requiresLegalReview:false };
}
export function unitSalePriceFinding(r: InspectionRequest): Finding | undefined {
  if (r.inspectionDate.slice(0,10) < EFFECTIVE_FROM) return undefined;
  if (r.context !== 'physical_package' && r.context !== 'both') return undefined;

  const packageType = r.productMetadata.packageType;
  if (packageType === 'group' || packageType === 'combination' || packageType === 'multi_unit') return finding('OUT_OF_SCOPE', 'Unit sale price is not evaluated for group, combination or multi-piece packages under the applicable Rule 6(11) exception.');

  const { value, unit } = quantity(r);
  if (value === undefined || !unit) return finding('UNABLE_TO_VERIFY', 'The declared net quantity and unit are required to determine whether the Rule 6(11) unit-sale-price requirement applies.', undefined, ['declarations.netQuantity','declarations.netQuantityUnit']);

  const normalizedUnit = unit.toLowerCase();
  const requiresUnitSalePrice =
    (['kg','kilogram','kilograms'].includes(normalizedUnit) && value > 1) ||
    (['l','litre','liter','litres','liters'].includes(normalizedUnit) && value > 1);

  if (!requiresUnitSalePrice) return undefined;

  const declared = evidenceValue(r, 'declarations.unitSalePrice', 'unitSalePrice');
  const mrp = evidenceValue(r, 'declarations.retailSalePrice', 'transaction.mrp');

  if (declared === undefined) {
    const uspValue = evidenceValue(r, 'declarations.unitSalePriceValue');
    if (uspValue !== undefined && mrp !== undefined && String(uspValue).trim() === String(mrp).trim()) return finding('PASS', 'The unit sale price requirement is satisfied because the supplied unit-sale-price value equals the retail sale price.');
    return finding('VIOLATION', 'The applicable unit sale price declaration was not established by the inspection providers.', 'No provider established the required Rule 6(11) unit sale price.', ['declarations.unitSalePrice']);
  }
  if (typeof declared !== 'string' || declared.trim() === '') return finding('UNABLE_TO_VERIFY', 'The unit sale price declaration was detected but could not be interpreted reliably.', undefined, ['declarations.unitSalePrice']);

  const normalized = declared.toLowerCase().replace(/₹|rs\.?/g,'rs').replace(/\s+/g,' ').trim();
  let expected: RegExp;
  if (['kg','kilogram','kilograms'].includes(normalizedUnit)) expected = /per\s*kg\b|\/\s*kg\b/;
  else if (['l','litre','liter','litres','liters'].includes(normalizedUnit)) expected = /per\s*(litre|liter|l)\b|\/\s*(litre|liter|l)\b/;
  else return finding('UNABLE_TO_VERIFY', `The quantity unit “${unit}” is not mapped to a Rule 6(11) unit-sale-price basis.`, undefined, ['declarations.netQuantityUnit']);

  if (!expected.test(normalized)) return finding('VIOLATION', `The detected unit sale price does not use the prescribed basis for the declared quantity (${value} ${unit}).`, 'Rule 6(11) prescribes the unit basis according to the applicable quantity unit.');
  return finding('PASS', 'The unit sale price declaration uses a basis consistent with Rule 6(11) from 1 January 2024.');
}
