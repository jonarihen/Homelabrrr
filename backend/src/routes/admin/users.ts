import { Router } from 'express';
import { createHash } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { and, eq, desc, inArray, sql } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import { users, roles, rolePermissions, apiTokens, vmAssignments, userVlans, loginAttempts, recoveryCodes } from '../../db/schema/index.ts';
import { isUniqueViolation, isForeignKeyViolation } from '../../db/errors.ts';
import { getAllVMs } from '../../proxmox.ts';
import { requireAdmin, requireInteractiveSession } from '../../middleware/auth.ts';
import { sanitizeError } from '../../utils/sanitize.ts';
import { logAudit, logAuditTx } from '../../utils/audit.ts';
import { syncVmTagsSafe } from '../../utils/vmTags.ts';
import { validateObject, validatePassword, validateUsername } from '../../utils/validation.ts';
import { changeCredentials } from '../../utils/accountSecurity.ts';
import { pAssignments, pUsers } from './shared.ts';
import { LOCKOUT_MAX, LOCKOUT_WINDOW_MS, ensureCanManageTargetUser, parseQuotaValue, parseRoleId, roleRef } from './userHelpers.ts';

const router = Router();

// ─── Users ────────────────────────────────────────────────────────────────────



router.get('/users', pUsers, async (req, res) => {
  const windowStart = Date.now() - LOCKOUT_WINDOW_MS;
  // Correlated per-user aggregates (VM count, recent failures, worst per-IP
  // failure streak). Computed as subquery scalars so the row shape is unchanged.
  // PostgreSQL COUNT()/MAX(COUNT()) are bigint, which pg hands back as a string;
  // `sql<number>` is only a type assertion, so mapWith(Number) is what actually
  // keeps these numbers in the JSON (they were numbers under SQLite).
  const la = loginAttempts;
  const vmCountSq = sql<number>`(SELECT COUNT(*) FROM ${vmAssignments} WHERE ${vmAssignments.user_id} = ${users.id})`.mapWith(Number);
  const recentFailuresSq = sql<number>`(SELECT COUNT(*) FROM ${la} WHERE ${la.username} = ${users.username} AND ${la.attempted_at} > ${windowStart})`.mapWith(Number);
  const maxIpFailuresSq = sql<number>`(SELECT COALESCE(MAX(ip_count), 0) FROM (
        SELECT COUNT(*) AS ip_count FROM ${la}
        WHERE ${la.username} = ${users.username} AND ${la.attempted_at} > ${windowStart} GROUP BY ${la.ip}
      ) AS s)`.mapWith(Number);
  const rows = await db.select({
    id: users.id, username: users.username, is_admin: users.is_admin, see_all_vms: users.see_all_vms,
    can_operate_all_vms: users.can_operate_all_vms, can_provision: users.can_provision, can_create_vms: users.can_create_vms,
    totp_enabled: users.totp_enabled, require_2fa: users.require_2fa,
    can_manage_hosts: users.can_manage_hosts, can_manage_firewalls: users.can_manage_firewalls,
    can_manage_port_forwards: users.can_manage_port_forwards, can_manage_vlans: users.can_manage_vlans,
    can_manage_policies: users.can_manage_policies, can_manage_templates: users.can_manage_templates,
    can_manage_users: users.can_manage_users, can_manage_assignments: users.can_manage_assignments,
    can_view_audit_log: users.can_view_audit_log, can_edit_vm_hardware: users.can_edit_vm_hardware,
    can_manage_websites: users.can_manage_websites, can_manage_public_ips: users.can_manage_public_ips,
    created_at: users.created_at, role_id: users.role_id, role_name: roles.name,
    max_cores: users.max_cores, max_memory_gb: users.max_memory_gb, max_storage_gb: users.max_storage_gb,
    vm_count: vmCountSq,
    recent_failures: recentFailuresSq,
    max_ip_failures: maxIpFailuresSq,
  }).from(users)
    .leftJoin(roles, eq(roles.id, users.role_id))
    .orderBy(users.username);
  // Lockout is per (username, ip) — a user counts as locked when any single
  // address has hit the limit
  res.json(rows.map(u => ({ ...u, locked: u.max_ip_failures >= LOCKOUT_MAX, twoFactorEnabled: !!u.totp_enabled, require2fa: !!u.require_2fa, canProvision: !!u.can_provision, canCreateVms: !!u.can_create_vms })));
});

