import { Router } from 'express';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import { vmSshConfigs, vlans, firewallVlanSync, firewalls, vmDetectedIps } from '../../db/schema/index.ts';
import { getVMConfig, getLXCConfig, getVMAgentInterfaces, guestPresence } from '../../proxmox.ts';
import { createClient } from '../../fortigate.ts';
import { sanitizeError } from '../../utils/sanitize.ts';
import { httpError, sendError } from '../../utils/httpError.ts';
import { logAudit } from '../../utils/audit.ts';
import { decodeNodeRef, nodeLookupCandidates } from '../../utils/nodeRef.ts';
import {
  parseIpConfig0, normalizeGuestAgentInterfaces, rankCandidates, normalizeMac, parseVmNetworkInterfaces,
  findMatchingLease,
} from '../../utils/detectedIps.ts';
import { withVmPolicyWrite } from '../../utils/vmMigrationLock.ts';
import { allowOp } from './shared.ts';

const router = Router();

// Portal-authored validation failure. Handlers report it through sendError(),
// which honours the tagged status and returns the message verbatim for 4xx —
// these strings were written for the user, not scraped from an upstream.
const badRequest = (message) => httpError(400, message);

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

// `vm_ssh_configs.host` is the portal's only record of "where this VM lives" —
// port forwarding, website publishing and browser SSH all read it. Whenever the
// firewall tells us the real address, write it back so the user never has to
// look it up by hand.
//
// `onlyIfEmpty` is the opportunistic mode used for observed DHCP leases: a
// lease is evidence, not a decision, so it fills a blank but never overwrites
// an address the user (or a static reservation) put there on purpose.
//
// Returns { matched, updated, previous } — `matched` means a config row for
// this VM exists and now holds `ip`; `previous` is what was recorded before,
// so the caller can audit an address changing under the user.
async function syncReservationToSshConfig(node, vmid, ip, { onlyIfEmpty = false } = {}) {
  const miss = { matched: false, updated: false, previous: '' };
  const { nodeName } = decodeNodeRef(node);
  const candidates = [...new Set([String(node || ''), String(nodeName || '')].filter(Boolean))];
  if (candidates.length === 0 || !ip) return miss;

  const rows = await db
    .select({ id: vmSshConfigs.id, node: vmSshConfigs.node, host: vmSshConfigs.host })
    .from(vmSshConfigs)
    .where(and(eq(vmSshConfigs.vmid, Number.parseInt(vmid, 10)), inArray(vmSshConfigs.node, candidates)));

  if (rows.length === 0) return miss;
  const exact = rows.find((row) => row.node === node);
  const target = exact || (rows.length === 1 ? rows[0] : null);
  if (!target) return miss;

  const previous = String(target.host || '').trim();
  if (previous === ip) return { matched: true, updated: false, previous };
  if (onlyIfEmpty && previous) return { matched: false, updated: false, previous };

  await db.update(vmSshConfigs).set({ host: ip }).where(eq(vmSshConfigs.id, target.id));
  return { matched: true, updated: true, previous };
}

// Shared column map for the firewall_vlan_sync ⨝ firewalls join (was
// `SELECT fvs.*, f.name AS firewall_name, f.host, …`). createClient() reads
// host/port/api_key/vdom/verify_tls; the rest is fvs bookkeeping.
const SYNC_WITH_FIREWALL_COLUMNS = {
  id: firewallVlanSync.id,
  firewall_id: firewallVlanSync.firewall_id,
  vlan_id: firewallVlanSync.vlan_id,
  interface_name: firewallVlanSync.interface_name,
  policy_ids: firewallVlanSync.policy_ids,
  dhcp_server_id: firewallVlanSync.dhcp_server_id,
  synced_at: firewallVlanSync.synced_at,
  artifacts: firewallVlanSync.artifacts,
  workflow_run_id: firewallVlanSync.workflow_run_id,
  firewall_name: firewalls.name,
  host: firewalls.host,
  port: firewalls.port,
  api_key: firewalls.api_key,
  vdom: firewalls.vdom,
  verify_tls: firewalls.verify_tls,
};

