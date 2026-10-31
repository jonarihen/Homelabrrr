import { isIP } from 'net';
import dns from 'dns/promises';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { publicIpAssignments, vmAssignments } from '../db/schema/index.ts';
import { decodeNodeRef, nodeLookupCandidates } from './nodeRef.ts';
import { userVlanCidrs } from './vlanSubnets.ts';
import { hostForNode } from '../proxmox.ts';
import { isValidUpstreamHost } from './validation.ts';

export { isValidUpstreamHost };

// ─── Field validation ─────────────────────────────────────────────────────────
// Everything a user submits is validated here before it is ever built into a
// Caddy route or a DNS query. Never trust the raw strings.

// Strict, single hostname (a-z 0-9 - . ), each label 1-63 chars, TLD present.
// No wildcards, no schemes, no ports — this is the domain we publish and the
// SNI Caddy will request a cert for.
const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function normalizeDomain(input) {
  return String(input || '').trim().toLowerCase().replace(/\.$/, '');
}

export function isValidDomain(domain) {
  return HOSTNAME_RE.test(domain);
}

export function parsePort(port) {
  const n = Number.parseInt(port, 10);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return null;
  return n;
}

// ─── Private / reserved address guard ─────────────────────────────────────────
// Hygiene for DNS validation: a public domain's A record should resolve to the
// homelab's *public* WAN IP, never to a private/reserved/loopback/metadata
// address. (Same reasoning as utils/urlGuard.js, reimplemented here per the
// issue since urlGuard is scoped to download-URL SSRF.)

function isPrivateIPv4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n))) return true;
  const [a, b] = parts;
  return (
    a === 0 ||                              // "this network"
    a === 10 ||                             // RFC1918
    a === 127 ||                            // loopback
    (a === 100 && b >= 64 && b <= 127) ||   // CGNAT 100.64/10
    (a === 169 && b === 254) ||             // link-local / metadata
    (a === 172 && b >= 16 && b <= 31) ||    // RFC1918
    (a === 192 && b === 168) ||             // RFC1918
    (a === 198 && (b === 18 || b === 19)) ||// benchmarking 198.18/15
    a >= 224                                // multicast + reserved + broadcast
  );
}

function isPrivateIPv6(ip) {
  const lower = ip.toLowerCase();
  const dotted = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return isPrivateIPv4(dotted[1]);
  if (lower === '::' || lower === '::1') return true;
  return /^(fc|fd|fe[89ab]|fe[c-f])/.test(lower);
}

export function isPrivateOrReservedIp(address) {
  const version = isIP(address);
  if (version === 4) return isPrivateIPv4(address);
  if (version === 6) return isPrivateIPv6(address);
  return true; // not a valid IP — refuse
}

// ─── DNS resolution ───────────────────────────────────────────────────────────

/**
 * Resolve a domain's A records, following a CNAME chain (best-effort, capped).
 * Returns { addresses: string[], cname: string|null }.
 */
export async function resolveDomainToIps(domain, maxHops = 5) {
  let name = domain;
  let cname = null;
  for (let hop = 0; hop < maxHops; hop++) {
    try {
      const addresses = await dns.resolve4(name);
      if (addresses && addresses.length > 0) return { addresses, cname };
    } catch { /* no A record at this name — fall through and try a CNAME */ }
    // No A record here — see whether it's a CNAME and follow it.
    try {
      const targets = await dns.resolveCname(name);
      if (targets && targets.length > 0) {
        cname = targets[0];
        name = targets[0];
        continue;
      }
    } catch { /* no CNAME either */ }
    break;
  }
  return { addresses: [], cname };
}

/**
 * Validate that a domain currently points at the homelab WAN IP.
 * Returns { ok, addresses, cname, message }.
 */
export async function validateDomainDns(domain, wanIp) {
  if (!wanIp) {
    return { ok: false, addresses: [], cname: null, message: 'No homelab WAN IP is configured yet — an admin must set it on the Caddy server before domains can be validated.' };
  }
  const { addresses, cname } = await resolveDomainToIps(domain);
  if (addresses.length === 0) {
    return {
      ok: false,
      addresses,
      cname,
      message: `No A record found for ${domain}. Create an A record pointing ${domain} at ${wanIp}${cname ? ` (currently a CNAME to ${cname})` : ''}.`,
    };
  }
  if (!addresses.includes(wanIp)) {
    return {
      ok: false,
      addresses,
      cname,
      message: `${domain} currently resolves to ${addresses.join(', ')}, not the homelab WAN IP ${wanIp}. Point its A record at ${wanIp} and try again (DNS changes can take a few minutes to propagate).`,
    };
  }
  return { ok: true, addresses, cname, message: `${domain} points at ${wanIp}.` };
}

// ─── Upstream ownership ────────────────────────────────────────────────────────
// A non-admin may only proxy to targets they own: a private IP an admin
// assigned to them, or an IP inside one of their own VLAN subnets. Otherwise anyone could
// publish an internal admin service to the internet under their own domain.

