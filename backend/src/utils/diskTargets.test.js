// Coverage for the per-disk target storage translation:
//  1. a per-disk pick must survive as a PVE storage-pair list
//  2. two disks on the SAME source storage cannot be split by the copy, so one
//     of them has to be relocated on the target afterwards
//  3. nothing malformed may reach the `target-storage` parameter
// Run with:  node --test src/utils/diskTargets.test.js   (from backend/)
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeDiskStorages, resolveDiskTargets, planStorageMapping, sizeByTargetStorage,
} from './diskTargets.js';

// ─── normalizeDiskStorages ───────────────────────────────────────────────────

test('accepts qemu and LXC disk keys with plain storage ids', () => {
  assert.deepEqual(
    normalizeDiskStorages({ scsi0: 'ssdpool', efidisk0: 'ssdpool', rootfs: 'local-lvm', mp0: 'hddpool' }),
    { scsi0: 'ssdpool', efidisk0: 'ssdpool', rootfs: 'local-lvm', mp0: 'hddpool' },
  );
});

test('an empty pick survives as an explicit "leave it where it is"', () => {
  // Dropping it would let the default storage claim a disk the admin asked to
  // keep on shared storage during an adopt migration.
  assert.deepEqual(normalizeDiskStorages({ scsi0: 'ssdpool', scsi1: '' }), { scsi0: 'ssdpool', scsi1: '' });
  assert.deepEqual(normalizeDiskStorages({ scsi0: null }), {});
  assert.deepEqual(normalizeDiskStorages(undefined), {});
  assert.deepEqual(normalizeDiskStorages(null), {});
});

test('an explicit empty pick is not overridden by the default storage', () => {
  const targets = resolveDiskTargets(
    [{ key: 'scsi0', storage: 'bank-ssd', sizeGb: 100 }, { key: 'scsi1', storage: 'bank-ssd', sizeGb: 200 }],
    { defaultStorage: 'ssdpool', diskStorages: { scsi1: '' } },
  );
  assert.deepEqual(targets.map((t) => t.key), ['scsi0']);
});

test('a storage id carrying pair-list punctuation is refused', () => {
  // The value lands in `target-storage`; a comma or colon would smuggle in
  // extra mappings.
  assert.throws(() => normalizeDiskStorages({ scsi0: 'ssdpool,other:evil' }), /Invalid target storage/);
  assert.throws(() => normalizeDiskStorages({ scsi0: 'ssd pool' }), /Invalid target storage/);
  assert.throws(() => normalizeDiskStorages({ scsi0: 42 }), /Invalid target storage/);
});

test('an unknown disk key is refused', () => {
  assert.throws(() => normalizeDiskStorages({ cores: 'ssdpool' }), /Invalid disk key/);
  assert.throws(() => normalizeDiskStorages({ 'scsi0;rm': 'ssdpool' }), /Invalid disk key/);
});

test('a non-object body value is refused', () => {
  assert.throws(() => normalizeDiskStorages(['scsi0']), /must be an object/);
  assert.throws(() => normalizeDiskStorages('scsi0=ssdpool'), /must be an object/);
});

// ─── resolveDiskTargets ──────────────────────────────────────────────────────

const disks = [
  { key: 'scsi0', storage: 'bank-ssd', sizeGb: 100 },
  { key: 'scsi1', storage: 'vdisks-nfs', sizeGb: 2048 },
];

test('disks without an explicit pick fall back to the single target storage', () => {
  assert.deepEqual(
    resolveDiskTargets(disks, { defaultStorage: 'hddpool' }),
    [
      { key: 'scsi0', sourceStorage: 'bank-ssd', sizeGb: 100, target: 'hddpool' },
      { key: 'scsi1', sourceStorage: 'vdisks-nfs', sizeGb: 2048, target: 'hddpool' },
    ],
  );
});

test('an explicit pick wins over the default', () => {
  const targets = resolveDiskTargets(disks, {
    defaultStorage: 'hddpool',
    diskStorages: { scsi0: 'ssdpool' },
  });
  assert.equal(targets.find((t) => t.key === 'scsi0').target, 'ssdpool');
  assert.equal(targets.find((t) => t.key === 'scsi1').target, 'hddpool');
});

test('a disk with no default and no pick is dropped (adopt: stays on shared storage)', () => {
  assert.deepEqual(resolveDiskTargets(disks, { defaultStorage: '' }), []);
});

