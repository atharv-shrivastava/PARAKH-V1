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
  return key.split('.').reduce((v, p) => v != null && typeof v === 'object' ? (v as Record<string, unknown>)[p] : undefined, input);
}

function present(value: unknown): boolean {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

function evidenceValue(r: InspectionRequest, fields: string[]): unknown {
  for (const field of fields) {
    const direct = path(r, field);
    if (present(direct)) return direct;

    const stripped = field.replace(/^declarations\./, '');
    const evidence = r.evidence.find(x => x.field === field || x.field === stripped);
    if (present(evidence?.normalizedValue)) return evidence?.normalizedValue;
    if (present(evidence?.rawValue)) return evidence?.rawValue;
  }
  return undefined;
}

function finding(
  code: string,
  number: string,
  status: EvaluationStatus,
  field: string,
  message: string,
  reason?: string,
  missing?: string[],
): Finding {
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
    aliases: [
      'declarations.manufacturerOrPacker', 'declarations.manufacturerNameAddress',
      'declarations.packerNameAddress', 'declarations.importerNameAddress',
      'declarations.manufacturer', 'declarations.packer', 'declarations.importer',
      'manufacturer', 'packer', 'importer',
    ],
    label: 'manufacturer/packer/importer name and complete address',
  },
  {
    code: 'PCR-R6-1-B', number: '6(1)(b)', field: 'declarations.commonGenericName',
    aliases: [
      'declarations.commonOrGenericName', 'declarations.productName',
      'productMetadata.commonGenericName', 'productName',
    ],
    label: 'common or generic name of the commodity',
  },
  {
    code: 'PCR-R6-1-C', number: '6(1)(c)', field: 'declarations.netQuantity',
    aliases: [
      'measurements.netQuantity', 'declarations.quantityText', 'declarations.netQuantityText',
      'netQuantity',
    ],
    label: 'net quantity in the prescribed unit or number',
  },
  {
    code: 'PCR-R6-1-D', number: '6(1)(d)', field: 'declarations.dateOfManufacturePackingImport',
    aliases: [
      'declarations.manufactureOrImportDate', 'declarations.manufactureDate',
      'declarations.packingDate', 'declarations.importDate', 'declarations.dateOfManufacture',
      'declarations.dateOfPacking', 'declarations.dateOfPrePacking', 'declarations.dateOfImport',
      'dateOfManufacture', 'dateOfPacking',
    ],
    label: 'month and year of manufacture, pre-packing or import',
  },
  {
    code: 'PCR-R6-1-E', number: '6(1)(e)', field: 'declarations.retailSalePrice',
    aliases: [
      'transaction.mrp', 'declarations.mrp', 'mrp', 'retailSalePrice',
      'declarations.retailPrice', 'transaction.retailSalePrice',
    ],
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
    conditional: r => path(r, 'declarations.otherRequiredParticularsRequired') === true
      || path(r, 'declarations.otherParticularsRequired') === true
      || Boolean(evidenceValue(r, ['declarations.otherRequiredParticularsApplicable', 'declarations.otherParticularsApplicable'])),
  },
  {
    code: 'PCR-R6-2', number: '6(2)', field: 'declarations.consumerComplaintContact',
    aliases: [
      'declarations.consumerCare', 'declarations.consumerComplaintNameAddressPhoneEmail',
      'declarations.consumerCarePhone', 'declarations.consumerCareEmail',
      'consumerCarePhone', 'consumerCareEmail',
    ],
    label: 'consumer complaint contact declaration',
    conditional: r => r.context !== 'ecommerce_listing',
  },
];

