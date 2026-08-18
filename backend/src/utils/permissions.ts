import { eq } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { users, rolePermissions } from '../db/schema/index.ts';
import { resolvePermissionCheck, resolveEffectivePermissions } from './permissionRules.ts';
import { PERMISSION_KEYS } from './permissionKeys.ts';

export { PERMISSION_KEYS } from './permissionKeys.ts';

// Every granular permission the portal knows. These are simultaneously the
// legacy per-user column names on `users` and the permission key strings
// stored in `role_permissions` — one vocabulary, two layers.
//
// NEVER read these columns off the `users` table directly to make an
// authorization decision — `SELECT can_x FROM users ...` silently ignores
// role_id, so anyone who got the permission from a role (including the
// built-in Administrator role) is treated as not having it. Always go
// through `userHasPermission` / `effectivePermissions` below, or
// `requirePermission` in middleware/auth.ts.

/** A user row as loaded from the DB or handed in by a caller. Loose on
 * purpose: mid-migration callers still pass rows of either flag dialect. */
type UserFlagRow = { role_id?: number | null; [key: string]: unknown } | null | undefined;

// permissionRules.ts is pure and still speaks the SQLite flag dialect
// (`=== 1`); PostgreSQL rows carry real booleans. Translate exactly
// true/false to 1/0 at this boundary and coerce nothing else, preserving
// the rule module's deliberate strictness (a string '1' still grants
// nothing).
function toLegacyFlagRow(userRow: UserFlagRow): UserFlagRow {
  if (!userRow) return userRow;
  const out: Record<string, unknown> = { ...userRow };
  for (const key of ['is_admin', ...PERMISSION_KEYS]) {
    if (out[key] === true) out[key] = 1;
    else if (out[key] === false) out[key] = 0;
  }
  return out as UserFlagRow;
}

/** Permission keys granted by a role (empty set for no role). */
export async function getRolePermissions(roleId: number | null | undefined): Promise<Set<string>> {
  if (!roleId) return new Set();
  const rows = await db
    .select({ permission: rolePermissions.permission })
    .from(rolePermissions)
    .where(eq(rolePermissions.role_id, roleId));
  return new Set(rows.map((r) => r.permission));
}

/**
 * Effective permission check: admin bypasses everything. A user WITH a role
 * gets exactly the role's permissions (the per-user columns are ignored);
 * a user WITHOUT a role falls back to the per-user columns. Accepts multiple
 * keys — passes if any one is granted.
 */
export async function userHasPermission(userId: number, ...keys: string[]): Promise<boolean> {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) return false;
  // Short-circuit the admin bypass before spending a query on the role.
  if (user.is_admin) return true;
  return resolvePermissionCheck(
    toLegacyFlagRow(user),
    user.role_id ? await getRolePermissions(user.role_id) : null,
    keys,
  );
}

/**
 * Full effective map for a loaded user row (must include the permission
 * columns and role_id): { key: boolean }. Role assigned → the role defines
 * the set; no role → the per-user columns. Deliberately does NOT fold in
 * is_admin — admin bypass stays at the check sites, matching how the
 * frontend treats isAdmin separately.
 */
export async function effectivePermissions(userRow: UserFlagRow): Promise<Record<string, boolean>> {
  return resolveEffectivePermissions(
    toLegacyFlagRow(userRow),
    userRow?.role_id ? await getRolePermissions(userRow.role_id) : null,
    PERMISSION_KEYS,
  );
}
