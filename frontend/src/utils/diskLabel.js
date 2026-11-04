// "scsi0" + "local-lvm:vm-101-disk-0" -> "SCSI 0 · local-lvm · 32G"; raw id stays available to callers.
export function diskLabel(d) {
  const m = /^([a-z]+)(\d+)$/.exec(d.name);
  const slot = m ? `${m[1] === 'efidisk' ? 'EFI disk' : m[1] === 'tpmstate' ? 'TPM state' : m[1].toUpperCase()} ${m[2]}` : d.name;
  const store = String(d.storage).split(':')[0];
  return `${slot} · ${store} · ${d.size}`;
}
