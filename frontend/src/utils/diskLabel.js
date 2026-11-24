// "scsi0" + "local-lvm:vm-101-disk-0" -> "SCSI 0 · local-lvm · 32G"; raw id stays available to callers.
export function diskLabel(d) {
  const m = /^([a-z]+)(\d+)$/.exec(d.name);
  const slot = m ? `${m[1] === 'efidisk' ? 'EFI disk' : m[1] === 'tpmstate' ? 'TPM state' : m[1].toUpperCase()} ${m[2]}` : d.name;
  const store = String(d.storage).split(':')[0];
  return `${slot} · ${store} · ${d.size}`;
}

// Mirrors the backend's removal guard: disks in `boot: order=...` or the legacy
// `bootdisk`; with neither naming a present disk, PVE's first disk (ide, sata, scsi, virtio).
const DISK_BUSES = ['ide', 'sata', 'scsi', 'virtio'];
export function bootDiskKeys(cfg) {
  const order = String(cfg?.boot ?? '').match(/(?:^|,)order=([^,]*)/)?.[1];
  const keys = new Set([...(order ? order.split(';') : []), ...(cfg?.bootdisk ? [cfg.bootdisk] : [])]);
  const disks = Object.keys(cfg || {})
    .map((k) => k.match(/^(ide|sata|scsi|virtio)(\d+)$/))
    .filter((m) => m && typeof cfg[m[0]] === 'string' && !cfg[m[0]].split(',').includes('media=cdrom'))
    .sort((a, b) => DISK_BUSES.indexOf(a[1]) - DISK_BUSES.indexOf(b[1]) || Number(a[2]) - Number(b[2]));
  if (!disks.some((m) => keys.has(m[0])) && disks[0]) keys.add(disks[0][0]);
  return keys;
}

// Why a disk cannot be removed, or '' when it can. `canRemove` is the owner signal (status canDelete).
export function diskRemoveBlocker(d, { vmid, isRunning, canRemove }) {
  if (!canRemove) return 'Only the VM owner can remove disks';
  if (!/^(scsi|virtio|sata|ide)\d+$/.test(d.name) || String(d.storage).includes('cloudinit')) return 'Not a data disk';
  if (!new RegExp(`^[A-Za-z0-9][\\w.-]*:(?:.*/)?vm-${Number(vmid)}-disk-\\d+(?:\\.\\w+)?$`).test(d.storage)) return 'Not a volume owned by this VM: ask an administrator';
  if (d.boot) return 'Boot disk: cannot be removed';
  if (isRunning) return 'Stop the VM to remove disks';
  return '';
}
