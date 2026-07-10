import db from '../db.js';

// Low-level insert — used by request-scoped logAudit and by background jobs that
// have no `req` (e.g. the tag-sync scheduler).
export function logAuditEntry({ userId = null, username = 'system', action, target = '', detail = '', ip = '' }) {
  db.prepare(
    'INSERT INTO audit_log (user_id, username, action, target, ip, detail) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(userId, username, action, target, ip, detail);
}

export function logAudit(req, action, target = '', detail = '') {
  let username = req.session?.username || 'anonymous';
  // Attribute token-authenticated requests so scripted actions are traceable
  // to the specific personal API token that made them.
  if (req.apiToken?.name) {
    username = `${username} (token: ${req.apiToken.name})`;
  }
  logAuditEntry({
    userId: req.session?.userId || null,
    username,
    action,
    target,
    detail,
    ip: req.ip || req.socket?.remoteAddress || '',
  });
}