router.post('/users', pUsers, async (req, res) => {
  let username;
  let password;
  let isAdmin;
  try {
    validateObject(req.body, { fields: ['username', 'password', 'isAdmin'], required: ['username', 'password'] });
    ({ isAdmin } = req.body);
    username = validateUsername(req.body?.username);
    password = validatePassword(req.body?.password);
  } catch (err) {
    return res.status(400).json({ error: err.message, code: err.code, field: err.field });
  }
  if (isAdmin && !req.session.isAdmin) {
    return res.status(403).json({ error: 'Only admins can create admin accounts' });
  }
  const hash = bcrypt.hashSync(password, 10);
  try {
    const [r] = await db.insert(users).values({ username, password: hash, is_admin: !!isAdmin }).returning({ id: users.id });
    await logAudit(req, 'admin_create_user', username, '');
    res.json({ id: r.id, username, isAdmin: !!isAdmin });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return res.status(400).json({ error: 'Username already exists' });
    }
    throw err;
  }
});

router.post('/users/:id/reset-2fa', requireAdmin, async (req, res) => {
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, Number(req.params.id))).limit(1);
  if (!user) return res.status(404).json({ error: 'User not found' });
  // Credential reset ends the target's sessions (the admin's own is kept if self-targeted).
  const { version, revoked } = await changeCredentials(db, user.id, { totp_enabled: false, totp_secret: null }, req.sessionID);
  if (user.id === req.session.userId) req.session.credentialsVersion = version;
  await db.delete(recoveryCodes).where(eq(recoveryCodes.user_id, user.id));
  await logAudit(req, 'admin_reset_2fa', req.params.id, `revoked_sessions=${revoked}`);
  res.json({ ok: true });
});

// ─── API tokens (admin oversight) ─────────────────────────────────────────────
// Admins (or can_manage_users delegates, within ensureCanManageTargetUser) can
// list and revoke a user's personal API tokens. Token secrets/hashes are never exposed. Interactive-session only.

router.get('/users/:id/tokens', requireInteractiveSession, pUsers, async (req, res) => {
  if (!await ensureCanManageTargetUser(req, res, req.params.id)) return;
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, Number(req.params.id))).limit(1);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const rows = await db.select({
    id: apiTokens.id, name: apiTokens.name, scopes: apiTokens.scopes,
    created_at: apiTokens.created_at, expires_at: apiTokens.expires_at, last_used_at: apiTokens.last_used_at,
  }).from(apiTokens).where(eq(apiTokens.user_id, Number(req.params.id))).orderBy(desc(apiTokens.created_at));
  res.json(rows.map(r => ({
    id: r.id,
    name: r.name,
    scopes: String(r.scopes || 'read').split(',').filter(Boolean),
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    lastUsedAt: r.last_used_at,
    expired: !!r.expires_at && r.expires_at.getTime() < Date.now(),
  })));
});

router.delete('/tokens/:id', requireInteractiveSession, pUsers, async (req, res) => {
  const [token] = await db.select({ id: apiTokens.id, name: apiTokens.name, userId: apiTokens.user_id, username: users.username })
    .from(apiTokens)
    .innerJoin(users, eq(users.id, apiTokens.user_id))
    .where(eq(apiTokens.id, Number(req.params.id))).limit(1);
  if (!token) return res.status(404).json({ error: 'Token not found' });
  if (!await ensureCanManageTargetUser(req, res, token.userId)) return;
  await db.delete(apiTokens).where(eq(apiTokens.id, token.id));
  await logAudit(req, 'admin_revoke_api_token', token.name, `owner: ${token.username}`);
  res.json({ ok: true });
});

router.post('/users/:id/unlock', pUsers, async (req, res) => {
  if (!await ensureCanManageTargetUser(req, res, req.params.id)) return;
  const [user] = await db.select({ username: users.username }).from(users).where(eq(users.id, Number(req.params.id))).limit(1);
  if (!user) return res.status(404).json({ error: 'User not found' });
  await db.delete(loginAttempts).where(eq(loginAttempts.username, user.username));
  await logAudit(req, 'admin_unlock_user', req.params.id, '');
  res.json({ ok: true });
});

