import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import db from '../db.js';
import {
  getVMStatus, vmAction, getVNCTicket, getVMConfig, updateVMConfig, resizeVMDisk, getAllVMs, getVMRRD,
  getVMBackups, createVMBackup, deleteVMBackup, getBackupStorages,
  restoreVMBackup, listBackupFiles, downloadBackupFile, deleteVM, getGuestType,
  getLXCStatus, lxcAction, getLXCConfig, updateLXCConfig, getLXCRRD, getLXCVNCTicket,
  getSnapshots, createSnapshot, deleteSnapshot, rollbackSnapshot,
  getTaskStatus, getTaskLog,
} from '../proxmox.js';
import { createClient } from '../fortigate.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { sanitizeError } from '../utils/sanitize.js';
import { httpError, sendError } from '../utils/httpError.js';
import { logAudit } from '../utils/audit.js';
import { notify, portalLink } from '../utils/notify.js';
import { userCanAccessVm, userOwnsVm } from '../utils/vmAccess.js';
import { checkVlanAssignment } from '../utils/vlanAccess.js';
import { userHasPermission } from '../utils/permissions.js';
import { summarizeLease, renewLease } from '../utils/leases.js';
import { assertUserQuota, sizeToGb } from '../utils/quota.js';
import { decodeNodeRef, nodeLookupCandidates } from '../utils/nodeRef.js';
import { computeCpuTopology } from '../utils/cpuTopology.js';
import {
  isValidTime, isValidDaysMask, isValidTimezone, timeToMinutes,
  serializeSchedule, scheduleBadge, nextTimeOccurrence, ALL_DAYS,
} from '../utils/schedule.js';
import { derivePublicKey } from '../utils/sshPublicKey.js';
import { decryptSecret } from '../utils/secrets.js';
import { readTaskProgress } from '../utils/taskProgress.js';
import { parseUpid, inProgressVolids } from '../utils/backupTask.js';
import { resolveRestoreGuestType } from '../utils/backupGuestType.js';

const router = Router();
router.use(requireAuth);

// Short-lived VNC session store (token → {node, vmid, ticket, port, expires})
export const vncSessions = new Map();

function checkAccess(userId, node, vmid, isAdmin) {
  return userCanAccessVm(userId, node, vmid, isAdmin);
}

// Backup volume IDs embed the VMID they belong to. The route-level access
// check only covers :vmid, so every handler that forwards a caller-supplied
// volid to Proxmox must also verify the volid targets that same VM —
// otherwise any user could read, restore, or delete another tenant's
// backups by naming a foreign volid (IDOR). Unparseable volids are rejected.
function volidBelongsToVm(volid, vmid) {
  const s = String(volid || '');
  const target = Number.parseInt(vmid, 10);
  const found = [];
  // Classic vzdump archives: <storage>:backup/vzdump-qemu-100-2024_05_01-….vma.zst
  const vzdump = s.match(/vzdump-(?:qemu|lxc|openvz)-(\d+)-/);
  if (vzdump) found.push(Number.parseInt(vzdump[1], 10));
  // PBS snapshots: <storage>:backup/vm/100/2026-07-06T22:37:18Z
  const pbs = s.match(/(?:^|[:/])backup\/(?:vm|ct)\/(\d+)(?:\/|$)/);
  if (pbs) found.push(Number.parseInt(pbs[1], 10));
  // A volid that matches both forms must agree with the route VMID in both
  return found.length > 0 && found.every(id => id === target);
}

function serializeNodeIdentity(nodeValue) {
  const { nodeName, nodeRef } = decodeNodeRef(nodeValue);
  return {
    node: nodeName || String(nodeValue || ''),
    nodeRef: nodeRef || String(nodeValue || ''),
  };
}

// Overlay a lightweight power-schedule badge ({ stopTime, startTime, days, … })
// onto a VM listing so the dashboard can render "sleeps 23:00–08:00" without an
// extra round-trip per card. Matches on vmid + any node-ref candidate.
function attachSchedules(list) {
  const rows = db.prepare('SELECT * FROM vm_schedules WHERE enabled = 1').all();
  if (rows.length === 0) return list;
  const now = Date.now();
  return list.map((item) => {
    const candidates = new Set(nodeLookupCandidates(item.nodeRef || item.node));
    const row = rows.find((r) => (
      Number(r.vmid) === Number(item.vmid)
      && nodeLookupCandidates(r.node).some((c) => candidates.has(c))
    ));
    const badge = row ? scheduleBadge(row, now) : null;
    return badge ? { ...item, schedule: badge } : item;
  });
}

// Editing a schedule requires strict ownership (admins bypass) — mirrors the
// destructive-op gate. Reads use userCanAccessVm at the call site.
function canEditSchedule(req, node, vmid) {
  return req.session.isAdmin || userOwnsVm(req.session.userId, node, vmid);
}

// Display name of the PVE host a node ref belongs to — users get to SEE which
// host their VM runs on (moving it stays admin-only via /api/migrate).
function hostNameForNode(nodeValue) {
  const { hostId } = decodeNodeRef(nodeValue);
  if (!hostId) return '';
  return db.prepare('SELECT name FROM pve_hosts WHERE id = ?').get(hostId)?.name || '';
}

// Portal-authored validation failure. Handlers report it through sendError(),
// which honours the tagged status and returns the message verbatim for 4xx —
// these strings were written for the user, not scraped from an upstream.
const badRequest = (message) => httpError(400, message);

function normalizeMac(mac = '') {
  return String(mac || '').trim().toLowerCase().replace(/-/g, ':');
}

function isLikelyMac(value = '') {
  return /^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/i.test(normalizeMac(value));
}

function parseIpv4(value = '') {
  const parts = String(value || '').trim().split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => Number.parseInt(part, 10));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
  return octets;
}

function ipv4ToInt(value = '') {
  const octets = parseIpv4(value);
  if (!octets) return null;
  return (
    (((octets[0] << 24) >>> 0)
      + ((octets[1] << 16) >>> 0)
      + ((octets[2] << 8) >>> 0)
      + octets[3])
    >>> 0
  );
}

function intToIpv4(value) {
  return [
    (value >>> 24) & 255,
    (value >>> 16) & 255,
    (value >>> 8) & 255,
    value & 255,
  ].join('.');
}

function maskToPrefix(netmask = '') {
  const value = ipv4ToInt(netmask);
  if (value === null) return null;
  let prefix = 0;
  let seenZero = false;

  for (let bit = 31; bit >= 0; bit -= 1) {
    const set = (value >>> bit) & 1;
    if (set) {
      if (seenZero) return null;
      prefix += 1;
    } else {
      seenZero = true;
    }
  }

  return prefix;
}

function ipInSubnet(ip, gateway, netmask) {
  const ipInt = ipv4ToInt(ip);
  const gatewayInt = ipv4ToInt(gateway);
  const netmaskInt = ipv4ToInt(netmask);
  if (ipInt === null || gatewayInt === null || netmaskInt === null) return false;
  return (ipInt & netmaskInt) === (gatewayInt & netmaskInt);
}

function formatSubnetCidr(gateway = '', netmask = '') {
  const prefix = maskToPrefix(netmask);
  const gatewayInt = ipv4ToInt(gateway);
  const netmaskInt = ipv4ToInt(netmask);
  if (prefix === null || gatewayInt === null || netmaskInt === null) return '';
  return `${intToIpv4(gatewayInt & netmaskInt)}/${prefix}`;
}

function parseVmNetworkInterfaces(config = {}) {
  return Object.keys(config)
    .filter((key) => /^net\d+$/.test(key))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((name) => {
      const raw = String(config[name] || '');
      const parts = raw.split(',').map((part) => part.trim()).filter(Boolean);
      const details = {
        name,
        raw,
        model: '',
        guestName: '',
        bridge: '',
        vlanTag: null,
        mac: '',
      };

      if (parts[0]?.includes('=')) {
        const [firstKey, firstValue = ''] = parts[0].split('=');
        if (firstKey === 'name') {
          details.guestName = firstValue;
        } else if (isLikelyMac(firstValue)) {
          details.model = firstKey;
          details.mac = normalizeMac(firstValue);
        }
      }

      for (const part of parts) {
        const [key, value = ''] = part.split('=');
        if (key === 'bridge') details.bridge = value;
        if (key === 'tag') {
          const tag = Number.parseInt(value, 10);
          details.vlanTag = Number.isInteger(tag) ? tag : null;
        }
        if (key === 'hwaddr' || key === 'macaddr') details.mac = normalizeMac(value);
        if (key === 'name') details.guestName = value;
        if (!details.mac && isLikelyMac(value)) details.mac = normalizeMac(value);
      }

      return details;
    });
}

