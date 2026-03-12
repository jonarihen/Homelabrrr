import db from '../db.js';

export function logAudit(req, action, target = '', detail = '') {
  const userId = req.session?.userId || null;
  const username = req.session?.username || 'anonymous';
  const ip = req.ip || req.socket?.remoteAddress || '';
  db.prepare(
    'INSERT INTO audit_log (user_id, username, action, target, ip, detail) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(userId, username, action, target, ip, detail);
}
