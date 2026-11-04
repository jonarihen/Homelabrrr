import test from 'node:test';
import assert from 'node:assert/strict';
import { diskLabel } from './diskLabel.js';

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
