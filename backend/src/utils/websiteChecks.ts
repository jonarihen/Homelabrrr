import { isIP } from 'net';
import dns from 'dns/promises';
import db from '../db.ts';
import { nodeLookupCandidates } from './nodeRef.ts';
import { userVlanCidrs } from './vlanSubnets.ts';

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

// Upstream host: an IP literal or a DNS hostname (single-label hostnames like
// "app" are allowed for upstreams, unlike the public domain).
const UPSTREAM_HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;

export function isValidUpstreamHost(host) {
  if (!host) return false;
  if (isIP(host)) return true;
  return UPSTREAM_HOST_RE.test(host);
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
// A non-admin may only proxy to targets they own: an IP of a VM assigned to
// them, or an IP inside one of their own VLAN subnets. Otherwise anyone could
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
 *  - vmIps: IPs of VMs assigned to them (from vm_ssh_configs.host)
 *  - subnets: CIDRs of the VLANs assigned to them (see utils/vlanSubnets.js)
 */
export function getUserAllowedUpstreams(userId) {
  const vmIps = new Set();
  const assignments = db.prepare('SELECT node, vmid FROM vm_assignments WHERE user_id = ?').all(userId);
  const sshConfigStmt = db.prepare('SELECT host FROM vm_ssh_configs WHERE node = ? AND vmid = ?');
  for (const a of assignments) {
    for (const candidate of nodeLookupCandidates(a.node)) {
      const cfg = sshConfigStmt.get(candidate, a.vmid);
      if (cfg?.host && isIP(cfg.host)) { vmIps.add(cfg.host); break; }
    }
  }

  return { vmIps: [...vmIps], subnets: userVlanCidrs(db, userId) };
}

/**
 * Whether `host` is an upstream `userId` is allowed to point a public site at.
 * Admins are exempt. Non-admins must give an IPv4 that is either one of their
 * assigned VMs' IPs or inside one of their VLAN subnets.
 */
export function userCanReachUpstream(userId, host, isAdmin) {
  if (isAdmin) return { ok: true };
  if (!isIP(host)) {
    return { ok: false, message: 'Upstream must be an IP address you own (a VM assigned to you or an address in your VLAN). Host names can only be used by admins.' };
  }
  if (isPrivateOrReservedIp(host) === false) {
    // A public IP is not something we can prove the user owns.
    return { ok: false, message: 'Upstream must be a private address of a VM assigned to you or inside your VLAN subnet.' };
  }
  const { vmIps, subnets } = getUserAllowedUpstreams(userId);
  if (vmIps.includes(host)) return { ok: true };
  if (subnets.some((cidr) => ipv4InCidr(host, cidr))) return { ok: true };
  return {
    ok: false,
    message: `You can only proxy to targets you own. ${host} is not an assigned VM's IP or inside one of your VLAN subnets${subnets.length ? ` (${subnets.join(', ')})` : ''}.`,
  };
}