router.put('/users/:id/username', pUsers, async (req, res) => {
  if (!await ensureCanManageTargetUser(req, res, req.params.id)) return;
  let username;
  try { username = validateUsername(req.body?.username); }
  catch (err) { return res.status(400).json({ error: err.message, code: err.code, field: err.field }); }
  const [previous] = await db.select({ username: users.username }).from(users).where(eq(users.id, Number(req.params.id))).limit(1);
  try {
    await db.update(users).set({ username }).where(eq(users.id, Number(req.params.id)));
    await retagUserVms(req.params.id, previous?.username);
    res.json({ ok: true });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return res.status(400).json({ error: 'Username already taken' });
    }
    throw err;
  }
});

// Re-stamp the PVE owner tag on a user's VMs after a rename; the old
// username no longer exists in the users table, so pass it as retired.
async function retagUserVms(userId, previousUsername) {
  const vms = await db.select({ node: vmAssignments.node, vmid: vmAssignments.vmid })
    .from(vmAssignments).where(eq(vmAssignments.user_id, Number(userId)));
  for (const vm of vms) {
    await syncVmTagsSafe(vm.node, vm.vmid, { retired: [previousUsername].filter(Boolean) });
  }
}

router.put('/users/:id/password', pUsers, async (req, res) => {
  if (!await ensureCanManageTargetUser(req, res, req.params.id)) return;
  let password;
  try { password = validatePassword(req.body?.password); }
  catch (err) { return res.status(400).json({ error: err.message, code: err.code, field: err.field }); }
  const hash = bcrypt.hashSync(password, 10);
  const { version, revoked } = await changeCredentials(db, Number(req.params.id), { password: hash }, req.sessionID);
  if (Number(req.params.id) === req.session.userId) req.session.credentialsVersion = version;
  await logAudit(req, 'admin_reset_password', req.params.id, `revoked_sessions=${revoked}`);
  res.json({ ok: true });
});

router.put('/users/:id/require-2fa', requireAdmin, async (req, res) => {
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, Number(req.params.id))).limit(1);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { enabled } = req.body;
  await db.update(users).set({ require_2fa: !!enabled }).where(eq(users.id, Number(req.params.id)));
  res.json({ ok: true });
});

router.put('/users/:id/see-all-vms', requireAdmin, async (req, res) => {
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, Number(req.params.id))).limit(1);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { enabled } = req.body;
  await db.update(users).set({ see_all_vms: !!enabled }).where(eq(users.id, Number(req.params.id)));
  res.json({ ok: true });
});

router.put('/users/:id/can-provision', requireAdmin, async (req, res) => {
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, Number(req.params.id))).limit(1);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { enabled } = req.body;
  await db.update(users).set({ can_provision: !!enabled }).where(eq(users.id, Number(req.params.id)));
  res.json({ ok: true });
});

router.put('/users/:id/can-create-vms', requireAdmin, async (req, res) => {
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, Number(req.params.id))).limit(1);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { enabled } = req.body;
  await db.update(users).set({ can_create_vms: !!enabled }).where(eq(users.id, Number(req.params.id)));
  await logAudit(req, 'admin_toggle_permission', req.params.id, `can_create_vms=${enabled ? 1 : 0}`);
  res.json({ ok: true });
});

// Permission toggle endpoint for all granular permissions
const TOGGLEABLE_PERMISSIONS = ['can_operate_all_vms', 'can_manage_hosts', 'can_manage_firewalls', 'can_manage_port_forwards', 'can_manage_vlans', 'can_manage_policies', 'can_manage_templates', 'can_manage_users', 'can_manage_assignments', 'can_view_audit_log', 'can_edit_vm_hardware', 'can_manage_websites', 'can_manage_public_ips'] as const;

router.put('/users/:id/permission', requireAdmin, async (req, res) => {
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, Number(req.params.id))).limit(1);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { permission, enabled } = req.body;
  if (!TOGGLEABLE_PERMISSIONS.includes(permission)) {
    return res.status(400).json({ error: `Invalid permission: ${permission}` });
  }
  // `permission` is whitelisted above and the schema property keys equal the
  // column names, so a computed-key set targets exactly that boolean column —
  // no raw identifier is ever interpolated into SQL text.
  await db.update(users).set({ [permission]: !!enabled } as any).where(eq(users.id, Number(req.params.id)));
  await logAudit(req, 'admin_toggle_permission', req.params.id, `${permission}=${enabled ? 1 : 0}`);
  res.json({ ok: true });
});