async function loadVmConfigForIpManagement(node, vmid) {
  try {
    return await getVMConfig(node, vmid);
  } catch {
    return await getLXCConfig(node, vmid);
  }
}

function sanitizeDhcpReservation(entry = {}) {
  return {
    id: Number.parseInt(entry.id ?? entry.q_origin_key ?? 0, 10) || 0,
    type: entry.type || 'mac',
    ip: entry.ip || '',
    mac: normalizeMac(entry.mac),
    action: entry.action || 'reserved',
    'circuit-id-type': entry['circuit-id-type'] || 'string',
    'circuit-id': entry['circuit-id'] || '',
    'remote-id-type': entry['remote-id-type'] || 'string',
    'remote-id': entry['remote-id'] || '',
    description: entry.description || '',
  };
}

function nextReservationId(reservations = []) {
  return reservations.reduce((max, reservation) => {
    const value = Number.parseInt(reservation.id ?? reservation.q_origin_key ?? 0, 10) || 0;
    return Math.max(max, value);
  }, 0) + 1;
}

function findMatchingLease(leases = [], interfaceName, mac) {
  const normalizedMac = normalizeMac(mac);
  const candidates = leases.filter((lease) => (
    normalizeMac(lease.mac) === normalizedMac
    && lease.interface === interfaceName
    && (!lease.type || lease.type === 'ipv4')
  ));

  return candidates.find((lease) => lease.status === 'leased')
    || candidates.find((lease) => lease.status === 'reserved')
    || candidates[0]
    || null;
}

function syncReservationToSshConfig(node, vmid, ip) {
  const { nodeName } = decodeNodeRef(node);
  const candidates = [...new Set([String(node || ''), String(nodeName || '')].filter(Boolean))];
  if (candidates.length === 0) return false;

  const placeholders = candidates.map(() => '?').join(', ');
  const rows = db.prepare(
    `SELECT id, node FROM vm_ssh_configs WHERE vmid = ? AND node IN (${placeholders})`
  ).all(vmid, ...candidates);

  if (rows.length === 0) return false;
  const exact = rows.find((row) => row.node === node);
  const target = exact || (rows.length === 1 ? rows[0] : null);
  if (!target) return false;

  db.prepare('UPDATE vm_ssh_configs SET host = ? WHERE id = ?').run(ip, target.id);
  return true;
}

async function resolveVmDhcpScope(node, vmid, netInterface, firewallId = null) {
  const config = await loadVmConfigForIpManagement(node, vmid);
  const iface = parseVmNetworkInterfaces(config).find((entry) => entry.name === netInterface);
  if (!iface) throw badRequest(`Network interface ${netInterface} not found on this VM`);
  if (!iface.mac) throw badRequest(`Network interface ${netInterface} has no MAC address`);
  if (!iface.vlanTag) throw badRequest(`Network interface ${netInterface} is not VLAN-tagged`);

  const vlan = db.prepare('SELECT * FROM vlans WHERE tag = ?').get(iface.vlanTag);
  if (!vlan) throw badRequest(`VLAN ${iface.vlanTag} is not managed by the portal`);
  if (vlan.mode === 'tagged_only') throw badRequest(`VLAN ${iface.vlanTag} is tagged-only and has no managed DHCP server`);

  const syncs = db.prepare(`
    SELECT fvs.*, f.name as firewall_name, f.host, f.port, f.api_key, f.vdom, f.verify_tls
    FROM firewall_vlan_sync fvs
    JOIN firewalls f ON f.id = fvs.firewall_id
    WHERE fvs.vlan_id = ?
    ORDER BY fvs.id
  `).all(vlan.id);

  const filtered = firewallId
    ? syncs.filter((sync) => String(sync.firewall_id) === String(firewallId))
    : syncs;

  if (filtered.length === 0) {
    throw badRequest('No synced firewall DHCP scope was found for this VLAN');
  }
  if (!firewallId && filtered.length > 1) {
    throw badRequest('This VM interface is synced to multiple firewalls. Choose a specific firewall.');
  }

  const sync = filtered[0];
  const client = createClient(sync);
  let server = null;

  if (sync.dhcp_server_id) {
    try {
      server = await client.getDhcpServer(sync.dhcp_server_id);
    } catch {
      server = null;
    }
  }

  if (!server) {
    const servers = await client.getDhcpServers();
    server = servers.find((entry) => (
      String(entry.id) === String(sync.dhcp_server_id)
      || entry.interface === sync.interface_name
    )) || null;
  }

  if (!server) {
    throw badRequest(`No DHCP server was found on ${sync.firewall_name} for ${sync.interface_name}`);
  }

  const leases = await client.getDhcpLeases();
  const reservations = Array.isArray(server['reserved-address'])
    ? server['reserved-address'].map(sanitizeDhcpReservation)
    : [];
  const currentReservation = reservations.find((reservation) => reservation.mac === normalizeMac(iface.mac)) || null;
  const currentLease = findMatchingLease(leases, sync.interface_name, iface.mac);

  return {
    iface,
    vlan,
    sync,
    client,
    server,
    leases,
    reservations,
    currentReservation,
    currentLease,
  };
}

// ─── User's assigned VMs ──────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  if (userHasPermission(req.session.userId, 'see_all_vms')) {
    try {
      const vms = await getAllVMs();
      return res.json(attachSchedules(vms.map(vm => {
        const identity = serializeNodeIdentity(vm.nodeRef || vm.node);
        return {
          ...vm,
          ...identity,
          lease: summarizeLease(identity.nodeRef, vm.vmid),
        };
      })));
    } catch (err) {
      return sendError(res, err);
    }
  }

  const assignments = db.prepare('SELECT * FROM vm_assignments WHERE user_id = ?').all(req.session.userId);

  const results = await Promise.all(assignments.map(async (a) => {
    const nodeIdentity = serializeNodeIdentity(a.node);
    const lease = summarizeLease(a.node, a.vmid);
    const hostName = hostNameForNode(a.node);
    try {
      const status = await getVMStatus(a.node, a.vmid);
      return { ...status, ...nodeIdentity, hostName, assignmentId: a.id, lease };
    } catch {
      return { vmid: a.vmid, ...nodeIdentity, hostName, name: `VM ${a.vmid}`, status: 'error', assignmentId: a.id, lease };
    }
  }));

  res.json(attachSchedules(results));
});

// ─── VM Status ────────────────────────────────────────────────────────────────

router.get('/:node/:vmid/status', async (req, res) => {
  const { node, vmid } = req.params;
  if (!checkAccess(req.session.userId, node, vmid, req.session.isAdmin)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    const nodeIdentity = serializeNodeIdentity(node);
    const lease = summarizeLease(node, vmid);
    const hostName = hostNameForNode(node);
    try {
      res.json({ ...(await getVMStatus(node, vmid)), ...nodeIdentity, hostName, vmid: parseInt(vmid, 10), type: 'qemu', lease });
    } catch {
      res.json({ ...(await getLXCStatus(node, vmid)), ...nodeIdentity, hostName, vmid: parseInt(vmid, 10), type: 'lxc', lease });
    }
  } catch (err) {
    sendError(res, err);
  }
});

// ─── VM Lease renewal ─────────────────────────────────────────────────────────
// Strict ownership (like deletion) — an assignment, not see_all_vms, is
// required. Renewing resets the clock and bumps the renewal count.
router.post('/:node/:vmid/lease/renew', (req, res) => {
  const { node, vmid } = req.params;

  if (!req.session.isAdmin && !userOwnsVm(req.session.userId, node, vmid)) {
    return res.status(403).json({ error: 'You can only renew leases for VMs assigned to you' });
  }

  try {
    const lease = renewLease(node, vmid, { createdBy: req.session.username });
    if (!lease) return res.status(404).json({ error: 'This VM has no lease to renew' });
    logAudit(req, 'lease_renew', `${node}/${vmid}`, `renewal #${lease.renewal_count}`);
    res.json({ ok: true, lease: summarizeLease(node, vmid) });
  } catch (err) {
    sendError(res, err);
  }
});

