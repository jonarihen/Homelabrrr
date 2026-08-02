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
import db from '../db.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { logAudit } from '../utils/audit.js';
import { sanitizeError } from '../utils/sanitize.js';
import { vlanTagToSubnet } from '../fortigate.js';
import { decodeNodeRef, nodeLookupCandidates } from '../utils/nodeRef.js';
import { userOwnsVm } from '../utils/vmAccess.js';
import {
  PUBLIC_IP_STATES, ASSIGNMENT_STATUSES, MAX_POOL_EXPANSION,
  normalizeIpv4, parseCidr, planPoolAddresses,
} from '../utils/publicIpPools.js';
import {
  checkAssignmentRequest, checkAssignmentDeletion, checkPublicIpDeletion,
  describeAssignmentProvisioning,
} from '../utils/publicIpAccess.js';

const router = Router();
router.use(requireAuth);

// Pools, addresses and assignments are administrative. Port-forward permissions
// deliberately do NOT grant them: a user may use an address handed to them, but
// never hand one to themselves.
const pPublicIps = requirePermission('can_manage_public_ips');

const PROVISIONING_NOTE =
  'Recorded only. FortiGate provisioning for public IP assignments (SNAT pool, policy route, '
  + 'GRE egress policy, kill switch) is not implemented yet.';

function nowStamp() {
  return db.prepare("SELECT datetime('now') AS ts").get().ts;
}

function intOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) ? n : null;
}

function boolInt(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return value === true || value === 1 || value === '1' || value === 'true' ? 1 : 0;
}

function getPool(id) {
  return db.prepare('SELECT * FROM public_ip_pools WHERE id = ?').get(id);
}

function getPublicIp(id) {
  return db.prepare('SELECT * FROM public_ips WHERE id = ?').get(id);
}

/** Private IPs the portal already knows for a VM (its registered SSH targets). */
function vmKnownIps(node, vmid) {
  const parsedVmid = Number.parseInt(vmid, 10);
  if (!Number.isInteger(parsedVmid)) return [];
  const ips = [];
  for (const candidate of nodeLookupCandidates(node)) {
    const rows = db.prepare('SELECT host FROM vm_ssh_configs WHERE node = ? AND vmid = ?')
      .all(candidate, parsedVmid);
    for (const row of rows) if (row.host) ips.push(row.host);
  }
  return ips;
}

/**
 * Subnets of the VLANs assigned to a user. Explicit `subnet_cidr` wins; VLANs
 * on the automatic 10.<tag>.0/24 scheme fall back to the derived subnet so a
 * VLAN that was never given an explicit CIDR still validates.
 */
function userVlanCidrs(userId) {
  const rows = db.prepare(`
    SELECT v.tag, v.subnet_cidr
    FROM vlans v
    JOIN user_vlans uv ON uv.vlan_id = v.id
    WHERE uv.user_id = ?
  `).all(userId);
  const cidrs = [];
  for (const row of rows) {
    const explicit = String(row.subnet_cidr || '').trim();
    if (explicit) { cidrs.push(explicit); continue; }
    const derived = vlanTagToSubnet(row.tag);
    if (derived?.network) cidrs.push(derived.network);
  }
  return cidrs;
}

function countForwardsForIp(publicIpId) {
  return db.prepare('SELECT COUNT(*) AS n FROM managed_vips WHERE public_ip_id = ?').get(publicIpId).n;
}

function serializeAssignment(row) {
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
    egressEnabled: row.egress_enabled === 1,
    statusDetail: row.status_detail || '',
    provisionRunId: row.provision_run_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    provisioning: describeAssignmentProvisioning(row.status),
    portForwardCount: countForwardsForIp(row.public_ip_id),
  };
}

const ASSIGNMENT_SELECT = `
  SELECT a.*, pi.address, pi.pool_id, p.name AS pool_name, f.name AS firewall_name, u.username
  FROM public_ip_assignments a
  JOIN public_ips pi ON pi.id = a.public_ip_id
  JOIN public_ip_pools p ON p.id = pi.pool_id
  LEFT JOIN firewalls f ON f.id = a.firewall_id
  LEFT JOIN users u ON u.id = a.user_id
`;

// ─── User-visible ───────────────────────────────────────────────────────────