function manufacturerFinding(r: InspectionRequest): Finding {
  const identity = evidenceValue(r, [
    'declarations.manufacturerName', 'declarations.packerName', 'declarations.importerName',
    'declarations.manufacturerOrPacker', 'declarations.manufacturer', 'manufacturer', 'packer', 'importer',
  ]);
  const address = evidenceValue(r, [
    'declarations.completeAddress', 'declarations.manufacturerAddress',
    'declarations.packerAddress', 'declarations.importerAddress',
    'manufacturerAddress', 'packerAddress', 'importerAddress',
  ]);

  const hasIdentity = present(identity);
  const hasAddress = present(address);

  if (hasIdentity && hasAddress) {
    return finding('PCR-R6-1-A', '6(1)(a)', 'PASS', 'declarations.manufacturerPackerImporter', 'Manufacturer/packer/importer identity and address evidence were established.');
  }

  const missing: string[] = [];
  if (!hasIdentity) missing.push('declarations.manufacturerName');
  if (!hasAddress) missing.push('declarations.completeAddress');
  return finding(
    'PCR-R6-1-A',
    '6(1)(a)',
    'UNABLE_TO_VERIFY',
    'declarations.manufacturerPackerImporter',
    'The automated inspection did not reliably establish both responsible-entity identity and complete address. Officer verification is required.',
    undefined,
    missing,
  );
}

function consumerContactFinding(r: InspectionRequest): Finding {
  const explicit = path(r, 'declarations.consumerComplaintContact');
  if (explicit === false) {
    return finding('PCR-R6-2', '6(2)', 'VIOLATION', 'declarations.consumerComplaintContact', 'The supplied evidence explicitly indicates that the consumer-complaint contact declaration is missing.', 'The inspection evidence explicitly records the required contact declaration as absent.');
  }

  const name = evidenceValue(r, ['declarations.consumerComplaintName', 'declarations.consumerCareName']);
  const address = evidenceValue(r, ['declarations.consumerComplaintAddress', 'declarations.consumerCareAddress']);
  const phone = evidenceValue(r, ['declarations.consumerComplaintPhone', 'declarations.consumerCarePhone', 'consumerCarePhone']);
  const email = evidenceValue(r, ['declarations.consumerComplaintEmail', 'declarations.consumerCareEmail', 'consumerCareEmail']);
  const combined = evidenceValue(r, ['declarations.consumerComplaintContact', 'declarations.consumerCare', 'declarations.consumerComplaintNameAddressPhoneEmail']);

  const hasEntity = [name, address].some(present) || (present(combined) && /consumer|care|complaint|helpline|customer/i.test(String(combined)));
  const hasMethod = [phone, email].some(present) || (present(combined) && /@|\+?\d[\d\s().-]{6,}/.test(String(combined)));

  if (hasEntity && hasMethod) {
    return finding('PCR-R6-2', '6(2)', 'PASS', 'declarations.consumerComplaintContact', 'Consumer-complaint contact evidence establishes a contact entity together with a phone number or email address.');
  }

  const missing: string[] = [];
  if (!hasEntity) missing.push('declarations.consumerComplaintNameOrContext');
  if (!hasMethod) missing.push('declarations.consumerComplaintPhoneOrEmail');
  return finding(
    'PCR-R6-2',
    '6(2)',
    'UNABLE_TO_VERIFY',
    'declarations.consumerComplaintContact',
    'The automated inspection could not reliably establish the complete consumer-complaint contact declaration. Officer verification is required.',
    undefined,
    missing,
  );
}

export function rule6DeclarationsFindings(r: InspectionRequest): Finding[] {
  const findings: Finding[] = [];

  for (const req of REQUIREMENTS) {
    if (req.conditional && !req.conditional(r)) continue;

    if (req.code === 'PCR-R6-1-A') {
      findings.push(manufacturerFinding(r));
      continue;
    }

    if (req.code === 'PCR-R6-2') {
      findings.push(consumerContactFinding(r));
      continue;
    }

    const fields = [req.field, ...(req.aliases ?? [])];
    const value = evidenceValue(r, fields);

    if (present(value)) {
      findings.push(finding(req.code, req.number, 'PASS', req.field, `Evidence was supplied for the required ${req.label}.`));
    } else {
      findings.push(finding(
        req.code,
        req.number,
        'UNABLE_TO_VERIFY',
        req.field,
        `The automated inspection could not reliably establish the required ${req.label}. This is not proof that the declaration is absent; officer verification is required.`,
        undefined,
        fields,
      ));
    }
  }

  return findings;
}
