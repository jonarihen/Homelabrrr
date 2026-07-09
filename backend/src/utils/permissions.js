import db from '../db.js';

// Every granular permission the portal knows. These are simultaneously the
// legacy per-user column names on `users` and the permission key strings
// stored in `role_permissions` — one vocabulary, two layers.
export const PERMISSION_KEYS = [
  'see_all_vms',
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
 * Effective permission check: admin bypasses everything; otherwise a
 * permission counts if the legacy per-user column is 1 OR the user's role
 * grants it. Accepts multiple keys — passes if any one is granted.
 */
export function userHasPermission(userId, ...keys) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return false;
  if (user.is_admin === 1) return true;
  if (keys.some((k) => user[k] === 1)) return true;
  const rolePerms = getRolePermissions(user.role_id);
  return keys.some((k) => rolePerms.has(k));
}

/**
 * Full effective map for a loaded user row (must include the permission
 * columns and role_id): { key: boolean } with column OR role semantics.
 * Deliberately does NOT fold in is_admin — admin bypass stays at the check
 * sites, matching how the frontend treats isAdmin separately.
 */
export function effectivePermissions(userRow) {
  const rolePerms = getRolePermissions(userRow?.role_id);
  const out = {};
  for (const key of PERMISSION_KEYS) {
    out[key] = userRow?.[key] === 1 || rolePerms.has(key);
  }
  return out;
}
