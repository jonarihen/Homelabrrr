import { and, count, eq, gt, isNull, lt, or } from 'drizzle-orm';
import { db, type DbOrTx } from '../db/client.ts';
import { apiTokens, tokenAuthAttempts, users } from '../db/schema/index.ts';
import { hashApiToken } from '../utils/apiTokens.ts';
import { requiredScopeForRequest } from '../utils/apiTokenScopes.ts';
import { logAudit } from '../utils/audit.ts';
import { log } from '../utils/logger.ts';

// Rate-limit failed Bearer-token authentication the same way login attempts are
// throttled: too many bad tokens from one IP within the window get locked out.
const TOKEN_LOCKOUT_WINDOW_MS = 10 * 60 * 1000;
const TOKEN_LOCKOUT_MAX = 20;

function clientIp(req): string {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

// Denial audits are fire-and-forget (conventions M13): the 403 payload —
// including the machine-read scope code — must reach the client
// deterministically even when the audit insert fails.
function auditDenial(req, action: string, target: string, detail: string): void {
  logAudit(req, action, target, detail)
    .catch((err) => log('warn', 'audit_write_failed', { action, error: err?.message }));
}

async function recentTokenFailures(database: DbOrTx, ip: string, windowStart: number): Promise<number> {
  const [{ c }] = await database
    .select({ c: count() })
    .from(tokenAuthAttempts)
    .where(and(eq(tokenAuthAttempts.ip, ip), gt(tokenAuthAttempts.attempted_at, windowStart)));
  return c;
}

/**
 * Record a failed token attempt and return how many failures the IP now has
 * inside the lockout window.
 *
 * Prune → count → insert runs as ONE short transaction (redesign R8): failed
 * token auth is attacker-controlled load, and running the triple on a single
 * pool connection inside one atomic unit means concurrent failures cannot
 * interleave between the prune and the insert — the count is exact at the
 * moment the failure is recorded, and the attempts table cannot be pruned out
 * from under a half-finished recording. Kept deliberately short: three cheap
 * indexed statements and nothing else, so the connection is held for
 * microseconds, not across any auth work.
 */
async function recordTokenFailure(ip: string): Promise<number> {
  const now = Date.now();
  return db.transaction(async (tx) => {
    await tx.delete(tokenAuthAttempts).where(lt(tokenAuthAttempts.attempted_at, now - TOKEN_LOCKOUT_WINDOW_MS));
    const failures = await recentTokenFailures(tx, ip, now - TOKEN_LOCKOUT_WINDOW_MS);
    await tx.insert(tokenAuthAttempts).values({ ip, attempted_at: now });
    return failures + 1;
  });
}

/**
 * Authenticate a request carrying `Authorization: Bearer <token>`.
 *
 * Runs BEFORE the session middleware fallback. On success it populates a plain
 * `req.session`-shaped context (`userId`, `username`, `isAdmin`) — resolved from
 * the LIVE user row on every request so a token is never more powerful than its
 * owner and permission/role changes take effect immediately — plus a
 * `req.apiToken` marker used for audit attribution and to block sensitive
 * (interactive-only) operations. No session cookie is created for token auth.
 */
export async function authenticateApiToken(req, res, next): Promise<void> {
  const ip = clientIp(req);
  const windowStart = Date.now() - TOKEN_LOCKOUT_WINDOW_MS;

  if (await recentTokenFailures(db, ip, windowStart) >= TOKEN_LOCKOUT_MAX) {
    return res.status(429).json({ error: 'Too many invalid API token attempts. Try again later.' });
  }

  // The Authorization header value has already been confirmed to start with
  // "Bearer " by the caller; re-extract the raw token here.
  const raw = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!raw) {
    await recordTokenFailure(ip);
    return res.status(401).json({ error: 'Invalid API token' });
  }

  const tokenHash = hashApiToken(raw);
  const [token] = await db
    .select({
      id: apiTokens.id,
      user_id: apiTokens.user_id,
      name: apiTokens.name,
      scopes: apiTokens.scopes,
      expires_at: apiTokens.expires_at,
    })
    .from(apiTokens)
    .where(and(
      eq(apiTokens.token_hash, tokenHash),
      or(isNull(apiTokens.expires_at), gt(apiTokens.expires_at, new Date()))
    ))
    .limit(1);

  if (!token) {
    await recordTokenFailure(ip);
    return res.status(401).json({ error: 'Invalid or expired API token' });
  }

  // Resolve the live user every request — role/permission changes and account
  // deletion take effect immediately.
  const [user] = await db
    .select({ id: users.id, username: users.username, is_admin: users.is_admin })
    .from(users)
    .where(eq(users.id, token.user_id))
    .limit(1);
  if (!user) {
    await recordTokenFailure(ip);
    return res.status(401).json({ error: 'Invalid API token' });
  }

  // Usage stamp is best-effort fire-and-forget (conventions M13): auth must
  // never slow down or fail because the bookkeeping UPDATE did.
  db.update(apiTokens)
    .set({ last_used_at: new Date() })
    .where(eq(apiTokens.id, token.id))
    .catch((err) => log('warn', 'api_token_last_used_write_failed', { error: err?.message }));

  // Provide a plain session-shaped object so every downstream requireAuth /
  // requirePermission / userCanAccessVm check works unchanged. The no-op
  // `destroy` keeps the session-hydration middleware from throwing if it ever
  // tries to tear this "session" down.
  req.session = {
    userId: user.id,
    username: user.username,
    isAdmin: !!user.is_admin,
    destroy: (cb) => { if (typeof cb === 'function') cb(); },
  };
  req.apiToken = {
    id: token.id,
    name: token.name,
    scopes: new Set(String(token.scopes || 'read').split(',').map((scope) => scope.trim()).filter(Boolean)),
  };

  next();
}

export function enforceApiTokenScope(req, res, next) {
  if (!req.apiToken) return next();
  const required = requiredScopeForRequest(req);
  if (!required) {
    auditDenial(req, 'api_token_scope_denied', String(req.originalUrl || req.path).split('?')[0], 'interactive session required');
    return res.status(403).json({ error: 'This identity operation requires an interactive session' });
  }
  if (!req.apiToken.scopes.has(required) && !req.apiToken.scopes.has('admin')) {
    auditDenial(req, 'api_token_scope_denied', String(req.originalUrl || req.path).split('?')[0], `required=${required}`);
    return res.status(403).json({ error: `API token requires the ${required} scope`, code: 'API_TOKEN_SCOPE_REQUIRED' });
  }
  next();
}
