import { eq } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import { users } from '../../db/schema/index.ts';
import { effectivePermissions, withImpliedPermissions } from '../../utils/permissions.ts';

export const LOCKOUT_WINDOW_MS = 10 * 60 * 1000;
export const LOCKOUT_MAX = 10;

export async function ensureCanManageTargetUser(req, res, userId) {
  if (req.session.isAdmin) return true;

  const [target] = await db.select().from(users).where(eq(users.id, Number(userId))).limit(1);
  if (!target) {
    res.status(404).json({ error: 'User not found' });
    return false;
  }
  if (target.is_admin) {
    res.status(403).json({ error: 'Only admins can modify admin accounts' });
    return false;
  }
  // A delegate may only manage users whose effective permissions are a subset of its own.
  const [caller] = await db.select().from(users).where(eq(users.id, Number(req.session.userId))).limit(1);
  const [targetPerms, callerPerms] = (await Promise.all([effectivePermissions(target), effectivePermissions(caller)]))
    .map(withImpliedPermissions);
  if (Object.keys(targetPerms).some((key) => targetPerms[key] && !callerPerms[key])) {
    res.status(403).json({ error: 'Only admins can manage users with permissions you do not have' });
    return false;
  }
  return true;
}

// null = unlimited, undefined = invalid. Strict: "1.5", "1e3" or "8abc" are
// rejected rather than truncated, so the saved quota is exactly what was sent.
export function parseQuotaValue(value) {
  if (value === null || value === undefined || value === '') return null;
  let n;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string' && /^\d{1,10}$/.test(value.trim())) n = Number(value.trim());
  else return undefined;
  return Number.isInteger(n) && n >= 0 && n <= 2147483647 ? n : undefined;
}

export const roleRef = (id) => `role:${id}`;

export const PG_INT_MAX = 2147483647;
export function parseRoleId(value): number | null {
  let n;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string' && /^\d{1,10}$/.test(value.trim())) n = Number(value.trim());
  else return null;
  return Number.isInteger(n) && n >= 1 && n <= PG_INT_MAX ? n : null;
}