async function resolveVmDhcpScope(node, vmid, netInterface, firewallId = null) {
  const config = await loadVmConfigForIpManagement(node, vmid);
  const iface = parseVmNetworkInterfaces(config).find((entry) => entry.name === netInterface);
  if (!iface) throw badRequest(`Network interface ${netInterface} not found on this VM`);
  if (!iface.mac) throw badRequest(`Network interface ${netInterface} has no MAC address`);
  if (!iface.vlanTag) throw badRequest(`Network interface ${netInterface} is not VLAN-tagged`);

  const [vlan] = await db.select().from(vlans).where(eq(vlans.tag, iface.vlanTag)).limit(1);
  if (!vlan) throw badRequest(`VLAN ${iface.vlanTag} is not managed by the portal`);
  if (vlan.mode === 'tagged_only') throw badRequest(`VLAN ${iface.vlanTag} is tagged-only and has no managed DHCP server`);

  const syncs = await db
    .select(SYNC_WITH_FIREWALL_COLUMNS)
    .from(firewallVlanSync)
    .innerJoin(firewalls, eq(firewalls.id, firewallVlanSync.firewall_id))
    .where(eq(firewallVlanSync.vlan_id, vlan.id))
    .orderBy(firewallVlanSync.id);

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

router.get('/:node/:vmid/ip-management', async (req, res) => {
  const { node, vmid } = req.params;
  if (!(await allowOp(req, node, vmid, 'vm.ipManagement.read'))) {
    return res.status(403).json({ error: 'Access denied' });
  }

  try {
    const config = await loadVmConfigForIpManagement(node, vmid);
    const interfaces = parseVmNetworkInterfaces(config);
    const vlanTags = [...new Set(interfaces.map((entry) => entry.vlanTag as number | null).filter((tag): tag is number => !!tag))];
    // One query for every tagged VLAN instead of a lookup per interface.
    const vlanRows = vlanTags.length > 0
      ? await db.select().from(vlans).where(inArray(vlans.tag, vlanTags))
      : [];
    const vlanMap = new Map(vlanRows.map((vlan) => [vlan.tag, vlan]));

    const syncRows = vlanTags.length > 0
      ? await db
          .select({ ...SYNC_WITH_FIREWALL_COLUMNS, vlan_tag: vlans.tag })
          .from(firewallVlanSync)
          .innerJoin(firewalls, eq(firewalls.id, firewallVlanSync.firewall_id))
          .innerJoin(vlans, eq(vlans.id, firewallVlanSync.vlan_id))
          .where(inArray(vlans.tag, vlanTags))
          .orderBy(firewallVlanSync.id)
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

    // A VM that only ever got a plain DHCP lease used to keep an empty
    // vm_ssh_configs.host forever — which silently blocks port forwarding,
    // website publishing and browser SSH with no hint as to why. Now that the
    // lease is in hand, fill the blank opportunistically. A recorded address is
    // never overwritten here; only PUT .../reservation does that.
    const observedIp = payload
      .flatMap((entry) => entry.dhcpScopes || [])
      .map((scope) => scope.effectiveIp)
      .find((ip) => !!ip);
    let recordedIp = null;
    if (observedIp) {
      const sshSync = await syncReservationToSshConfig(node, vmid, observedIp, { onlyIfEmpty: true });
      if (sshSync.updated) {
        recordedIp = observedIp;
        await logAudit(req, 'vm_ip_record_changed', `${node}/${vmid}`, `recorded ${observedIp} from DHCP lease`);
      }
    }

    res.json({ interfaces: payload, recordedIp });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

// ─── Detected IPs ────────────────────────────────────────────────────────────
// "What address does this VM actually have?" answered from every source the
// portal can reach, ranked with provenance. Every source is best-effort: a
// missing guest agent, an unreachable firewall or a VLAN with no managed DHCP
// scope degrades the answer instead of failing the request.
router.get('/:node/:vmid/detected-ips', async (req, res) => {
  const { node, vmid } = req.params;
  if (!(await allowOp(req, node, vmid, 'vm.ipManagement.read'))) {
    return res.status(403).json({ error: 'Access denied' });
  }

  try {
    const config = await loadVmConfigForIpManagement(node, vmid);
    const observations = [];
    const sourcesTried = [];

    // 1. cloud-init statics — ipconfigN maps to netN (see parseCloudInitOptions).
    let cloudInitDhcp = false;
    const ipConfigKeys = Object.keys(config)
      .filter((key) => /^ipconfig\d+$/.test(key))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    for (const key of ipConfigKeys) {
      const parsed = parseIpConfig0(config[key]);
      if (!parsed) continue;
      sourcesTried.push('cloud_init');
      if (parsed.dhcp) cloudInitDhcp = true;
      if (parsed.ip) observations.push({ ip: parsed.ip, source: 'cloud_init', iface: `net${key.slice('ipconfig'.length)}` });
    }

    // 2. FortiGate DHCP reservation / lease, per VLAN-tagged interface. Reuses
    //    the same resolution the /ip-management panel does.
    for (const iface of parseVmNetworkInterfaces(config)) {
      if (!iface.mac || !iface.vlanTag) continue;
      try {
        const scope = await resolveVmDhcpScope(node, vmid, iface.name);
        sourcesTried.push('dhcp');
        if (scope.currentReservation?.ip) {
          observations.push({ ip: scope.currentReservation.ip, source: 'dhcp_reservation', iface: iface.name });
        }
        if (scope.currentLease?.ip) {
          observations.push({ ip: scope.currentLease.ip, source: 'dhcp_lease', iface: iface.name });
        }
      } catch {
        // Unmanaged VLAN, unsynced firewall, or the firewall is down — the
        // other sources can still answer.
      }
    }

    // 3. qemu-guest-agent. Absent/stopped agent → Proxmox 500s; not an error here.
    let guestAgent = 'unavailable';
    try {
      const agentPayload = await getVMAgentInterfaces(node, vmid);
      const agentEntries = normalizeGuestAgentInterfaces(agentPayload);
      guestAgent = 'ok';
      sourcesTried.push('guest_agent');
      observations.push(...agentEntries.map((entry) => ({ ip: entry.ip, source: 'guest_agent', iface: entry.iface })));
    } catch {
      guestAgent = 'unavailable';
    }

    const candidates = rankCandidates(observations);
    if (candidates[0]) {
      // Best-effort cache for the VM list; a failed write must not fail detection.
      // Under the VM lock and only while the guest exists, so a write racing a
      // delete or migration cannot leave a stale row for a reused VMID.
      const cached = { ip: candidates[0].ip, source: candidates[0].source, detected_at: new Date() };
      const parsedVmid = parseInt(vmid, 10);
      await withVmPolicyWrite(node, parsedVmid, async (tx, currentNode) => {
        if (!(await guestPresence(currentNode, parsedVmid, tx))) return;
        await tx.insert(vmDetectedIps).values({ node: currentNode, vmid: parsedVmid, ...cached })
          .onConflictDoUpdate({ target: [vmDetectedIps.node, vmDetectedIps.vmid], set: cached });
      }).catch((err) => console.warn(`[detected-ips] cache write skipped for ${node}/${vmid}: ${err.message}`));
    }
    // Legacy rows store the bare node name, so match on every candidate form.
    const lookupNodes = nodeLookupCandidates(node);
    const [sshRow] = lookupNodes.length > 0
      ? await db
        .select({ host: vmSshConfigs.host })
        .from(vmSshConfigs)
        .where(and(eq(vmSshConfigs.vmid, parseInt(vmid, 10)), inArray(vmSshConfigs.node, lookupNodes)))
        .limit(1)
      : [];

    res.json({
      candidates,
      guestAgent,
      cloudInitDhcp,
      sourcesTried: [...new Set(sourcesTried)],
      recordedHost: sshRow?.host || '',
    });
  } catch (err) {
    sendError(res, err);
  }
});

router.put('/:node/:vmid/ip-management/:netInterface/reservation', async (req, res) => {
  const { node, vmid, netInterface } = req.params;
  const { firewallId = null, ip, description = '' } = req.body;

  if (!(await allowOp(req, node, vmid, 'vm.ipManagement.write'))) {
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

    const sshSync = await syncReservationToSshConfig(node, vmid, ip);
    await logAudit(req, 'vm_set_ip_reservation', `${node}/${vmid}/${netInterface}`, `${scope.sync.firewall_name}:${ip}`);
    // The recorded address also drives port forwarding and website publishing,
    // so replacing one the user typed is worth its own audit line.
    if (sshSync.updated && sshSync.previous) {
      await logAudit(req, 'vm_ip_record_changed', `${node}/${vmid}`, `${sshSync.previous} → ${ip} (dhcp reservation)`);
    }
    res.json({
      ok: true,
      reservation: { ip, description: descriptionText },
      sshConfigHost: sshSync.matched ? ip : null,
    });
  } catch (err) {
    sendError(res, err);
  }
});

router.delete('/:node/:vmid/ip-management/:netInterface/reservation', async (req, res) => {
  const { node, vmid, netInterface } = req.params;
  const { firewallId = null } = req.body || {};

  if (!(await allowOp(req, node, vmid, 'vm.ipManagement.write'))) {
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

    await logAudit(req, 'vm_delete_ip_reservation', `${node}/${vmid}/${netInterface}`, scope.sync.firewall_name);
    res.json({ ok: true, removed: true });
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
