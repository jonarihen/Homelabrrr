// Coverage for telling a container backup apart from a VM backup, across both
// the classic vzdump filenames and PBS snapshot paths, and for reconciling that
// with the guest actually living at the restore target.
// Run with:  node --test src/utils/backupGuestType.test.js   (from backend/)
import test from 'node:test';
import assert from 'node:assert/strict';
import { backupGuestType, resolveRestoreGuestType } from './backupGuestType.ts';

test('classic vzdump archives are typed from the filename', () => {
  assert.equal(backupGuestType('local:backup/vzdump-lxc-101-2026_07_01-00_00_00.tar.zst'), 'lxc');
  assert.equal(backupGuestType('local:backup/vzdump-qemu-100-2026_07_01-00_00_00.vma.zst'), 'qemu');
  // Other compressions and a bare filename with no storage prefix.
  assert.equal(backupGuestType('local:backup/vzdump-lxc-101-2026_07_01-00_00_00.tar.gz'), 'lxc');
  assert.equal(backupGuestType('vzdump-qemu-100-2026_07_01-00_00_00.vma.lzo'), 'qemu');
});

// The bug: PBS volids carry no "vzdump-" at all, so the old
// `archive.includes('vzdump-lxc-')` sniff sent every PBS container restore to
// the qemu endpoint.
test('PBS snapshots are typed from the ct/vm path segment', () => {
  assert.equal(backupGuestType('pbs-store:backup/ct/101/2026-07-06T22:37:18Z'), 'lxc');
  assert.equal(backupGuestType('pbs-store:backup/vm/100/2026-07-06T22:37:18Z'), 'qemu');
});

test('a storage name containing "vm" or "ct" is not mistaken for the type marker', () => {
  assert.equal(backupGuestType('vm-backups:backup/ct/101/2026-07-06T22:37:18Z'), 'lxc');
  assert.equal(backupGuestType('ct-store:backup/vm/100/2026-07-06T22:37:18Z'), 'qemu');
  assert.equal(backupGuestType('pbsvm:backup/ct/101/2026-07-06T22:37:18Z'), 'lxc');
  assert.equal(backupGuestType('backup-ct:backup/vm/100/2026-07-06T22:37:18Z'), 'qemu');
  // The marker alone, unanchored, must not be enough.
  assert.equal(backupGuestType('vmbackup:iso/debian.iso'), null);
  assert.equal(backupGuestType('ctbackup:snippets/user-data.yml'), null);
});

test('empty, missing and junk values are unknown rather than qemu', () => {
  for (const bad of ['', null, undefined, 0, false, {}, [], 'local:backup/', 'nonsense']) {
    assert.equal(backupGuestType(bad), null, JSON.stringify(bad) ?? String(bad));
  }
});

test('an unrecognised shape returns null instead of guessing', () => {
  // A future storage format we have never seen.
  assert.equal(backupGuestType('futurestore:backup/guest/101/2026-07-06T22:37:18Z'), null);
  // openvz dumps are deliberately unmapped — modern PVE cannot restore them.
  assert.equal(backupGuestType('local:backup/vzdump-openvz-101-2013_01_01-00_00_00.tar'), null);
  // A volid claiming to be both is contradictory, not qemu.
  assert.equal(backupGuestType('local:backup/ct/101/vzdump-qemu-100-2026_07_01-00_00_00.vma.zst'), null);
});

test('the live guest and the volid agreeing picks that type', () => {
  assert.deepEqual(
    resolveRestoreGuestType({ volid: 'pbs-store:backup/ct/101/2026-07-06T22:37:18Z', detected: 'lxc', vmid: '101' }),
    { vmtype: 'lxc' },
  );
  assert.deepEqual(
    resolveRestoreGuestType({ volid: 'local:backup/vzdump-qemu-100-2026_07_01-00_00_00.vma.zst', detected: 'qemu', vmid: 100 }),
    { vmtype: 'qemu' },
  );
});

test('a fresh VMID with nothing to probe falls back to the volid', () => {
  assert.deepEqual(
    resolveRestoreGuestType({ volid: 'pbs-store:backup/ct/101/2026-07-06T22:37:18Z', detected: null, vmid: '101' }),
    { vmtype: 'lxc' },
  );
  // Same when the probe result is missing or nonsense.
  assert.deepEqual(
    resolveRestoreGuestType({ volid: 'pbs-store:backup/vm/100/2026-07-06T22:37:18Z' }),
    { vmtype: 'qemu' },
  );
  assert.deepEqual(
    resolveRestoreGuestType({ volid: 'pbs-store:backup/vm/100/2026-07-06T22:37:18Z', detected: 'container' }),
    { vmtype: 'qemu' },
  );
});

test('an unknown volid still restores when the target guest is known', () => {
  assert.deepEqual(
    resolveRestoreGuestType({ volid: 'futurestore:backup/guest/101/x', detected: 'lxc', vmid: '101' }),
    { vmtype: 'lxc' },
  );
});

test('nothing known at all is a 400, never a silent qemu default', () => {
  const expected = {
    status: 400,
    error: 'Could not determine whether this backup is a VM or a container',
  };
  assert.deepEqual(resolveRestoreGuestType({ volid: 'futurestore:backup/guest/101/x', detected: null, vmid: '101' }), expected);
  assert.deepEqual(resolveRestoreGuestType({ volid: '', detected: null }), expected);
  assert.deepEqual(resolveRestoreGuestType({}), expected);
  assert.deepEqual(resolveRestoreGuestType(), expected);
});

test('a container backup aimed at a QEMU guest is refused with a real error', () => {
  const result = resolveRestoreGuestType({
    volid: 'pbs-store:backup/ct/101/2026-07-06T22:37:18Z',
    detected: 'qemu',
    vmid: '101',
  });
  assert.equal(result.status, 409);
  assert.equal(result.vmtype, undefined);
  assert.match(result.error, /backup is a container \(LXC\)/);
  assert.match(result.error, /guest 101 is a virtual machine \(QEMU\)/);
});

test('a VM backup aimed at a container is refused the same way', () => {
  const result = resolveRestoreGuestType({
    volid: 'local:backup/vzdump-qemu-100-2026_07_01-00_00_00.vma.zst',
    detected: 'lxc',
    vmid: 100,
  });
  assert.equal(result.status, 409);
  assert.match(result.error, /backup is a virtual machine \(QEMU\)/);
  assert.match(result.error, /guest 100 is a container \(LXC\)/);
});

test('the mismatch message stays readable without a vmid', () => {
  const result = resolveRestoreGuestType({ volid: 'pbs-store:backup/ct/101/x', detected: 'qemu' });
  assert.equal(result.status, 409);
  assert.match(result.error, /the restore target is a virtual machine \(QEMU\)/);
});
