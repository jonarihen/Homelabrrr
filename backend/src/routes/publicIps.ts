// Public IP pools, addresses and assignments.
//
// Scope note: this router owns the *records only*. Creating an assignment here
// writes a `pending` row and nothing else — the FortiGate workflow that would
// build the egress path (SNAT pool, policy route, GRE egress policy, kill
// switch) is a later phase, and every response says so explicitly rather than
// pretending the address is live.
//
// Route shape follows the repo's one-router-per-domain convention rather than
// the issue's illustrative /api/admin/... names:
//   GET    /api/public-ips/mine                   — the caller's own assignments
//   GET    /api/public-ips/pools                  \
//   POST   /api/public-ips/pools                  |
//   PATCH  /api/public-ips/pools/:id              | can_manage_public_ips
//   DELETE /api/public-ips/pools/:id              |
//   POST   /api/public-ips/pools/:id/addresses    |
//   GET    /api/public-ips/addresses              |
//   PATCH  /api/public-ips/addresses/:id          |
//   DELETE /api/public-ips/addresses/:id          |
//   GET    /api/public-ips/assignments            |
//   POST   /api/public-ips/assignments            |
//   PATCH  /api/public-ips/assignments/:id        |
//   DELETE /api/public-ips/assignments/:id        /

import { Router } from 'express';
import { and, count, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.ts';
import {
  publicIpPools, publicIps, publicIpAssignments, managedVips,
  firewalls, users, vmSshConfigs,
} from '../db/schema/index.ts';
import { isUniqueViolation } from '../db/errors.ts';
import { requireAuth, requirePermission } from '../middleware/auth.ts';
import { logAudit } from '../utils/audit.ts';
import { sanitizeError } from '../utils/sanitize.ts';
import { userVlanCidrs } from '../utils/vlanSubnets.ts';
import { decodeNodeRef, nodeLookupCandidates } from '../utils/nodeRef.ts';
import { userOwnsVm } from '../utils/vmAccess.ts';
import {
  PUBLIC_IP_STATES, ASSIGNMENT_STATUSES, MAX_POOL_EXPANSION,
  normalizeIpv4, parseCidr, planPoolAddresses,
} from '../utils/publicIpPools.ts';
import {
  checkAssignmentRequest, checkAssignmentDeletion, checkPublicIpDeletion,
  describeAssignmentProvisioning,
} from '../utils/publicIpAccess.ts';

const router = Router();
router.use(requireAuth);

// Pools, addresses and assignments are administrative. Port-forward permissions
// deliberately do NOT grant them: a user may use an address handed to them, but
// never hand one to themselves.
const pPublicIps = requirePermission('can_manage_public_ips');

const PROVISIONING_NOTE =
  'Recorded only. FortiGate provisioning for public IP assignments (SNAT pool, policy route, '
  + 'GRE egress policy, kill switch) is not implemented yet.';

function intOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) ? n : null;
}

// Flag columns are real booleans now. Falls back to the given boolean when the
// field is absent/empty.
function boolOr(value, fallback: boolean): boolean {
  if (value === undefined || value === null || value === '') return fallback;
  return value === true || value === 1 || value === '1' || value === 'true';
}

async function getPool(id) {
  const [row] = await db.select().from(publicIpPools).where(eq(publicIpPools.id, id)).limit(1);
  return row;
}

async function getPublicIp(id) {
  const [row] = await db.select().from(publicIps).where(eq(publicIps.id, id)).limit(1);
  return row;
}

/** Private IPs the portal already knows for a VM (its registered SSH targets). */
async function vmKnownIps(node, vmid) {
  const parsedVmid = Number.parseInt(vmid, 10);
  if (!Number.isInteger(parsedVmid)) return [];
  // Legacy rows may store the bare node name (utils/nodeRef.ts) — try all candidates.
  const candidates = nodeLookupCandidates(node);
  if (candidates.length === 0) return [];
  const rows = await db.select({ host: vmSshConfigs.host }).from(vmSshConfigs)
    .where(and(inArray(vmSshConfigs.node, candidates), eq(vmSshConfigs.vmid, parsedVmid)));
  return rows.map((row) => row.host).filter(Boolean);
}

