import { logAudit } from '../utils/audit.ts';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function auditMutations(req, res, next) {
  if (!MUTATING.has(req.method)) return next();
  res.on('finish', () => {
    if (!req.session?.userId) return;
    try {
      logAudit(
        req,
        'api_mutation',
        String(req.originalUrl || req.path).split('?')[0].slice(0, 300),
        `method=${req.method}; status=${res.statusCode}; requestId=${req.requestId || ''}; auth=${req.apiToken ? `token:${req.apiToken.id}` : 'session'}`,
        res.statusCode < 400 ? 'success' : res.statusCode < 500 ? 'denied' : 'failed',
      );
    } catch { /* an audit failure must not change a completed response */ }
  });
  next();
}
