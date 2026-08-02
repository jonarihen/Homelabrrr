// ─── VMID allocation ─────────────────────────────────────────────────────────
// The decision half of getNextVmid(), kept free of Proxmox and DB access so it
// can be unit-tested: which id to hand out given what is in use upstream and
// what other in-flight deploys are holding.
//
// Picking an id from a snapshot of /cluster/resources is a TOCTOU race — there
// are seconds between the snapshot and the create call (one HTTP round-trip per
// registered host, then storage/maintenance/CPU/capacity/quota checks), so two
// concurrent deploys would otherwise be handed the same id. VmidReservations
// closes that window in-process; the backend is single-process, the same
// assumption the tag-sync scheduler already makes.

// Proxmox's lowest allowed guest id.
export const VMID_MIN = 100;

// How long a reservation is held if nobody releases it. Long enough to cover a
// slow clone submit, short enough that a leaked reservation self-heals.
export const VMID_RESERVATION_TTL_MS = 5 * 60 * 1000;

function toSet(ids) {
  if (ids instanceof Set) return ids;
  return new Set(ids || []);
}

function normalizeVmid(vmid) {
  const n = Number.parseInt(vmid, 10);
  return Number.isInteger(n) ? n : null;
}

// Lowest free VMID at or above `startAt` that is neither in use upstream nor
// held by an in-flight reservation. `usedIds` / `reservedIds` may be Sets or
// plain arrays; values are compared as integers.
export function pickVmid(usedIds, reservedIds, startAt = VMID_MIN) {
  const used = toSet(usedIds);
  const reserved = toSet(reservedIds);
  const taken = (id) => used.has(id) || reserved.has(id);

  const from = normalizeVmid(startAt);
  let vmid = from !== null && from > VMID_MIN ? from : VMID_MIN;
  while (taken(vmid)) vmid++;
  return vmid;
}

// Proxmox refuses a create/clone onto an id that already exists. The wording
// differs per call, so match the shapes PVE actually emits rather than a bare
// "already exists" (which also shows up for unrelated resources).
const VMID_TAKEN_PATTERNS = [
  /config file already exists/i,
  /\b(?:vm|ct|container)\s*\d*\s*already exists/i,
  /\balready exists on node\b/i,
  /\bvmid\b[^.]*\balready\s+(?:exists|in use)/i,
];

export function isVmidTakenError(err) {
  const message = typeof err === 'string' ? err : (err?.message || '');
  return VMID_TAKEN_PATTERNS.some((re) => re.test(message));
}

// A set of VMIDs handed out but not yet visible to Proxmox. Entries expire on
// their own so a caller that never releases (crash, unhandled path) can't burn
// an id forever. The clock is injectable so the TTL is testable without timers.
export class VmidReservations {
  constructor({ ttlMs = VMID_RESERVATION_TTL_MS, now = Date.now } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.entries = new Map(); // vmid → expiry timestamp (ms)
  }

  // Drop expired reservations. Called by every read so there is no timer.
  sweep() {
    const t = this.now();
    for (const [vmid, expiresAt] of this.entries) {
      if (expiresAt <= t) this.entries.delete(vmid);
    }
    return this;
  }

  reserve(vmid) {
    const id = normalizeVmid(vmid);
    if (id === null) return null;
    this.entries.set(id, this.now() + this.ttlMs);
    return id;
  }

  release(vmid) {
    const id = normalizeVmid(vmid);
    if (id === null) return false;
    return this.entries.delete(id);
  }

  // Currently-held ids, expired ones swept out first.
  active() {
    this.sweep();
    return new Set(this.entries.keys());
  }

  has(vmid) {
    const id = normalizeVmid(vmid);
    return id !== null && this.active().has(id);
  }

  get size() {
    return this.active().size;
  }
}
