// Endpoint-aware external-port conflict detection for port forwards.
//
// A port forward is uniquely identified by the *public endpoint* it lands on,
// not by the firewall it lives on. Historically the portal enforced
//
//     firewall + protocol + external port
//
// which meant one user claiming TCP 443 locked it for everybody. Once a user
// can be handed a dedicated public IPv4 address, the boundary becomes
//
//     firewall + public endpoint + protocol + overlapping external port range
//
// so 203.0.113.10:443/tcp and 203.0.113.11:443/tcp coexist happily.
//
// `NULL public_ip_id` keeps its historical meaning — the firewall's default WAN
// endpoint — and forms its own namespace, so legacy forwards keep colliding
// with each other exactly as before and never with a dedicated address.
//
// Pure module: rows come in as plain objects, no db handle, no FortiGate client.

import { normalizeIpv4 } from './publicIpPools.js';

// Sentinel used when an endpoint has no resolvable address (a firewall whose
// external IP has not been configured yet). Stable across processes so it can
// be compared, stored and logged.
export const LEGACY_WAN_ENDPOINT_KEY = 'wan';

/** 'tcp' | 'udp', or null for anything else. */
export function normalizePortProtocol(protocol) {
  const normalized = String(protocol ?? '').trim().toLowerCase();
  return normalized === 'tcp' || normalized === 'udp' ? normalized : null;
}

/**
 * Comparable key for a public endpoint. Address wins when known (that is what
 * FortiGate actually keys a VIP on, and `UNIQUE(firewall_id, address)` makes it
 * 1:1 with the public IP row); the numeric id is the fallback for callers that
 * only hold a reference; the legacy WAN sentinel is last.
 */
export function publicEndpointKey({ firewallId = null, publicIpId = null, address = '' } = {}) {
  const firewall = firewallId === null || firewallId === undefined || firewallId === ''
    ? '?'
    : String(firewallId);
  const normalized = normalizeIpv4(address);
  if (normalized) return `fw:${firewall}|ip:${normalized}`;
  if (publicIpId !== null && publicIpId !== undefined && publicIpId !== '') {
    return `fw:${firewall}|pubip:${publicIpId}`;
  }
  return `fw:${firewall}|${LEGACY_WAN_ENDPOINT_KEY}`;
}

/**
 * Parse an external port specification into `{ start, end }`.
 *   443        → { start: 443, end: 443 }
 *   '4000-5000'→ { start: 4000, end: 5000 }
 * Reversed bounds are normalized (a range is a set, not a direction). Returns
 * null for anything unparseable or outside 1–65535.
 */
export function parsePortRange(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const match = raw.match(/^(\d{1,5})(?:\s*-\s*(\d{1,5}))?$/);
  if (!match) return null;
  let start = Number(match[1]);
  let end = match[2] === undefined ? start : Number(match[2]);
  if (start < 1 || start > 65535 || end < 1 || end > 65535) return null;
  if (end < start) [start, end] = [end, start];
  return { start, end };
}

/** '443' or '4000-5000'. */
export function formatPortRange(range) {
  if (!range) return '';
  return range.start === range.end ? String(range.start) : `${range.start}-${range.end}`;
}

/** Closed-interval overlap. Adjacent ranges (…-4999 / 5000-…) do not overlap. */
export function portRangesOverlap(a, b) {
  if (!a || !b) return false;
  return a.start <= b.end && b.start <= a.end;
}

/**
 * Normalize a forward (DB row, live FortiGate VIP, or a pending request) into
 * the shape the conflict scan compares. Returns null when the entry cannot be
 * interpreted — an unparseable protocol or port cannot conflict with anything.
 *
 * Input: { firewallId, publicIpId, address, protocol, port, label }
 */
export function normalizeEndpointEntry(entry) {
  const protocol = normalizePortProtocol(entry?.protocol);
  const range = parsePortRange(entry?.port);
  if (!protocol || !range) return null;
  return {
    key: publicEndpointKey(entry),
    protocol,
    range,
    address: normalizeIpv4(entry?.address),
    publicIpId: entry?.publicIpId ?? null,
    label: entry?.label ? String(entry.label) : '',
  };
}

/**
 * First existing forward that collides with `candidate`, or null. Collision =
 * same endpoint key AND same protocol AND overlapping external port range.
 * Callers updating an existing forward must filter it out of `existing` first.
 */
export function findPortConflict(existing, candidate) {
  const target = normalizeEndpointEntry(candidate);
  if (!target) return null;
  for (const row of existing || []) {
    const entry = normalizeEndpointEntry(row);
    if (!entry) continue;
    if (entry.key !== target.key) continue;
    if (entry.protocol !== target.protocol) continue;
    if (!portRangesOverlap(entry.range, target.range)) continue;
    return entry;
  }
  return null;
}

/**
 * Error text for a detected conflict. Names the address, protocol and range so
 * the user can see *why* it collided, and points out that the same port is
 * still free on any other public IP assigned to them.
 */
export function portConflictMessage(conflict) {
  if (!conflict) return '';
  const where = conflict.address ? `on ${conflict.address}` : 'on the default WAN address';
  const by = conflict.label ? ` by "${conflict.label}"` : '';
  const single = conflict.range.start === conflict.range.end;
  const subject = `${conflict.protocol.toUpperCase()} ${single ? 'port' : 'ports'} ${formatPortRange(conflict.range)}`;
  return `${subject} ${single ? 'is' : 'are'} already in use ${where}${by}. `
    + 'The same port may still be used on another public IP assigned to you.';
}
