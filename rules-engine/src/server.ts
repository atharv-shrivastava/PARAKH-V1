import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { evaluateInspectionCompleteWithCurrentRulesV2 } from './engine/complete-evaluator-v2.js';
import type { InspectionRequest } from '../domain/types.js';
import { loadActiveRules } from './store/rules-store.js';

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

export async function rulesEngineHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const pathname = (req.url ?? '/').split('?')[0];

  if (req.method === 'GET' && pathname === '/health') {
    json(res, 200, { status: 'ok', service: 'parakh-rules-engine' });
    return;
  }

  if (req.method !== 'POST' || pathname !== '/api/rules-engine/evaluate') {
    json(res, 404, { error: 'Not found' });
    return;
  }

  try {
    let raw = '';
    for await (const chunk of req) {
      raw += chunk.toString();
      if (raw.length > 2_000_000) {
        json(res, 413, { error: 'Request body too large' });
        return;
      }
    }

    const request = JSON.parse(raw) as InspectionRequest;
    if (!request.inspectionId || !request.productId || !request.inspectionDate ||
        !request.productMetadata || !Array.isArray(request.evidence)) {
      json(res, 400, { error: 'Invalid inspection request.' });
      return;
    }

    const rules = await loadActiveRules();
    json(res, 200, {
      ...evaluateInspectionCompleteWithCurrentRulesV2(request, rules),
      rulesSource: process.env.DATABASE_URL ? 'database' : 'built_in_fallback',
      activeRuleCount: rules.length,
    });
  } catch (error) {
    json(res, 400, {
      error: 'Invalid JSON or inspection payload.',
      detail: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

export default rulesEngineHandler;

// Keep the same module runnable locally while Vercel invokes the exported handler.
if (process.env.VERCEL !== '1') {
  const PORT = Number(process.env.PORT ?? process.env.RULES_ENGINE_PORT ?? 8090);
  createServer(rulesEngineHandler).listen(PORT, '0.0.0.0', () => {
    console.log(`PARAKH rules engine listening on port ${PORT}`);
  });
}