async function countForwardsForIp(publicIpId): Promise<number> {
  const [row] = await db.select({ n: count() }).from(managedVips)
    .where(eq(managedVips.public_ip_id, publicIpId));
  return row.n;
}

/** Port-forward counts for many addresses in one grouped query (avoids N+1). */
async function portForwardCountsByIp(publicIpIds: number[]): Promise<Map<number, number>> {
  if (publicIpIds.length === 0) return new Map();
  const rows = await db.select({ id: managedVips.public_ip_id, n: count() })
    .from(managedVips)
    .where(inArray(managedVips.public_ip_id, publicIpIds))
    .groupBy(managedVips.public_ip_id);
  return new Map(rows.map((row) => [row.id as number, row.n]));
}

async function serializeAssignment(row, portForwardCount?: number) {
  const pfCount = portForwardCount !== undefined ? portForwardCount : await countForwardsForIp(row.public_ip_id);
  return {
    id: row.id,
    publicIpId: row.public_ip_id,
    address: row.address,
    poolId: row.pool_id ?? null,
    poolName: row.pool_name ?? '',
    firewallId: row.firewall_id,
    firewallName: row.firewall_name ?? '',
    userId: row.user_id,
    username: row.username ?? '',
    node: row.node || '',
    proxmoxHostId: row.proxmox_host_id ?? null,
    vmid: row.vmid ?? null,
    privateIp: row.private_ip,
    egressEnabled: !!row.egress_enabled,
    statusDetail: row.status_detail || '',
    provisionRunId: row.provision_run_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    provisioning: describeAssignmentProvisioning(row.status),
    portForwardCount: pfCount,
  };
}

// Shared column map + join builder replacing the old ASSIGNMENT_SELECT string:
//   a.* + pi.address, pi.pool_id, p.name, f.name, u.username.
const ASSIGNMENT_COLUMNS = {
  id: publicIpAssignments.id,
  public_ip_id: publicIpAssignments.public_ip_id,
  firewall_id: publicIpAssignments.firewall_id,
  user_id: publicIpAssignments.user_id,
  proxmox_host_id: publicIpAssignments.proxmox_host_id,
  node: publicIpAssignments.node,
  vmid: publicIpAssignments.vmid,
  private_ip: publicIpAssignments.private_ip,
  status: publicIpAssignments.status,
  status_detail: publicIpAssignments.status_detail,
  egress_enabled: publicIpAssignments.egress_enabled,
  provision_run_id: publicIpAssignments.provision_run_id,
  created_at: publicIpAssignments.created_at,
  updated_at: publicIpAssignments.updated_at,
  address: publicIps.address,
  pool_id: publicIps.pool_id,
  pool_name: publicIpPools.name,
  firewall_name: firewalls.name,
  username: users.username,
};

function assignmentQuery() {
  return db.select(ASSIGNMENT_COLUMNS)
    .from(publicIpAssignments)
    .innerJoin(publicIps, eq(publicIps.id, publicIpAssignments.public_ip_id))
    .innerJoin(publicIpPools, eq(publicIpPools.id, publicIps.pool_id))
    .leftJoin(firewalls, eq(firewalls.id, publicIpAssignments.firewall_id))
    .leftJoin(users, eq(users.id, publicIpAssignments.user_id));
}

// ─── User-visible ───────────────────────────────────────────────────────────

