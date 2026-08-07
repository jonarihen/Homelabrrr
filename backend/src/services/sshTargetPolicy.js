import dns from 'node:dns/promises';
import net from 'node:net';
import db from '../db.js';
import { validateHost, validatePort } from '../utils/validation.js';
import { getLXCConfig, getVMAgentInterfaces, getVMConfig } from '../proxmox.js';
import { parseIpConfig0 } from '../utils/detectedIps.js';
import { allowedResolvedSshAddresses } from '../utils/sshTargetAuthorization.js';
import { userVlanCidrs } from '../utils/vlanSubnets.js';

const ATTEMPT_WINDOW_MS = 60_000;

export function sshConnectionRateLimited(userId, kind, limit) {
  const now = Date.now();
  db.prepare('DELETE FROM ssh_connection_attempts WHERE attempted_at < ?').run(now - ATTEMPT_WINDOW_MS);
  const count = db.prepare('SELECT COUNT(*) AS count FROM ssh_connection_attempts WHERE user_id = ? AND kind = ? AND attempted_at > ?')
    .get(userId, kind, now - ATTEMPT_WINDOW_MS).count;
  if (count >= limit) return true;
  db.prepare('INSERT INTO ssh_connection_attempts (user_id, kind, attempted_at) VALUES (?, ?, ?)').run(userId, kind, now);
  return false;
}

function assignedNetworks(userId) {
  return userVlanCidrs(db, userId);
}

function explicitlyAssignedAddresses(userId, node, vmid) {
  return db.prepare(`
    SELECT private_ip AS ip FROM public_ip_assignments
    WHERE user_id = ? AND node IN (?, ?) AND vmid = ?
  `).all(userId, node, String(node).replace(/^\d+~/, ''), Number.parseInt(vmid, 10)).map((row) => row.ip);
}

function addressesFromAgent(payload) {
  const interfaces = Array.isArray(payload) ? payload : Array.isArray(payload?.result) ? payload.result : [];
  return interfaces.flatMap((entry) => Array.isArray(entry?.['ip-addresses']) ? entry['ip-addresses'] : [])
    .map((entry) => String(entry?.['ip-address'] || '').split('/')[0])
    .filter((address) => net.isIP(address) && !['127.0.0.1', '::1'].includes(address));
}

function addressesFromConfig(config) {
  const addresses = [];
  for (const [key, value] of Object.entries(config || {})) {
    if (!/^ipconfig\d+$/.test(key) && !/^net\d+$/.test(key)) continue;
    const parsed = parseIpConfig0(String(value || ''));
    if (parsed?.ip) addresses.push(parsed.ip);
    for (const match of String(value || '').matchAll(/(?:^|,)ip6?=([^,]+)/g)) {
      const address = match[1].split('/')[0];
      if (net.isIP(address)) addresses.push(address);
    }
  }
  return addresses;
}

async function detectedVmAddresses(node, vmid) {
  const addresses = new Set();
  try {
    let config;
    try { config = await getVMConfig(node, vmid); }
    catch { config = await getLXCConfig(node, vmid); }
    for (const address of addressesFromConfig(config)) addresses.add(address);
  } catch { /* a stopped/unreachable VM can still be authorized by its VLAN */ }
  try {
    for (const address of addressesFromAgent(await getVMAgentInterfaces(node, vmid))) addresses.add(address);
  } catch { /* guest agent is optional */ }
  return addresses;
}

export async function authorizeSshTarget({ userId, isAdmin, node, vmid, host, port }) {
  const checkedHost = validateHost(host);
  const checkedPort = validatePort(port ?? 22);
  if (isAdmin) return { host: checkedHost, port: checkedPort, resolvedAddresses: [checkedHost], adminOverride: true };

  let addresses;
  if (net.isIP(checkedHost)) addresses = [checkedHost];
  else {
    try {
      addresses = [...new Set((await dns.lookup(checkedHost, { all: true, verbatim: true })).map((entry) => entry.address))];
    } catch {
      const err = new Error('SSH host could not be resolved');
      err.status = 400;
      err.code = 'SSH_TARGET_UNRESOLVED';
      throw err;
    }
  }

  const networks = assignedNetworks(userId);
  const exact = new Set([
    ...explicitlyAssignedAddresses(userId, node, vmid),
    ...(await detectedVmAddresses(node, vmid)),
  ]);
  const allowed = allowedResolvedSshAddresses(addresses, { exactAddresses: [...exact], networks });
  if (!allowed.length) {
    const err = new Error('SSH/SFTP target is outside the VM addresses or networks assigned to you');
    err.status = 403;
    err.code = 'SSH_TARGET_NOT_ASSIGNED';
    throw err;
  }

  // Pin the address selected by policy so a later DNS lookup cannot rebind the
  // hostname to a management-network target between validation and connect.
  return { host: allowed[0], port: checkedPort, resolvedAddresses: allowed, adminOverride: false };
}