// ─── Quotas ───────────────────────────────────────────────────────────────────


router.put('/users/:id/quotas', requireAdmin, async (req, res) => {
  const [user] = await db.select({ id: users.id, username: users.username }).from(users).where(eq(users.id, Number(req.params.id))).limit(1);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const maxCores = parseQuotaValue(req.body.maxCores);
  const maxMemoryGb = parseQuotaValue(req.body.maxMemoryGb);
  const maxStorageGb = parseQuotaValue(req.body.maxStorageGb);
  if (maxCores === undefined || maxMemoryGb === undefined || maxStorageGb === undefined) {
    return res.status(400).json({ error: 'Quota values must be non-negative integers (empty = unlimited)' });
  }

  await db.update(users).set({ max_cores: maxCores, max_memory_gb: maxMemoryGb, max_storage_gb: maxStorageGb })
    .where(eq(users.id, user.id));
  await logAudit(req, 'admin_set_quotas', user.username,
    `cores=${maxCores ?? '∞'} memory=${maxMemoryGb ?? '∞'}GB storage=${maxStorageGb ?? '∞'}GB`);
  res.json({ ok: true });
});

// ─── Staged user edits (batch apply) ──────────────────────────────────────────
// The Manage User modal stages every change locally and applies them here in
// one transaction. `version` is a digest of the editable state the client
// loaded; a mismatch means someone else changed the user meanwhile (409).


const USER_FLAG_KEYS = ['see_all_vms', 'can_provision', 'can_create_vms', ...TOGGLEABLE_PERMISSIONS] as const;
const USER_PATCH_FIELDS = ['version', 'roleId', 'roleVersion', 'permissions', 'require2fa', 'quotas', 'vms', 'vlans'];
const MAX_BATCH_ITEMS = 500;
const roleDefinitionVersion = (role) => createHash('sha256').update(JSON.stringify(role)).digest('hex').slice(0, 24);

class PatchError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function loadUserState(executor, userId, { lock = false } = {}) {
  let q = executor.select().from(users).where(eq(users.id, userId)).limit(1);
  if (lock) q = q.for('update');
  const [row] = await q;
  if (!row) return null;
  let roleQuery = executor.select().from(roles).orderBy(roles.id);
  if (lock) roleQuery = roleQuery.for('share');
  const roleRows = await roleQuery;
  const rolePerms = await executor.select().from(rolePermissions)
    .orderBy(rolePermissions.role_id, rolePermissions.permission);
  const roleDefinitions = roleRows.map((r) => ({
    id: r.id, name: r.name, permissions: rolePerms.filter((p) => p.role_id === r.id).map((p) => p.permission),
    max_cores: r.max_cores, max_memory_gb: r.max_memory_gb, max_storage_gb: r.max_storage_gb,
  }));
  const vms = await executor.select({ id: vmAssignments.id, node: vmAssignments.node, vmid: vmAssignments.vmid })
    .from(vmAssignments).where(eq(vmAssignments.user_id, userId)).orderBy(vmAssignments.id);
  const vlanRows = await executor.select({ vlan_id: userVlans.vlan_id })
    .from(userVlans).where(eq(userVlans.user_id, userId)).orderBy(userVlans.vlan_id);
  const state = {
    id: row.id,
    username: row.username,
    is_admin: !!row.is_admin,
    role_id: row.role_id ?? null,
    permissions: Object.fromEntries(USER_FLAG_KEYS.map((k) => [k, !!row[k]])),
    require_2fa: !!row.require_2fa,
    quotas: { max_cores: row.max_cores ?? null, max_memory_gb: row.max_memory_gb ?? null, max_storage_gb: row.max_storage_gb ?? null },
    vms: vms.map((v) => ({ id: v.id, node: v.node, vmid: v.vmid })),
    vlan_ids: vlanRows.map((v) => v.vlan_id),
    roleDefinitions: roleDefinitions.map((r) => ({ ...r, version: roleDefinitionVersion(r) })),
  };
  const versionState = {
    ...state,
    roleDefinitions: state.roleDefinitions.filter((r) => r.id === state.role_id),
  };
  const version = createHash('sha256').update(JSON.stringify(versionState)).digest('hex').slice(0, 24);
  return { ...state, version };
}

