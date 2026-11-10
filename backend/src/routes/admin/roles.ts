import { Router } from 'express';
import { eq, desc, inArray, sql, count } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import { users, roles, rolePermissions } from '../../db/schema/index.ts';
import { isUniqueViolation, isForeignKeyViolation } from '../../db/errors.ts';
import { requireAdmin } from '../../middleware/auth.ts';
import { logAudit } from '../../utils/audit.ts';
import { PERMISSION_KEYS } from '../../utils/permissions.ts';
import { boundedString } from '../../utils/validation.ts';
import { pUsers } from './shared.ts';
import { parseQuotaValue, parseRoleId, roleRef } from './userHelpers.ts';

const router = Router();

// ─── Roles (RBAC) ─────────────────────────────────────────────────────────────
// Mutations are requireAdmin (editing a role changes live permissions of every
// holder, same weight class as the per-user permission toggles). Reading is
// pUsers so the Users page can render role names.

async function serializeRole(role) {
  const perms = await db.select({ permission: rolePermissions.permission }).from(rolePermissions)
    .where(eq(rolePermissions.role_id, role.id));
  const [uc] = await db.select({ c: count() }).from(users).where(eq(users.role_id, role.id));
  return {
    ...role,
    builtIn: role.built_in === true,
    permissions: perms.map((r) => r.permission),
    userCount: uc.c,
  };
}

function validatePermissionList(permissions) {
  if (!Array.isArray(permissions)) return null;
  const unique = [...new Set(permissions)];
  if (unique.some((p) => !PERMISSION_KEYS.includes(p))) return null;
  return unique;
}

// Replaces a role's permission set. Takes the caller's `tx` so the replacement
// commits or rolls back together with the rest of the role write.
async function setRolePermissions(tx, roleId, permissions) {
  await tx.delete(rolePermissions).where(eq(rolePermissions.role_id, roleId));
  if (permissions.length > 0) {
    await tx.insert(rolePermissions).values(permissions.map((p) => ({ role_id: roleId, permission: p })));
  }
}

// Ids are PostgreSQL `integer` columns. Anything that isn't a positive int32 —
// non-numeric, fractional, or out of range — becomes null so lookups answer
// 404/400 instead of letting PostgreSQL reject the bound parameter with a 500.


class RoleConflict extends Error {
  status: number;
  constructor(message, status = 409) {
    super(message);
    this.status = status;
  }
}

// A membership change shows up in both roles' history: the destination gets
// `admin_assign_role`, the role the user left gets `admin_unassign_role`.
async function auditRoleChange(req, username, previousRoleId, nextRole) {
  if (nextRole) {
    await logAudit(req, 'admin_assign_role', username, nextRole.name, 'success', roleRef(nextRole.id));
  } else {
    await logAudit(req, 'admin_assign_role', username, 'none');
  }
  if (previousRoleId != null && previousRoleId !== nextRole?.id) {
    await logAudit(req, 'admin_unassign_role', username,
      nextRole ? `moved to ${nextRole.name}` : 'role removed', 'success', roleRef(previousRoleId));
  }
}

async function findRole(id) {
  const roleId = parseRoleId(id);
  if (roleId === null) return null;
  const [role] = await db.select().from(roles).where(eq(roles.id, roleId)).limit(1);
  return role || null;
}

const ROLE_NAME_MAX = 100;

// "<base> (copy)", then "<base> (copy 2)", … — the first name nobody holds.
async function nextCopyName(tx, base) {
  const stem = `${base} (copy`;
  const taken = new Set((await tx.select({ name: roles.name }).from(roles)
    .where(sql`${roles.name} LIKE ${`${stem.replace(/[\\%_]/g, '\\$&')}%`}`)).map((r) => r.name));
  if (!taken.has(`${stem})`)) return `${stem})`;
  for (let i = 2; ; i += 1) {
    const candidate = `${stem} ${i})`;
    if (!taken.has(candidate)) return candidate;
  }
}

router.get('/roles', pUsers, async (req, res) => {
  const roleRows = await db.select().from(roles).orderBy(desc(roles.built_in), roles.name);
  res.json({ roles: await Promise.all(roleRows.map(serializeRole)), permissionKeys: PERMISSION_KEYS });
});

router.get('/roles/:id/users', pUsers, async (req, res) => {
  const role = await findRole(req.params.id);
  if (!role) return res.status(404).json({ error: 'Role not found' });
  const holders = await db.select({ id: users.id, username: users.username, is_admin: users.is_admin })
    .from(users).where(eq(users.role_id, role.id)).orderBy(users.username);
  res.json(holders);
});

