import db from '../db.js';

export function logAudit(req, action, target = '', detail = '') {
  const userId = req.session?.userId || null;
  let username = req.session?.username || 'anonymous';
  // Attribute token-authenticated requests so scripted actions are traceable
  // to the specific personal API token that made them.
  if (req.apiToken?.name) {
    username = `${username} (token: ${req.apiToken.name})`;
  }
  const ip = req.ip || req.socket?.remoteAddress || '';
  db.prepare(
    'INSERT INTO audit_log (user_id, username, action, target, ip, detail) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(userId, username, action, target, ip, detail);
}
