import { Router } from 'express';
import { getVMStatus, getVMConfigCurrent, updateVMConfig, resizeVMDisk, deleteVMDisk, getAllVMs, getSnapshots } from '../../proxmox.ts';
import { requirePermission } from '../../middleware/auth.ts';
import { httpError, sendError } from '../../utils/httpError.ts';
import { logAudit } from '../../utils/audit.ts';
import { assertUserQuota, configDiskGb, diskSizeGb, refreshHardwareAllocation, sizeToGb, vmQuotaUserId } from '../../utils/quota.ts';
import { computeCpuTopology } from '../../utils/cpuTopology.ts';
import { assertVmPolicyLocation, vmMigrationPending, withVmMigrationLock } from '../../utils/vmMigrationLock.ts';
import { allowOp } from './shared.ts';

const router = Router();

// ─── VM Hardware Edit ────────────────────────────────────────────────────────

const pHardware = requirePermission('can_edit_vm_hardware');

router.put('/:node/:vmid/hardware', pHardware, async (req, res) => {
  const { node, vmid } = req.params;
  const { cores, memory } = req.body;

  if (!(await allowOp(req, node, vmid, 'vm.hardware'))) {
    return res.status(403).json({ error: 'Access denied' });
  }

  if (!cores && !memory) {
    return res.status(400).json({ error: 'Specify cores and/or memory to update' });
  }

  try {
    const updates = {};
    const details = [];

    if (cores) {
      const coresNum = parseInt(cores, 10);
      if (!coresNum || coresNum < 1 || coresNum > 128) {
        return res.status(400).json({ error: 'Cores must be between 1 and 128' });
      }
      const cpuLayout = await computeCpuTopology(node, coresNum);
      updates.cpu = 'host';
      updates.sockets = cpuLayout.sockets;
      updates.cores = cpuLayout.cores;
      details.push(`cores=${cpuLayout.totalVcpus} (${cpuLayout.sockets}s×${cpuLayout.cores}c)`);
    }

    if (memory) {
      const memMb = parseInt(memory, 10);
      if (!memMb || memMb < 128 || memMb > 1048576) {
        return res.status(400).json({ error: 'Memory must be between 128 MB and 1 TB' });
      }
      updates.memory = memMb;
      details.push(`memory=${memMb}MB`);
    }

    // Quota: only the increase over the VM's current allocation counts —
    // a user at their quota can still shrink resources. The owner is resolved
    // for admins too, so conflicting owner rows answer 409 before any change.
    const quotaUserId = await vmQuotaUserId(node, Number(vmid), req.session.userId);
    if (!req.session.isAdmin) {
      const current = (await getAllVMs()).find((v) => Number(v.vmid) === Number(vmid));
      const curCores = current?.maxcpu || 0;
      const curMemMb = (current?.maxmem || 0) / (1024 * 1024);
      const newCores = updates.cores ? updates.sockets * updates.cores : curCores;
      const newMemMb = updates.memory || curMemMb;
      const addCores = Math.max(0, newCores - curCores);
      const addMemoryMb = Math.max(0, newMemMb - curMemMb);
      if (addCores > 0 || addMemoryMb > 0) {
        await assertUserQuota(quotaUserId, { addCores, addMemoryMb });
      }
    }

    await updateVMConfig(node, vmid, updates);
    await refreshHardwareAllocation(node, Number(vmid), {
      ...(updates.cores ? { cores: updates.sockets * updates.cores } : {}),
      ...(updates.memory ? { memoryMb: updates.memory } : {}),
    });
    await logAudit(req, 'vm_hardware_change', `${node}/${vmid}`, details.join(', '));
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

// Storage exposure (issue #19): this endpoint grows an *existing* disk in
// place (e.g. scsi0) — it never names a storage pool, so there is no exposed/
// hidden pool to enforce here. There is currently no "add a disk on a chosen
// storage" path in hardware edit; if one is added, call assertStorageExposed()
// on the named pool the same way the /provision create paths do.
router.put('/:node/:vmid/resize-disk', pHardware, async (req, res) => {
  const { node, vmid } = req.params;
  const { disk, size } = req.body;

  if (!(await allowOp(req, node, vmid, 'vm.disk.resize'))) {
    return res.status(403).json({ error: 'Access denied' });
  }

  if (!disk || !size) {
    return res.status(400).json({ error: 'disk and size are required' });
  }

  // Validate disk name pattern
  if (!/^(scsi|virtio|sata|ide)\d+$/.test(disk)) {
    return res.status(400).json({ error: 'Invalid disk name' });
  }

  // Validate size format (e.g. "+10G", "50G")
  if (!/^\+?\d+[GMT]$/.test(size)) {
    return res.status(400).json({ error: 'Size must be like "+10G", "50G", "+512M", etc.' });
  }

  try {
    // Quota: count only the growth (PVE resize can never shrink). Relative
    // sizes ("+10G") are the delta directly; absolute sizes are compared to
    // the disk's current size from the VM config. The growth is charged to
    // the VM's owner, not to an operator resizing someone else's VM.
    // Uncached: a cached size from just before an earlier resize would inflate the delta.
    const config = await getVMConfigCurrent(node, vmid);
    // Resolved for admins too: conflicting owner rows answer 409 before the resize.
    const quotaUserId = await vmQuotaUserId(node, Number(vmid), req.session.userId);
    let addDiskGb = 0;
    if (size.startsWith('+')) {
      addDiskGb = sizeToGb(size.slice(1)) || 0;
    } else {
      const currentGb = sizeToGb(String(config?.[disk] || '').match(/(?:^|,)size=(\d+[MGT])/)?.[1]) || 0;
      addDiskGb = Math.max(0, (sizeToGb(size) || 0) - currentGb);
    }
    if (!req.session.isAdmin && addDiskGb > 0) {
      // Count every existing disk from config, the same measure the post-resize floor uses.
      // A disk without a readable size (e.g. passthrough) would hide usage, so fail closed.
      const measured = configDiskGb(config);
      if (!measured.complete) throw httpError(409, 'Cannot verify disk usage for this VM; ask an administrator to resize it');
      await assertUserQuota(quotaUserId, { addDiskGb }, undefined, undefined, { vmid: Number(vmid), diskGb: measured.diskGb });
    }

    await resizeVMDisk(node, vmid, disk, size);
    await refreshHardwareAllocation(node, Number(vmid), { addDiskGb, config });
    await logAudit(req, 'vm_disk_resize', `${node}/${vmid}`, `${disk}=${size}`);
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

// Disks the VM boots from: every entry of `boot: order=...` plus the legacy
// `bootdisk`. With neither naming a present disk, PVE boots its first disk
// (ide, sata, scsi, virtio order; see resolve_first_disk), so that one is protected.
const DISK_BUSES = ['ide', 'sata', 'scsi', 'virtio'];
function bootDiskKeys(config) {
  const order = String(config?.boot ?? '').match(/(?:^|,)order=([^,]*)/)?.[1];
  const keys = new Set([...(order ? order.split(';') : []), ...(config?.bootdisk ? [config.bootdisk] : [])]);
  const disks = Object.keys(config || {})
    .map((k) => k.match(/^(ide|sata|scsi|virtio)(\d+)$/))
    .filter((m) => m && typeof config[m[0]] === 'string' && !config[m[0]].split(',').includes('media=cdrom'))
    .sort((a, b) => DISK_BUSES.indexOf(a[1]) - DISK_BUSES.indexOf(b[1]) || Number(a[2]) - Number(b[2]));
  if (!disks.some((m) => keys.has(m[0])) && disks[0]) keys.add(disks[0][0]);
  return keys;
}

// Detach a data disk and delete its volume, freeing the storage and the
// owner's disk quota. Stopped VMs only: hot-unplug depends on the guest.
router.delete('/:node/:vmid/disks/:disk', pHardware, async (req, res) => {
  const { node, vmid, disk } = req.params;

  if (!(await allowOp(req, node, vmid, 'vm.disk.remove'))) {
    return res.status(403).json({ error: 'Access denied' });
  }
  if (!/^(scsi|virtio|sata|ide)\d+$/.test(disk)) {
    return res.status(400).json({ error: 'Invalid disk name' });
  }

  try {
    const parsedVmid = parseInt(vmid, 10);
    // Conflicting owner aliases would leave the quota unaccounted: refuse before deleting anything.
    await vmQuotaUserId(node, parsedVmid, req.session.userId);
    const value = await withVmMigrationLock(parsedVmid, async (database) => {
      if (await vmMigrationPending(database, parsedVmid)) {
        throw httpError(409, 'VM migration is running or awaiting review; disk removal is blocked');
      }
      // Also refuses a migrated-away source copy, whose disks may be shared with the target.
      await assertVmPolicyLocation(database, node, parsedVmid);
      const config = await getVMConfigCurrent(node, vmid);
      const value = typeof config?.[disk] === 'string' ? config[disk] : '';
      const volume = value.split(',')[0];
      if (!value || volume === 'none') throw httpError(404, `Disk ${disk} not found on this VM`);
      if (value.includes('cloudinit') || value.split(',').includes('media=cdrom')) {
        throw httpError(400, 'CD-ROM and cloud-init drives cannot be removed here');
      }
      // PVE only deletes a managed volume this VM owns; a host path or another VM's volume would just be detached.
      if (!new RegExp(`^[A-Za-z0-9][\\w.-]*:(?:[^,]*/)?vm-${parsedVmid}-disk-\\d+(?:\\.\\w+)?$`).test(volume)) {
        throw httpError(400, `${disk} is not a storage volume owned by this VM; ask an administrator to remove it`);
      }
      if (bootDiskKeys(config).has(disk)) throw httpError(409, `${disk} is a boot disk and cannot be removed`);
      if ((await getVMStatus(node, vmid))?.status !== 'stopped') throw httpError(409, 'Stop the VM before removing a disk');
      // PVE keeps a volume a snapshot still references (as unusedN), so the delete would silently not happen.
      if ((await getSnapshots(node, vmid))?.some((snap) => snap.name !== 'current')) {
        throw httpError(409, 'Delete this VM\'s snapshots before removing a disk');
      }
      await deleteVMDisk(node, vmid, disk);
      return value;
    });

    await refreshHardwareAllocation(node, parsedVmid, { removeDiskGb: diskSizeGb(value) || 0 });
    await logAudit(req, 'vm_disk_remove', `${node}/${vmid}`, `${disk} (${value.split(',')[0]})`);
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
