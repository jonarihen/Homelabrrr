// Per-disk target storage for a cross-host migration.
//
// The UI lets an admin send each disk of a guest to its own storage on the
// target host. Proxmox does not work that way: `remote_migrate`'s
// `target-storage` parameter is a *storage-pair list* (`src:tgt,src2:tgt2`),
// so the copy maps a source STORAGE to a target storage — two disks sharing a
// source storage cannot be split across two targets by the migration itself.
//
// This module is the translation layer. It turns the per-disk choice into
//   1. the storage-pair list PVE accepts, and
//   2. the leftover disks that need a `move_disk` on the target once the copy
//      has finished, for the picks the pair list could not express.
//
// Pure data in, pure data out — no network, no database (unit-tested in
// diskTargets.test.js).

// Storage ids and disk keys both end up in PVE parameters. A stray comma or
// colon in a storage id would smuggle extra mappings into the pair list, so
// everything is validated against the same identifier shape the routes use.
const IDENT_RE = /^[a-zA-Z0-9._-]+$/;
// qemu disk keys plus the LXC volume keys (rootfs / mpN).
const DISK_KEY_RE = /^(?:scsi|virtio|sata|ide|efidisk|tpmstate|mp)\d+$|^rootfs$/;

// Validate a `{ diskKey: storageId }` map coming off the request body.
//
// An empty string is kept, not dropped: it is how the UI says "this one stays
// where it is" for a disk being adopted onto shared storage, and collapsing it
// into "no choice" would silently drag the disk onto the default storage
// instead. Only null/undefined mean "no entry".
// Throws on anything malformed — the caller turns that into a 400.
export function normalizeDiskStorages(raw) {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('diskStorages must be an object mapping disk keys to storage ids');
  }
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined || value === null) continue;
    if (!DISK_KEY_RE.test(key)) {
      throw new Error(`Invalid disk key "${key}" in diskStorages`);
    }
    if (typeof value !== 'string' || (value !== '' && !IDENT_RE.test(value))) {
      throw new Error(`Invalid target storage for disk ${key}`);
    }
    out[key] = value;
  }
  return out;
}

// Pair each disk of a plan with the storage it should end up on.
// `disks` are entries from the migration plan ({ key, storage, sizeGb }).
// Disks with no resolvable target are dropped — in adopt mode "no target"
// legitimately means "leave it on the shared storage".
export function resolveDiskTargets(disks, { defaultStorage = '', diskStorages = {} } = {}) {
  const picked = (key) => (
    Object.prototype.hasOwnProperty.call(diskStorages, key) ? diskStorages[key] : defaultStorage
  );
  return (disks || [])
    .map((d) => ({
      key: d.key,
      sourceStorage: d.storage || '',
      sizeGb: Number.isFinite(d.sizeGb) ? d.sizeGb : 0,
      target: picked(d.key) || '',
    }))
    .filter((d) => d.target);
}

// Build the `target-storage` value for remote_migrate, plus the moves that have
// to happen on the target afterwards.
//
//   targets        resolveDiskTargets() output
//   defaultStorage the storage every unlisted source storage maps to
//   sourceStorages every source storage the migration will actually carry
//                  (from the plan's data volumes) — PVE rejects a pair list
//                  that does not cover one of them, so they are filled in
//
// Returns:
//   targetStorage  a bare storage id when everything lands in one place (which
//                  also covers source storages nobody enumerated), otherwise
//                  the explicit `src:tgt,...` pair list
//   pairs          [{ source, target }] behind that value
//   relocate       [{ key, storage }] disks the copy puts somewhere else and
//                  that must be moved on the target once it finishes
export function planStorageMapping(targets, { defaultStorage = '', sourceStorages = [] } = {}) {
  const groups = new Map(); // source storage → disks coming off it
  for (const t of targets || []) {
    if (!t.sourceStorage) continue;
    if (!groups.has(t.sourceStorage)) groups.set(t.sourceStorage, []);
    groups.get(t.sourceStorage).push(t);
  }

  const pairs = [];
  const relocate = [];
  for (const [source, disks] of groups) {
    // One target per source storage, so pick the one carrying the most data:
    // whatever is left over gets copied to the wrong pool first and moved
    // afterwards, and this keeps that second pass as small as possible.
    const bytesByTarget = new Map();
    for (const d of disks) bytesByTarget.set(d.target, (bytesByTarget.get(d.target) || 0) + d.sizeGb);
    let primary = disks[0].target;
    let mostBytes = -1;
    for (const [target, size] of bytesByTarget) {
      if (size > mostBytes) { mostBytes = size; primary = target; } // ties keep the first disk's pick
    }
    pairs.push({ source, target: primary });
    for (const d of disks) {
      if (d.target !== primary) relocate.push({ key: d.key, storage: d.target });
    }
  }

  // A volume whose source storage never made it into the plan would leave the
  // pair list incomplete and PVE would refuse with "no storage mapped".
  if (defaultStorage) {
    const covered = new Set(pairs.map((p) => p.source));
    for (const source of sourceStorages || []) {
      if (!source || covered.has(source)) continue;
      covered.add(source);
      pairs.push({ source, target: defaultStorage });
    }
  }

  const distinctTargets = new Set(pairs.map((p) => p.target));
  const uniform = relocate.length === 0 && distinctTargets.size <= 1;
  return {
    targetStorage: uniform
      ? (pairs[0]?.target || defaultStorage)
      : pairs.map((p) => `${p.source}:${p.target}`).join(','),
    pairs,
    relocate,
    mapped: !uniform,
  };
}

// Total size landing on each target storage, for the capacity pre-flight.
export function sizeByTargetStorage(targets) {
  const totals = new Map();
  for (const t of targets || []) {
    totals.set(t.target, (totals.get(t.target) || 0) + (Number.isFinite(t.sizeGb) ? t.sizeGb : 0));
  }
  return totals;
}
