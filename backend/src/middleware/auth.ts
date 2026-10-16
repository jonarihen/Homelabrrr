import { eq } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { users } from '../db/schema/index.ts';
import { userHasPermission } from '../utils/permissions.ts';
import { logAudit } from '../utils/audit.ts';
import { log } from '../utils/logger.ts';

// Denial audits are fire-and-forget (conventions M13): the 401/403 payload —
// including machine-read codes like REAUTHENTICATION_REQUIRED — must reach the
// client deterministically even when the audit insert fails.
function auditDenial(req, action: string, target: string, detail: string): void {
  logAudit(req, action, target, detail)
    .catch((err) => log('warn', 'audit_write_failed', { action, error: err?.message }));
}

// Re-hydrates the cookie session from the live user row on every request, and
// drops sessions whose user is gone or that were authenticated before the
// user's last password/2FA change (closes the login-vs-credential-change race).
export async function loadSessionUser(req, res, next) {
  if (!req.session?.userId) return next();
  // Token auth already resolved the live user; don't re-hydrate (and never try
  // to destroy) the plain token session object.
  if (req.apiToken) return next();

  const [user] = await db
    .select({ username: users.username, is_admin: users.is_admin, credentials_changed_at: users.credentials_changed_at })
    .from(users)
    .where(eq(users.id, req.session.userId))
    .limit(1);
  const authenticatedAt = Number(req.session.authenticatedAt ?? req.session.createdAt ?? 0);
  if (!user || (user.credentials_changed_at && authenticatedAt < user.credentials_changed_at.getTime())) {
    return req.session.destroy(() => next());
  }

  req.session.username = user.username;
  req.session.isAdmin = user.is_admin === true;
  if (!req.session.lastSeenAt || Date.now() - Number(req.session.lastSeenAt) > 5 * 60 * 1000) {
    req.session.lastSeenAt = Date.now();
    req.session.clientIp = String(req.ip || '').slice(0, 128);
    req.session.userAgent = String(req.headers['user-agent'] || '').slice(0, 256);
  }
  next();
}

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
    auditDenial(req, 'api_token_interactive_operation_denied', String(req.originalUrl || req.path).split('?')[0], 'interactive session required');
    return res.status(403).json({ error: 'This operation requires an interactive session and cannot be performed with an API token' });
  }
  next();
}

export function requireRecentReauthentication(req, res, next) {
  if (req.apiToken) {
    auditDenial(req, 'api_token_interactive_operation_denied', String(req.originalUrl || req.path).split('?')[0], 'recent reauthentication required');
    return res.status(403).json({ error: 'This operation requires an interactive session' });
  }
  const maxAgeMs = 15 * 60 * 1000;
  const reauthenticatedAt = Number(req.session?.reauthenticatedAt || 0);
  if (!reauthenticatedAt || Date.now() - reauthenticatedAt > maxAgeMs) {
    auditDenial(req, 'recent_reauthentication_required', String(req.originalUrl || req.path).split('?')[0], 'sensitive operation denied');
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
 * utils/permissions.ts). Usage: requirePermission('can_manage_vlans', ...)
 *
 * The returned middleware is async (the permission check hits the DB);
 * Express 5 forwards a rejected promise to the error middleware, so a DB
 * failure surfaces as a sanitized 500 rather than an unhandled rejection.
 */
export function requirePermission(...permKeys: string[]) {
  return async (req, res, next) => {
    if (!req.session?.userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    // Admin bypasses all permission checks
    if (req.session.isAdmin) return next();

    if (!(await userHasPermission(req.session.userId, ...permKeys))) {
      return res.status(403).json({ error: 'Forbidden — insufficient permissions' });
    }
    next();
  };
}
