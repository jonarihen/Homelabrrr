import { decodeNodeRef } from './nodeRef.js';

// ─── Memory capacity policy (pure) ───────────────────────────────────────────
//
// Decision logic for the pre-flight memory check, with no DB, no network and no
// Express in sight — everything it needs is passed in, so it can be unit-tested
// directly (capacityPolicy.test.js). `capacity.js` gathers the numbers and this
// module decides.
//
// Why not `memory.free`: on a Proxmox node that is *currently unallocated* RAM,
// which on a healthy homelab host sits near zero (ZFS ARC, page cache and
// ballooning guests all eat it) — it is not what a new guest can be given, and
// Proxmox itself never blocks a VM start on it. The meaningful comparison is the
// sum of configured guest RAM on the node against physical RAM × an overcommit
// ratio, because overcommit is normal homelab practice: guests don't all peak
// together.
//
// Storage is deliberately NOT handled here — `storage.avail` is a real hard
// limit and stays a hard block in capacity.js.

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

export const MEMORY_MODES = ['off', 'warn', 'block'];
export const DEFAULT_MEMORY_MODE = 'warn';
export const DEFAULT_OVERCOMMIT_RATIO = 1.5;
const MAX_OVERCOMMIT_RATIO = 100;

// Charged for a guest whose configured memory is unknown when no sibling guest
// reports one either — better than counting it as costing nothing.
const ASSUMED_GUEST_MEMORY_BYTES = GIB;

export function normalizeMemoryMode(value) {
  const mode = String(value ?? '').trim().toLowerCase();
  return MEMORY_MODES.includes(mode) ? mode : DEFAULT_MEMORY_MODE;
}

// Ratios below 1 are legal (they reserve headroom instead of overcommitting).
// Anything unparseable falls back to the default rather than disabling the rail.
export function normalizeOvercommitRatio(value) {
  const ratio = typeof value === 'number' ? value : Number.parseFloat(String(value ?? '').trim());
  if (!Number.isFinite(ratio) || ratio <= 0) return DEFAULT_OVERCOMMIT_RATIO;
  return Math.min(MAX_OVERCOMMIT_RATIO, Math.round(ratio * 100) / 100);
}

const fmtGb = (bytes) => (bytes / GIB).toFixed(1);
const fmtRatio = (ratio) => String(Number(ratio.toFixed(2)));

function isTemplate(guest) {
  return guest.template === 1 || guest.template === true || guest.template === '1';
}

// Guests (from getAllVMs()) that live on `nodeValue`. Node identity round-trips
// through nodeRef: both sides may be encoded ("1~pve") or a legacy bare name, so
// names must match and host ids must agree whenever both carry one.
export function guestsOnNode(guests, nodeValue) {
  const target = decodeNodeRef(nodeValue);
  if (!target.nodeName) return [];
  return (Array.isArray(guests) ? guests : []).filter((guest) => {
    if (!guest) return false;
    const on = decodeNodeRef(guest.nodeRef || guest.node);
    if (!on.nodeName || on.nodeName !== target.nodeName) return false;
    if (on.hostId && target.hostId) return on.hostId === target.hostId;
    return true;
  });
}

// Sum of configured guest RAM. Templates are skipped (they can never run). A
// guest missing `maxmem` is charged the average of the guests that do report
// one, so a single gap can't make a busy node look empty.
export function sumAllocatedMemoryBytes(guests) {
  const list = (Array.isArray(guests) ? guests : []).filter((g) => g && !isTemplate(g));
  const known = [];
  let unknown = 0;
  for (const guest of list) {
    const maxmem = Number(guest.maxmem);
    if (Number.isFinite(maxmem) && maxmem > 0) known.push(maxmem);
    else unknown += 1;
  }
  const knownBytes = known.reduce((sum, n) => sum + n, 0);
  const perUnknown = known.length > 0 ? knownBytes / known.length : ASSUMED_GUEST_MEMORY_BYTES;
  return { bytes: knownBytes + (unknown * perUnknown), guests: list.length, estimated: unknown };
}

// null / undefined / '' mean "unknown", never 0 — Number(null) is 0 and that
// would quietly turn an unreadable node into an empty one.
function toFiniteBytes(value, { min = 0 } = {}) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= min ? n : null;
}

