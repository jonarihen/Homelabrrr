import db from '../db.js';
import { hashApiToken } from '../utils/apiTokens.js';

// Rate-limit failed Bearer-token authentication the same way login attempts are
// throttled: too many bad tokens from one IP within the window get locked out.
const TOKEN_LOCKOUT_WINDOW_MS = 10 * 60 * 1000;
const TOKEN_LOCKOUT_MAX = 20;

function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function recentTokenFailures(ip, windowStart) {
  return db.prepare(
    'SELECT COUNT(*) as count FROM token_auth_attempts WHERE ip = ? AND attempted_at > ?'
  ).get(ip, windowStart).count;
}

function recordTokenFailure(ip) {
  const now = Date.now();
  db.prepare('DELETE FROM token_auth_attempts WHERE attempted_at < ?').run(now - TOKEN_LOCKOUT_WINDOW_MS);
  db.prepare('INSERT INTO token_auth_attempts (ip, attempted_at) VALUES (?, ?)').run(ip, now);
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
export function authenticateApiToken(req, res, next) {
  const ip = clientIp(req);
  const windowStart = Date.now() - TOKEN_LOCKOUT_WINDOW_MS;

  if (recentTokenFailures(ip, windowStart) >= TOKEN_LOCKOUT_MAX) {
    return res.status(429).json({ error: 'Too many invalid API token attempts. Try again later.' });
  }

  // The Authorization header value has already been confirmed to start with
  // "Bearer " by the caller; re-extract the raw token here.
  const raw = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!raw) {
    recordTokenFailure(ip);
    return res.status(401).json({ error: 'Invalid API token' });
  }

  const tokenHash = hashApiToken(raw);
  const token = db.prepare(
    "SELECT id, user_id, name, expires_at FROM api_tokens WHERE token_hash = ? AND (expires_at IS NULL OR expires_at > datetime('now'))"
  ).get(tokenHash);

  if (!token) {
    recordTokenFailure(ip);
    return res.status(401).json({ error: 'Invalid or expired API token' });
  }

  // Resolve the live user every request — role/permission changes and account
  // deletion take effect immediately.
  const user = db.prepare('SELECT id, username, is_admin FROM users WHERE id = ?').get(token.user_id);
  if (!user) {
    recordTokenFailure(ip);
    return res.status(401).json({ error: 'Invalid API token' });
  }

  db.prepare("UPDATE api_tokens SET last_used_at = datetime('now') WHERE id = ?").run(token.id);

  // Provide a plain session-shaped object so every downstream requireAuth /
  // requirePermission / userCanAccessVm check works unchanged. The no-op
  // `destroy` keeps the session-hydration middleware from throwing if it ever
  // tries to tear this "session" down.
  req.session = {
    userId: user.id,
    username: user.username,
    isAdmin: user.is_admin === 1,
    destroy: (cb) => { if (typeof cb === 'function') cb(); },
  };
  req.apiToken = { id: token.id, name: token.name };

  next();
}
