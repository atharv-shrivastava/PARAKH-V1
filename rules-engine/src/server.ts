import { createServer } from 'node:http';
import { evaluateInspectionCompleteWithCurrentRulesV2 } from './engine/complete-evaluator-v2.js';
import type { InspectionRequest } from '../domain/types.js';
import { loadActiveRules } from './store/rules-store.js';

const PORT = Number(process.env.PORT ?? process.env.RULES_ENGINE_PORT ?? 8090);

function json(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') return json(res, 200, { status: 'ok', service: 'parakh-rules-engine' });
  if (req.method !== 'POST' || req.url !== '/api/rules-engine/evaluate') return json(res, 404, { error: 'Not found' });

  try {
    let raw = '';
    for await (const chunk of req) raw += chunk.toString();
    if (raw.length > 2_000_000) return json(res, 413, { error: 'Request body too large' });
    const request = JSON.parse(raw) as InspectionRequest;
    if (!request.inspectionId || !request.productId || !request.inspectionDate || !request.productMetadata || !Array.isArray(request.evidence)) {
      return json(res, 400, { error: 'Invalid inspection request.' });
    }

    const rules = await loadActiveRules();
    return json(res, 200, {
      ...evaluateInspectionCompleteWithCurrentRulesV2(request, rules),
      rulesSource: process.env.DATABASE_URL ? 'database' : 'built_in_fallback',
      activeRuleCount: rules.length,
    });
  } catch (error) {
    return json(res, 400, { error: 'Invalid JSON or inspection payload.', detail: error instanceof Error ? error.message : 'Unknown error' });
  }
});

server.listen(PORT, '0.0.0.0', () => console.log(`PARAKH rules engine listening on port ${PORT}`));