// The caller's own assignments — the source for the port-forward page's public
// endpoint selector. Deliberately does NOT expose the pool's interface, GRE
// gateway, VDOM or MTU: those are FortiGate provisioning details and a
// non-admin must never see (let alone submit) them.
router.get('/mine', async (req, res) => {
  const rows = await assignmentQuery()
    .where(eq(publicIpAssignments.user_id, req.session.userId))
    .orderBy(publicIps.address);
  res.json({
    assignments: rows.map((row) => ({
      id: row.id,
      publicIpId: row.public_ip_id,
      address: row.address,
      firewallId: row.firewall_id,
      firewallName: row.firewall_name || '',
      poolName: row.pool_name || '',
      node: row.node || '',
      vmid: row.vmid ?? null,
      privateIp: row.private_ip,
      egressEnabled: !!row.egress_enabled,
      provisioning: describeAssignmentProvisioning(row.status),
    })),
    note: PROVISIONING_NOTE,
  });
});

// ─── Pools ──────────────────────────────────────────────────────────────────

router.get('/pools', pPublicIps, async (req, res) => {
  const rows = await db.select({ pool: publicIpPools, firewall_name: firewalls.name })
    .from(publicIpPools)
    .leftJoin(firewalls, eq(firewalls.id, publicIpPools.firewall_id))
    .orderBy(publicIpPools.name);

  // Address tallies per pool in one grouped scan (replaces the correlated
  // COUNT subqueries the SQLite version ran per pool).
  const stateRows = await db.select({ pool_id: publicIps.pool_id, state: publicIps.state, n: count() })
    .from(publicIps)
    .groupBy(publicIps.pool_id, publicIps.state);
  const tallies = new Map<number, { address_count: number; available_count: number; reserved_count: number; assigned_count: number; error_count: number }>();
  for (const r of stateRows) {
    const e = tallies.get(r.pool_id) ?? { address_count: 0, available_count: 0, reserved_count: 0, assigned_count: 0, error_count: 0 };
    e.address_count += r.n;
    if (r.state === 'available') e.available_count += r.n;
    else if (r.state === 'reserved') e.reserved_count += r.n;
    else if (r.state === 'assigned') e.assigned_count += r.n;
    else if (r.state === 'error') e.error_count += r.n;
    tallies.set(r.pool_id, e);
  }

  const pools = rows.map((r) => ({
    ...r.pool,
    firewall_name: r.firewall_name ?? null,
    ...(tallies.get(r.pool.id) ?? { address_count: 0, available_count: 0, reserved_count: 0, assigned_count: 0, error_count: 0 }),
  }));
  res.json({ pools, note: PROVISIONING_NOTE });
});

