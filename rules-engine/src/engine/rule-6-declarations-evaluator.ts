import type { EvaluationStatus, Finding, InspectionRequest } from '../../domain/types.js';
import { SOURCES } from '../legal/sources.js';

const SOURCE = SOURCES.PRINCIPAL_2011;

type Requirement = {
  code: string;
  number: string;
  field: string;
  aliases?: string[];
  label: string;
  conditional?: (r: InspectionRequest) => boolean;
};

function path(input: unknown, key: string): unknown {
  return key.split('.').reduce<unknown>((v, p) => v != null && typeof v === 'object' ? (v as Record<string, unknown>)[p] : undefined, input);
}

function evidenceValue(r: InspectionRequest, fields: string[]): unknown {
  for (const field of fields) {
    const direct = path(r, field);
    if (direct !== undefined && direct !== null && String(direct).trim() !== '') return direct;
    const e = r.evidence.find(x => x.field === field || x.field === field.replace(/^declarations\./, ''));
    if (e?.normalizedValue !== undefined && e.normalizedValue !== null) return e.normalizedValue;
    if (e?.rawValue !== undefined && e.rawValue !== null) return e.rawValue;
  }
  return undefined;
}

function explicitMissing(r: InspectionRequest, fields: string[]): boolean {
  return fields.some(field => path(r, field) === false || path(r, field) === null);
}

function finding(code: string, number: string, status: EvaluationStatus, field: string, message: string, reason?: string, missing?: string[]): Finding {
  return {
    findingId: `${code}-${status}`,
    ruleId: code,
    ruleCode: code,
    ruleNumber: number,
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

const REQUIREMENTS: Requirement[] = [
  {
    code: 'PCR-R6-1-A', number: '6(1)(a)', field: 'declarations.manufacturerPackerImporter',
    aliases: ['declarations.manufacturerOrPacker', 'declarations.manufacturerNameAddress', 'declarations.packerNameAddress', 'declarations.importerNameAddress'],
    label: 'manufacturer/packer/importer name and complete address',
  },
  {
    code: 'PCR-R6-1-B', number: '6(1)(b)', field: 'declarations.commonGenericName',
    aliases: ['declarations.commonOrGenericName', 'declarations.productName', 'productMetadata.commonGenericName'],
    label: 'common or generic name of the commodity',
  },
  {
    code: 'PCR-R6-1-C', number: '6(1)(c)', field: 'declarations.netQuantity',
    aliases: ['measurements.netQuantity', 'declarations.quantityText'],
    label: 'net quantity in the prescribed unit or number',
  },
  {
    code: 'PCR-R6-1-D', number: '6(1)(d)', field: 'declarations.dateOfManufacturePackingImport',
    aliases: ['declarations.manufactureOrImportDate', 'declarations.manufactureDate', 'declarations.packingDate', 'declarations.importDate'],
    label: 'month and year of manufacture, pre-packing or import',
  },
  {
    code: 'PCR-R6-1-E', number: '6(1)(e)', field: 'declarations.retailSalePrice',
    aliases: ['transaction.mrp'],
    label: 'retail sale price',
  },
  {
    code: 'PCR-R6-1-F', number: '6(1)(f)', field: 'declarations.dimensions',
    aliases: ['productMetadata.dimensions'],
    label: 'dimensions where the dimensions of the commodity are relevant',
    conditional: r => r.productMetadata.dimensionsRelevant === true,
  },
  {
    code: 'PCR-R6-1-G', number: '6(1)(g)', field: 'declarations.otherRequiredParticulars',
    aliases: ['declarations.otherParticulars'],
    label: 'other particulars required by the rules',
    conditional: r => path(r, 'declarations.otherRequiredParticularsRequired') === true || path(r, 'declarations.otherParticularsRequired') === true || Boolean(evidenceValue(r, ['declarations.otherRequiredParticularsApplicable', 'declarations.otherParticularsApplicable'])),
  },
  {
    code: 'PCR-R6-2', number: '6(2)', field: 'declarations.consumerComplaintContact',
    aliases: ['declarations.consumerCare', 'declarations.consumerComplaintNameAddressPhoneEmail'],
    label: 'name, address, telephone number and email address, if available, for consumer complaints',
    conditional: r => r.context !== 'ecommerce_listing',
  },
];

function consumerContactFinding(r: InspectionRequest): Finding {
  const explicit = path(r, 'declarations.consumerComplaintContact');
  if (explicit === false || explicit === null) {
    return finding('PCR-R6-2', '6(2)', 'VIOLATION', 'declarations.consumerComplaintContact', 'The supplied inspection evidence explicitly indicates that the consumer-complaint contact declaration is missing.', 'Rule 6(2) requires the name, address and telephone number of the person/office that can be contacted for consumer complaints, with email address where available.');
  }

  const name = evidenceValue(r, ['declarations.consumerComplaintName', 'declarations.consumerCareName']);
  const address = evidenceValue(r, ['declarations.consumerComplaintAddress', 'declarations.consumerCareAddress']);
  const phone = evidenceValue(r, ['declarations.consumerComplaintPhone', 'declarations.consumerCarePhone']);
  const email = evidenceValue(r, ['declarations.consumerComplaintEmail', 'declarations.consumerCareEmail']);

  const hasName = name !== undefined && String(name).trim() !== '';
  const hasAddress = address !== undefined && String(address).trim() !== '';
  const hasPhone = phone !== undefined && String(phone).trim() !== '';
  const hasEmail = email !== undefined && String(email).trim() !== '';

  if (hasName && hasAddress && hasPhone) {
    return finding('PCR-R6-2', '6(2)', 'PASS', 'declarations.consumerComplaintContact', hasEmail
      ? 'Consumer complaint contact name, address, telephone and email evidence were supplied.'
      : 'Consumer complaint contact name, address and telephone evidence were supplied; no email address was established as available.');
  }

  const missing: string[] = [];
  if (!hasName) missing.push('declarations.consumerComplaintName');
  if (!hasAddress) missing.push('declarations.consumerComplaintAddress');
  if (!hasPhone) missing.push('declarations.consumerComplaintPhone');

  return finding(
    'PCR-R6-2',
    '6(2)',
    'UNABLE_TO_VERIFY',
    'declarations.consumerComplaintContact',
    'Consumer-care phone/email evidence alone does not establish the complete Rule 6(2) contact declaration. Inspector verification of the contact name/address/telephone is required; email is checked when available.',
    undefined,
    missing,
  );
}

export function rule6DeclarationsFindings(r: InspectionRequest): Finding[] {
  const findings: Finding[] = [];
  for (const req of REQUIREMENTS) {
    if (req.code === 'PCR-R6-2') {
      if (req.conditional && !req.conditional(r)) continue;
      findings.push(consumerContactFinding(r));
      continue;
    }
    if (req.conditional && !req.conditional(r)) continue;
    const fields = [req.field, ...(req.aliases ?? [])];
    const value = evidenceValue(r, fields);
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      findings.push(finding(req.code, req.number, 'PASS', req.field, `Evidence was supplied for the required ${req.label}.`));
      continue;
    }
    if (explicitMissing(r, fields)) {
      findings.push(finding(req.code, req.number, 'VIOLATION', req.field, `The supplied inspection evidence explicitly indicates that the required ${req.label} is missing.`, `Rule ${req.number} requires the applicable declaration to be made on the package.`));
      continue;
    }
    findings.push(finding(req.code, req.number, 'UNABLE_TO_VERIFY', req.field, `The required ${req.label} was not supplied as evidence; absence of evidence is not treated as proof that the declaration is absent.`, undefined, fields));
  }
  return findings;
}