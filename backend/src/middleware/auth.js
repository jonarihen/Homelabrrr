import db from '../db.js';

export function requireAuth(req, res, next) {
  if (!req.session?.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
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
 * Factory: require that the user is admin OR has one of the given permission columns.
 * Usage: requirePermission('can_manage_vlans', 'can_manage_firewalls')
 * The user passes if they are admin OR if any of the listed columns is 1.
 */
export function requirePermission(...permColumns) {
  return (req, res, next) => {
    if (!req.session?.userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    // Admin bypasses all permission checks
    if (req.session.isAdmin) return next();

    // Check user's permission columns in DB
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const hasPermission = permColumns.some(col => user[col] === 1);
    if (!hasPermission) {
      return res.status(403).json({ error: 'Forbidden — insufficient permissions' });
    }
    next();
  };
}