// The caller's own assignments — the source for the port-forward page's public
// endpoint selector. Deliberately does NOT expose the pool's interface, GRE
// gateway, VDOM or MTU: those are FortiGate provisioning details and a
// non-admin must never see (let alone submit) them.
router.get('/mine', (req, res) => {
  const rows = db.prepare(`${ASSIGNMENT_SELECT} WHERE a.user_id = ? ORDER BY pi.address`)
    .all(req.session.userId);
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
      egressEnabled: row.egress_enabled === 1,
      provisioning: describeAssignmentProvisioning(row.status),
    })),
    note: PROVISIONING_NOTE,
  });
});

// ─── Pools ──────────────────────────────────────────────────────────────────

router.get('/pools', pPublicIps, (req, res) => {
  const pools = db.prepare(`
    SELECT p.*, f.name AS firewall_name,
      (SELECT COUNT(*) FROM public_ips WHERE pool_id = p.id) AS address_count,
      (SELECT COUNT(*) FROM public_ips WHERE pool_id = p.id AND state = 'available') AS available_count,
      (SELECT COUNT(*) FROM public_ips WHERE pool_id = p.id AND state = 'reserved') AS reserved_count,
      (SELECT COUNT(*) FROM public_ips WHERE pool_id = p.id AND state = 'assigned') AS assigned_count,
      (SELECT COUNT(*) FROM public_ips WHERE pool_id = p.id AND state = 'error') AS error_count
    FROM public_ip_pools p
    LEFT JOIN firewalls f ON f.id = p.firewall_id
    ORDER BY p.name
  `).all();
  res.json({ pools, note: PROVISIONING_NOTE });
});

router.post('/pools', pPublicIps, (req, res) => {
  const firewallId = intOrNull(req.body.firewallId ?? req.body.firewall_id);
  const name = String(req.body.name || '').trim();
  const externalInterface = String(req.body.externalInterface ?? req.body.external_interface ?? '').trim();
  const cidr = String(req.body.cidr || '').trim();

  if (!firewallId || !name || !externalInterface) {
    return res.status(400).json({ error: 'firewallId, name and externalInterface are required' });
  }
  if (!db.prepare('SELECT id FROM firewalls WHERE id = ?').get(firewallId)) {
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
    const info = db.prepare(`
      INSERT INTO public_ip_pools
        (firewall_id, name, vdom, external_interface, gre_gateway, lab_ingress_interface,
         cidr, mtu, tcp_mss, kill_switch_enabled, enabled, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      firewallId, name,
      String(req.body.vdom || 'root').trim() || 'root',
      externalInterface, greGateway,
      String(req.body.labIngressInterface ?? req.body.lab_ingress_interface ?? '').trim(),
      cidr,
      intOrNull(req.body.mtu), intOrNull(req.body.tcpMss ?? req.body.tcp_mss),
      boolInt(req.body.killSwitchEnabled ?? req.body.kill_switch_enabled, 1),
      boolInt(req.body.enabled, 1),
      String(req.body.notes || ''),
    );
    logAudit(req, 'public_ip_pool_create', name, `firewall=${firewallId} intf=${externalInterface} cidr=${cidr || '-'}`);
    res.json({ pool: getPool(info.lastInsertRowid), note: PROVISIONING_NOTE });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'A pool with that name already exists on this firewall' });
    }
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

router.patch('/pools/:id', pPublicIps, (req, res) => {
  const pool = getPool(req.params.id);
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
    kill_switch_enabled: boolInt(req.body.killSwitchEnabled ?? req.body.kill_switch_enabled, pool.kill_switch_enabled),
    enabled: boolInt(req.body.enabled, pool.enabled),
    notes: req.body.notes === undefined ? pool.notes : String(req.body.notes || ''),
  };
  if (!next.name || !next.external_interface) {
    return res.status(400).json({ error: 'name and externalInterface cannot be empty' });
  }

  try {
    db.prepare(`
      UPDATE public_ip_pools SET
        name = ?, vdom = ?, external_interface = ?, gre_gateway = ?, lab_ingress_interface = ?,
        cidr = ?, mtu = ?, tcp_mss = ?, kill_switch_enabled = ?, enabled = ?, notes = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      next.name, next.vdom, next.external_interface, next.gre_gateway, next.lab_ingress_interface,
      next.cidr, next.mtu, next.tcp_mss, next.kill_switch_enabled, next.enabled, next.notes,
      nowStamp(), pool.id,
    );
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'A pool with that name already exists on this firewall' });
    }
    return res.status(500).json({ error: sanitizeError(err.message) });
  }

  logAudit(req, 'public_ip_pool_update', next.name, `pool=${pool.id} enabled=${next.enabled} killSwitch=${next.kill_switch_enabled}`);
  res.json({ pool: getPool(pool.id) });
});

