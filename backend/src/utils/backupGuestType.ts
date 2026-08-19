// Which kind of guest a backup volume holds, and whether that agrees with the
// guest already sitting at the restore target.
//
// Two naming schemes are in play. Classic vzdump archives on file/directory
// storage carry the guest type in the filename:
//
//   local:backup/vzdump-lxc-101-2026_07_01-00_00_00.tar.zst      ← container
//   local:backup/vzdump-qemu-100-2026_07_01-00_00_00.vma.zst     ← virtual machine
//
// Proxmox Backup Server snapshots carry it as a path segment instead, with no
// `vzdump-` anywhere in the volid:
//
//   pbs-store:backup/ct/101/2026-07-06T22:37:18Z                 ← container
//   pbs-store:backup/vm/100/2026-07-06T22:37:18Z                 ← virtual machine
//
// Sniffing only the vzdump form meant every PBS container restore was POSTed to
// `/nodes/{node}/qemu` and rejected upstream. Anything that can't be placed —
// including a volid that somehow claims both — returns null, so the caller
// refuses the restore instead of quietly guessing `qemu`.

// The path forms are anchored on a `:` or `/` boundary so a storage *name*
// containing "vm" or "ct" (`vm-backups:…`, `ct-store:…`) can never be mistaken
// for the type marker.
const LXC_PATTERNS = [/vzdump-lxc-/, /(?:^|[:/])backup\/ct\//];
const QEMU_PATTERNS = [/vzdump-qemu-/, /(?:^|[:/])backup\/vm\//];

/**
 * 'lxc' | 'qemu' for a recognised backup volid, null for anything else.
 * Note that `vzdump-openvz-` is deliberately not mapped: modern PVE cannot
 * restore those at all, so a loud "unknown" beats a wrong endpoint.
 */
export function backupGuestType(volid) {
  const s = String(volid ?? '');
  if (!s) return null;
  const found = new Set();
  if (LXC_PATTERNS.some((re) => re.test(s))) found.add('lxc');
  if (QEMU_PATTERNS.some((re) => re.test(s))) found.add('qemu');
  // Exactly one verdict, or we don't know.
  return found.size === 1 ? [...found][0] : null;
}

const GUEST_LABELS = {
  lxc: 'a container (LXC)',
  qemu: 'a virtual machine (QEMU)',
};

/**
 * Decide which Proxmox endpoint a restore should target.
 *
 * `detected` is what `detectGuest` found at the target VMID ('qemu' | 'lxc'),
 * or null when the VMID doesn't exist yet (a fresh restore creates it) or the
 * probe couldn't run. The live guest is the source of truth — it is what the
 * restore writes over — and the volid is the cross-check.
 *
 * Returns `{ vmtype }` on success, or `{ status, error }` to hand straight back
 * to the client.
 */
export function resolveRestoreGuestType({ volid, detected = null, vmid } = {}) {
  const fromVolid = backupGuestType(volid);
  const fromGuest = detected === 'lxc' || detected === 'qemu' ? detected : null;

  if (fromVolid && fromGuest && fromVolid !== fromGuest) {
    const label = vmid === undefined || vmid === null || vmid === '' ? 'the restore target' : `guest ${vmid}`;
    return {
      status: 409,
      error: `This backup is ${GUEST_LABELS[fromVolid]} but ${label} is ${GUEST_LABELS[fromGuest]}. Restore it onto a matching guest.`,
    };
  }

  const vmtype = fromGuest || fromVolid;
  if (!vmtype) {
    return { status: 400, error: 'Could not determine whether this backup is a VM or a container' };
  }
  return { vmtype };
}
