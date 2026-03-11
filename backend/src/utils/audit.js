import db from '../db.js';

export function logAudit(req, action, target = '', detail = '') {
  const userId = req.session?.userId || null;
  const username = req.session?.username || 'anonymous';
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || '';
  db.prepare(
    'INSERT INTO audit_log (user_id, username, action, target, ip, detail) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(userId, username, action, target, ip, detail);
}