router.delete('/pools/:id', pPublicIps, (req, res) => {
  const pool = getPool(req.params.id);
  if (!pool) return res.status(404).json({ error: 'Pool not found' });

  const assigned = db.prepare(`
    SELECT COUNT(*) AS n FROM public_ip_assignments a
    JOIN public_ips pi ON pi.id = a.public_ip_id WHERE pi.pool_id = ?
  `).get(pool.id).n;
  if (assigned > 0) {
    return res.status(409).json({ error: `${assigned} address(es) in this pool are still assigned` });
  }
  const referenced = db.prepare(`
    SELECT COUNT(*) AS n FROM managed_vips mv
    JOIN public_ips pi ON pi.id = mv.public_ip_id WHERE pi.pool_id = ?
  `).get(pool.id).n;
  if (referenced > 0) {
    return res.status(409).json({ error: `${referenced} port forward(s) still use addresses from this pool` });
  }

  db.prepare('DELETE FROM public_ip_pools WHERE id = ?').run(pool.id);
  logAudit(req, 'public_ip_pool_delete', pool.name, `pool=${pool.id}`);
  res.json({ ok: true });
});

// ─── Addresses ──────────────────────────────────────────────────────────────

router.get('/addresses', pPublicIps, (req, res) => {
  const poolId = intOrNull(req.query.poolId);
  const state = String(req.query.state || '').trim();
  const clauses = [];
  const params = [];
  if (poolId) { clauses.push('pi.pool_id = ?'); params.push(poolId); }
  if (state) { clauses.push('pi.state = ?'); params.push(state); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const rows = db.prepare(`
    SELECT pi.*, p.name AS pool_name, a.id AS assignment_id, a.user_id AS assigned_user_id,
           a.status AS assignment_status, a.private_ip, u.username AS assigned_username,
           (SELECT COUNT(*) FROM managed_vips mv WHERE mv.public_ip_id = pi.id) AS port_forward_count
    FROM public_ips pi
    JOIN public_ip_pools p ON p.id = pi.pool_id
    LEFT JOIN public_ip_assignments a ON a.public_ip_id = pi.id
    LEFT JOIN users u ON u.id = a.user_id
    ${where}
    ORDER BY p.name, pi.id
  `).all(...params);
  res.json({ addresses: rows });
});

// Import addresses into a pool: a whole CIDR, an explicit list, or both.
// Reserved addresses are recorded in state `reserved` rather than dropped —
// which addresses the provider keeps is deployment knowledge, not something the
// portal is allowed to guess from the prefix boundaries.
router.post('/pools/:id/addresses', pPublicIps, (req, res) => {
  const pool = getPool(req.params.id);
  if (!pool) return res.status(404).json({ error: 'Pool not found' });

  const rawAddresses = Array.isArray(req.body.addresses)
    ? req.body.addresses
    : String(req.body.addresses || '').split(/[\s,]+/);
  const rawReserved = Array.isArray(req.body.reserved)
    ? req.body.reserved
    : String(req.body.reserved || '').split(/[\s,]+/);
  const cidr = req.body.cidr === undefined ? (pool.cidr || '') : String(req.body.cidr || '').trim();

  const existing = db.prepare('SELECT address FROM public_ips WHERE pool_id = ?').all(pool.id);
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

  const insert = db.prepare(`
    INSERT INTO public_ips (pool_id, firewall_id, address, state, reserved_reason)
    VALUES (?, ?, ?, ?, ?)
  `);
  try {
    db.transaction(() => {
      for (const row of plan.add) {
        insert.run(pool.id, pool.firewall_id, row.address, row.state, row.reserved_reason);
      }
    })();
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'One or more of those addresses already exist on this firewall' });
    }
    return res.status(500).json({ error: sanitizeError(err.message) });
  }

  logAudit(req, 'public_ip_address_import', pool.name,
    `pool=${pool.id} added=${plan.add.length} duplicates=${plan.duplicates.length}`);
  res.json({ added: plan.add, duplicates: plan.duplicates, note: PROVISIONING_NOTE });
});