/**
 * Decide whether a memory request may proceed on a node.
 *
 * @param requestedMb     memory the new guest asks for, in MB
 * @param nodeTotalBytes  physical RAM of the node (getNodeStatus → memory.total)
 * @param allocatedBytes  sum of configured guest RAM already on the node, or
 *                        null when the guest list couldn't be read
 * @param freeBytes       node memory.free — only a fallback estimate + context
 * @param mode            off | warn | block
 * @param ratio           overcommit ratio, e.g. 1.5
 * @param nodeName        display name for the message
 * @returns { decision: 'allow'|'warn'|'block', reason, code, … }
 */
export function evaluateMemoryCapacity({
  requestedMb,
  nodeTotalBytes,
  allocatedBytes,
  freeBytes,
  mode,
  ratio,
  nodeName,
} = {}) {
  const resolvedMode = normalizeMemoryMode(mode);
  const resolvedRatio = normalizeOvercommitRatio(ratio);
  const requestedBytes = (Number(requestedMb) || 0) * MIB;

  const allow = (code = 'ok') => ({
    decision: 'allow',
    code,
    reason: '',
    mode: resolvedMode,
    ratio: resolvedRatio,
    requestedBytes,
  });

  if (resolvedMode === 'off') return allow('disabled');
  if (!(requestedBytes > 0)) return allow('no-request');

  // No usable node status — never block a deploy on a monitoring blind spot.
  const totalBytes = toFiniteBytes(nodeTotalBytes, { min: 1 });
  if (totalBytes === null) return allow('unknown-node-memory');

  const usableBytes = totalBytes * resolvedRatio;

  // Prefer the real allocation; fall back to (total - free) when the guest list
  // is unavailable. That is a rough proxy (it counts ARC/page cache too), but it
  // still leaves the whole overcommit margin available instead of blocking.
  let allocated = toFiniteBytes(allocatedBytes);
  let estimatedFromFree = false;
  if (allocated === null) {
    const free = toFiniteBytes(freeBytes);
    if (free !== null) {
      allocated = Math.max(0, totalBytes - free);
      estimatedFromFree = true;
    } else {
      allocated = 0;
    }
  }

  const name = nodeName ? String(nodeName) : 'this node';
  const physical = `${fmtGb(totalBytes)} GB physical × ${fmtRatio(resolvedRatio)} overcommit`;
  const result = {
    mode: resolvedMode,
    ratio: resolvedRatio,
    requestedBytes,
    allocatedBytes: allocated,
    usableBytes,
    totalBytes,
    estimatedFromFree,
  };

  // A guest bigger than the node's whole usable memory can never be backed, no
  // matter how the policy is set — that's a bad request, not a policy call, so
  // it is refused in `warn` mode too. Only `off` (handled above) skips it.
  if (requestedBytes > usableBytes) {
    return {
      ...result,
      decision: 'block',
      code: 'exceeds-node',
      reason: `${name} cannot host a ${fmtGb(requestedBytes)} GB guest: only ${fmtGb(usableBytes)} GB usable (${physical}).`,
    };
  }

  if (allocated + requestedBytes <= usableBytes) {
    return { ...result, decision: 'allow', code: 'ok', reason: '' };
  }

  const allocatedLabel = `${fmtGb(allocated)} GB already allocated to guests${estimatedFromFree ? ' (estimated from node usage)' : ''}`;
  if (resolvedMode === 'block') {
    return {
      ...result,
      decision: 'block',
      code: 'overcommit',
      reason: `Not enough memory headroom on ${name}: ${fmtGb(requestedBytes)} GB requested, ${allocatedLabel}, ${fmtGb(usableBytes)} GB usable (${physical}).`,
    };
  }
  return {
    ...result,
    decision: 'warn',
    code: 'overcommit',
    reason: `Memory overcommitted on ${name}: ${fmtGb(requestedBytes)} GB requested plus ${allocatedLabel} exceeds ${fmtGb(usableBytes)} GB usable (${physical}). Deploying anyway — capacity policy is "warn".`,
  };
}
