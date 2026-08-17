import { userHasPermission } from '../utils/permissions.ts';
import { logAudit } from '../utils/audit.ts';

export function requireAuth(req, res, next) {
  if (!req.session?.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

/**
 * Reject requests authenticated with a personal API token. Sensitive account
 * operations — managing API tokens, changing passwords, touching 2FA — are
 * interactive-session only and must never be reachable with a Bearer token.
 */
export function requireInteractiveSession(req, res, next) {
  if (req.apiToken) {
    logAudit(req, 'api_token_interactive_operation_denied', String(req.originalUrl || req.path).split('?')[0], 'interactive session required');
    return res.status(403).json({ error: 'This operation requires an interactive session and cannot be performed with an API token' });
  }
  next();
}

export function requireRecentReauthentication(req, res, next) {
  if (req.apiToken) {
    logAudit(req, 'api_token_interactive_operation_denied', String(req.originalUrl || req.path).split('?')[0], 'recent reauthentication required');
    return res.status(403).json({ error: 'This operation requires an interactive session' });
  }
  const maxAgeMs = 15 * 60 * 1000;
  const reauthenticatedAt = Number(req.session?.reauthenticatedAt || 0);
  if (!reauthenticatedAt || Date.now() - reauthenticatedAt > maxAgeMs) {
    logAudit(req, 'recent_reauthentication_required', String(req.originalUrl || req.path).split('?')[0], 'sensitive operation denied');
    return res.status(403).json({
      error: 'Please confirm your password and second factor before continuing',
      code: 'REAUTHENTICATION_REQUIRED',
    });
  }
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.session?.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!req.session?.isAdmin) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

/**
 * Factory: require that the user is admin OR effectively holds one of the
 * given permissions (legacy per-user column OR their role grants it — see
 * utils/permissions.js). Usage: requirePermission('can_manage_vlans', ...)
 */
export function requirePermission(...permKeys) {
  return (req, res, next) => {
    if (!req.session?.userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    // Admin bypasses all permission checks
    if (req.session.isAdmin) return next();

    if (!userHasPermission(req.session.userId, ...permKeys)) {
      return res.status(403).json({ error: 'Forbidden — insufficient permissions' });
    }
    next();
  };
}
