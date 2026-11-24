// "scsi0" + "local-lvm:vm-101-disk-0" -> "SCSI 0 · local-lvm · 32G"; raw id stays available to callers.
export function diskLabel(d) {
  const m = /^([a-z]+)(\d+)$/.exec(d.name);
  const slot = m ? `${m[1] === 'efidisk' ? 'EFI disk' : m[1] === 'tpmstate' ? 'TPM state' : m[1].toUpperCase()} ${m[2]}` : d.name;
  const store = String(d.storage).split(':')[0];
  return `${slot} · ${store} · ${d.size}`;
}

// Mirrors the backend's removal guard: disks in `boot: order=...` or the legacy
// `bootdisk`; with neither naming a present disk, scsi0/virtio0 are assumed.
export function bootDiskKeys(cfg) {
  const order = String(cfg?.boot ?? '').match(/(?:^|,)order=([^,]*)/)?.[1];
  const keys = new Set([...(order ? order.split(';') : []), ...(cfg?.bootdisk ? [cfg.bootdisk] : [])]);
  if (![...keys].some((k) => /^(scsi|virtio|sata|ide)\d+$/.test(k) && typeof cfg?.[k] === 'string')) { keys.add('scsi0'); keys.add('virtio0'); }
  return keys;
}

// Why a disk cannot be removed, or '' when it can.
export function diskRemoveBlocker(d, isRunning) {
  if (!/^(scsi|virtio|sata|ide)\d+$/.test(d.name) || String(d.storage).includes('cloudinit')) return 'Not a data disk';
  if (d.boot) return 'Boot disk: cannot be removed';
  if (isRunning) return 'Stop the VM to remove disks';
  return '';
}