// Duplicates a role's description, permissions and quotas under a new name.
// Built-in roles can be cloned; the copy is always a regular, editable role.
router.post('/roles/:id/clone', requireAdmin, async (req, res) => {
  const source = await findRole(req.params.id);
  if (!source) return res.status(404).json({ error: 'Role not found' });

  let explicitName = null;
  if (req.body?.name !== undefined && req.body?.name !== null && req.body?.name !== '') {
    try { explicitName = boundedString(req.body.name, { field: 'name', min: 1, max: ROLE_NAME_MAX }); }
    catch (err) { return res.status(400).json({ error: err.message, field: err.field }); }
  }

  // The source row is locked and its permissions read inside the clone
  // transaction, so a concurrent edit or delete can't produce a half-old copy
  // (or an empty one, after the permission rows cascade away).
  let result;
  try {
    result = await db.transaction(async (tx) => {
      if (explicitName === null) {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(1213157460, ${source.id})`);
      }
      const [locked] = await tx.select().from(roles).where(eq(roles.id, source.id)).limit(1).for('share');
      if (!locked) return null;
      const perms = await tx.select({ permission: rolePermissions.permission }).from(rolePermissions)
        .where(eq(rolePermissions.role_id, locked.id));
      const name = explicitName ?? await nextCopyName(tx, locked.name);
      const [row] = await tx.insert(roles).values({
        name,
        description: locked.description || '',
        max_cores: locked.max_cores,
        max_memory_gb: locked.max_memory_gb,
        max_storage_gb: locked.max_storage_gb,
      }).returning();
      await setRolePermissions(tx, row.id, perms.map((p) => p.permission));
      return { row, sourceName: locked.name };
    });
  } catch (err) {
    if (isUniqueViolation(err)) return res.status(400).json({ error: 'Role name already exists' });
    throw err;
  }
  if (!result) return res.status(404).json({ error: 'Role not found' });
  await logAudit(req, 'admin_clone_role', result.row.name, `from: ${result.sourceName}`, 'success', roleRef(result.row.id));
  res.json(await serializeRole(result.row));
});

// Assigns one role to several users at once — all-or-nothing.
router.post('/roles/:id/assign', requireAdmin, async (req, res) => {
  const role = await findRole(req.params.id);
  if (!role) return res.status(404).json({ error: 'Role not found' });
  const { userIds } = req.body || {};
  if (!Array.isArray(userIds) || userIds.length === 0 || userIds.length > 500) {
    return res.status(400).json({ error: 'userIds must be a non-empty list' });
  }
  const ids = [...new Set(userIds.map(parseRoleId))];
  if (ids.some((id) => id === null)) return res.status(400).json({ error: 'userIds must be integers' });

  let changing;
  try {
    changing = await db.transaction(async (tx) => {
      const [currentRole] = await tx.select({ id: roles.id }).from(roles)
        .where(eq(roles.id, role.id)).for('share');
      if (!currentRole) throw new RoleConflict('Role was removed — reload and try again');
      const targets = await tx.select({ id: users.id, username: users.username, role_id: users.role_id })
        .from(users).where(inArray(users.id, ids)).orderBy(users.id).for('update');
      if (targets.length !== ids.length) throw new RoleConflict('One or more users not found', 400);
      const changed = targets.filter((u) => u.role_id !== role.id);
      if (changed.length) {
        await tx.update(users).set({ role_id: role.id }).where(inArray(users.id, changed.map((u) => u.id)));
      }
      return changed;
    });
  } catch (err) {
    if (err instanceof RoleConflict) return res.status(err.status).json({ error: err.message });
    if (isForeignKeyViolation(err)) return res.status(409).json({ error: 'Role was removed — reload and try again' });
    if (err?.code === '40P01' || err?.cause?.code === '40P01') {
      return res.status(409).json({ error: 'Concurrent role change — retry' });
    }
    throw err;
  }
  for (const u of changing) await auditRoleChange(req, u.username, u.role_id, role);
  res.json({ ok: true, assigned: changing.length });
});

router.post('/roles', requireAdmin, async (req, res) => {
  const { name, description = '', permissions = [] } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Role name required' });
  const perms = validatePermissionList(permissions);
  if (!perms) return res.status(400).json({ error: 'Invalid permission list' });
  const maxCores = parseQuotaValue(req.body.maxCores);
  const maxMemoryGb = parseQuotaValue(req.body.maxMemoryGb);
  const maxStorageGb = parseQuotaValue(req.body.maxStorageGb);
  if (maxCores === undefined || maxMemoryGb === undefined || maxStorageGb === undefined) {
    return res.status(400).json({ error: 'Quota values must be non-negative integers (empty = unlimited)' });
  }
  try {
    const r = await db.transaction(async (tx) => {
      const [row] = await tx.insert(roles).values({
        name: String(name).trim(), description: String(description),
        max_cores: maxCores, max_memory_gb: maxMemoryGb, max_storage_gb: maxStorageGb,
      }).returning({ id: roles.id });
      await setRolePermissions(tx, row.id, perms);
      return row;
    });
    await logAudit(req, 'admin_create_role', String(name).trim(), perms.join(','), 'success', roleRef(r.id));
    const [created] = await db.select().from(roles).where(eq(roles.id, r.id)).limit(1);
    res.json(await serializeRole(created));
  } catch (err) {
    if (isUniqueViolation(err)) return res.status(400).json({ error: 'Role name already exists' });
    throw err;
  }
});

router.put('/roles/:id', requireAdmin, async (req, res) => {
  const role = await findRole(req.params.id);
  if (!role) return res.status(404).json({ error: 'Role not found' });

  const { name, description, permissions } = req.body;
  const expectedHolders = req.body.expectedHolders;
  if (expectedHolders !== undefined && (!Number.isInteger(expectedHolders) || expectedHolders < 0)) {
    return res.status(400).json({ error: 'expectedHolders must be a non-negative integer' });
  }

  // Validate every supplied field *before* writing anything: a rejection partway
  // through used to leave the earlier metadata/permission writes committed, so a
  // bad quota could still replace the live permissions of every role holder.
  const patch = {};
  // Built-in roles keep their name/description; their permissions stay editable
  if (!role.built_in && name !== undefined) {
    if (!String(name).trim()) return res.status(400).json({ error: 'Role name required' });
    patch.name = String(name).trim();
  }
  if (!role.built_in && description !== undefined) {
    patch.description = String(description);
  }
  let perms = null;
  if (permissions !== undefined) {
    perms = validatePermissionList(permissions);
    if (!perms) return res.status(400).json({ error: 'Invalid permission list' });
  }
  // Quotas are editable on every role, including built-ins (like permissions)
  if ('maxCores' in req.body || 'maxMemoryGb' in req.body || 'maxStorageGb' in req.body) {
    const maxCores = parseQuotaValue(req.body.maxCores);
    const maxMemoryGb = parseQuotaValue(req.body.maxMemoryGb);
    const maxStorageGb = parseQuotaValue(req.body.maxStorageGb);
    if (maxCores === undefined || maxMemoryGb === undefined || maxStorageGb === undefined) {
      return res.status(400).json({ error: 'Quota values must be non-negative integers (empty = unlimited)' });
    }
    patch.max_cores = maxCores;
    patch.max_memory_gb = maxMemoryGb;
    patch.max_storage_gb = maxStorageGb;
  }

  // One transaction for metadata + permissions + quotas, so a DB failure anywhere
  // in the update rolls the whole thing back.
  try {
    await db.transaction(async (tx) => {
      const [locked] = await tx.select({ id: roles.id }).from(roles).where(eq(roles.id, role.id)).for('update');
      if (!locked) throw new RoleConflict('Role was removed — reload and try again');
      if (expectedHolders !== undefined) {
        const [{ c }] = await tx.select({ c: count() }).from(users).where(eq(users.role_id, role.id));
        if (c !== expectedHolders) throw new RoleConflict('Role holders changed — reload and review before saving');
      }
      if (Object.keys(patch).length > 0) {
        await tx.update(roles).set(patch).where(eq(roles.id, role.id));
      }
      if (perms) await setRolePermissions(tx, role.id, perms);
    });
  } catch (err) {
    if (err instanceof RoleConflict) return res.status(err.status).json({ error: err.message });
    if (isUniqueViolation(err)) return res.status(400).json({ error: 'Role name already exists' });
    throw err;
  }
  await logAudit(req, 'admin_update_role', role.name,
    [patch.name && patch.name !== role.name ? `renamed to: ${patch.name}` : '', Array.isArray(permissions) ? permissions.join(',') : '']
      .filter(Boolean).join('; '),
    'success', roleRef(role.id));
  const [updated] = await db.select().from(roles).where(eq(roles.id, role.id)).limit(1);
  res.json(await serializeRole(updated));
});

// Holders are unassigned, or moved to `?reassignTo=<roleId>`, in the same
// transaction as the delete — a failure leaves the role and its holders intact.
router.delete('/roles/:id', requireAdmin, async (req, res) => {
  const role = await findRole(req.params.id);
  if (!role) return res.status(404).json({ error: 'Role not found' });
  if (role.built_in) return res.status(400).json({ error: 'Built-in roles cannot be deleted' });

  let target = null;
  const expectedHolders = req.query.expectedHolders === undefined ? null : Number(req.query.expectedHolders);
  if (expectedHolders !== null && (!Number.isInteger(expectedHolders) || expectedHolders < 0)) {
    return res.status(400).json({ error: 'expectedHolders must be a non-negative integer' });
  }
  const reassignTo = req.query.reassignTo;
  if (reassignTo !== undefined && reassignTo !== '') {
    target = await findRole(reassignTo);
    if (!target) return res.status(400).json({ error: 'Reassignment role not found' });
    if (target.id === role.id) return res.status(400).json({ error: 'Cannot reassign holders to the role being deleted' });
  }

  let moved;
  try {
    moved = await db.transaction(async (tx) => {
      // Lock the doomed role first: a concurrent assignment to it then waits
      // (its FK check needs a KEY SHARE lock) and fails once the row is gone,
      // instead of slipping in after the holder move and being silently
      // nulled by ON DELETE SET NULL. The target is share-locked so it can't
      // vanish mid-move.
      const [locked] = await tx.select({ id: roles.id }).from(roles).where(eq(roles.id, role.id)).for('update');
      if (!locked) return null;
      if (target) {
        const [t] = await tx.select({ id: roles.id }).from(roles).where(eq(roles.id, target.id)).for('share');
        if (!t) throw new RoleConflict('Reassignment role was removed — reload and try again');
      }
      if (expectedHolders !== null) {
        const [{ c }] = await tx.select({ c: count() }).from(users).where(eq(users.role_id, role.id));
        if (c !== expectedHolders) throw new RoleConflict('Role holders changed — reload and review before deleting');
      }
      const holders = await tx.update(users).set({ role_id: target ? target.id : null })
        .where(eq(users.role_id, role.id)).returning({ id: users.id, username: users.username });
      if (expectedHolders !== null && holders.length !== expectedHolders) {
        throw new RoleConflict('Role holders changed — reload and review before deleting');
      }
      await tx.delete(roles).where(eq(roles.id, role.id));
      return holders;
    });
  } catch (err) {
    if (err instanceof RoleConflict) return res.status(409).json({ error: err.message });
    if (err?.code === '40P01' || err?.cause?.code === '40P01') {
      return res.status(409).json({ error: 'A concurrent role assignment conflicted with this delete — retry' });
    }
    if (isForeignKeyViolation(err)) return res.status(409).json({ error: 'Reassignment role was removed — reload and try again' });
    throw err;
  }
  if (moved === null) return res.status(404).json({ error: 'Role not found' });
  await logAudit(req, 'admin_delete_role', role.name,
    moved.length > 0 ? `${moved.length} holder(s) ${target ? `reassigned to ${target.name}` : 'unassigned'}` : '', 'success', roleRef(role.id));
  for (const u of moved) {
    await logAudit(req, 'admin_unassign_role', u.username,
      target ? `moved to ${target.name}` : 'role deleted', 'success', roleRef(role.id));
    if (target) await logAudit(req, 'admin_assign_role', u.username, target.name, 'success', roleRef(target.id));
  }
  res.json({ ok: true, reassigned: target ? moved.length : 0, unassigned: target ? 0 : moved.length });
});

router.put('/users/:id/role', requireAdmin, async (req, res) => {
  const userId = parseRoleId(req.params.id);
  if (userId === null) return res.status(404).json({ error: 'User not found' });
  const rawRoleId = req.body?.roleId;
  const nextId = rawRoleId === null || rawRoleId === undefined || rawRoleId === '' ? null : parseRoleId(rawRoleId);
  if (nextId === null && rawRoleId !== null && rawRoleId !== undefined && rawRoleId !== '') {
    return res.status(400).json({ error: 'Role not found' });
  }

  let result;
  try {
    result = await db.transaction(async (tx) => {
      let role = null;
      if (nextId !== null) {
        const [r] = await tx.select({ id: roles.id, name: roles.name }).from(roles)
          .where(eq(roles.id, nextId)).for('share');
        if (!r) throw new RoleConflict('Role not found', 400);
        role = r;
      }
      const [user] = await tx.select({ id: users.id, username: users.username, role_id: users.role_id })
        .from(users).where(eq(users.id, userId)).for('update');
      if (!user) return null;
      if (user.role_id !== nextId) {
        await tx.update(users).set({ role_id: nextId }).where(eq(users.id, user.id));
      }
      return { user, role };
    });
  } catch (err) {
    if (err instanceof RoleConflict) return res.status(err.status).json({ error: err.message });
    if (isForeignKeyViolation(err)) return res.status(409).json({ error: 'Role was removed — reload and try again' });
    throw err;
  }
  if (!result) return res.status(404).json({ error: 'User not found' });
  if (result.user.role_id !== nextId) {
    await auditRoleChange(req, result.user.username, result.user.role_id, result.role);
  }
  res.json({ ok: true });
});

export default router;