function patchSection(value, field, allowed, required = []) {
  try { return validateObject(value, { fields: allowed, required }); }
  catch (err) { throw new PatchError(400, `${field}: ${err.message}`); }
}

function parseIdList(value, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_BATCH_ITEMS) throw new PatchError(400, `${field} must be a list`);
  const ids = value.map(parseRoleId);
  if (ids.some((id) => id === null)) throw new PatchError(400, `${field} must contain integer ids`);
  return [...new Set(ids)];
}

// Validates the whole body before anything is written and returns a normalized
// plan. Each sub-change is gated on its own permission, not just the route's.
function planUserPatch(body, isAdmin) {
  try { validateObject(body, { fields: USER_PATCH_FIELDS }); }
  catch (err) { throw new PatchError(400, err.message); }
  const plan: any = { version: body.version };
  const privileged = ['roleId', 'permissions', 'require2fa', 'quotas'].filter((k) => body[k] !== undefined);
  if (privileged.length && !isAdmin) throw new PatchError(403, `Only admins can change ${privileged.join(', ')}`);

  if (body.version !== undefined && typeof body.version !== 'string') throw new PatchError(400, 'version must be a string');

  if (body.roleId !== undefined) {
    if (body.roleId === null || body.roleId === '') plan.roleId = null;
    else {
      plan.roleId = parseRoleId(body.roleId);
      if (plan.roleId === null) throw new PatchError(400, 'roleId must be an integer or null');
      if (typeof body.roleVersion !== 'string' || !/^[a-f0-9]{24}$/.test(body.roleVersion)) {
        throw new PatchError(400, 'roleVersion required when assigning a role');
      }
      plan.roleVersion = body.roleVersion;
    }
  } else if (body.roleVersion !== undefined) {
    throw new PatchError(400, 'roleVersion requires roleId');
  }
  if (body.permissions !== undefined) {
    if (!body.permissions || typeof body.permissions !== 'object' || Array.isArray(body.permissions)) {
      throw new PatchError(400, 'permissions must be an object of key → boolean');
    }
    plan.permissions = {};
    for (const [key, value] of Object.entries(body.permissions)) {
      if (!(USER_FLAG_KEYS as readonly string[]).includes(key)) throw new PatchError(400, `Invalid permission: ${key}`);
      if (typeof value !== 'boolean') throw new PatchError(400, `Permission ${key} must be true or false`);
      plan.permissions[key] = value;
    }
  }
  if (body.require2fa !== undefined) {
    if (typeof body.require2fa !== 'boolean') throw new PatchError(400, 'require2fa must be true or false');
    plan.require2fa = body.require2fa;
  }
  if (body.quotas !== undefined) {
    const q = patchSection(body.quotas, 'quotas', ['maxCores', 'maxMemoryGb', 'maxStorageGb']);
    if (Object.keys(q).length === 0) throw new PatchError(400, 'quotas must include a quota value');
    plan.quotas = {};
    for (const [key, column] of [['maxCores', 'max_cores'], ['maxMemoryGb', 'max_memory_gb'], ['maxStorageGb', 'max_storage_gb']]) {
      if (!(key in q)) continue;
      const value = parseQuotaValue(q[key]);
      if (value === undefined) throw new PatchError(400, 'Quota values must be non-negative integers (empty = unlimited)');
      plan.quotas[column] = value;
    }
  }
  if (body.vms !== undefined) {
    const v = patchSection(body.vms, 'vms', ['add', 'remove']);
    const add = v.add === undefined ? [] : v.add;
    if (!Array.isArray(add) || add.length > MAX_BATCH_ITEMS) throw new PatchError(400, 'vms.add must be a list');
    plan.vmAdd = add.map((raw) => {
      const item = patchSection(raw, 'vms.add item', ['node', 'vmid'], ['node', 'vmid']);
      const node = typeof item.node === 'string' ? item.node.trim() : '';
      const vmid = parseRoleId(item.vmid);
      if (!node || node.length > 255 || vmid === null) throw new PatchError(400, 'Each VM needs a node and integer vmid');
      return { node, vmid };
    });
    plan.vmRemove = parseIdList(v.remove, 'vms.remove');
  }
  if (body.vlans !== undefined) {
    const v = patchSection(body.vlans, 'vlans', ['add', 'remove']);
    plan.vlanAdd = parseIdList(v.add, 'vlans.add');
    plan.vlanRemove = parseIdList(v.remove, 'vlans.remove');
    if (plan.vlanAdd.some((id) => plan.vlanRemove.includes(id))) throw new PatchError(400, 'A VLAN cannot be both added and removed');
  }
  return plan;
}

