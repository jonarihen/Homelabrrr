import { logAudit } from '../utils/audit.ts';
import { log } from '../utils/logger.ts';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function auditMutations(req, res, next) {
  if (!MUTATING.has(req.method)) return next();
  res.on('finish', () => {
    if (!req.session?.userId) return;
    // Fire-and-forget: the response is already complete, so the async audit
    // INSERT cannot be awaited — a failure is logged and must never throw.
    logAudit(
      req,
      'api_mutation',
      String(req.originalUrl || req.path).split('?')[0].slice(0, 300),
      `method=${req.method}; status=${res.statusCode}; requestId=${req.requestId || ''}; auth=${req.apiToken ? `token:${req.apiToken.id}` : 'session'}`,
      res.statusCode < 400 ? 'success' : res.statusCode < 500 ? 'denied' : 'failed',
    ).catch((err: unknown) => {
      log('warn', 'mutation_audit_write_failed', { requestId: req.requestId, error: err });
    });
  });
  next();
}