// ─── VM Actions ───────────────────────────────────────────────────────────────

router.post('/:node/:vmid/action', async (req, res) => {
  const { node, vmid } = req.params;
  const { action } = req.body;

  if (!checkAccess(req.session.userId, node, vmid, req.session.isAdmin)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  if (!['start', 'stop', 'reboot', 'shutdown'].includes(action)) {
    return res.status(400).json({ error: 'Invalid action' });
  }

  try {
    let upid;
    try {
      upid = await vmAction(node, vmid, action);
    } catch {
      upid = await lxcAction(node, vmid, action);
    }
    logAudit(req, 'vm_action', `${node}/${vmid}`, action);
    res.json({ ok: true, upid });
  } catch (err) {
    sendError(res, err);
  }
});

// ─── VM Deletion ──────────────────────────────────────────────────────────────

router.delete('/:node/:vmid', async (req, res) => {
  const { node, vmid } = req.params;

  // Admins can delete any VM; regular users only VMs assigned to them.
  // Deliberately NOT userCanAccessVm — see_all_vms must not grant deletion.
  if (!req.session.isAdmin && !userOwnsVm(req.session.userId, node, vmid)) {
    return res.status(403).json({ error: 'You can only delete VMs assigned to you' });
  }

  // Never destroy the kept-behind source copy of a shared-storage migration —
  // its disks are the SAME volumes the migrated VM uses on the other host.
  // (PVE's protection flag also blocks this; this check gives a clear message
  // instead of a raw upstream error.)
  const latestMigration = db.prepare(
    "SELECT source_node, target_node, kept_source FROM vm_migrations WHERE vmid = ? AND status = 'ok' ORDER BY id DESC LIMIT 1"
  ).get(parseInt(vmid, 10));
  if (latestMigration?.kept_source === 1) {
    const requestCandidates = nodeLookupCandidates(node);
    const sourceCandidates = nodeLookupCandidates(latestMigration.source_node);
    if (sourceCandidates.some((c) => requestCandidates.includes(c))) {
      return res.status(400).json({
        error: `This is the migrated-away source copy — its disks belong to the live VM on the other host. Remove only its config from the source host shell: rm /etc/pve/qemu-server/${parseInt(vmid, 10)}.conf`,
      });
    }
  }

  try {
    // Collect backups first — after destruction the VMID no longer resolves to a host
    let backups = [];
    try {
      backups = await getVMBackups(node, vmid);
    } catch (err) {
      console.warn(`[vm-delete] Could not list backups for ${node}/${vmid}: ${err.message}`);
    }

    await deleteVM(node, vmid);

    // Purge every backup of this VMID so a future VM reusing the ID never inherits them
    let deletedBackups = 0;
    const failedBackups = [];
    for (const backup of backups) {
      try {
        await deleteVMBackup(node, backup.storage, backup.volid);
        deletedBackups += 1;
      } catch (err) {
        console.warn(`[vm-delete] Failed to delete backup ${backup.volid}: ${err.message}`);
        failedBackups.push(backup.volid);
      }
    }

    // Clean up portal records tied to this VM
    const parsedVmid = parseInt(vmid, 10);
    const candidates = nodeLookupCandidates(node);
    const placeholders = candidates.map(() => '?').join(', ');
    for (const table of ['vm_assignments', 'vm_ssh_configs', 'vm_ssh_user_configs', 'provisioned_vms', 'vm_leases', 'vm_schedules', 'backup_tasks']) {
      db.prepare(`DELETE FROM ${table} WHERE vmid = ? AND node IN (${placeholders})`).run(parsedVmid, ...candidates);
    }

    logAudit(req, 'vm_delete', `${node}/${vmid}`, `backups_deleted=${deletedBackups}${failedBackups.length > 0 ? ` backups_failed=${failedBackups.length}` : ''}`);
    res.json({ ok: true, deletedBackups, failedBackups });
  } catch (err) {
    sendError(res, err);
  }
});

// ─── VM RRD data ──────────────────────────────────────────────────────────────

router.get('/:node/:vmid/rrddata', async (req, res) => {
  const { node, vmid } = req.params;
  const { timeframe = 'hour' } = req.query;
  if (!checkAccess(req.session.userId, node, vmid, req.session.isAdmin)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    // Try qemu first, fall back to lxc
    let data;
    try {
      data = await getVMRRD(node, vmid, 'qemu', timeframe);
    } catch {
      data = await getVMRRD(node, vmid, 'lxc', timeframe);
    }
    res.json(data);
  } catch (err) {
    sendError(res, err);
  }
});

// ─── VNC ticket ───────────────────────────────────────────────────────────────

router.post('/:node/:vmid/vnc-ticket', async (req, res) => {
  const { node, vmid } = req.params;
  if (!checkAccess(req.session.userId, node, vmid, req.session.isAdmin)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  try {
    let vncData;
    let vmtype = 'qemu';
    try {
      vncData = await getVNCTicket(node, vmid);
    } catch {
      vncData = await getLXCVNCTicket(node, vmid);
      vmtype = 'lxc';
    }
    const token = uuidv4();

    // Purge expired sessions
    for (const [k, v] of vncSessions) {
      if (v.expires < Date.now()) vncSessions.delete(k);
    }

    const now = Date.now();
    console.log(`[VNC-ticket] node=${node} vmid=${vmid} type=${vmtype} port=${vncData.port} ticket=${vncData.ticket?.slice(0, 20)}...`);

    vncSessions.set(token, {
      userId: req.session.userId,
      sessionId: req.sessionID,
      node, vmid, vmtype,
      ticket: vncData.ticket,
      port:   vncData.port,
      createdAt: now,
      expires: now + 120_000, // 2 min to establish connection
    });

    // Return ticket so noVNC can use it as VNC password
    res.json({ token, ticket: vncData.ticket });
  } catch (err) {
    sendError(res, err);
  }
});

router.get('/:node/:vmid/ip-management', async (req, res) => {
  const { node, vmid } = req.params;
  if (!checkAccess(req.session.userId, node, vmid, req.session.isAdmin)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  try {
    const config = await loadVmConfigForIpManagement(node, vmid);
    const interfaces = parseVmNetworkInterfaces(config);
    const vlanTags = [...new Set(interfaces.map((entry) => entry.vlanTag).filter(Boolean))];
    const vlanMap = new Map(
      vlanTags.map((tag) => [tag, db.prepare('SELECT * FROM vlans WHERE tag = ?').get(tag)]).filter(([, vlan]) => !!vlan)
    );

    const syncRows = vlanTags.length > 0
      ? db.prepare(`
          SELECT fvs.*, f.name as firewall_name, f.host, f.port, f.api_key, f.vdom, f.verify_tls, v.tag as vlan_tag
          FROM firewall_vlan_sync fvs
          JOIN firewalls f ON f.id = fvs.firewall_id
          JOIN vlans v ON v.id = fvs.vlan_id
          WHERE v.tag IN (${vlanTags.map(() => '?').join(', ')})
          ORDER BY fvs.id
        `).all(...vlanTags)
      : [];

    const syncMap = new Map();
    for (const sync of syncRows) {
      const list = syncMap.get(sync.vlan_tag) || [];
      list.push(sync);
      syncMap.set(sync.vlan_tag, list);
    }

    const firewallCache = new Map();

    const payload = await Promise.all(interfaces.map(async (iface) => {
      if (!iface.mac) {
        return { ...iface, status: 'missing_mac', message: 'This interface does not expose a usable MAC address.' };
      }
      if (!iface.vlanTag) {
        return { ...iface, status: 'untagged', message: 'This interface is not VLAN-tagged, so there is no managed DHCP scope to inspect.' };
      }

      const vlan = vlanMap.get(iface.vlanTag);
      if (!vlan) {
        return { ...iface, status: 'unmanaged_vlan', message: `VLAN ${iface.vlanTag} is not managed by the portal.` };
      }
      if (vlan.mode === 'tagged_only') {
        return { ...iface, status: 'tagged_only', vlan: { id: vlan.id, name: vlan.name, tag: vlan.tag }, message: 'Tagged-only VLANs are not pushed to firewall DHCP, so IP management is unavailable.' };
      }

      const scopes = syncMap.get(iface.vlanTag) || [];
      if (scopes.length === 0) {
        return {
          ...iface,
          status: 'unsynced',
          vlan: { id: vlan.id, name: vlan.name, tag: vlan.tag },
          message: 'This VLAN is not synced to a firewall, so there is no managed DHCP scope yet.',
        };
      }

      const dhcpScopes = await Promise.all(scopes.map(async (sync) => {
        const cacheKey = String(sync.firewall_id);
        try {
          let state = firewallCache.get(cacheKey);
          if (!state) {
            const client = createClient(sync);
            const [servers, leases] = await Promise.all([
              client.getDhcpServers(),
              client.getDhcpLeases(),
            ]);
            state = { servers, leases };
            firewallCache.set(cacheKey, state);
          }

          const server = state.servers.find((entry) => (
            String(entry.id) === String(sync.dhcp_server_id)
            || entry.interface === sync.interface_name
          ));
          if (!server) {
            return {
              firewallId: sync.firewall_id,
              firewallName: sync.firewall_name,
              interfaceName: sync.interface_name,
              dhcpServerId: sync.dhcp_server_id || null,
              error: 'No DHCP server was found for this synced interface.',
            };
          }

          const reservations = Array.isArray(server['reserved-address'])
            ? server['reserved-address'].map(sanitizeDhcpReservation)
            : [];
          const reservation = reservations.find((entry) => entry.mac === normalizeMac(iface.mac)) || null;
          const lease = findMatchingLease(state.leases, sync.interface_name, iface.mac);
          const range = Array.isArray(server['ip-range']) ? server['ip-range'][0] || null : null;

          return {
            firewallId: sync.firewall_id,
            firewallName: sync.firewall_name,
            interfaceName: sync.interface_name,
            dhcpServerId: server.id || sync.dhcp_server_id || null,
            subnet: formatSubnetCidr(server['default-gateway'], server.netmask),
            gateway: server['default-gateway'] || '',
            netmask: server.netmask || '',
            rangeStart: range?.['start-ip'] || '',
            rangeEnd: range?.['end-ip'] || '',
            reservation: reservation ? {
              id: reservation.id,
              ip: reservation.ip,
              description: reservation.description || '',
            } : null,
            currentLease: lease ? {
              ip: lease.ip || '',
              hostname: lease.hostname || '',
              status: lease.status || '',
              reserved: !!lease.reserved,
              expireTime: lease.expire_time || null,
            } : null,
            effectiveIp: reservation?.ip || lease?.ip || '',
          };
        } catch (err) {
          return {
            firewallId: sync.firewall_id,
            firewallName: sync.firewall_name,
            interfaceName: sync.interface_name,
            dhcpServerId: sync.dhcp_server_id || null,
            error: sanitizeError(err.message),
          };
        }
      }));

      return {
        ...iface,
        status: 'managed',
        vlan: { id: vlan.id, name: vlan.name, tag: vlan.tag },
        dhcpScopes,
      };
    }));

    res.json({ interfaces: payload });
  } catch (err) {
    sendError(res, err);
  }
});

router.put('/:node/:vmid/ip-management/:netInterface/reservation', async (req, res) => {
  const { node, vmid, netInterface } = req.params;
  const { firewallId = null, ip, description = '' } = req.body;

  if (!checkAccess(req.session.userId, node, vmid, req.session.isAdmin)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  if (!ip) {
    return res.status(400).json({ error: 'Reservation IP is required' });
  }
  if (!parseIpv4(ip)) {
    return res.status(400).json({ error: 'Invalid IPv4 address' });
  }

  try {
    const scope = await resolveVmDhcpScope(node, vmid, netInterface, firewallId);
    if (!ipInSubnet(ip, scope.server['default-gateway'], scope.server.netmask)) {
      return res.status(400).json({ error: 'Reservation IP must be inside the DHCP subnet' });
    }
    if (ip === scope.server['default-gateway']) {
      return res.status(400).json({ error: 'Reservation IP cannot be the gateway address' });
    }

    const conflictReservation = scope.reservations.find((reservation) => (
      reservation.ip === ip && reservation.mac !== normalizeMac(scope.iface.mac)
    ));
    if (conflictReservation) {
      return res.status(400).json({ error: `IP ${ip} is already reserved for another device` });
    }

    const conflictLease = scope.leases.find((lease) => (
      lease.ip === ip
      && normalizeMac(lease.mac) !== normalizeMac(scope.iface.mac)
      && lease.interface === scope.sync.interface_name
      && (!lease.type || lease.type === 'ipv4')
      && lease.status === 'leased'
    ));
    if (conflictLease) {
      return res.status(400).json({ error: `IP ${ip} is currently leased to another device` });
    }

    const reservations = [...scope.reservations];
    const descriptionText = String(description || '').trim();
    const nextReservation = {
      ...(scope.currentReservation || {}),
      id: scope.currentReservation?.id || nextReservationId(reservations),
      type: 'mac',
      ip,
      mac: normalizeMac(scope.iface.mac),
      action: 'reserved',
      'circuit-id-type': scope.currentReservation?.['circuit-id-type'] || 'string',
      'circuit-id': scope.currentReservation?.['circuit-id'] || '',
      'remote-id-type': scope.currentReservation?.['remote-id-type'] || 'string',
      'remote-id': scope.currentReservation?.['remote-id'] || '',
      description: descriptionText,
    };

    const nextReservations = reservations
      .filter((reservation) => reservation.mac !== normalizeMac(scope.iface.mac))
      .concat(nextReservation)
      .sort((a, b) => a.id - b.id);

    await scope.client.updateDhcpServer(scope.server.id || scope.sync.dhcp_server_id, {
      'reserved-address': nextReservations,
    });

    const sshConfigUpdated = syncReservationToSshConfig(node, vmid, ip);
    logAudit(req, 'vm_set_ip_reservation', `${node}/${vmid}/${netInterface}`, `${scope.sync.firewall_name}:${ip}`);
    res.json({
      ok: true,
      reservation: { ip, description: descriptionText },
      sshConfigHost: sshConfigUpdated ? ip : null,
    });
  } catch (err) {
    sendError(res, err);
  }
});

router.delete('/:node/:vmid/ip-management/:netInterface/reservation', async (req, res) => {
  const { node, vmid, netInterface } = req.params;
  const { firewallId = null } = req.body || {};

  if (!checkAccess(req.session.userId, node, vmid, req.session.isAdmin)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  try {
    const scope = await resolveVmDhcpScope(node, vmid, netInterface, firewallId);
    if (!scope.currentReservation) {
      return res.json({ ok: true, removed: false });
    }

    const nextReservations = scope.reservations
      .filter((reservation) => reservation.mac !== normalizeMac(scope.iface.mac))
      .sort((a, b) => a.id - b.id);

    await scope.client.updateDhcpServer(scope.server.id || scope.sync.dhcp_server_id, {
      'reserved-address': nextReservations,
    });

    logAudit(req, 'vm_delete_ip_reservation', `${node}/${vmid}/${netInterface}`, scope.sync.firewall_name);
    res.json({ ok: true, removed: true });
  } catch (err) {
    sendError(res, err);
  }
});

// ─── VM Config / VLAN ────────────────────────────────────────────────────────

router.get('/:node/:vmid/config', async (req, res) => {
  const { node, vmid } = req.params;
  if (!checkAccess(req.session.userId, node, vmid, req.session.isAdmin)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    const nodeIdentity = serializeNodeIdentity(node);
    try {
      res.json({ ...(await getVMConfig(node, vmid)), ...nodeIdentity, vmid: parseInt(vmid, 10) });
    } catch {
      res.json({ ...(await getLXCConfig(node, vmid)), ...nodeIdentity, vmid: parseInt(vmid, 10) });
    }
  } catch (err) {
    sendError(res, err);
  }
});

// ─── Cloud-init credential reset ─────────────────────────────────────────────

// Detect whether a qemu VM config exposes a cloud-init drive. PVE reports the
// drive back as e.g. "ide2: local-lvm:vm-100-cloudinit,media=cdrom"; the value
// always carries the "cloudinit" volume marker regardless of which bus it uses.
function hasCloudInitDrive(config = {}) {
  return Object.entries(config).some(([key, value]) => (
    /^(ide|sata|scsi|virtio)\d+$/.test(key)
    && typeof value === 'string'
    && value.includes('cloudinit')
  ));
}

// Loose OpenSSH public-key shape check (ssh-rsa / ssh-ed25519 / ecdsa-* / sk-*).
function looksLikeSshPublicKey(value = '') {
  return /^(ssh-(rsa|ed25519|dss)|ecdsa-sha2-\S+|sk-\S+)\s+\S+/.test(String(value).trim());
}

// Availability probe for the frontend: reveal the reset action only for a
// strict owner (admins bypass) of a qemu VM that actually has a cloud-init
// drive. Keeps the feature hidden for non-owners (incl. see_all_vms) and for
// VMs without cloud-init.
router.get('/:node/:vmid/cloudinit', async (req, res) => {
  const { node, vmid } = req.params;
  if (!checkAccess(req.session.userId, node, vmid, req.session.isAdmin)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    let config;
    try {
      config = await getVMConfig(node, vmid);
    } catch {
      // Not a qemu VM (or unreadable) — no cloud-init here.
      return res.json({ cloudInit: false, canReset: false, ciuser: '' });
    }
    const cloudInit = hasCloudInitDrive(config);
    const owns = req.session.isAdmin || userOwnsVm(req.session.userId, node, vmid);
    res.json({
      cloudInit,
      canReset: cloudInit && owns,
      ciuser: typeof config.ciuser === 'string' ? config.ciuser : '',
    });
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/:node/:vmid/cloudinit-credentials', async (req, res) => {
  const { node, vmid } = req.params;
  const { password, sshKeyId, sshKey, reboot } = req.body || {};

  // Strict ownership only — see_all_vms must NOT grant credential resets,
  // mirroring VM deletion. Admins bypass.
  if (!req.session.isAdmin && !userOwnsVm(req.session.userId, node, vmid)) {
    return res.status(403).json({ error: 'You can only reset credentials for VMs assigned to you' });
  }

  // Must be a qemu VM with a cloud-init drive, otherwise hide the feature (404).
  let config;
  try {
    config = await getVMConfig(node, vmid);
  } catch {
    return res.status(404).json({ error: 'Cloud-init is not available for this VM' });
  }
  if (!hasCloudInitDrive(config)) {
    return res.status(404).json({ error: 'This VM does not have a cloud-init drive' });
  }

  // Resolve the SSH public key — either from one of the user's stored keys or a
  // pasted value. Only public keys are ever touched here; nothing is stored.
  let sshKeys = '';
  if (sshKeyId) {
    const row = db.prepare(
      'SELECT public_key, private_key FROM ssh_keys WHERE id = ? AND user_id = ?'
    ).get(sshKeyId, req.session.userId);
    if (!row) return res.status(400).json({ error: 'Selected SSH key was not found' });
    let publicKey = (row.public_key || '').trim();
    if (!publicKey) {
      // Backfill from the private half — same derivation the SSH key list uses.
      try { publicKey = derivePublicKey(decryptSecret(row.private_key)).trim(); } catch { publicKey = ''; }
    }
    if (!publicKey) {
      return res.status(400).json({ error: 'Could not derive a public key from that stored key — re-add it with its public key.' });
    }
    sshKeys = publicKey;
  } else if (typeof sshKey === 'string' && sshKey.trim()) {
    sshKeys = sshKey.trim();
    if (!looksLikeSshPublicKey(sshKeys)) {
      return res.status(400).json({ error: 'That does not look like an OpenSSH public key' });
    }
  }

  const newPassword = typeof password === 'string' ? password : '';
  if (!newPassword && !sshKeys) {
    return res.status(400).json({ error: 'Provide a new password and/or an SSH public key' });
  }
  if (newPassword && newPassword.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  try {
    // Update cloud-init config. Setting cipassword/sshkeys marks the cloud-init
    // drive for regeneration; PVE rebuilds it and the guest re-applies on the
    // next boot — hence the reboot requirement. URL-encode sshkeys exactly like
    // the from-image provisioning flow does (a PVE quirk).
    const updates = {};
    if (newPassword) updates.cipassword = newPassword;
    if (sshKeys) updates.sshkeys = encodeURIComponent(sshKeys);
    await updateVMConfig(node, vmid, updates);

    // Best-effort inline reboot so the change takes effect immediately: reboot a
    // running VM, or start a stopped one (a stopped guest can't be rebooted).
    let rebooted = false;
    if (reboot) {
      try {
        const status = await getVMStatus(node, vmid);
        if (status?.status === 'running') {
          await vmAction(node, vmid, 'reboot');
        } else {
          await vmAction(node, vmid, 'start');
        }
        rebooted = true;
      } catch (err) {
        console.warn(`[cloudinit-creds] reboot for ${node}/${vmid} failed: ${err.message}`);
      }
    }

    // Audit the event only — never the password or the key material.
    const changed = [newPassword ? 'password' : null, sshKeys ? 'ssh-key' : null].filter(Boolean).join('+');
    logAudit(req, 'vm_cloudinit_credentials_reset', `${node}/${vmid}`, `${changed}${rebooted ? ';rebooted' : ''}`);

    res.json({
      ok: true,
      changedPassword: !!newPassword,
      changedSshKey: !!sshKeys,
      rebooted,
      rebootRequired: !rebooted,
    });
  } catch (err) {
    sendError(res, err);
  }
});

router.put('/:node/:vmid/vlan', async (req, res) => {
  const { node, vmid } = req.params;
  const { netInterface = 'net0', vlanTag } = req.body;

  if (!checkAccess(req.session.userId, node, vmid, req.session.isAdmin)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  // Authorize the target VLAN. Non-admins must move the VM onto a VLAN assigned
  // to them; setting it untagged (removing the tag) drops the VM onto the
  // native network and is admin-only (utils/vlanAccess.js).
  const vlanErr = checkVlanAssignment(db, { userId: req.session.userId, isAdmin: req.session.isAdmin, vlanTag });
  if (vlanErr) return res.status(vlanErr.status).json({ error: vlanErr.error });

  try {
    const config = await getVMConfig(node, vmid);
    const current = config[netInterface];
    if (!current) {
      return res.status(400).json({ error: `Interface ${netInterface} not found on this VM` });
    }

    // Parse "virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0,tag=100,firewall=1" style string
    let parts = current.split(',');
    if (vlanTag === null || vlanTag === 0 || vlanTag === '') {
      parts = parts.filter(p => !p.startsWith('tag='));
    } else if (parts.some(p => p.startsWith('tag='))) {
      parts = parts.map(p => p.startsWith('tag=') ? `tag=${vlanTag}` : p);
    } else {
      parts.push(`tag=${vlanTag}`);
    }

    await updateVMConfig(node, vmid, { [netInterface]: parts.join(',') });
    logAudit(req, 'vlan_change', `${node}/${vmid}`, `${netInterface}=tag:${vlanTag}`);
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

// ─── VM Hardware Edit ────────────────────────────────────────────────────────

const pHardware = requirePermission('can_edit_vm_hardware');

router.put('/:node/:vmid/hardware', pHardware, async (req, res) => {
  const { node, vmid } = req.params;
  const { cores, memory } = req.body;

  if (!checkAccess(req.session.userId, node, vmid, req.session.isAdmin)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  if (!cores && !memory) {
    return res.status(400).json({ error: 'Specify cores and/or memory to update' });
  }

  try {
    const updates = {};
    const details = [];

    if (cores) {
      const coresNum = parseInt(cores, 10);
      if (!coresNum || coresNum < 1 || coresNum > 128) {
        return res.status(400).json({ error: 'Cores must be between 1 and 128' });
      }
      const cpuLayout = await computeCpuTopology(node, coresNum);
      updates.cpu = 'host';
      updates.sockets = cpuLayout.sockets;
      updates.cores = cpuLayout.cores;
      details.push(`cores=${cpuLayout.totalVcpus} (${cpuLayout.sockets}s×${cpuLayout.cores}c)`);
    }

    if (memory) {
      const memMb = parseInt(memory, 10);
      if (!memMb || memMb < 128 || memMb > 1048576) {
        return res.status(400).json({ error: 'Memory must be between 128 MB and 1 TB' });
      }
      updates.memory = memMb;
      details.push(`memory=${memMb}MB`);
    }

    // Quota: only the increase over the VM's current allocation counts —
    // a user at their quota can still shrink resources
    if (!req.session.isAdmin) {
      const current = (await getAllVMs()).find((v) => Number(v.vmid) === Number(vmid));
      const curCores = current?.maxcpu || 0;
      const curMemMb = (current?.maxmem || 0) / (1024 * 1024);
      const newCores = updates.cores ? updates.sockets * updates.cores : curCores;
      const newMemMb = updates.memory || curMemMb;
      const addCores = Math.max(0, newCores - curCores);
      const addMemoryMb = Math.max(0, newMemMb - curMemMb);
      if (addCores > 0 || addMemoryMb > 0) {
        await assertUserQuota(req.session.userId, { addCores, addMemoryMb });
      }
    }

    await updateVMConfig(node, vmid, updates);
    logAudit(req, 'vm_hardware_change', `${node}/${vmid}`, details.join(', '));
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

// NOTE (storage exposure, issue #19): this endpoint grows an *existing* disk in
// place (e.g. scsi0) — it never names a storage pool, so there is no exposed/
// hidden pool to enforce here. There is currently no "add a disk on a chosen
// storage" path in hardware edit; if one is added, call assertStorageExposed()
// on the named pool the same way the /provision create paths do.
router.put('/:node/:vmid/resize-disk', pHardware, async (req, res) => {
  const { node, vmid } = req.params;
  const { disk, size } = req.body;

  if (!checkAccess(req.session.userId, node, vmid, req.session.isAdmin)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  if (!disk || !size) {
    return res.status(400).json({ error: 'disk and size are required' });
  }

  // Validate disk name pattern
  if (!/^(scsi|virtio|sata|ide)\d+$/.test(disk)) {
    return res.status(400).json({ error: 'Invalid disk name' });
  }

  // Validate size format (e.g. "+10G", "50G")
  if (!/^\+?\d+[GMT]$/.test(size)) {
    return res.status(400).json({ error: 'Size must be like "+10G", "50G", "+512M", etc.' });
  }

  try {
    // Quota: count only the growth (PVE resize can never shrink). Relative
    // sizes ("+10G") are the delta directly; absolute sizes are compared to
    // the disk's current size from the VM config.
    if (!req.session.isAdmin) {
      let addDiskGb = 0;
      if (size.startsWith('+')) {
        addDiskGb = sizeToGb(size.slice(1)) || 0;
      } else {
        const config = await getVMConfig(node, vmid);
        const currentGb = sizeToGb(String(config?.[disk] || '').match(/(?:^|,)size=(\d+[MGT])/)?.[1]) || 0;
        addDiskGb = Math.max(0, (sizeToGb(size) || 0) - currentGb);
      }
      if (addDiskGb > 0) {
        await assertUserQuota(req.session.userId, { addDiskGb });
      }
    }

    await resizeVMDisk(node, vmid, disk, size);
    logAudit(req, 'vm_disk_resize', `${node}/${vmid}`, `${disk}=${size}`);
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

// ─── VM Backups ──────────────────────────────────────────────────────────────

// Manual vzdump runs are tracked so the UI can tell a finished archive from one
// Proxmox is still writing — the storage listing shows both the moment the file
// exists. Like vm_migrations, rows are refreshed lazily rather than by a
// background timer: the vzdump task keeps running on the node whatever the
// portal is doing, so re-checking it when someone asks is enough and survives a
// backend restart for free.
const BACKUP_LOG_BATCH = 512;
const BACKUP_LOG_MAX_BATCHES = 20; // bounds the catch-up read of a long dump

function backupTaskRows(node, vmid, { limit = 10 } = {}) {
  const candidates = nodeLookupCandidates(node);
  const placeholders = candidates.map(() => '?').join(', ');
  return db.prepare(
    `SELECT * FROM backup_tasks WHERE vmid = ? AND node IN (${placeholders}) ORDER BY id DESC LIMIT ?`
  ).all(parseInt(vmid, 10), ...candidates, limit);
}

function finalizeBackupTask(row, ok, detail) {
  const changed = db.prepare(
    "UPDATE backup_tasks SET status = ?, status_detail = ?, finished_at = datetime('now') WHERE id = ? AND status = 'running'"
  ).run(ok ? 'ok' : 'failed', detail || '', row.id).changes;
  // Two pollers can land on the same finished task; only the one that actually
  // flipped the row gets to notify.
  if (changed === 0) return;

  const { nodeName } = decodeNodeRef(row.node);
  const vmLabel = `#${row.vmid}${nodeName ? ` on ${nodeName}` : ''}`;
  const owner = row.user_id
    ? db.prepare('SELECT username FROM users WHERE id = ?').get(row.user_id)?.username || ''
    : '';
  // Until now `backup.failed` only ever fired when the *submission* failed, so
  // a dump that died halfway through notified nobody.
  notify(ok ? 'backup.created' : 'backup.failed', {
    vm: vmLabel,
    owner,
    ownerUserId: row.user_id || null,
    status: ok ? 'completed' : 'failed',
    detail: ok
      ? (row.storage ? `Backup to ${row.storage} finished` : 'Backup finished')
      : `Backup failed: ${detail || 'the vzdump task did not finish successfully'}`,
    url: portalLink(`/vm/${row.node}/${row.vmid}`),
  });
}

// Re-check still-'running' rows against their PVE task and scrape the percentage
// out of the task log. Mutates the rows in place so the caller can serialize
// them straight away.
// A row whose node stays unreachable would otherwise sit at 'running' forever,
// and a permanent "Backing up…" banner holds Restore and Delete hostage. No
// manual vzdump runs for a day, so past this point the row is written off.
const BACKUP_TASK_MAX_AGE_MS = 24 * 60 * 60 * 1000;

async function refreshBackupTasks(rows) {
  for (const row of rows) {
    if (row.status !== 'running' || !row.upid) continue;
    // SQLite's datetime('now') is UTC, space-separated — spell out the offset.
    const startedMs = Date.parse(`${String(row.created_at || '').replace(' ', 'T')}Z`);
    if (Number.isFinite(startedMs) && Date.now() - startedMs > BACKUP_TASK_MAX_AGE_MS) {
      finalizeBackupTask(row, false, 'Gave up tracking this backup after 24 hours — check the task log in Proxmox');
      Object.assign(row, db.prepare('SELECT * FROM backup_tasks WHERE id = ?').get(row.id));
      continue;
    }
    // Read the log before the status, so a task that finishes between the two
    // still gets its final progress line recorded. The read has its own catch:
    // a log endpoint that errors (PVE briefly 400s a task it has only just
    // accepted) must not stop the status check below from finalizing the row.
    try {
      const read = await readTaskProgress(
        (opts) => getTaskLog(row.node, row.upid, opts),
        { start: Number(row.log_offset) || 0, batch: BACKUP_LOG_BATCH, maxBatches: BACKUP_LOG_MAX_BATCHES },
      );
      if (read.progress) {
        db.prepare('UPDATE backup_tasks SET progress = ?, progress_detail = ?, log_offset = ? WHERE id = ?')
          .run(read.progress.percent, read.progress.detail, read.offset, row.id);
      } else {
        db.prepare('UPDATE backup_tasks SET log_offset = ? WHERE id = ?').run(read.offset, row.id);
      }
    } catch { /* no readable log yet — the status check still decides the row */ }

    try {
      const task = await getTaskStatus(row.node, row.upid);
      if (task.status === 'stopped') {
        const ok = task.exitstatus === 'OK';
        finalizeBackupTask(row, ok, ok ? '' : task.exitstatus || 'The backup task failed');
      }
    } catch { /* node unreachable — leave it running and try again next poll */ }

    Object.assign(row, db.prepare('SELECT * FROM backup_tasks WHERE id = ?').get(row.id));
  }
}

function serializeBackupTask(row) {
  const { log_offset, user_id, ...rest } = row; // internal bookkeeping, not for the UI
  return {
    ...rest,
    nodeName: decodeNodeRef(row.node).nodeName || row.node,
    // null until the log carries a percentage — the UI falls back to a plain
    // running indicator for the early phase and for rsync-based LXC dumps.
    progress: Number.isFinite(row.progress) ? row.progress : null,
    progress_detail: row.progress_detail || '',
  };
}

router.get('/:node/:vmid/backups', async (req, res) => {
  const { node, vmid } = req.params;
  if (!checkAccess(req.session.userId, node, vmid, req.session.isAdmin)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    const backups = await getVMBackups(node, vmid);
    // Flag the archive a running dump is writing, so the UI can hold back
    // Restore/Delete/Browse and its misleading size and verification tags.
    const tasks = backupTaskRows(node, vmid);
    await refreshBackupTasks(tasks);
    const inProgress = new Set(inProgressVolids(backups, tasks));
    res.json(backups.map((b) => (inProgress.has(b.volid) ? { ...b, inProgress: true } : b)));
  } catch (err) {
    sendError(res, err);
  }
});

// Backup tasks for this VM, newest first. Polled by the VM page while a dump is
// running; also the reason progress survives a page reload or a backend restart.
router.get('/:node/:vmid/backup-tasks', async (req, res) => {
  const { node, vmid } = req.params;
  if (!checkAccess(req.session.userId, node, vmid, req.session.isAdmin)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    const rows = backupTaskRows(node, vmid, { limit: 5 });
    await refreshBackupTasks(rows);
    res.json(rows.map(serializeBackupTask));
  } catch (err) {
    sendError(res, err);
  }
});

router.get('/:node/:vmid/backup-storages', async (req, res) => {
  const { node, vmid } = req.params;
  if (!checkAccess(req.session.userId, node, vmid, req.session.isAdmin)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    res.json(await getBackupStorages(node));
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/:node/:vmid/backup', async (req, res) => {
  const { node, vmid } = req.params;
  if (!checkAccess(req.session.userId, node, vmid, req.session.isAdmin)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const { mode, compress, storage, notes } = req.body;
  const { nodeName } = decodeNodeRef(node);
  const vmLabel = `#${vmid}${nodeName ? ` on ${nodeName}` : ''}`;
  try {
    const upid = await createVMBackup(node, vmid, { mode, compress, storage, notes });
    logAudit(req, 'backup_create', `${node}/${vmid}`, storage || '');
    // Track the task so the UI can mark the archive as in progress instead of
    // showing a half-written dump as a finished backup. The completion
    // notification is fired from finalizeBackupTask once the task actually ends.
    const info = db.prepare(
      'INSERT INTO backup_tasks (user_id, node, vmid, upid, storage, started_epoch) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(
      req.session.userId, node, parseInt(vmid, 10), upid, storage || '',
      parseUpid(upid)?.startTime || 0,
    );
    res.json({ ok: true, upid, taskId: info.lastInsertRowid });
  } catch (err) {
    notify('backup.failed', {
      vm: vmLabel,
      owner: req.session.username,
      ownerUserId: req.session.userId,
      status: 'failed',
      detail: 'Backup could not be started',
      url: portalLink(`/vm/${node}/${vmid}`),
    });
    sendError(res, err);
  }
});

router.delete('/:node/:vmid/backups/:storage/*', async (req, res) => {
  const { node, vmid, storage } = req.params;
  const volid = req.params[0];
  // Deliberately NOT userCanAccessVm — see_all_vms must not grant backup deletion.
  if (!req.session.isAdmin && !userOwnsVm(req.session.userId, node, vmid)) {
    return res.status(403).json({ error: 'You can only delete backups of VMs assigned to you' });
  }
  if (!volidBelongsToVm(volid, vmid)) {
    return res.status(403).json({ error: 'Backup does not belong to this VM' });
  }
  try {
    await deleteVMBackup(node, storage, volid);
    logAudit(req, 'backup_delete', `${node}/${vmid}`, volid);
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

// ─── Restore VM from backup ──────────────────────────────────────────────────

router.post('/:node/:vmid/restore', async (req, res) => {
  const { node, vmid } = req.params;
  // Deliberately NOT userCanAccessVm — restore overwrites the VM's disks
  // (force: 1), so see_all_vms must not grant it.
  if (!req.session.isAdmin && !userOwnsVm(req.session.userId, node, vmid)) {
    return res.status(403).json({ error: 'You can only restore backups to VMs assigned to you' });
  }
  const { archive, storage } = req.body;
  if (!archive) return res.status(400).json({ error: 'archive (volid) is required' });
  if (!volidBelongsToVm(archive, vmid)) {
    return res.status(403).json({ error: 'Backup does not belong to this VM' });
  }
  // A restore has to go to /nodes/{node}/qemu or /nodes/{node}/lxc — the wrong
  // one is rejected upstream with a confusing error. The guest already at the
  // target VMID is authoritative; the volid is a cross-check that catches
  // restoring a container archive over a VM (and vice versa). Either can be
  // unknown — a fresh VMID has no guest to probe, and an unrecognised volid
  // shape tells us nothing — but if both are, refuse rather than assume qemu.
  try {
    const detected = await getGuestType(node, vmid);
    const guest = resolveRestoreGuestType({ volid: archive, detected, vmid });
    if (guest.error) return res.status(guest.status).json({ error: guest.error });
    const upid = await restoreVMBackup(node, vmid, archive, storage, guest.vmtype);
    logAudit(req, 'vm_restore', `${node}/${vmid}`, archive);
    res.json({ ok: true, upid });
  } catch (err) {
    sendError(res, err);
  }
});

// ─── File-level restore (browse backup contents) ────────────────────────────

router.get('/:node/:vmid/backup-files/:storage/*', async (req, res) => {
  const { node, vmid, storage } = req.params;
  const volid = req.params[0]; // everything after storage/
  const { filepath = '/' } = req.query;
  if (!checkAccess(req.session.userId, node, vmid, req.session.isAdmin)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  if (!volidBelongsToVm(volid, vmid)) {
    return res.status(403).json({ error: 'Backup does not belong to this VM' });
  }
  try {
    const files = await listBackupFiles(node, storage, volid, filepath);
    res.json(files);
  } catch (err) {
    sendError(res, err);
  }
});

router.get('/:node/:vmid/backup-download/:storage/*', async (req, res) => {
  const { node, vmid, storage } = req.params;
  const volid = req.params[0]; // everything after storage/
  const { filepath } = req.query;
  if (!checkAccess(req.session.userId, node, vmid, req.session.isAdmin)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  if (!volidBelongsToVm(volid, vmid)) {
    return res.status(403).json({ error: 'Backup does not belong to this VM' });
  }
  if (!filepath) return res.status(400).json({ error: 'filepath is required' });
  try {
    const { stream, headers } = await downloadBackupFile(node, storage, volid, filepath);
    const contentType = headers['content-type'] || 'application/octet-stream';
    // filepath is base64-encoded by Proxmox — decode to get real path
    let realName = 'download';
    try {
      const decoded = Buffer.from(filepath, 'base64').toString('utf-8');
      realName = decoded.split('/').filter(Boolean).pop() || 'download';
    } catch { /* use default */ }
    // Proxmox returns directories as tar archives
    const isArchive = contentType.includes('tar') || contentType.includes('octet-stream');
    if (isArchive && !realName.includes('.')) {
      realName += '.tar.zst';
    }
    // Sanitize filename to prevent header injection
    const safeName = realName.replace(/["\\\r\n]/g, '_').replace(/[^\x20-\x7E]/g, '_');
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    stream.pipe(res);
  } catch (err) {
    sendError(res, err);
  }
});

// ─── VM Snapshots ───────────────────────────────────────────────────────────

router.get('/:node/:vmid/snapshots', async (req, res) => {
  const { node, vmid } = req.params;
  if (!checkAccess(req.session.userId, node, vmid, req.session.isAdmin)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    let snaps;
    try { snaps = await getSnapshots(node, vmid, 'qemu'); }
    catch { snaps = await getSnapshots(node, vmid, 'lxc'); }
    // Filter out 'current' pseudo-snapshot and sort by snaptime
    const filtered = (snaps || []).filter(s => s.name !== 'current');
    filtered.sort((a, b) => (b.snaptime || 0) - (a.snaptime || 0));
    res.json(filtered);
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/:node/:vmid/snapshots', async (req, res) => {
  const { node, vmid } = req.params;
  const { name, description, vmstate } = req.body;
  if (!checkAccess(req.session.userId, node, vmid, req.session.isAdmin)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  if (!name) return res.status(400).json({ error: 'Snapshot name is required' });
  try {
    let upid;
    try { upid = await createSnapshot(node, vmid, 'qemu', name, description, vmstate); }
    catch { upid = await createSnapshot(node, vmid, 'lxc', name, description, false); }
    logAudit(req, 'snapshot_create', `${node}/${vmid}`, name);
    res.json({ ok: true, upid });
  } catch (err) {
    sendError(res, err);
  }
});

router.delete('/:node/:vmid/snapshots/:snapname', async (req, res) => {
  const { node, vmid, snapname } = req.params;
  if (!checkAccess(req.session.userId, node, vmid, req.session.isAdmin)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    try { await deleteSnapshot(node, vmid, 'qemu', snapname); }
    catch { await deleteSnapshot(node, vmid, 'lxc', snapname); }
    logAudit(req, 'snapshot_delete', `${node}/${vmid}`, snapname);
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/:node/:vmid/snapshots/:snapname/rollback', async (req, res) => {
  const { node, vmid, snapname } = req.params;
  if (!checkAccess(req.session.userId, node, vmid, req.session.isAdmin)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    try { await rollbackSnapshot(node, vmid, 'qemu', snapname); }
    catch { await rollbackSnapshot(node, vmid, 'lxc', snapname); }
    logAudit(req, 'snapshot_rollback', `${node}/${vmid}`, snapname);
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

// ─── VM Power Schedule ───────────────────────────────────────────────────────
// Owners (and admins) define an automatic OFF window — stop_time/start_time on a
// set of days in a timezone — enforced by the background scheduler (scheduler.js).

function loadScheduleRow(node, vmid) {
  const candidates = nodeLookupCandidates(node);
  const parsedVmid = parseInt(vmid, 10);
  for (const candidate of candidates) {
    const row = db.prepare('SELECT * FROM vm_schedules WHERE node = ? AND vmid = ?').get(candidate, parsedVmid);
    if (row) return row;
  }
  return null;
}

// Read the schedule (view access is enough).
router.get('/:node/:vmid/schedule', (req, res) => {
  const { node, vmid } = req.params;
  if (!checkAccess(req.session.userId, node, vmid, req.session.isAdmin)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const row = loadScheduleRow(node, vmid);
  res.json({ schedule: serializeSchedule(row) });
});

// Create / update the schedule (strict ownership; admin bypass).
router.put('/:node/:vmid/schedule', (req, res) => {
  const { node, vmid } = req.params;
  if (!canEditSchedule(req, node, vmid)) {
    return res.status(403).json({ error: 'You can only edit schedules for VMs assigned to you' });
  }

  const {
    enabled = true,
    stopTime,
    startTime,
    days = ALL_DAYS,
    timezone = 'UTC',
  } = req.body || {};

  if (!isValidTime(stopTime) || !isValidTime(startTime)) {
    return res.status(400).json({ error: 'stopTime and startTime must be valid HH:MM (24-hour) values' });
  }
  if (stopTime === startTime) {
    return res.status(400).json({ error: 'stopTime and startTime cannot be identical' });
  }
  const daysMask = parseInt(days, 10);
  if (!isValidDaysMask(daysMask)) {
    return res.status(400).json({ error: 'days must be a bitmask between 1 and 127 (at least one active day)' });
  }
  if (!isValidTimezone(timezone)) {
    return res.status(400).json({ error: 'timezone must be a valid IANA timezone (e.g. Europe/Copenhagen)' });
  }

  const parsedVmid = parseInt(vmid, 10);
  const enabledInt = enabled ? 1 : 0;

  // Reset scheduler bookkeeping so a re-defined window is evaluated fresh.
  db.prepare(`
    INSERT INTO vm_schedules
      (node, vmid, enabled, stop_time, start_time, days, timezone,
       skip_until, running_due_to_manual, stopped_this_window, last_off, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, -1, datetime('now'))
    ON CONFLICT(node, vmid) DO UPDATE SET
      enabled = excluded.enabled,
      stop_time = excluded.stop_time,
      start_time = excluded.start_time,
      days = excluded.days,
      timezone = excluded.timezone,
      skip_until = 0,
      running_due_to_manual = 0,
      stopped_this_window = 0,
      last_off = -1,
      updated_at = datetime('now')
  `).run(node, parsedVmid, enabledInt, stopTime, startTime, daysMask, timezone);

  logAudit(req, 'vm_schedule_set', `${node}/${vmid}`, `${enabledInt ? 'on' : 'off'} stop=${stopTime} start=${startTime} days=${daysMask} tz=${timezone}`);
  res.json({ schedule: serializeSchedule(loadScheduleRow(node, vmid)) });
});

// Delete the schedule entirely.
router.delete('/:node/:vmid/schedule', (req, res) => {
  const { node, vmid } = req.params;
  if (!canEditSchedule(req, node, vmid)) {
    return res.status(403).json({ error: 'You can only edit schedules for VMs assigned to you' });
  }
  const candidates = nodeLookupCandidates(node);
  const parsedVmid = parseInt(vmid, 10);
  const placeholders = candidates.map(() => '?').join(', ');
  db.prepare(`DELETE FROM vm_schedules WHERE vmid = ? AND node IN (${placeholders})`).run(parsedVmid, ...candidates);
  logAudit(req, 'vm_schedule_delete', `${node}/${vmid}`, '');
  res.json({ ok: true });
});

// "Skip tonight": suppress scheduler actions until the next start_time so the
// upcoming shutdown is skipped once, then normal enforcement resumes.
router.post('/:node/:vmid/schedule/skip', (req, res) => {
  const { node, vmid } = req.params;
  if (!canEditSchedule(req, node, vmid)) {
    return res.status(403).json({ error: 'You can only edit schedules for VMs assigned to you' });
  }
  const row = loadScheduleRow(node, vmid);
  if (!row || row.enabled !== 1 || !isValidTime(row.start_time) || !isValidTimezone(row.timezone)) {
    return res.status(400).json({ error: 'No active schedule to skip' });
  }
  const skipUntil = nextTimeOccurrence(Date.now(), row.timezone, timeToMinutes(row.start_time));
  db.prepare('UPDATE vm_schedules SET skip_until = ? WHERE id = ?').run(skipUntil, row.id);
  logAudit(req, 'vm_schedule_skip', `${node}/${vmid}`, new Date(skipUntil).toISOString());
  res.json({ schedule: serializeSchedule(loadScheduleRow(node, vmid)) });
});

// Cancel a pending "skip tonight".
router.delete('/:node/:vmid/schedule/skip', (req, res) => {
  const { node, vmid } = req.params;
  if (!canEditSchedule(req, node, vmid)) {
    return res.status(403).json({ error: 'You can only edit schedules for VMs assigned to you' });
  }
  const row = loadScheduleRow(node, vmid);
  if (!row) return res.status(404).json({ error: 'No schedule found' });
  db.prepare('UPDATE vm_schedules SET skip_until = 0 WHERE id = ?').run(row.id);
  logAudit(req, 'vm_schedule_skip_cancel', `${node}/${vmid}`, '');
  res.json({ schedule: serializeSchedule(loadScheduleRow(node, vmid)) });
});

// ─── User's allowed VLANs ────────────────────────────────────────────────────

router.get('/my-vlans', (req, res) => {
  if (req.session.isAdmin) {
    return res.json(db.prepare('SELECT * FROM vlans ORDER BY tag').all());
  }
  const vlans = db.prepare(`
    SELECT v.* FROM vlans v
    JOIN user_vlans uv ON uv.vlan_id = v.id
    WHERE uv.user_id = ?
    ORDER BY v.tag
  `).all(req.session.userId);
  res.json(vlans);
});

export default router;
