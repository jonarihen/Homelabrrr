import db from '../db.js';

// Low-level insert — used by request-scoped logAudit and by background jobs that
// have no `req` (e.g. the tag-sync scheduler).
export function logAuditEntry({ userId = null, username = 'system', action, target = '', detail = '', ip = '' }) {
  db.prepare(
    'INSERT INTO audit_log (user_id, username, action, target, ip, detail) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(userId, username, action, target, ip, detail);
}

export function logAudit(req, action, target = '', detail = '') {
  logAuditEntry({
    userId: req.session?.userId || null,
    username: req.session?.username || 'anonymous',
    action,
    target,
    detail,
    ip: req.ip || req.socket?.remoteAddress || '',
  });
}
