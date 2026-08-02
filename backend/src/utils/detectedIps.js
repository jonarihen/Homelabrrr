// Pure helpers behind GET /api/vms/:node/:vmid/detected-ips.
//
// The portal already knows a VM's address from several independent places
// (FortiGate DHCP, the cloud-init ipconfig line, qemu-guest-agent) but has
// historically made the user re-type it into the SSH form. These helpers turn
// those raw upstream payloads into one ranked, de-duplicated candidate list.
//
// Deliberately free of DB handles, network calls and Express objects so the
// ranking rules can be unit-tested — the callers pass rows/payloads in.

const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

// Ranking is confidence-tier first, then how trustworthy the source is inside
// that tier. A reservation is a promise about the future; a lease or a
// cloud-init line is only a statement about a moment in time.
export const IP_SOURCES = {
  dhcp_reservation: { rank: 0, confidence: 'high' },
  guest_agent: { rank: 1, confidence: 'high' },
  cloud_init: { rank: 2, confidence: 'medium' },
  dhcp_lease: { rank: 3, confidence: 'medium' },
};

const UNKNOWN_SOURCE = { rank: 99, confidence: 'low' };
const CONFIDENCE_ORDER = { high: 0, medium: 1, low: 2 };

function sourceMeta(source) {
  return IP_SOURCES[source] || UNKNOWN_SOURCE;
}

/** Split "10.0.20.50/24" into its address and prefix. Never throws. */
export function stripCidr(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return { ip: '', prefix: null };
  const slash = raw.indexOf('/');
  if (slash === -1) return { ip: raw, prefix: null };
  const prefix = Number.parseInt(raw.slice(slash + 1), 10);
  return {
    ip: raw.slice(0, slash),
    prefix: Number.isInteger(prefix) && prefix >= 0 && prefix <= 32 ? prefix : null,
  };
}

/**
 * True only for an IPv4 address a human could actually connect to.
 * Rejects IPv6, loopback (127/8), link-local / APIPA (169.254/16), the
 * unspecified 0/8 block, multicast (224–239) and the reserved 240+ block —
 * qemu-guest-agent reports all of those and none of them are the VM's address.
 */
export function isUsableIpv4(value) {
  const raw = String(value ?? '').trim();
  const match = IPV4_PATTERN.exec(raw);
  if (!match) return false;

  const octets = match.slice(1, 5).map((part) => Number.parseInt(part, 10));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  // "010.1.1.1" parses but is not a form anything else in the portal emits.
  if (match.slice(1, 5).some((part) => part.length > 1 && part.startsWith('0'))) return false;

  const [a, b] = octets;
  if (a === 0) return false;                  // 0.0.0.0/8 — unspecified
  if (a === 127) return false;                // loopback
  if (a === 169 && b === 254) return false;   // link-local / APIPA
  if (a >= 224) return false;                 // multicast + reserved + broadcast
  return true;
}

/**
 * Parse a Proxmox cloud-init `ipconfigN` string.
 *
 *   "ip=10.0.20.50/24,gw=10.0.20.1" → { ip: '10.0.20.50', prefix: 24, gateway: '10.0.20.1', dhcp: false }
 *   "ip=dhcp"                       → { ip: '', prefix: null, gateway: '', dhcp: true }
 *
 * Returns null when the string carries no `ip=`/`ip6=` token at all (empty,
 * missing, or some unrelated value), so a caller can tell "nothing configured"
 * apart from "configured for DHCP". IPv6-only configs come back with an empty
 * `ip` — the portal's downstream features are IPv4-only.
 */