router.post('/pools', pPublicIps, async (req, res) => {
  const firewallId = intOrNull(req.body.firewallId ?? req.body.firewall_id);
  const name = String(req.body.name || '').trim();
  const externalInterface = String(req.body.externalInterface ?? req.body.external_interface ?? '').trim();
  const cidr = String(req.body.cidr || '').trim();

  if (!firewallId || !name || !externalInterface) {
    return res.status(400).json({ error: 'firewallId, name and externalInterface are required' });
  }
  const [firewall] = await db.select({ id: firewalls.id }).from(firewalls).where(eq(firewalls.id, firewallId)).limit(1);
  if (!firewall) {
    return res.status(404).json({ error: 'Firewall not found' });
  }
  if (cidr && !parseCidr(cidr)) {
    return res.status(400).json({ error: `"${cidr}" is not a valid IPv4 CIDR` });
  }
  const greGateway = String(req.body.greGateway ?? req.body.gre_gateway ?? '').trim();
  if (greGateway && !normalizeIpv4(greGateway)) {
    return res.status(400).json({ error: 'greGateway must be an IPv4 address' });
  }

  try {
    const [inserted] = await db.insert(publicIpPools).values({
      firewall_id: firewallId,
      name,
      vdom: String(req.body.vdom || 'root').trim() || 'root',
      external_interface: externalInterface,
      gre_gateway: greGateway,
      lab_ingress_interface: String(req.body.labIngressInterface ?? req.body.lab_ingress_interface ?? '').trim(),
      cidr,
      mtu: intOrNull(req.body.mtu),
      tcp_mss: intOrNull(req.body.tcpMss ?? req.body.tcp_mss),
      kill_switch_enabled: boolOr(req.body.killSwitchEnabled ?? req.body.kill_switch_enabled, true),
      enabled: boolOr(req.body.enabled, true),
      notes: String(req.body.notes || ''),
    }).returning({ id: publicIpPools.id });
    await logAudit(req, 'public_ip_pool_create', name, `firewall=${firewallId} intf=${externalInterface} cidr=${cidr || '-'}`);
    res.json({ pool: await getPool(inserted.id), note: PROVISIONING_NOTE });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return res.status(409).json({ error: 'A pool with that name already exists on this firewall' });
    }
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

router.patch('/pools/:id', pPublicIps, async (req, res) => {
  const pool = await getPool(intOrNull(req.params.id));
  if (!pool) return res.status(404).json({ error: 'Pool not found' });

  // firewall_id is intentionally immutable: public_ips denormalizes it to
  // enforce UNIQUE(firewall_id, address), and moving a pool would strand every
  // assignment and port forward already bound to its addresses.
  const cidr = req.body.cidr === undefined ? pool.cidr : String(req.body.cidr || '').trim();
  if (cidr && !parseCidr(cidr)) {
    return res.status(400).json({ error: `"${cidr}" is not a valid IPv4 CIDR` });
  }
  const greGateway = req.body.greGateway === undefined && req.body.gre_gateway === undefined
    ? pool.gre_gateway
    : String(req.body.greGateway ?? req.body.gre_gateway ?? '').trim();
  if (greGateway && !normalizeIpv4(greGateway)) {
    return res.status(400).json({ error: 'greGateway must be an IPv4 address' });
  }

  const next = {
    name: req.body.name === undefined ? pool.name : String(req.body.name || '').trim(),
    vdom: req.body.vdom === undefined ? pool.vdom : String(req.body.vdom || 'root').trim(),
    external_interface: req.body.externalInterface === undefined && req.body.external_interface === undefined
      ? pool.external_interface
      : String(req.body.externalInterface ?? req.body.external_interface ?? '').trim(),
    gre_gateway: greGateway,
    lab_ingress_interface: req.body.labIngressInterface === undefined && req.body.lab_ingress_interface === undefined
      ? pool.lab_ingress_interface
      : String(req.body.labIngressInterface ?? req.body.lab_ingress_interface ?? '').trim(),
    cidr,
    mtu: req.body.mtu === undefined ? pool.mtu : intOrNull(req.body.mtu),
    tcp_mss: req.body.tcpMss === undefined && req.body.tcp_mss === undefined
      ? pool.tcp_mss
      : intOrNull(req.body.tcpMss ?? req.body.tcp_mss),
    kill_switch_enabled: boolOr(req.body.killSwitchEnabled ?? req.body.kill_switch_enabled, pool.kill_switch_enabled),
    enabled: boolOr(req.body.enabled, pool.enabled),
    notes: req.body.notes === undefined ? pool.notes : String(req.body.notes || ''),
  };
  if (!next.name || !next.external_interface) {
    return res.status(400).json({ error: 'name and externalInterface cannot be empty' });
  }

  try {
    await db.update(publicIpPools).set({
      name: next.name,
      vdom: next.vdom,
      external_interface: next.external_interface,
      gre_gateway: next.gre_gateway,
      lab_ingress_interface: next.lab_ingress_interface,
      cidr: next.cidr,
      mtu: next.mtu,
      tcp_mss: next.tcp_mss,
      kill_switch_enabled: next.kill_switch_enabled,
      enabled: next.enabled,
      notes: next.notes,
      updated_at: new Date(),
    }).where(eq(publicIpPools.id, pool.id));
  } catch (err) {
    if (isUniqueViolation(err)) {
      return res.status(409).json({ error: 'A pool with that name already exists on this firewall' });
    }
    return res.status(500).json({ error: sanitizeError(err.message) });
  }

  await logAudit(req, 'public_ip_pool_update', next.name, `pool=${pool.id} enabled=${next.enabled} killSwitch=${next.kill_switch_enabled}`);
  res.json({ pool: await getPool(pool.id) });
});

router.delete('/pools/:id', pPublicIps, async (req, res) => {
  const pool = await getPool(intOrNull(req.params.id));
  if (!pool) return res.status(404).json({ error: 'Pool not found' });

  const [{ n: assigned }] = await db.select({ n: count() })
    .from(publicIpAssignments)
    .innerJoin(publicIps, eq(publicIps.id, publicIpAssignments.public_ip_id))
    .where(eq(publicIps.pool_id, pool.id));
  if (assigned > 0) {
    return res.status(409).json({ error: `${assigned} address(es) in this pool are still assigned` });
  }
  const [{ n: referenced }] = await db.select({ n: count() })
    .from(managedVips)
    .innerJoin(publicIps, eq(publicIps.id, managedVips.public_ip_id))
    .where(eq(publicIps.pool_id, pool.id));
  if (referenced > 0) {
    return res.status(409).json({ error: `${referenced} port forward(s) still use addresses from this pool` });
  }

  await db.delete(publicIpPools).where(eq(publicIpPools.id, pool.id));
  await logAudit(req, 'public_ip_pool_delete', pool.name, `pool=${pool.id}`);
  res.json({ ok: true });
});

// ─── Addresses ──────────────────────────────────────────────────────────────

router.get('/addresses', pPublicIps, async (req, res) => {
  const poolId = intOrNull(req.query.poolId);
  const state = String(req.query.state || '').trim();
  const conds = [];
  if (poolId) conds.push(eq(publicIps.pool_id, poolId));
  if (state) conds.push(eq(publicIps.state, state));

  const base = db.select({
    id: publicIps.id,
    pool_id: publicIps.pool_id,
    firewall_id: publicIps.firewall_id,
    address: publicIps.address,
    state: publicIps.state,
    reserved_reason: publicIps.reserved_reason,
    notes: publicIps.notes,
    created_at: publicIps.created_at,
    updated_at: publicIps.updated_at,
    pool_name: publicIpPools.name,
    assignment_id: publicIpAssignments.id,
    assigned_user_id: publicIpAssignments.user_id,
    assignment_status: publicIpAssignments.status,
    private_ip: publicIpAssignments.private_ip,
    assigned_username: users.username,
  })
    .from(publicIps)
    .innerJoin(publicIpPools, eq(publicIpPools.id, publicIps.pool_id))
    .leftJoin(publicIpAssignments, eq(publicIpAssignments.public_ip_id, publicIps.id))
    .leftJoin(users, eq(users.id, publicIpAssignments.user_id));

  const rows = await (conds.length ? base.where(and(...conds)) : base)
    .orderBy(publicIpPools.name, publicIps.id);

  const pfMap = await portForwardCountsByIp([...new Set(rows.map((r) => r.id as number))]);
  res.json({ addresses: rows.map((r) => ({ ...r, port_forward_count: pfMap.get(r.id as number) ?? 0 })) });
});

// Import addresses into a pool: a whole CIDR, an explicit list, or both.
// Reserved addresses are recorded in state `reserved` rather than dropped —
// which addresses the provider keeps is deployment knowledge, not something the
// portal is allowed to guess from the prefix boundaries.
router.post('/pools/:id/addresses', pPublicIps, async (req, res) => {
  const pool = await getPool(intOrNull(req.params.id));
  if (!pool) return res.status(404).json({ error: 'Pool not found' });

  const rawAddresses = Array.isArray(req.body.addresses)
    ? req.body.addresses
    : String(req.body.addresses || '').split(/[\s,]+/);
  const rawReserved = Array.isArray(req.body.reserved)
    ? req.body.reserved
    : String(req.body.reserved || '').split(/[\s,]+/);
  const cidr = req.body.cidr === undefined ? (pool.cidr || '') : String(req.body.cidr || '').trim();

  const existing = await db.select({ address: publicIps.address }).from(publicIps).where(eq(publicIps.pool_id, pool.id));
  const plan = planPoolAddresses({
    cidr,
    addresses: rawAddresses.filter(Boolean),
    reserved: rawReserved.filter(Boolean),
    existing,
    max: MAX_POOL_EXPANSION,
  });
  if (plan.error) return res.status(400).json({ error: plan.error });
  if (plan.invalid.length) {
    return res.status(400).json({ error: `Not valid IPv4 addresses: ${plan.invalid.join(', ')}` });
  }
  if (plan.outOfRange.length) {
    return res.status(400).json({ error: `Outside ${cidr}: ${plan.outOfRange.join(', ')}` });
  }

  try {
    await db.transaction(async (tx) => {
      if (plan.add.length === 0) return;
      await tx.insert(publicIps).values(plan.add.map((row) => ({
        pool_id: pool.id,
        firewall_id: pool.firewall_id,
        address: row.address,
        state: row.state,
        reserved_reason: row.reserved_reason,
      })));
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return res.status(409).json({ error: 'One or more of those addresses already exist on this firewall' });
    }
    return res.status(500).json({ error: sanitizeError(err.message) });
  }

  await logAudit(req, 'public_ip_address_import', pool.name,
    `pool=${pool.id} added=${plan.add.length} duplicates=${plan.duplicates.length}`);
  res.json({ added: plan.add, duplicates: plan.duplicates, note: PROVISIONING_NOTE });
});

router.patch('/addresses/:id', pPublicIps, async (req, res) => {
  const publicIp = await getPublicIp(intOrNull(req.params.id));
  if (!publicIp) return res.status(404).json({ error: 'Public IP not found' });

  const state = req.body.state === undefined ? publicIp.state : String(req.body.state || '').trim();
  if (!PUBLIC_IP_STATES.includes(state)) {
    return res.status(400).json({ error: `state must be one of: ${PUBLIC_IP_STATES.join(', ')}` });
  }
  // `assigned` is bookkeeping owned by the assignment endpoints — an
  // administrator must not be able to fake it, or clear it out from under a
  // live assignment.
  const [assignment] = await db.select({ id: publicIpAssignments.id }).from(publicIpAssignments)
    .where(eq(publicIpAssignments.public_ip_id, publicIp.id)).limit(1);
  if (assignment && state !== 'assigned') {
    return res.status(409).json({ error: 'This address is assigned. Release the assignment before changing its state.' });
  }
  if (!assignment && state === 'assigned') {
    return res.status(400).json({ error: 'Only the assignment endpoints may put an address into the assigned state' });
  }

  const reservedReason = req.body.reservedReason === undefined && req.body.reserved_reason === undefined
    ? publicIp.reserved_reason
    : String(req.body.reservedReason ?? req.body.reserved_reason ?? '');
  const notes = req.body.notes === undefined ? publicIp.notes : String(req.body.notes || '');

  await db.update(publicIps)
    .set({ state, reserved_reason: reservedReason, notes, updated_at: new Date() })
    .where(eq(publicIps.id, publicIp.id));
  await logAudit(req, 'public_ip_address_update', publicIp.address, `state=${state} reason=${reservedReason || '-'}`);
  res.json({ address: await getPublicIp(publicIp.id) });
});

router.delete('/addresses/:id', pPublicIps, async (req, res) => {
  const publicIp = await getPublicIp(intOrNull(req.params.id));
  if (!publicIp) return res.status(404).json({ error: 'Public IP not found' });

  const [{ n: assignmentCount }] = await db.select({ n: count() }).from(publicIpAssignments)
    .where(eq(publicIpAssignments.public_ip_id, publicIp.id));
  const denial = checkPublicIpDeletion({
    publicIp,
    assignmentCount,
    portForwardCount: await countForwardsForIp(publicIp.id),
  });
  if (denial) return res.status(denial.status).json({ error: denial.error });

  await db.delete(publicIps).where(eq(publicIps.id, publicIp.id));
  await logAudit(req, 'public_ip_address_delete', publicIp.address, `pool=${publicIp.pool_id}`);
  res.json({ ok: true });
});

// ─── Assignments ────────────────────────────────────────────────────────────

router.get('/assignments', pPublicIps, async (req, res) => {
  const userId = intOrNull(req.query.userId);
  const poolId = intOrNull(req.query.poolId);
  const conds = [];
  if (userId) conds.push(eq(publicIpAssignments.user_id, userId));
  if (poolId) conds.push(eq(publicIps.pool_id, poolId));

  const base = assignmentQuery();
  const rows = await (conds.length ? base.where(and(...conds)) : base).orderBy(publicIps.address);

  const pfMap = await portForwardCountsByIp([...new Set(rows.map((r) => r.public_ip_id as number))]);
  const assignments = await Promise.all(rows.map((row) => serializeAssignment(row, pfMap.get(row.public_ip_id as number) ?? 0)));
  res.json({ assignments, note: PROVISIONING_NOTE });
});

router.post('/assignments', pPublicIps, async (req, res) => {
  const publicIpId = intOrNull(req.body.publicIpId ?? req.body.public_ip_id);
  const targetUserId = intOrNull(req.body.userId ?? req.body.user_id);
  const node = String(req.body.node || '').trim();
  const vmid = intOrNull(req.body.vmid);
  const privateIp = normalizeIpv4(req.body.privateIp ?? req.body.private_ip);
  const egressEnabled = boolOr(req.body.egressEnabled ?? req.body.egress_enabled, true);

  if (!publicIpId || !targetUserId || !node || !vmid) {
    return res.status(400).json({ error: 'publicIpId, userId, node and vmid are required' });
  }
  const [targetUser] = await db.select({ id: users.id }).from(users).where(eq(users.id, targetUserId)).limit(1);
  if (!targetUser) {
    return res.status(404).json({ error: 'User not found' });
  }

  const publicIp = await getPublicIp(publicIpId);
  const pool = publicIp ? await getPool(publicIp.pool_id) : null;
  const [existingForIp] = await db.select({ id: publicIpAssignments.id }).from(publicIpAssignments)
    .where(eq(publicIpAssignments.public_ip_id, publicIpId)).limit(1);
  let existingEgress = null;
  if (publicIp && privateIp) {
    const [row] = await db.select({ id: publicIpAssignments.id }).from(publicIpAssignments)
      .where(and(
        eq(publicIpAssignments.firewall_id, publicIp.firewall_id),
        eq(publicIpAssignments.private_ip, privateIp),
        eq(publicIpAssignments.egress_enabled, true),
      )).limit(1);
    existingEgress = row ?? null;
  }
  const denial = checkAssignmentRequest({
    publicIp,
    pool,
    targetUserId,
    vmOwnedByUser: await userOwnsVm(targetUserId, node, vmid),
    privateIp,
    vmIps: await vmKnownIps(node, vmid),
    userVlanCidrs: await userVlanCidrs(db, targetUserId),
    existingForIp: existingForIp ?? null,
    existingEgress,
    egressEnabled,
  });
  if (denial) return res.status(denial.status).json({ error: denial.error });

  const { hostId } = decodeNodeRef(node);
  let assignmentId;
  try {
    assignmentId = await db.transaction(async (tx) => {
      // `pending` and nothing else: no FortiGate object is created here, so
      // claiming `active` would be a lie the health checks could not back up.
      const [inserted] = await tx.insert(publicIpAssignments).values({
        public_ip_id: publicIp.id,
        firewall_id: publicIp.firewall_id,
        user_id: targetUserId,
        proxmox_host_id: hostId,
        node,
        vmid,
        private_ip: privateIp,
        status: 'pending',
        status_detail: PROVISIONING_NOTE,
        egress_enabled: egressEnabled,
      }).returning({ id: publicIpAssignments.id });
      await tx.update(publicIps).set({ state: 'assigned', updated_at: new Date() })
        .where(eq(publicIps.id, publicIp.id));
      return inserted.id;
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return res.status(409).json({ error: 'That address, or that private IP, already has an active assignment' });
    }
    return res.status(500).json({ error: sanitizeError(err.message) });
  }

  await logAudit(req, 'public_ip_assign', publicIp.address,
    `user=${targetUserId} vm=${node}/${vmid} private=${privateIp} egress=${egressEnabled}`);
  const [row] = await assignmentQuery().where(eq(publicIpAssignments.id, assignmentId)).limit(1);
  res.json({ assignment: await serializeAssignment(row), note: PROVISIONING_NOTE });
});

// Enable/disable the dedicated egress path for an assignment. The kill switch
// itself is a pool-level setting and stays administrator-only.
router.patch('/assignments/:id', pPublicIps, async (req, res) => {
  const [assignment] = await db.select().from(publicIpAssignments)
    .where(eq(publicIpAssignments.id, intOrNull(req.params.id))).limit(1);
  if (!assignment) return res.status(404).json({ error: 'Assignment not found' });

  const egressEnabled = boolOr(req.body.egressEnabled ?? req.body.egress_enabled, assignment.egress_enabled);
  const status = req.body.status === undefined ? assignment.status : String(req.body.status || '').trim();
  if (!ASSIGNMENT_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${ASSIGNMENT_STATUSES.join(', ')}` });
  }
  if (status !== assignment.status && status !== 'pending' && status !== 'error') {
    return res.status(400).json({
      error: 'Only pending and error may be set by hand until the FortiGate provisioning workflow exists',
    });
  }

  try {
    await db.update(publicIpAssignments)
      .set({ egress_enabled: egressEnabled, status, updated_at: new Date() })
      .where(eq(publicIpAssignments.id, assignment.id));
  } catch (err) {
    if (isUniqueViolation(err)) {
      return res.status(409).json({ error: 'That private IP already egresses through another public IP on this firewall' });
    }
    return res.status(500).json({ error: sanitizeError(err.message) });
  }

  await logAudit(req, 'public_ip_assignment_update', String(assignment.id),
    `egress=${egressEnabled} status=${status}`);
  const [row] = await assignmentQuery().where(eq(publicIpAssignments.id, assignment.id)).limit(1);
  res.json({ assignment: await serializeAssignment(row), note: PROVISIONING_NOTE });
});

router.delete('/assignments/:id', pPublicIps, async (req, res) => {
  const [assignment] = await db.select().from(publicIpAssignments)
    .where(eq(publicIpAssignments.id, intOrNull(req.params.id))).limit(1);
  const denial = checkAssignmentDeletion({
    assignment,
    portForwardCount: assignment ? await countForwardsForIp(assignment.public_ip_id) : 0,
    // Force cleanup (deleting the dependent forwards as part of the release) is
    // part of the FortiGate deprovision workflow and is not offered yet.
    force: false,
  });
  if (denial) return res.status(denial.status).json({ error: denial.error });

  const publicIp = await getPublicIp(assignment.public_ip_id);
  await db.transaction(async (tx) => {
    await tx.delete(publicIpAssignments).where(eq(publicIpAssignments.id, assignment.id));
    await tx.update(publicIps).set({ state: 'available', updated_at: new Date() })
      .where(eq(publicIps.id, assignment.public_ip_id));
  });

  await logAudit(req, 'public_ip_release', publicIp?.address || String(assignment.public_ip_id),
    `assignment=${assignment.id} user=${assignment.user_id} private=${assignment.private_ip}`);
  res.json({ ok: true, note: PROVISIONING_NOTE });
});

export default router;
