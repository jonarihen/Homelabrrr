import db from '../db.js';
import { resolvePermissionCheck, resolveEffectivePermissions } from './permissionRules.js';

// Every granular permission the portal knows. These are simultaneously the
// legacy per-user column names on `users` and the permission key strings
// stored in `role_permissions` — one vocabulary, two layers.
//
// NEVER read these columns off the `users` table directly to make an
// authorization decision — `SELECT can_x FROM users ...` silently ignores
// role_id, so anyone who got the permission from a role (including the
// built-in Administrator role) is treated as not having it. Always go
// through `userHasPermission` / `effectivePermissions` below, or
// `requirePermission` in middleware/auth.js.
export const PERMISSION_KEYS = [
  'see_all_vms',
  'can_operate_all_vms',
  'can_provision',
  'can_create_vms',
  'can_manage_hosts',
  'can_manage_firewalls',
  'can_manage_port_forwards',
  'can_manage_vlans',
  'can_manage_policies',
  'can_manage_templates',
  'can_manage_users',
  'can_manage_assignments',
  'can_view_audit_log',
  'can_edit_vm_hardware',
  'can_manage_websites',
  'can_manage_public_ips',
];

/** Permission keys granted by a role (empty set for no role). */
export function getRolePermissions(roleId) {
  if (!roleId) return new Set();
  return new Set(
    db.prepare('SELECT permission FROM role_permissions WHERE role_id = ?')
      .all(roleId)
      .map((r) => r.permission)
  );
}

/**
 * Effective permission check: admin bypasses everything. A user WITH a role
 * gets exactly the role's permissions (the per-user columns are ignored);
 * a user WITHOUT a role falls back to the per-user columns. Accepts multiple
 * keys — passes if any one is granted.
 */
export function userHasPermission(userId, ...keys) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return false;
  // Short-circuit the admin bypass before spending a query on the role.
  if (user.is_admin === 1) return true;
  return resolvePermissionCheck(user, user.role_id ? getRolePermissions(user.role_id) : null, keys);
}

/**
 * Full effective map for a loaded user row (must include the permission
 * columns and role_id): { key: boolean }. Role assigned → the role defines
 * the set; no role → the per-user columns. Deliberately does NOT fold in
 * is_admin — admin bypass stays at the check sites, matching how the
 * frontend treats isAdmin separately.
 */
export function effectivePermissions(userRow) {
  return resolveEffectivePermissions(
    userRow,
    userRow?.role_id ? getRolePermissions(userRow.role_id) : null,
    PERMISSION_KEYS,
  );
}