function ipv4ToInt(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

export function ipv4InCidr(ip, cidr) {
  const [range, bitsRaw] = String(cidr).split('/');
  const bits = Number.parseInt(bitsRaw, 10);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const ipInt = ipv4ToInt(ip);
  const rangeInt = ipv4ToInt(range);
  if (ipInt === null || rangeInt === null) return false;
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : (~((1 << (32 - bits)) - 1)) >>> 0;
  return (ipInt & mask) === (rangeInt & mask);
}

/**
 * The concrete set of upstream targets a user is allowed to proxy to:
 *  - vmIps: private IPs an admin assigned to them (public_ip_assignments) for
 *    VMs that are still assigned to them
 *  - subnets: CIDRs of the VLANs assigned to them (see utils/vlanSubnets.js)
 *  - unverifiedIps: assigned IPs whose VM's Proxmox host could not be checked
 *    right now; neither allowed nor proven disallowed
 * Never read user- or guest-editable data (vm_ssh_configs.host, guest-agent
 * IPs) here: that would let a user publish an arbitrary internal address.
 */
export type HostResolutionMemo = Map<string, Promise<number | false | null>>;

export async function getUserAllowedUpstreams(userId, hostResolutionMemo: HostResolutionMemo = new Map()) {
  const [rows, assignments] = await Promise.all([
    db.select({
      ip: publicIpAssignments.private_ip, node: publicIpAssignments.node, vmid: publicIpAssignments.vmid,
      hostId: publicIpAssignments.proxmox_host_id,
    })
      .from(publicIpAssignments).where(eq(publicIpAssignments.user_id, userId)),
    db.select({ node: vmAssignments.node, vmid: vmAssignments.vmid })
      .from(vmAssignments).where(eq(vmAssignments.user_id, userId)),
  ]);
  // An IP only counts while its VM is still assigned to this user: unassigning
  // a VM leaves the public-IP row behind. Legacy rows may store the bare node
  // name, so a node-name match alone is not enough when the row records its
  // Proxmox host: the assignment must resolve to that same host (`pve` must not
  // match `2~pve` on another cluster, in either direction).
  // Returns null when that cannot be known right now (a Proxmox host needed to
  // resolve a bare node is unreachable): callers must not treat it as a denial.
  const sameHost = async (a, row) => {
    if (row.hostId == null) return true;
    const { hostId } = decodeNodeRef(a.node);
    if (hostId != null) return String(hostId) === String(row.hostId);
    const key = `${a.node}|${a.vmid}`;
    if (!hostResolutionMemo.has(key)) {
      hostResolutionMemo.set(key, hostForNode(a.node, { vmid: a.vmid, strict: true })
        .then((host) => host?.id ?? false)
        .catch((err) => err?.definite ? false : null));
    }
    const resolved = await hostResolutionMemo.get(key);
    return resolved === null ? null : resolved !== false && String(resolved) === String(row.hostId);
  };
  const vmIps = [];
  const unverifiedIps = [];
  for (const row of rows) {
    if (!isIP(row.ip) || vmIps.includes(row.ip)) continue;
    for (const a of assignments) {
      if (a.vmid !== row.vmid) continue;
      if (!nodeLookupCandidates(a.node).includes(row.node) && !nodeLookupCandidates(row.node).includes(a.node)) continue;
      const same = await sameHost(a, row);
      if (same) { vmIps.push(row.ip); break; }
      if (same === null && !unverifiedIps.includes(row.ip)) unverifiedIps.push(row.ip);
    }
  }
  return { vmIps, subnets: await userVlanCidrs(db, userId), unverifiedIps: unverifiedIps.filter((ip) => !vmIps.includes(ip)) };
}

/**
 * Whether `host` is an upstream `userId` is allowed to point a public site at.
 * Admins are exempt. Non-admins must give an IPv4 that is either one of their
 * assigned VMs' IPs or inside one of their VLAN subnets. `unknown: true` on a
 * refusal means ownership could not be checked (Proxmox unreachable).
 */
export async function userCanReachUpstream(userId, host, isAdmin, hostResolutionMemo?: HostResolutionMemo) {
  if (isAdmin) return { ok: true };
  if (!isIP(host)) {
    return { ok: false, message: 'Upstream must be an IP address you own (a VM assigned to you or an address in your VLAN). Host names can only be used by admins.' };
  }
  if (isPrivateOrReservedIp(host) === false) {
    // A public IP is not something we can prove the user owns.
    return { ok: false, message: 'Upstream must be a private address of a VM assigned to you or inside your VLAN subnet.' };
  }
  const { vmIps, subnets, unverifiedIps } = await getUserAllowedUpstreams(userId, hostResolutionMemo);
  if (vmIps.includes(host)) return { ok: true };
  if (subnets.some((cidr) => ipv4InCidr(host, cidr))) return { ok: true };
  if (unverifiedIps.includes(host)) {
    // `unknown`: not a verdict. The maintenance sweep must defer, not revoke.
    return { ok: false, unknown: true, message: `Could not verify that ${host} belongs to a VM assigned to you because its Proxmox host is unreachable. Try again shortly.` };
  }
  return {
    ok: false,
    message: `You can only proxy to targets you own. ${host} is not an assigned VM's IP or inside one of your VLAN subnets${subnets.length ? ` (${subnets.join(', ')})` : ''}.`,
  };
}