test('a missing size does not become NaN', () => {
  const [t] = resolveDiskTargets([{ key: 'scsi0', storage: 'bank-ssd', sizeGb: null }], { defaultStorage: 'ssdpool' });
  assert.equal(t.sizeGb, 0);
});

// ─── planStorageMapping ──────────────────────────────────────────────────────

test('one target for everything stays a bare storage id', () => {
  const plan = planStorageMapping(resolveDiskTargets(disks, { defaultStorage: 'hddpool' }), {
    defaultStorage: 'hddpool',
    sourceStorages: ['bank-ssd', 'vdisks-nfs'],
  });
  assert.equal(plan.targetStorage, 'hddpool');
  assert.equal(plan.mapped, false);
  assert.deepEqual(plan.relocate, []);
});

test('the reported case: two disks on different source storages split cleanly', () => {
  // scsi0 (bank-ssd) → ssdpool, scsi1 (vdisks-nfs) → hddpool. Distinct source
  // storages, so the pair list expresses it and nothing needs a second move.
  const plan = planStorageMapping(
    resolveDiskTargets(disks, { defaultStorage: 'hddpool', diskStorages: { scsi0: 'ssdpool', scsi1: 'hddpool' } }),
    { defaultStorage: 'hddpool', sourceStorages: ['bank-ssd', 'vdisks-nfs'] },
  );
  assert.equal(plan.targetStorage, 'bank-ssd:ssdpool,vdisks-nfs:hddpool');
  assert.equal(plan.mapped, true);
  assert.deepEqual(plan.relocate, []);
});

test('two disks on the SAME source storage: the bigger one wins the copy, the other is relocated', () => {
  const sameSource = [
    { key: 'scsi0', storage: 'bank-ssd', sizeGb: 50 },
    { key: 'scsi1', storage: 'bank-ssd', sizeGb: 500 },
  ];
  const plan = planStorageMapping(
    resolveDiskTargets(sameSource, { defaultStorage: 'ssdpool', diskStorages: { scsi0: 'ssdpool', scsi1: 'hddpool' } }),
    { defaultStorage: 'ssdpool', sourceStorages: ['bank-ssd'] },
  );
  // 500 GB beats 50 GB, so the copy goes to hddpool and only scsi0 moves after.
  assert.equal(plan.targetStorage, 'bank-ssd:hddpool');
  assert.deepEqual(plan.relocate, [{ key: 'scsi0', storage: 'ssdpool' }]);
});

test('equal sizes on one source storage keep the first disk’s pick', () => {
  const sameSource = [
    { key: 'scsi0', storage: 'bank-ssd', sizeGb: 100 },
    { key: 'scsi1', storage: 'bank-ssd', sizeGb: 100 },
  ];
  const plan = planStorageMapping(
    resolveDiskTargets(sameSource, { defaultStorage: 'ssdpool', diskStorages: { scsi1: 'hddpool' } }),
    { defaultStorage: 'ssdpool', sourceStorages: ['bank-ssd'] },
  );
  assert.equal(plan.targetStorage, 'bank-ssd:ssdpool');
  assert.deepEqual(plan.relocate, [{ key: 'scsi1', storage: 'hddpool' }]);
});

test('a source storage missing from the plan is still mapped, so PVE never sees a gap', () => {
  // efidisk0 lives on a storage the disk list never enumerated; without a pair
  // for it PVE refuses the whole migration with "no storage mapped".
  const plan = planStorageMapping(
    resolveDiskTargets(disks, { defaultStorage: 'hddpool', diskStorages: { scsi0: 'ssdpool' } }),
    { defaultStorage: 'hddpool', sourceStorages: ['bank-ssd', 'vdisks-nfs', 'local-zfs'] },
  );
  assert.ok(plan.pairs.some((p) => p.source === 'local-zfs' && p.target === 'hddpool'));
  assert.match(plan.targetStorage, /local-zfs:hddpool/);
});

test('no disks at all falls back to the plain default storage', () => {
  const plan = planStorageMapping([], { defaultStorage: 'hddpool', sourceStorages: [] });
  assert.equal(plan.targetStorage, 'hddpool');
  assert.equal(plan.mapped, false);
});

// ─── sizeByTargetStorage ─────────────────────────────────────────────────────

test('capacity is summed per target storage, not per guest', () => {
  const totals = sizeByTargetStorage(resolveDiskTargets(disks, {
    defaultStorage: 'hddpool',
    diskStorages: { scsi0: 'ssdpool' },
  }));
  assert.equal(totals.get('ssdpool'), 100);
  assert.equal(totals.get('hddpool'), 2048);
});