router.get('/users/:id/state', pAssignments, async (req, res) => {
  const userId = parseRoleId(req.params.id);
  const state = userId === null ? null : await loadUserState(db, userId);
  if (!state) return res.status(404).json({ error: 'User not found' });
  res.json(state);
});

async function syncBatchVmTags(vms) {
  const unique = [...new Map(vms.map((vm) => [`${vm.node}/${vm.vmid}`, vm])).values()];
  let cursor = 0;
  const worker = async () => {
    while (cursor < unique.length) {
      const vm = unique[cursor++];
      await syncVmTagsSafe(vm.node, vm.vmid);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, unique.length) }, worker));
}

router.patch('/users/:id', pAssignments, async (req, res) => {
  const userId = parseRoleId(req.params.id);
  if (userId === null) return res.status(404).json({ error: 'User not found' });
  const isAdmin = !!req.session.isAdmin;

  let plan;
  try { plan = planUserPatch(req.body, isAdmin); }
  catch (err) {
    if (err instanceof PatchError) return res.status(err.status).json({ error: err.message });
    throw err;
  }

  const audits = [];
  const tagSync = [];
  let after;
  try {
    after = await db.transaction(async (tx) => {
      const before = await loadUserState(tx, userId, { lock: true });
      if (!before) throw new PatchError(404, 'User not found');
      if (before.is_admin && !isAdmin) throw new PatchError(403, 'Only admins can modify admin accounts');
      if (plan.version !== undefined && plan.version !== before.version) {
        throw new PatchError(409, 'This user was changed by someone else since you opened it — reload to see the latest state');
      }
      if (plan.roleVersion) {
        const definition = before.roleDefinitions.find((r) => r.id === plan.roleId);
        if (!definition) throw new PatchError(400, 'Role not found');
        if (definition.version !== plan.roleVersion) {
          throw new PatchError(409, 'The destination role changed since you reviewed it — reload and try again');
        }
      }

      const patch: any = {};
      if (plan.roleId !== undefined && plan.roleId !== before.role_id) {
        let roleName = 'none';
        if (plan.roleId !== null) {
          const [role] = await tx.select({ id: roles.id, name: roles.name }).from(roles).where(eq(roles.id, plan.roleId)).limit(1);
          if (!role) throw new PatchError(400, 'Role not found');
          roleName = role.name;
        }
        patch.role_id = plan.roleId;
        audits.push({ action: 'admin_assign_role', target: before.username, detail: roleName, targetRef: plan.roleId === null ? null : roleRef(plan.roleId) });
        if (before.role_id != null) {
          audits.push({
            action: 'admin_unassign_role', target: before.username,
            detail: plan.roleId === null ? 'role removed' : `moved to ${roleName}`,
            targetRef: roleRef(before.role_id),
          });
        }
      }
      for (const [key, value] of Object.entries(plan.permissions || {})) {
        if (before.permissions[key] === value) continue;
        patch[key] = value;
        audits.push({ action: 'admin_toggle_permission', target: String(userId), detail: `${key}=${value ? 1 : 0}` });
      }
      if (plan.require2fa !== undefined && plan.require2fa !== before.require_2fa) {
        patch.require_2fa = plan.require2fa;
        audits.push({ action: 'admin_toggle_permission', target: String(userId), detail: `require_2fa=${plan.require2fa ? 1 : 0}` });
      }
      if (plan.quotas) {
        const q = { ...before.quotas, ...plan.quotas };
        const changed = Object.keys(q).some((k) => q[k] !== before.quotas[k]);
        if (changed) {
          Object.assign(patch, plan.quotas);
          audits.push({
            action: 'admin_set_quotas', target: before.username,
            detail: `cores=${q.max_cores ?? '∞'} memory=${q.max_memory_gb ?? '∞'}GB storage=${q.max_storage_gb ?? '∞'}GB`,
          });
        }
      }
      if (Object.keys(patch).length) await tx.update(users).set(patch).where(eq(users.id, userId));

      if (plan.vmRemove?.length) {
        const removed = await tx.delete(vmAssignments)
          .where(and(eq(vmAssignments.user_id, userId), inArray(vmAssignments.id, plan.vmRemove)))
          .returning({ node: vmAssignments.node, vmid: vmAssignments.vmid });
        if (removed.length !== plan.vmRemove.length) throw new PatchError(409, 'A VM assignment to remove no longer exists — reload and try again');
        for (const r of removed) {
          tagSync.push(r);
          audits.push({ action: 'admin_unassign_vm', target: before.username, detail: `${r.node}/${r.vmid}` });
        }
      }
      for (const vm of plan.vmAdd || []) {
        await tx.insert(vmAssignments).values({ user_id: userId, node: vm.node, vmid: vm.vmid });
        tagSync.push(vm);
        audits.push({ action: 'admin_assign_vm', target: before.username, detail: `${vm.node}/${vm.vmid}` });
      }

      if (plan.vlanRemove?.length) {
        const removed = await tx.delete(userVlans)
          .where(and(eq(userVlans.user_id, userId), inArray(userVlans.vlan_id, plan.vlanRemove)))
          .returning({ vlan_id: userVlans.vlan_id });
        if (removed.length !== plan.vlanRemove.length) throw new PatchError(409, 'A VLAN to remove is no longer assigned — reload and try again');
        for (const r of removed) audits.push({ action: 'admin_unassign_vlan', target: before.username, detail: String(r.vlan_id) });
      }
      if (plan.vlanAdd?.length) {
        await tx.insert(userVlans).values(plan.vlanAdd.map((vlanId) => ({ user_id: userId, vlan_id: vlanId })));
        for (const id of plan.vlanAdd) audits.push({ action: 'admin_assign_vlan', target: before.username, detail: String(id) });
      }

      // Audit rows ride the same transaction: the trail and the change commit
      // (or roll back) together.
      await logAuditTx(tx, req, audits);
      return loadUserState(tx, userId, {});
    });
  } catch (err) {
    if (err instanceof PatchError) return res.status(err.status).json({ error: err.message });
    if (err?.code === '40P01' || err?.cause?.code === '40P01') {
      return res.status(409).json({ error: 'A concurrent role change conflicted with this edit — reload and try again' });
    }
    if (isUniqueViolation(err)) return res.status(400).json({ error: 'A VM or VLAN in this change is already assigned' });
    if (isForeignKeyViolation(err)) return res.status(400).json({ error: 'A VLAN in this change no longer exists' });
    throw err;
  }

  res.json({ ...after, applied: audits.length });
  void syncBatchVmTags(tagSync);
});

