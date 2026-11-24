import test from 'node:test';
import assert from 'node:assert/strict';
import { diskLabel, bootDiskKeys, diskRemoveBlocker } from './diskLabel.js';

test('friendly disk label', () => {
  assert.equal(diskLabel({ name: 'scsi0', storage: 'local-lvm:vm-101-disk-0', size: '32G' }), 'SCSI 0 · local-lvm · 32G');
  assert.equal(diskLabel({ name: 'efidisk0', storage: 'local-lvm:vm-101-disk-1', size: '4M' }), 'EFI disk 0 · local-lvm · 4M');
});

test('edge values', () => {
  assert.equal(diskLabel({ name: 'scsi1', storage: 'ceph:vm-100-disk-0', size: '10G' }), 'SCSI 1 · ceph · 10G');
  // loadDisks keeps only the text before the first comma
  assert.equal(diskLabel({ name: 'virtio0', storage: 'local-lvm:0', size: '8G' }), 'VIRTIO 0 · local-lvm · 8G');
  assert.equal(diskLabel({ name: 'scsi0', storage: 'local-lvm:vm-1-disk-0', size: '—' }), 'SCSI 0 · local-lvm · —');
  assert.equal(diskLabel({ name: 'tpmstate0', storage: 'local-lvm:vm-1-disk-2', size: '4M' }), 'TPM state 0 · local-lvm · 4M');
  assert.equal(diskLabel({ name: 'scsi2', storage: '/dev/disk/by-id/x', size: '1T' }), 'SCSI 2 · /dev/disk/by-id/x · 1T');
});

test('boot disks come from the boot order, then bootdisk, then the first disk across buses', () => {
  const disk = 'local-lvm:vm-1-disk-0,size=8G';
  assert.deepEqual([...bootDiskKeys({ boot: 'order=virtio1;ide2;net0', virtio1: disk })], ['virtio1', 'ide2', 'net0']);
  assert.ok(bootDiskKeys({ boot: 'cdn', bootdisk: 'sata0', sata0: disk }).has('sata0'));
  const fallback = bootDiskKeys({ boot: 'order=ide2;net0', ide2: 'local:iso/x.iso,media=cdrom', scsi1: disk, sata3: disk });
  assert.ok(fallback.has('sata3') && !fallback.has('scsi1'));
});

test('remove blockers', () => {
  const ok = { vmid: 1, isRunning: false, canRemove: true };
  assert.equal(diskRemoveBlocker({ name: 'scsi1', storage: 'local-lvm:vm-1-disk-1' }, ok), '');
  assert.equal(diskRemoveBlocker({ name: 'scsi1', storage: 'local:1/vm-1-disk-1.qcow2' }, ok), '');
  assert.equal(diskRemoveBlocker({ name: 'scsi1', storage: 'local-lvm:vm-1-disk-1' }, { ...ok, canRemove: false }), 'Only the VM owner can remove disks');
  assert.equal(diskRemoveBlocker({ name: 'scsi0', storage: 'local-lvm:vm-1-disk-0', boot: true }, ok), 'Boot disk: cannot be removed');
  assert.equal(diskRemoveBlocker({ name: 'ide2', storage: 'local-lvm:vm-1-cloudinit' }, ok), 'Not a data disk');
  assert.equal(diskRemoveBlocker({ name: 'efidisk0', storage: 'local-lvm:vm-1-disk-2' }, ok), 'Not a data disk');
  assert.match(diskRemoveBlocker({ name: 'scsi2', storage: '/dev/disk/by-id/ata-x' }, ok), /Not a volume owned/);
  assert.match(diskRemoveBlocker({ name: 'scsi2', storage: 'local-lvm:vm-11-disk-0' }, ok), /Not a volume owned/);
  assert.equal(diskRemoveBlocker({ name: 'scsi1', storage: 'local-lvm:vm-1-disk-1' }, { ...ok, isRunning: true }), 'Stop the VM to remove disks');
});
