import test from 'node:test';
import assert from 'node:assert/strict';
import { diskLabel } from './diskLabel.js';

test('friendly disk label', () => {
  assert.equal(diskLabel({ name: 'scsi0', storage: 'local-lvm:vm-101-disk-0', size: '32G' }), 'SCSI 0 · local-lvm · 32G');
  assert.equal(diskLabel({ name: 'efidisk0', storage: 'local-lvm:vm-101-disk-1', size: '4M' }), 'EFI disk 0 · local-lvm · 4M');
});
