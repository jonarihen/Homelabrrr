// Regression coverage for the cross-host migration pre-flight:
//  1. local CD-ROM ISOs must be ejected before remote_migrate (PVE aborts on them)
//  2. a target storage that cannot import the source volume's format must be
//     caught before the guest is stopped
// Run with:  node --test src/utils/migrationPreflight.test.js   (from backend/)
import test from 'node:test';
import assert from 'node:assert/strict';
import { planCdromDetach, checkStorageCompatibility } from './migrationPreflight.js';

// ─── planCdromDetach ─────────────────────────────────────────────────────────

test('the reported failure: two local ISOs are both scheduled for ejection', () => {
  // VM 116 from the task log — pve01 → pve03 aborted on exactly these two.
  const config = {
    name: 'win2025',
    ide0: 'local:iso/26100.32230.260111-0550.lt_release_svc_refresh_SERVER_EVAL_x64FRE_en-us.iso,media=cdrom,size=5905022K',
    ide2: 'local:iso/virtio-win-0.1.285.iso,media=cdrom,size=708140K',
    scsi0: 'local-lvm:vm-116-disk-0,size=100G',
  };
  const plan = planCdromDetach(config, { sharedStorages: [] });
  assert.deepEqual(plan.keys, ['ide0', 'ide2']);
  assert.deepEqual(plan.detach.map((d) => d.volid), [
    'local:iso/26100.32230.260111-0550.lt_release_svc_refresh_SERVER_EVAL_x64FRE_en-us.iso',
    'local:iso/virtio-win-0.1.285.iso',
  ]);
  assert.deepEqual(plan.detach.map((d) => d.storage), ['local', 'local']);
  // The original value is kept so the caller can put the ISO back if the
  // migration never actually starts.
  assert.equal(plan.detach[1].value, config.ide2);
  assert.deepEqual(plan.kept, []);
});

test('a CD-ROM on storage the target also mounts is left attached', () => {
  const config = {
    ide2: 'nas-iso:iso/debian-12.iso,media=cdrom',
    scsi0: 'local-lvm:vm-120-disk-0,size=32G',
  };
  const plan = planCdromDetach(config, { sharedStorages: ['nas-iso'] });
  assert.deepEqual(plan.keys, []);
  assert.deepEqual(plan.detach, []);
  assert.equal(plan.kept.length, 1);
  assert.equal(plan.kept[0].key, 'ide2');
  assert.equal(plan.kept[0].volid, 'nas-iso:iso/debian-12.iso');
});

test('a local ISO is still ejected when other storage is shared', () => {
  const config = {
    ide0: 'nas-iso:iso/debian-12.iso,media=cdrom',
    ide2: 'local:iso/virtio-win.iso,media=cdrom',
  };
  const plan = planCdromDetach(config, { sharedStorages: new Set(['nas-iso']) });
  assert.deepEqual(plan.keys, ['ide2']);
  assert.deepEqual(plan.kept.map((k) => k.key), ['ide0']);
});

test('an already-empty drive is not touched', () => {
  for (const value of ['none,media=cdrom', 'none', 'cdrom,media=cdrom']) {
    const plan = planCdromDetach({ ide2: value }, { sharedStorages: [] });
    assert.deepEqual(plan.keys, [], `${value} needs no ejection`);
    assert.deepEqual(plan.kept, [], `${value} is not reported as kept either`);
  }
});

test('a VM with no CD-ROM at all yields an empty plan', () => {
  const plan = planCdromDetach({
    name: 'db01',
    scsi0: 'local-lvm:vm-101-disk-0,size=64G',
    efidisk0: 'local-lvm:vm-101-disk-1,efitype=4m,size=4M',
    tpmstate0: 'local-lvm:vm-101-disk-2,size=4M,version=v2.0',
    net0: 'virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0',
  }, {});
  assert.deepEqual(plan.keys, []);
  assert.deepEqual(plan.detach, []);
  assert.deepEqual(plan.kept, []);
});

test('regular disks are never touched, even on a bus that can hold media', () => {
  const plan = planCdromDetach({
    scsi0: 'local-lvm:vm-101-disk-0,size=64G',
    sata0: 'local:101/vm-101-disk-0.qcow2,size=32G',
    ide0: 'local-lvm:vm-101-disk-3,size=8G',
    virtio0: 'ceph:vm-101-disk-9,size=8G',
  }, { sharedStorages: [] });
  assert.deepEqual(plan.keys, []);
});