router.patch('/addresses/:id', pPublicIps, (req, res) => {
  const publicIp = getPublicIp(req.params.id);
  if (!publicIp) return res.status(404).json({ error: 'Public IP not found' });

  const state = req.body.state === undefined ? publicIp.state : String(req.body.state || '').trim();
  if (!PUBLIC_IP_STATES.includes(state)) {
    return res.status(400).json({ error: `state must be one of: ${PUBLIC_IP_STATES.join(', ')}` });
  }
  // `assigned` is bookkeeping owned by the assignment endpoints — an
  // administrator must not be able to fake it, or clear it out from under a
  // live assignment.
  const assignment = db.prepare('SELECT id FROM public_ip_assignments WHERE public_ip_id = ?').get(publicIp.id);
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

  db.prepare('UPDATE public_ips SET state = ?, reserved_reason = ?, notes = ?, updated_at = ? WHERE id = ?')
    .run(state, reservedReason, notes, nowStamp(), publicIp.id);
  logAudit(req, 'public_ip_address_update', publicIp.address, `state=${state} reason=${reservedReason || '-'}`);
  res.json({ address: getPublicIp(publicIp.id) });
});

router.delete('/addresses/:id', pPublicIps, (req, res) => {
  const publicIp = getPublicIp(req.params.id);
  if (!publicIp) return res.status(404).json({ error: 'Public IP not found' });

  const assignmentCount = db.prepare('SELECT COUNT(*) AS n FROM public_ip_assignments WHERE public_ip_id = ?')
    .get(publicIp.id).n;
  const denial = checkPublicIpDeletion({
    publicIp,
    assignmentCount,
    portForwardCount: countForwardsForIp(publicIp.id),
  });
  if (denial) return res.status(denial.status).json({ error: denial.error });

  db.prepare('DELETE FROM public_ips WHERE id = ?').run(publicIp.id);
  logAudit(req, 'public_ip_address_delete', publicIp.address, `pool=${publicIp.pool_id}`);
  res.json({ ok: true });
});

// ─── Assignments ────────────────────────────────────────────────────────────

router.get('/assignments', pPublicIps, (req, res) => {
  const clauses = [];
  const params = [];
  const userId = intOrNull(req.query.userId);
  const poolId = intOrNull(req.query.poolId);
  if (userId) { clauses.push('a.user_id = ?'); params.push(userId); }
  if (poolId) { clauses.push('pi.pool_id = ?'); params.push(poolId); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const rows = db.prepare(`${ASSIGNMENT_SELECT} ${where} ORDER BY pi.address`).all(...params);
  res.json({ assignments: rows.map(serializeAssignment), note: PROVISIONING_NOTE });
});

router.post('/assignments', pPublicIps, (req, res) => {
  const publicIpId = intOrNull(req.body.publicIpId ?? req.body.public_ip_id);
  const targetUserId = intOrNull(req.body.userId ?? req.body.user_id);
  const node = String(req.body.node || '').trim();
  const vmid = intOrNull(req.body.vmid);
  const privateIp = normalizeIpv4(req.body.privateIp ?? req.body.private_ip);
  const egressEnabled = boolInt(req.body.egressEnabled ?? req.body.egress_enabled, 1) === 1;

  if (!publicIpId || !targetUserId || !node || !vmid) {
    return res.status(400).json({ error: 'publicIpId, userId, node and vmid are required' });
  }
  if (!db.prepare('SELECT id FROM users WHERE id = ?').get(targetUserId)) {
    return res.status(404).json({ error: 'User not found' });
  }

  const publicIp = getPublicIp(publicIpId);
  const pool = publicIp ? getPool(publicIp.pool_id) : null;
  const denial = checkAssignmentRequest({
    publicIp,
    pool,
    targetUserId,
    vmOwnedByUser: userOwnsVm(targetUserId, node, vmid),
    privateIp,
    vmIps: vmKnownIps(node, vmid),
    userVlanCidrs: userVlanCidrs(targetUserId),
    existingForIp: db.prepare('SELECT id FROM public_ip_assignments WHERE public_ip_id = ?').get(publicIpId),
    existingEgress: publicIp
      ? db.prepare('SELECT id FROM public_ip_assignments WHERE firewall_id = ? AND private_ip = ? AND egress_enabled = 1')
        .get(publicIp.firewall_id, privateIp)
      : null,
    egressEnabled,
  });
  if (denial) return res.status(denial.status).json({ error: denial.error });

  const { hostId } = decodeNodeRef(node);
  let assignmentId;
  try {
    assignmentId = db.transaction(() => {
      // `pending` and nothing else: no FortiGate object is created here, so
      // claiming `active` would be a lie the health checks could not back up.
      const info = db.prepare(`
        INSERT INTO public_ip_assignments
          (public_ip_id, firewall_id, user_id, proxmox_host_id, node, vmid, private_ip,
           status, status_detail, egress_enabled)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
      `).run(
        publicIp.id, publicIp.firewall_id, targetUserId, hostId, node, vmid, privateIp,
        PROVISIONING_NOTE, egressEnabled ? 1 : 0,
      );
      db.prepare("UPDATE public_ips SET state = 'assigned', updated_at = ? WHERE id = ?")
        .run(nowStamp(), publicIp.id);
      return info.lastInsertRowid;
    })();
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'That address, or that private IP, already has an active assignment' });
    }
    return res.status(500).json({ error: sanitizeError(err.message) });
  }

  logAudit(req, 'public_ip_assign', publicIp.address,
    `user=${targetUserId} vm=${node}/${vmid} private=${privateIp} egress=${egressEnabled ? 1 : 0}`);
  const row = db.prepare(`${ASSIGNMENT_SELECT} WHERE a.id = ?`).get(assignmentId);
  res.json({ assignment: serializeAssignment(row), note: PROVISIONING_NOTE });
});

