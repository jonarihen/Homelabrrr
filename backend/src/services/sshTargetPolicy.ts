import dns from 'node:dns/promises';
import net from 'node:net';
import { and, count, eq, gt, inArray, lt } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { publicIpAssignments, sshConnectionAttempts, vlans } from '../db/schema/index.ts';
import { validateHost, validatePort } from '../utils/validation.ts';
import { getLXCConfig, getVMAgentInterfaces, getVMConfig } from '../proxmox.ts';
import { parseIpConfig0 } from '../utils/detectedIps.ts';
import { allowedResolvedSshAddresses } from '../utils/sshTargetAuthorization.ts';
import { userVlanCidrs, vlanRowsToCidrs } from '../utils/vlanSubnets.ts';
import { ipv4InCidr } from '../utils/ipPolicy.ts';

const ATTEMPT_WINDOW_MS = 60_000;

// Prune, count, and record ride one transaction (a single pool connection).
// The read-then-insert can overshoot the limit slightly under concurrency —
// same tolerance the serialized SQLite version effectively had.
export async function sshConnectionRateLimited(userId: number, kind: string, limit: number): Promise<boolean> {
  const now = Date.now();
  const windowStart = now - ATTEMPT_WINDOW_MS;
  return db.transaction(async (tx) => {
    await tx.delete(sshConnectionAttempts).where(lt(sshConnectionAttempts.attempted_at, windowStart));
    const [{ c }] = await tx
      .select({ c: count() })
      .from(sshConnectionAttempts)
      .where(and(
        eq(sshConnectionAttempts.user_id, userId),
        eq(sshConnectionAttempts.kind, kind),
        gt(sshConnectionAttempts.attempted_at, windowStart),
      ));
    if (c >= limit) return true;
    await tx.insert(sshConnectionAttempts).values({ user_id: userId, kind, attempted_at: now });
    return false;
  });
}

async function assignedNetworks(userId: number): Promise<string[]> {
  return userVlanCidrs(db, userId);
}

async function explicitlyAssignedAddresses(userId: number, node: string, vmid: number | string): Promise<string[]> {
  // NaN matched nothing in SQLite; PostgreSQL rejects it as an integer
  // parameter, so keep the same fail-closed outcome without a round trip.
  const parsedVmid = Number.parseInt(String(vmid), 10);
  if (!Number.isInteger(parsedVmid)) return [];
  const rows = await db
    .select({ ip: publicIpAssignments.private_ip })
    .from(publicIpAssignments)
    .where(and(
      eq(publicIpAssignments.user_id, userId),
      // Legacy assignment rows may store the bare node name (utils/nodeRef.ts).
      inArray(publicIpAssignments.node, [String(node), String(node).replace(/^\d+~/, '')]),
      eq(publicIpAssignments.vmid, parsedVmid),
    ));
  return rows.map((row) => row.ip);
}

function addressesFromAgent(payload) {
  const interfaces = Array.isArray(payload) ? payload : Array.isArray(payload?.result) ? payload.result : [];
  return interfaces.flatMap((entry) => Array.isArray(entry?.['ip-addresses']) ? entry['ip-addresses'] : [])
    .map((entry) => String(entry?.['ip-address'] || '').split('/')[0])
    .filter((address) => net.isIP(address) && !['127.0.0.1', '::1'].includes(address));
}

function addressesFromConfig(config) {
  const addresses: string[] = [];
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

/** VLAN tags on the VM's NICs (`netN: ...,tag=1010`), set by the portal, not the guest. */
export function vlanTagsFromConfig(config): number[] {
  const tags = new Set<number>();
  for (const [key, value] of Object.entries(config || {})) {
    if (!/^net\d+$/.test(key)) continue;
    const tag = Number(/(?:^|,)tag=(\d+)/.exec(String(value || ''))?.[1]);
    if (Number.isInteger(tag) && tag > 0) tags.add(tag);
  }
  return [...tags];
}

/**
 * Guest-agent and cloud-init addresses are chosen inside the guest or at
 * deploy time, so a VM could claim a management address. Only trust the ones
 * that sit inside the VLAN networks the VM is actually attached to.
 */
export function addressesInsideNetworks(addresses: Iterable<string>, cidrs: string[]): string[] {
  return [...addresses].filter((address) => cidrs.some((cidr) => ipv4InCidr(address, cidr)));
}

async function detectedVmAddresses(node: string, vmid: number | string): Promise<Set<string>> {
  const claimed = new Set<string>();
  let config;
  try {
    try { config = await getVMConfig(node, vmid); }
    catch { config = await getLXCConfig(node, vmid); }
    for (const address of addressesFromConfig(config)) claimed.add(address);
  } catch { /* a stopped/unreachable VM can still be authorized by its VLAN */ }
  try {
    for (const address of addressesFromAgent(await getVMAgentInterfaces(node, vmid))) claimed.add(address);
  } catch { /* guest agent is optional */ }

  const tags = vlanTagsFromConfig(config);
  if (!claimed.size || !tags.length) return new Set();
  const rows = await db
    .select({ tag: vlans.tag, mode: vlans.mode, subnet_cidr: vlans.subnet_cidr })
    .from(vlans)
    .where(inArray(vlans.tag, tags));
  return new Set(addressesInsideNetworks(claimed, vlanRowsToCidrs(rows)));
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
      throw Object.assign(new Error('SSH host could not be resolved'), { status: 400, code: 'SSH_TARGET_UNRESOLVED' });
    }
  }

  const [networks, explicit, detected] = await Promise.all([
    assignedNetworks(userId),
    explicitlyAssignedAddresses(userId, node, vmid),
    detectedVmAddresses(node, vmid),
  ]);
  const exact = new Set([...explicit, ...detected]);
  const allowed = allowedResolvedSshAddresses(addresses, { exactAddresses: [...exact], networks });
  if (!allowed.length) {
    throw Object.assign(
      new Error('SSH/SFTP target is outside the VM addresses or networks assigned to you'),
      { status: 403, code: 'SSH_TARGET_NOT_ASSIGNED' },
    );
  }

  // Pin the address selected by policy so a later DNS lookup cannot rebind the
  // hostname to a management-network target between validation and connect.
  return { host: allowed[0], port: checkedPort, resolvedAddresses: allowed, adminOverride: false };
}
