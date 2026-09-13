import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';

const PORT = 18090;
const BASE_URL = `http://127.0.0.1:${PORT}`;
let server: ChildProcess | undefined;

const request = {
  inspectionId: 'api-test-001',
  productId: 'biscuit-500g-001',
  inspectionDate: '2026-09-02',
  context: 'physical_package',
  productMetadata: {
    commodityCategory: 'biscuits',
    consumerType: 'general',
    isImported: false,
    packageType: 'retail'
  },
  declarations: {
    manufacturerOrPacker: 'Example Foods, Bhopal, Madhya Pradesh',
    commonOrGenericName: 'Biscuits',
    netQuantity: 500,
    netQuantityUnit: 'g',
    manufactureOrImportDate: '08/2026',
    retailSalePrice: 100,
    consumerComplaintName: 'Consumer Care Cell',
    consumerComplaintAddress: 'Example Foods, Bhopal, Madhya Pradesh',
    consumerComplaintPhone: '1800-000-000'
  },
  packaging: {
    netQuantityExcludesPackaging: true,
    environmentalVariation: 'NONE',
    quantityQualification: ''
  },
  measurements: {
    declaredQuantity: 500,
    declaredUnit: 'g',
    actualQuantity: 497,
    actualUnit: 'g',
    numberOfSamplesTested: 1,
    measurementMethod: 'calibrated_weighing'
  },
  evidence: [
    {
      evidenceId: 'ev-001',
      field: 'declarations.manufacturerOrPacker',
      rawValue: 'Example Foods, Bhopal, Madhya Pradesh',
      confidence: 0.99,
      source: 'MANUAL_INPUT',
      timestamp: '2026-09-02T10:00:00Z'
    },
    {
      evidenceId: 'ev-002',
      field: 'declarations.commonOrGenericName',
      rawValue: 'Biscuits',
      confidence: 0.99,
      source: 'MANUAL_INPUT',
      timestamp: '2026-09-02T10:00:00Z'
    },
    {
      evidenceId: 'ev-003',
      field: 'declarations.netQuantity',
      rawValue: '500 g',
      normalizedValue: 500,
      unit: 'g',
      confidence: 0.99,
      source: 'MANUAL_INPUT',
      timestamp: '2026-09-02T10:00:00Z'
    },
    {
      evidenceId: 'ev-004',
      field: 'declarations.retailSalePrice',
      rawValue: '₹100',
      normalizedValue: 100,
      confidence: 0.99,
      source: 'MANUAL_INPUT',
      timestamp: '2026-09-02T10:00:00Z'
    },
    {
      evidenceId: 'ev-005',
      field: 'declarations.manufactureOrImportDate',
      rawValue: '08/2026',
      confidence: 0.99,
      source: 'MANUAL_INPUT',
      timestamp: '2026-09-02T10:00:00Z'
    },
    {
      evidenceId: 'ev-006',
      field: 'declarations.consumerComplaintName',
      rawValue: 'Consumer Care Cell',
      confidence: 0.99,
      source: 'MANUAL_INPUT',
      timestamp: '2026-09-02T10:00:00Z'
    },
    {
      evidenceId: 'ev-007',
      field: 'declarations.consumerComplaintAddress',
      rawValue: 'Example Foods, Bhopal, Madhya Pradesh',
      confidence: 0.99,
      source: 'MANUAL_INPUT',
      timestamp: '2026-09-02T10:00:00Z'
    },
    {
      evidenceId: 'ev-008',
      field: 'declarations.consumerComplaintPhone',
      rawValue: '1800-000-000',
      confidence: 0.99,
      source: 'MANUAL_INPUT',
      timestamp: '2026-09-02T10:00:00Z'
    }
  ]
};

async function waitForServer(): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE_URL}/health`);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Rules engine server did not become healthy within 10 seconds.');
}

before(async () => {
  server = spawn(process.execPath, ['dist/src/server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, RULES_ENGINE_PORT: String(PORT) },
    stdio: 'ignore'
  });
  await waitForServer();
});

after(() => {
  server?.kill();
});

test('GET /health returns service health', async () => {
  const response = await fetch(`${BASE_URL}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: 'ok',
    service: 'parakh-rules-engine'
  });
});

test('POST /api/rules-engine/evaluate returns a structured compliant evaluation', async () => {
  const response = await fetch(`${BASE_URL}/api/rules-engine/evaluate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request)
  });

  assert.equal(response.status, 200);
  const result = await response.json() as {
    inspectionId: string;
    productId: string;
    overallStatus: string;
    summary: { violations: number };
    findings: Array<{ ruleCode: string; status: string }>;
    auditHash: string;
  };

  assert.equal(result.inspectionId, 'api-test-001');
  assert.equal(result.productId, 'biscuit-500g-001');
  assert.equal(result.summary.violations, 0);
  assert.equal(result.overallStatus, 'UNABLE_TO_VERIFY');
  assert.equal(result.auditHash.length, 64);
  assert.equal(result.findings.some(f => f.ruleCode === 'PCR-R3-APPLICABILITY'), true);
});

test('POST /api/rules-engine/evaluate catches an MPE violation', async () => {
  const violating = {
    ...request,
    inspectionId: 'api-test-002',
    measurements: { ...request.measurements, actualQuantity: 480 }
  };

  const response = await fetch(`${BASE_URL}/api/rules-engine/evaluate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(violating)
  });

  assert.equal(response.status, 200);
  const result = await response.json() as {
    overallStatus: string;
    findings: Array<{ ruleCode: string; status: string; message: string }>;
  };

  assert.equal(result.overallStatus, 'VIOLATION');
  const mpe = result.findings.find(f => f.ruleCode === 'PCR-SCHED-I-MPE');
  assert.equal(mpe?.status, 'VIOLATION');
  assert.match(mpe?.message ?? '', /MPE 15 g/);
});

test('POST /api/rules-engine/evaluate rejects invalid JSON', async () => {
  const response = await fetch(`${BASE_URL}/api/rules-engine/evaluate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not-json'
  });