// Per-user allocated usage for the Users page — one resource-list call
// covers every user, so this stays cheap even with many accounts.
router.get('/user-usage', pUsers, async (req, res) => {
  try {
    const assignments = await db.select({ user_id: vmAssignments.user_id, vmid: vmAssignments.vmid }).from(vmAssignments);
    const byUser = new Map();
    for (const a of assignments) {
      if (!byUser.has(a.user_id)) byUser.set(a.user_id, new Set());
      byUser.get(a.user_id).add(Number(a.vmid));
    }
    const vms = await getAllVMs();
    const vmByVmid = new Map(vms.map((v) => [Number(v.vmid), v]));
    const GB = 1024 ** 3;

    const usage = {};
    for (const [userId, vmids] of byUser) {
      const u = { cores: 0, memoryGb: 0, diskGb: 0, vmCount: 0 };
      for (const vmid of vmids) {
        const vm = vmByVmid.get(vmid);
        if (!vm) continue;
        u.vmCount += 1;
        u.cores += vm.maxcpu || 0;
        u.memoryGb += (vm.maxmem || 0) / GB;
        u.diskGb += (vm.maxdisk || 0) / GB;
      }
      u.memoryGb = Math.round(u.memoryGb * 10) / 10;
      u.diskGb = Math.round(u.diskGb * 10) / 10;
      usage[userId] = u;
    }
    res.json(usage);
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

export default router;