export function parseIpConfig0(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return null;

  const parts = raw.split(',').map((part) => part.trim()).filter(Boolean);
  const fields = new Map();
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    if (!fields.has(key)) fields.set(key, part.slice(eq + 1).trim());
  }

  if (!fields.has('ip') && !fields.has('ip6')) return null;

  const rawIp = fields.get('ip') || '';
  const dhcp = rawIp.toLowerCase() === 'dhcp' || (fields.get('ip6') || '').toLowerCase() === 'dhcp';
  const result = { ip: '', prefix: null, gateway: '', dhcp };

  if (rawIp && !/^(dhcp|manual|auto)$/i.test(rawIp)) {
    const { ip, prefix } = stripCidr(rawIp);
    if (isUsableIpv4(ip)) {
      result.ip = ip;
      result.prefix = prefix;
    }
  }

  const gateway = fields.get('gw') || '';
  if (isUsableIpv4(gateway)) result.gateway = gateway;

  return result;
}

/**
 * Flatten a Proxmox `agent/network-get-interfaces` payload into
 * `[{ ip, iface, prefix }]`. Accepts the raw `{ result: [...] }` envelope, the
 * bare array, or garbage (→ []). Non-IPv4 entries are dropped here; loopback
 * and link-local filtering happens in rankCandidates so there is exactly one
 * place that decides what "usable" means.
 */
export function normalizeGuestAgentInterfaces(payload) {
  const list = Array.isArray(payload) ? payload
    : Array.isArray(payload?.result) ? payload.result
      : [];

  const out = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const iface = String(entry.name || entry['iface-name'] || '').trim();
    const addresses = Array.isArray(entry['ip-addresses']) ? entry['ip-addresses']
      : Array.isArray(entry.ipAddresses) ? entry.ipAddresses
        : [];

    for (const address of addresses) {
      if (!address || typeof address !== 'object') continue;
      const type = String(address['ip-address-type'] || address.type || '').toLowerCase();
      if (type && type !== 'ipv4') continue;
      const { ip } = stripCidr(address['ip-address'] ?? address.ip ?? '');
      if (!ip || ip.includes(':')) continue;
      const prefix = Number.parseInt(address.prefix, 10);
      out.push({ ip, iface, prefix: Number.isInteger(prefix) ? prefix : null });
    }
  }
  return out;
}

/**
 * Rank, de-duplicate and score raw `{ ip, source, iface }` observations.
 *
 * Rules:
 *  - anything that is not a usable IPv4 address is dropped;
 *  - the same address seen from several sources collapses to one entry, kept
 *    under its best-ranked source, with every contributing source listed in
 *    `sources`;
 *  - independent corroboration (2+ distinct sources agreeing) promotes the
 *    entry to `high` confidence — a lease the guest agent confirms is not a
 *    guess any more;
 *  - the result is sorted by confidence, then source rank, then address, so
 *    candidates[0] is always the one to offer first.
 */
export function rankCandidates(list) {
  const byIp = new Map();

  for (const entry of Array.isArray(list) ? list : []) {
    if (!entry || typeof entry !== 'object') continue;
    const { ip } = stripCidr(entry.ip);
    if (!isUsableIpv4(ip)) continue;

    const source = String(entry.source || '').trim() || 'unknown';
    const iface = String(entry.iface || '').trim();
    const existing = byIp.get(ip);

    if (!existing) {
      byIp.set(ip, { ip, source, iface, sources: [source] });
      continue;
    }

    if (!existing.sources.includes(source)) existing.sources.push(source);
    if (sourceMeta(source).rank < sourceMeta(existing.source).rank) {
      existing.source = source;
      if (iface) existing.iface = iface;
    } else if (!existing.iface) {
      existing.iface = iface;
    }
  }

  return [...byIp.values()]
    .map((entry) => {
      const base = sourceMeta(entry.source).confidence;
      const corroborated = entry.sources.length > 1;
      return {
        ip: entry.ip,
        source: entry.source,
        iface: entry.iface,
        confidence: corroborated && base !== 'high' ? 'high' : base,
        sources: [...entry.sources].sort((a, b) => sourceMeta(a).rank - sourceMeta(b).rank),
      };
    })
    .sort((a, b) => (
      (CONFIDENCE_ORDER[a.confidence] ?? 9) - (CONFIDENCE_ORDER[b.confidence] ?? 9)
      || sourceMeta(a.source).rank - sourceMeta(b.source).rank
      || a.ip.localeCompare(b.ip, undefined, { numeric: true })
    ));
}