// Enable/disable the dedicated egress path for an assignment. The kill switch
// itself is a pool-level setting and stays administrator-only.
router.patch('/assignments/:id', pPublicIps, (req, res) => {
  const assignment = db.prepare('SELECT * FROM public_ip_assignments WHERE id = ?').get(req.params.id);
  if (!assignment) return res.status(404).json({ error: 'Assignment not found' });

  const egressEnabled = boolInt(req.body.egressEnabled ?? req.body.egress_enabled, assignment.egress_enabled);
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
    db.prepare('UPDATE public_ip_assignments SET egress_enabled = ?, status = ?, updated_at = ? WHERE id = ?')
      .run(egressEnabled, status, nowStamp(), assignment.id);
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'That private IP already egresses through another public IP on this firewall' });
    }
    return res.status(500).json({ error: sanitizeError(err.message) });
  }

  logAudit(req, 'public_ip_assignment_update', String(assignment.id),
    `egress=${egressEnabled} status=${status}`);
  const row = db.prepare(`${ASSIGNMENT_SELECT} WHERE a.id = ?`).get(assignment.id);
  res.json({ assignment: serializeAssignment(row), note: PROVISIONING_NOTE });
});

router.delete('/assignments/:id', pPublicIps, (req, res) => {
  const assignment = db.prepare('SELECT * FROM public_ip_assignments WHERE id = ?').get(req.params.id);
  const denial = checkAssignmentDeletion({
    assignment,
    portForwardCount: assignment ? countForwardsForIp(assignment.public_ip_id) : 0,
    // Force cleanup (deleting the dependent forwards as part of the release) is
    // part of the FortiGate deprovision workflow and is not offered yet.
    force: false,
  });
  if (denial) return res.status(denial.status).json({ error: denial.error });

  const publicIp = getPublicIp(assignment.public_ip_id);
  db.transaction(() => {
    db.prepare('DELETE FROM public_ip_assignments WHERE id = ?').run(assignment.id);
    db.prepare("UPDATE public_ips SET state = 'available', updated_at = ? WHERE id = ?")
      .run(nowStamp(), assignment.public_ip_id);
  })();

  logAudit(req, 'public_ip_release', publicIp?.address || String(assignment.public_ip_id),
    `assignment=${assignment.id} user=${assignment.user_id} private=${assignment.private_ip}`);
  res.json({ ok: true, note: PROVISIONING_NOTE });
});

export default router;