test('the cloud-init drive is left alone (Proxmox regenerates it on the target)', () => {
  const plan = planCdromDetach({
    ide2: 'local-lvm:vm-100-cloudinit,media=cdrom',
    ide0: 'local:iso/seed.iso,media=cdrom',
  }, { sharedStorages: [] });
  assert.deepEqual(plan.keys, ['ide0']);
});

test('media=cdrom is matched as a whole option, not as a substring', () => {
  // A disk whose *filename* contains the text must not be mistaken for media.
  const plan = planCdromDetach({
    scsi0: 'local:101/vm-101-media=cdromish.raw,size=32G',
    ide2: 'local:iso/a.iso,media=cdrom,size=1G',
  }, { sharedStorages: [] });
  assert.deepEqual(plan.keys, ['ide2']);
});

test('non-string and unrelated config keys are ignored', () => {
  const plan = planCdromDetach({
    ide2: 'local:iso/a.iso,media=cdrom',
    memory: 8192,
    boot: 'order=scsi0;ide2',
    digest: 'abc',
  }, {});
  assert.deepEqual(plan.keys, ['ide2']);
});

test('an empty or missing config is safe', () => {
  for (const cfg of [null, undefined, {}]) {
    assert.deepEqual(planCdromDetach(cfg, {}).keys, []);
  }
});

// ─── checkStorageCompatibility ───────────────────────────────────────────────

const lxcRootfs = [{ key: 'rootfs', volid: 'bank-ssd:vm-107-disk-0', storage: 'bank-ssd', storageType: 'lvmthin' }];

test('the reported failure: raw container rootfs → zfspool target is blocked', () => {
  // CT 107 from the task log: bank-ssd:vm-107-disk-0 → local-zfs, which failed
  // with "no matching import/export format found for storage 'local-zfs'"
  // AFTER the container had been stopped.
  const res = checkStorageCompatibility({
    sourceVolumes: lxcRootfs,
    targetStorageDef: { storage: 'local-zfs', type: 'zfspool', content: 'images,rootdir' },
    guestType: 'lxc',
  });
  assert.equal(res.ok, false);
  assert.equal(res.severity, 'error');
  assert.match(res.reason, /local-zfs/);
  assert.match(res.reason, /no matching import\/export format/);
});

test('a subvolume rootfs → zfspool target is fine', () => {
  const res = checkStorageCompatibility({
    sourceVolumes: [{ key: 'rootfs', volid: 'tank:subvol-107-disk-0', storage: 'tank', storageType: 'zfspool' }],
    targetStorageDef: { storage: 'local-zfs', type: 'zfspool', content: 'images,rootdir' },
    guestType: 'lxc',
  });
  assert.deepEqual(res, { ok: true, severity: 'ok', reason: '' });
});

test('dir → dir keeps working (both stream formats are accepted)', () => {
  const res = checkStorageCompatibility({
    sourceVolumes: [{ key: 'rootfs', volid: 'local:107/vm-107-disk-0.raw', storage: 'local', storageType: 'dir' }],
    targetStorageDef: { storage: 'local', type: 'dir', content: 'rootdir,images,iso,vztmpl' },
    guestType: 'lxc',
  });
  assert.equal(res.ok, true);
  assert.equal(res.severity, 'ok');
});

test('lvmthin target accepts a raw rootfs but not a subvolume one', () => {
  const target = { storage: 'thinpool', type: 'lvmthin', content: 'rootdir,images' };
  const rawOk = checkStorageCompatibility({ sourceVolumes: lxcRootfs, targetStorageDef: target, guestType: 'lxc' });
  assert.equal(rawOk.ok, true);
  assert.equal(rawOk.severity, 'ok');

  const subvol = checkStorageCompatibility({
    sourceVolumes: [{ key: 'rootfs', volid: 'tank:subvol-107-disk-0', storage: 'tank', storageType: 'zfspool' }],
    targetStorageDef: target,
    guestType: 'lxc',
  });
  assert.equal(subvol.ok, false);
  assert.equal(subvol.severity, 'error');
  assert.match(subvol.reason, /thinpool/);
});

