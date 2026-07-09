import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import db from '../db.js';
import {
  getVMStatus, vmAction, getVNCTicket, getVMConfig, updateVMConfig, resizeVMDisk, getAllVMs, getVMRRD,
  getVMBackups, createVMBackup, deleteVMBackup, getBackupStorages,
  restoreVMBackup, listBackupFiles, downloadBackupFile, deleteVM,
  getLXCStatus, lxcAction, getLXCConfig, updateLXCConfig, getLXCRRD, getLXCVNCTicket,
  getSnapshots, createSnapshot, deleteSnapshot, rollbackSnapshot,
} from '../proxmox.js';
import { createClient } from '../fortigate.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { sanitizeError } from '../utils/sanitize.js';
import { logAudit } from '../utils/audit.js';
import { userCanAccessVm, userOwnsVm } from '../utils/vmAccess.js';
import { userHasPermission } from '../utils/permissions.js';
import { assertUserQuota, sizeToGb } from '../utils/quota.js';
import { decodeNodeRef, nodeLookupCandidates } from '../utils/nodeRef.js';
import { computeCpuTopology } from '../utils/cpuTopology.js';

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

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

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
      return res.json(vms.map(vm => ({
        ...vm,
        ...serializeNodeIdentity(vm.nodeRef || vm.node),
      })));
    } catch (err) {
      return res.status(500).json({ error: sanitizeError(err.message) });
    }
  }

  const assignments = db.prepare('SELECT * FROM vm_assignments WHERE user_id = ?').all(req.session.userId);

  const results = await Promise.all(assignments.map(async (a) => {
    const nodeIdentity = serializeNodeIdentity(a.node);
    try {
      const status = await getVMStatus(a.node, a.vmid);
      return { ...status, ...nodeIdentity, assignmentId: a.id };
    } catch {
      return { vmid: a.vmid, ...nodeIdentity, name: `VM ${a.vmid}`, status: 'error', assignmentId: a.id };
    }
  }));

  res.json(results);
});

// ─── VM Status ────────────────────────────────────────────────────────────────

router.get('/:node/:vmid/status', async (req, res) => {
  const { node, vmid } = req.params;
  if (!checkAccess(req.session.userId, node, vmid, req.session.isAdmin)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    const nodeIdentity = serializeNodeIdentity(node);
    try {
      res.json({ ...(await getVMStatus(node, vmid)), ...nodeIdentity, vmid: parseInt(vmid, 10), type: 'qemu' });
    } catch {
      res.json({ ...(await getLXCStatus(node, vmid)), ...nodeIdentity, vmid: parseInt(vmid, 10), type: 'lxc' });
    }
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: sanitizeError(err.message) });
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
    res.status(err.statusCode || 500).json({ error: sanitizeError(err.message) });
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
    for (const table of ['vm_assignments', 'vm_ssh_configs', 'vm_ssh_user_configs', 'provisioned_vms']) {
      db.prepare(`DELETE FROM ${table} WHERE vmid = ? AND node IN (${placeholders})`).run(parsedVmid, ...candidates);
    }

    logAudit(req, 'vm_delete', `${node}/${vmid}`, `backups_deleted=${deletedBackups}${failedBackups.length > 0 ? ` backups_failed=${failedBackups.length}` : ''}`);
    res.json({ ok: true, deletedBackups, failedBackups });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: sanitizeError(err.message) });
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
    res.status(err.statusCode || 500).json({ error: sanitizeError(err.message) });
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
    res.status(500).json({ error: sanitizeError(err.message) });
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
    res.status(500).json({ error: sanitizeError(err.message) });
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
    res.status(500).json({ error: sanitizeError(err.message) });
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
    res.status(500).json({ error: sanitizeError(err.message) });
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
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

router.put('/:node/:vmid/vlan', async (req, res) => {
  const { node, vmid } = req.params;
  const { netInterface = 'net0', vlanTag } = req.body;

  if (!checkAccess(req.session.userId, node, vmid, req.session.isAdmin)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  // Non-admins: verify they have access to the requested VLAN
  if (!req.session.isAdmin && vlanTag !== null && vlanTag !== 0) {
    const allowed = db.prepare(`
      SELECT v.id FROM vlans v
      JOIN user_vlans uv ON uv.vlan_id = v.id
      WHERE uv.user_id = ? AND v.tag = ?
    `).get(req.session.userId, parseInt(vlanTag));

    if (!allowed) {
      return res.status(403).json({ error: 'You do not have access to that VLAN' });
    }
  }

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
    res.status(500).json({ error: sanitizeError(err.message) });
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
    const status = err.status || 500;
    res.status(status).json({ error: sanitizeError(err.message) });
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
    const status = err.status || 500;
    res.status(status).json({ error: err.status ? err.message : sanitizeError(err.message) });
  }
});

// ─── VM Backups ──────────────────────────────────────────────────────────────

router.get('/:node/:vmid/backups', async (req, res) => {
  const { node, vmid } = req.params;
  if (!checkAccess(req.session.userId, node, vmid, req.session.isAdmin)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    res.json(await getVMBackups(node, vmid));
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
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
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

router.post('/:node/:vmid/backup', async (req, res) => {
  const { node, vmid } = req.params;
  if (!checkAccess(req.session.userId, node, vmid, req.session.isAdmin)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const { mode, compress, storage, notes } = req.body;
  try {
    const upid = await createVMBackup(node, vmid, { mode, compress, storage, notes });
    logAudit(req, 'backup_create', `${node}/${vmid}`, storage || '');
    res.json({ ok: true, upid });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
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
    res.status(500).json({ error: sanitizeError(err.message) });
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
  try {
    const vmtype = archive.includes('vzdump-lxc-') ? 'lxc' : 'qemu';
    const upid = await restoreVMBackup(node, vmid, archive, storage, vmtype);
    logAudit(req, 'vm_restore', `${node}/${vmid}`, archive);
    res.json({ ok: true, upid });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
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
    res.status(500).json({ error: sanitizeError(err.message) });
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
    res.status(500).json({ error: sanitizeError(err.message) });
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
    res.status(500).json({ error: sanitizeError(err.message) });
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
    res.status(500).json({ error: sanitizeError(err.message) });
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
    res.status(500).json({ error: sanitizeError(err.message) });
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
    res.status(500).json({ error: sanitizeError(err.message) });
  }
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
