import crypto from 'crypto';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { roles, vlans } from '../db/schema/index.ts';
// permissionKeys.ts is the db-free vocabulary module — importing the full
// permissions.ts would drag in the legacy SQLite singleton for no reason.
import { PERMISSION_KEYS } from './permissionKeys.ts';

// Permission columns an invite preset can carry directly (the granular can_*
// set plus the VM-visibility flag). Kept in sync with PERMISSION_KEYS so a
// preset can encode any grant the admin UI can toggle on a user.
export const INVITE_PERMISSION_COLUMNS = PERMISSION_KEYS;

// Raw token: 32 bytes of entropy, URL-safe. Shown to the admin exactly once.
export function generateInviteToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

// Only the hash is ever stored/compared — same discipline as other secrets.
export function hashInviteToken(token: unknown): string {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

// Non-negative integer, or null for "unlimited"/unset. undefined signals an
// invalid value so callers can reject the request (mirrors admin.js quotas).
export function parseQuotaValue(value: unknown): number | null | undefined {
  if (value === null || value === undefined || value === '') return null;
  const n = parseInt(String(value), 10);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

// The invite columns inviteStatus inspects — timestamptz columns arrive from
// Drizzle as Date objects (null when unset).
export interface InviteStatusFields {
  revoked_at?: Date | null;
  used_at?: Date | null;
  expires_at?: Date | null;
}

// Lifecycle state of an invite row: 'invalid' (missing), 'revoked', 'used',
// 'expired', or 'open' (redeemable).
export function inviteStatus(
  invite: InviteStatusFields | null | undefined,
  now: number = Date.now()
): 'invalid' | 'revoked' | 'used' | 'expired' | 'open' {
  if (!invite) return 'invalid';
  if (invite.revoked_at) return 'revoked';
  if (invite.used_at) return 'used';
  if (invite.expires_at && new Date(invite.expires_at).getTime() <= now) return 'expired';
  return 'open';
}

// The validated preset stored on an invite row. `invites.preset` is jsonb, so
// this object goes in and comes out as-is — no JSON.stringify/parse anywhere.
// Flags are real booleans; rows written before the PostgreSQL migration may
// still carry 1/0, so consumers must only rely on truthiness.
export interface InvitePreset {
  isAdmin: boolean;
  roleId: number | null;
  permissions: Record<string, boolean>;
  maxCores: number | null;
  maxMemoryGb: number | null;
  maxStorageGb: number | null;
  vlanIds: number[];
}

// Build (and validate) a stored preset object from the admin generate request.
// Returns { preset } on success or { error } with a message on bad input.
// `allowAdmin` is false for non-admin creators (they cannot mint admin
// accounts). `allowPrivileges` is false for non-admin creators too: every
// privilege-granting route (role, permission, quota, see-all-vms, ...) is
// admin-only, and POST /admin/users only lets a can_manage_users delegate
// create a BARE account. An invite must not become a side-channel for the
// delegate to grant access they could never grant directly, so their preset
// is constrained to a bare account exactly like a manually created one.
export async function normalizeInvitePreset(
  body: any,
  { allowAdmin = false, allowPrivileges = false }: { allowAdmin?: boolean; allowPrivileges?: boolean } = {}
): Promise<{ preset: InvitePreset } | { error: string }> {
  const isAdmin = Boolean(body.isAdmin);
  if (isAdmin && !allowAdmin) {
    return { error: 'Only admins can create invites for admin accounts' };
  }

  let roleId: number | null = null;
  if (body.roleId !== null && body.roleId !== undefined && body.roleId !== '') {
    if (!allowPrivileges) return { error: 'Only admins can attach a role to an invite' };
    roleId = parseInt(body.roleId, 10);
    if (!Number.isInteger(roleId)) return { error: 'Invalid role' };
    const [role] = await db.select({ id: roles.id }).from(roles).where(eq(roles.id, roleId)).limit(1);
    if (!role) return { error: 'Role not found' };
  }

  // Granular per-user permission flags (only meaningful when no role is set —
  // effectivePermissions lets a role override these, exactly as for any user).
  const permissions: Record<string, boolean> = {};
  const incoming = body.permissions || {};
  for (const key of INVITE_PERMISSION_COLUMNS) {
    permissions[key] = Boolean(incoming[key]);
  }
  if (!allowPrivileges && INVITE_PERMISSION_COLUMNS.some((k) => permissions[k])) {
    return { error: 'Only admins can grant permissions through an invite' };
  }

  const maxCores = parseQuotaValue(body.maxCores);
  const maxMemoryGb = parseQuotaValue(body.maxMemoryGb);
  const maxStorageGb = parseQuotaValue(body.maxStorageGb);
  if (maxCores === undefined || maxMemoryGb === undefined || maxStorageGb === undefined) {
    return { error: 'Quota values must be non-negative integers (empty = unlimited)' };
  }
  if (!allowPrivileges && (maxCores !== null || maxMemoryGb !== null || maxStorageGb !== null)) {
    return { error: 'Only admins can set quotas on an invite' };
  }

  let vlanIds: number[] = [];
  if (Array.isArray(body.vlanIds)) {
    vlanIds = [...new Set<number>(body.vlanIds.map((v: unknown) => parseInt(String(v), 10)).filter(Number.isInteger))];
    if (!allowPrivileges && vlanIds.length) {
      return { error: 'Only admins can grant VLAN access through an invite' };
    }
    if (vlanIds.length) {
      // One IN query validates every id at once (was a query per VLAN).
      const found = await db.select({ id: vlans.id }).from(vlans).where(inArray(vlans.id, vlanIds));
      const foundIds = new Set(found.map((v) => v.id));
      const missing = vlanIds.find((id) => !foundIds.has(id));
      if (missing !== undefined) return { error: `VLAN ${missing} not found` };
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

// A stored preset as read back from the jsonb column — same shape as
// InvitePreset but tolerant of pre-migration 1/0 flags and missing keys.
export interface StoredInvitePreset {
  isAdmin?: boolean | number;
  roleId?: number | null;
  permissions?: Record<string, boolean | number>;
  maxCores?: number | null;
  maxMemoryGb?: number | null;
  maxStorageGb?: number | null;
  vlanIds?: number[];
}

// A safe, non-sensitive summary for the public invite page and admin list.
// Resolves the role name and VLAN labels; never leaks the token.
export async function summarizeInvitePreset(preset: StoredInvitePreset | null | undefined) {
  const p = preset || {};
  let role: { id: number; name: string } | null = null;
  if (p.roleId) {
    const [r] = await db.select({ id: roles.id, name: roles.name }).from(roles).where(eq(roles.id, p.roleId)).limit(1);
    if (r) role = { id: r.id, name: r.name };
  }
  const perms = p.permissions || {};
  const grantedPermissions = INVITE_PERMISSION_COLUMNS.filter((k) => perms[k]);
  // One IN query resolves all VLAN labels (was a query per id); the result is
  // re-mapped through the preset's order, dropping ids that no longer exist.
  const vlanIds = (p.vlanIds || []).filter((id) => Number.isInteger(id));
  let vlanSummaries: { id: number; name: string; tag: number }[] = [];
  if (vlanIds.length) {
    const rows = await db
      .select({ id: vlans.id, name: vlans.name, tag: vlans.tag })
      .from(vlans)
      .where(inArray(vlans.id, vlanIds));
    const byId = new Map(rows.map((v) => [v.id, v]));
    vlanSummaries = vlanIds.flatMap((id) => byId.get(id) ?? []);
  }
  return {
    isAdmin: !!p.isAdmin,
    role,
    grantedPermissions,
    quotas: {
      maxCores: p.maxCores ?? null,
      maxMemoryGb: p.maxMemoryGb ?? null,
      maxStorageGb: p.maxStorageGb ?? null,
    },
    vlans: vlanSummaries,
  };
}
