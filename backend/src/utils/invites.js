import crypto from 'crypto';
import db from '../db.js';
import { PERMISSION_KEYS } from './permissions.js';

// Permission columns an invite preset can carry directly (the granular can_*
// set plus the VM-visibility flag). Kept in sync with PERMISSION_KEYS so a
// preset can encode any grant the admin UI can toggle on a user.
export const INVITE_PERMISSION_COLUMNS = PERMISSION_KEYS;

// Raw token: 32 bytes of entropy, URL-safe. Shown to the admin exactly once.
export function generateInviteToken() {
  return crypto.randomBytes(32).toString('base64url');
}

// Only the hash is ever stored/compared — same discipline as other secrets.
export function hashInviteToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

// Non-negative integer, or null for "unlimited"/unset. undefined signals an
// invalid value so callers can reject the request (mirrors admin.js quotas).
export function parseQuotaValue(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = parseInt(value, 10);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

// Lifecycle state of an invite row: 'invalid' (missing), 'revoked', 'used',
// 'expired', or 'open' (redeemable).
export function inviteStatus(invite, now = Date.now()) {
  if (!invite) return 'invalid';
  if (invite.revoked_at) return 'revoked';
  if (invite.used_at) return 'used';
  if (invite.expires_at && Date.parse(invite.expires_at) <= now) return 'expired';
  return 'open';
}

// Build (and validate) a stored preset object from the admin generate request.
// Returns { preset } on success or { error } with a message on bad input.
// `allowAdmin` is false for non-admin creators (they cannot mint admin accounts).
export function normalizeInvitePreset(body, { allowAdmin } = { allowAdmin: false }) {
  const isAdmin = body.isAdmin ? 1 : 0;
  if (isAdmin && !allowAdmin) {
    return { error: 'Only admins can create invites for admin accounts' };
  }

  let roleId = null;
  if (body.roleId !== null && body.roleId !== undefined && body.roleId !== '') {
    roleId = parseInt(body.roleId, 10);
    if (!Number.isInteger(roleId)) return { error: 'Invalid role' };
    const role = db.prepare('SELECT id FROM roles WHERE id = ?').get(roleId);
    if (!role) return { error: 'Role not found' };
  }

  // Granular per-user permission flags (only meaningful when no role is set —
  // effectivePermissions lets a role override these, exactly as for any user).
  const permissions = {};
  const incoming = body.permissions || {};
  for (const key of INVITE_PERMISSION_COLUMNS) {
    permissions[key] = incoming[key] ? 1 : 0;
  }

  const maxCores = parseQuotaValue(body.maxCores);
  const maxMemoryGb = parseQuotaValue(body.maxMemoryGb);
  const maxStorageGb = parseQuotaValue(body.maxStorageGb);
  if (maxCores === undefined || maxMemoryGb === undefined || maxStorageGb === undefined) {
    return { error: 'Quota values must be non-negative integers (empty = unlimited)' };
  }

  let vlanIds = [];
  if (Array.isArray(body.vlanIds)) {
    vlanIds = [...new Set(body.vlanIds.map((v) => parseInt(v, 10)).filter(Number.isInteger))];
    for (const id of vlanIds) {
      const vlan = db.prepare('SELECT id FROM vlans WHERE id = ?').get(id);
      if (!vlan) return { error: `VLAN ${id} not found` };
    }
  }

  return {
    preset: {
      isAdmin,
      roleId,
      permissions,
      maxCores,
      maxMemoryGb,
      maxStorageGb,
      vlanIds,
    },
  };
}

// A safe, non-sensitive summary for the public invite page and admin list.
// Resolves the role name and VLAN labels; never leaks the token.
export function summarizeInvitePreset(preset) {
  const p = preset || {};
  let role = null;
  if (p.roleId) {
    const r = db.prepare('SELECT id, name FROM roles WHERE id = ?').get(p.roleId);
    if (r) role = { id: r.id, name: r.name };
  }
  const perms = p.permissions || {};
  const grantedPermissions = INVITE_PERMISSION_COLUMNS.filter((k) => perms[k]);
  const vlans = (p.vlanIds || [])
    .map((id) => db.prepare('SELECT id, name, tag FROM vlans WHERE id = ?').get(id))
    .filter(Boolean)
    .map((v) => ({ id: v.id, name: v.name, tag: v.tag }));
  return {
    isAdmin: !!p.isAdmin,
    role,
    grantedPermissions,
    quotas: {
      maxCores: p.maxCores ?? null,
      maxMemoryGb: p.maxMemoryGb ?? null,
      maxStorageGb: p.maxStorageGb ?? null,
    },
    vlans,
  };
}
