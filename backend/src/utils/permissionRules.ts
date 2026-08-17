// The role-vs-column precedence rule for the granular `can_*` permissions,
// with no database access at all — that is what makes it unit-testable.
// The DB-backed wrappers (`userHasPermission` / `effectivePermissions`) live
// in permissions.js and are the only thing route code should call.
//
// The rule: admin bypasses everything; a user WITH a role gets exactly the
// role's permissions (the legacy per-user columns are ignored); a user
// WITHOUT a role falls back to the legacy per-user columns.

const EMPTY = new Set();

/** Accept a Set, an array, or null/undefined and normalize to a Set. */
function toSet(rolePermissions) {
  if (!rolePermissions) return EMPTY;
  return rolePermissions instanceof Set ? rolePermissions : new Set(rolePermissions);
}

/**
 * Effective permission check for one loaded user row. `keys` passes if any
 * one of them is granted. Includes the admin bypass.
 */
export function resolvePermissionCheck(userRow, rolePermissions, keys) {
  if (!userRow) return false;
  if (userRow.is_admin === 1) return true;
  if (userRow.role_id) {
    const perms = toSet(rolePermissions);
    return keys.some((k) => perms.has(k));
  }
  return keys.some((k) => userRow[k] === 1);
}

/**
 * Full effective map for a loaded user row: { key: boolean }. Deliberately
 * does NOT fold in is_admin — admin bypass stays at the check sites, matching
 * how the frontend treats isAdmin separately.
 */
export function resolveEffectivePermissions(userRow, rolePermissions, permissionKeys) {
  const out = {};
  const hasRole = !!userRow?.role_id;
  const perms = hasRole ? toSet(rolePermissions) : EMPTY;
  for (const key of permissionKeys) {
    out[key] = hasRole ? perms.has(key) : userRow?.[key] === 1;
  }
  return out;
}