test('a target whose content types exclude rootdir is blocked for a container', () => {
  const res = checkStorageCompatibility({
    sourceVolumes: lxcRootfs,
    targetStorageDef: { storage: 'vmpool', type: 'lvmthin', content: 'images' },
    guestType: 'lxc',
  });
  assert.equal(res.ok, false);
  assert.equal(res.severity, 'error');
  assert.match(res.reason, /container volumes/);
  assert.match(res.reason, /rootdir/);
});

test('a target whose content types exclude images is blocked for a VM', () => {
  const res = checkStorageCompatibility({
    sourceVolumes: [{ key: 'scsi0', volid: 'local-lvm:vm-116-disk-0', storage: 'local-lvm', storageType: 'lvmthin' }],
    targetStorageDef: { storage: 'ctonly', type: 'zfspool', content: 'rootdir' },
    guestType: 'qemu',
  });
  assert.equal(res.ok, false);
  assert.match(res.reason, /VM disk images/);
});

test('an unknown target storage type warns instead of blocking', () => {
  const res = checkStorageCompatibility({
    sourceVolumes: lxcRootfs,
    targetStorageDef: { storage: 'weird', type: 'some-future-plugin', content: 'rootdir,images' },
    guestType: 'lxc',
  });
  assert.equal(res.ok, true, 'never blocks on a plugin it does not know');
  assert.equal(res.severity, 'warn');
  assert.match(res.reason, /some-future-plugin/);
});

test('an unreadable / missing target storage definition warns instead of blocking', () => {
  for (const def of [null, undefined, {}, { storage: 'x' }]) {
    const res = checkStorageCompatibility({ sourceVolumes: lxcRootfs, targetStorageDef: def, guestType: 'lxc' });
    assert.equal(res.ok, true);
    assert.equal(res.severity, 'warn');
  }
});

test('a storage that lists no content types warns instead of blocking', () => {
  const res = checkStorageCompatibility({
    sourceVolumes: lxcRootfs,
    targetStorageDef: { storage: 'mystery', type: 'dir', content: '' },
    guestType: 'lxc',
  });
  assert.equal(res.ok, true);
  assert.equal(res.severity, 'warn');
});

test('a disabled target storage is blocked', () => {
  const res = checkStorageCompatibility({
    sourceVolumes: lxcRootfs,
    targetStorageDef: { storage: 'old-nas', type: 'nfs', content: 'rootdir,images', disable: 1 },
    guestType: 'lxc',
  });
  assert.equal(res.ok, false);
  assert.match(res.reason, /disabled/);
});

test('a QEMU migration is not blocked on volume format across storage types', () => {
  const res = checkStorageCompatibility({
    sourceVolumes: [{ key: 'scsi0', volid: 'local-lvm:vm-116-disk-0', storage: 'local-lvm', storageType: 'lvmthin' }],
    targetStorageDef: { storage: 'local-zfs', type: 'zfspool', content: 'images,rootdir' },
    guestType: 'qemu',
  });
  assert.deepEqual(res, { ok: true, severity: 'ok', reason: '' });
});

test('bind mounts and device mount points are skipped, not judged', () => {
  const res = checkStorageCompatibility({
    sourceVolumes: [
      { key: 'rootfs', volid: 'tank:subvol-107-disk-0', storage: 'tank', storageType: 'zfspool' },
      { key: 'mp0', volid: '/srv/media', storage: '/srv/media' },
    ],
    targetStorageDef: { storage: 'local-zfs', type: 'zfspool', content: 'rootdir' },
    guestType: 'lxc',
  });
  assert.equal(res.ok, true);
  assert.equal(res.severity, 'ok');
});

test('an unrecognizable volume name on a file storage warns instead of blocking', () => {
  const res = checkStorageCompatibility({
    sourceVolumes: [{ key: 'rootfs', volid: 'nas:107/rootfs-legacy.img', storage: 'nas', storageType: 'nfs' }],
    targetStorageDef: { storage: 'local-zfs', type: 'zfspool', content: 'rootdir' },
    guestType: 'lxc',
  });
  assert.equal(res.ok, true);
  assert.equal(res.severity, 'warn');
  assert.match(res.reason, /rootfs-legacy\.img/);
});

test('no source volumes at all is not an error', () => {
  const res = checkStorageCompatibility({
    sourceVolumes: [],
    targetStorageDef: { storage: 'local-zfs', type: 'zfspool', content: 'rootdir,images' },
    guestType: 'lxc',
  });
  assert.equal(res.ok, true);
  assert.equal(res.severity, 'ok');
});
