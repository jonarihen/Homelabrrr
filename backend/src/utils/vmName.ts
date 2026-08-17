// Proxmox requires a VM name to be a DNS label: only [a-zA-Z0-9-], at most 63
// characters, and no leading or trailing hyphen. Anything else is rejected by
// the API with a raw upstream error ("invalid format - value does not match the
// regex pattern") — and by then the portal has already allocated a VMID and run
// the capacity/quota checks. So every provisioning path sanitizes the requested
// name up front instead of letting Proxmox fail late.
//
// The identical logic runs in the frontend (frontend/src/utils/vmName.js) so the
// preview shown under the VM-name input matches the name that actually gets
// created. Keep the two copies in sync — frontend/src/utils/vmName.test.js
// asserts they agree character-for-character.

// Proxmox caps VM names at 63 characters (DNS label limit).
export const PVE_VM_NAME_MAX = 63;

// Convert an arbitrary user-supplied string into a name Proxmox will accept, or
// null when nothing usable is left (e.g. the input was empty or pure
// punctuation). Callers should treat null as a 400, not as "use the raw input".
//
// Note the trailing-hyphen strip *after* the length clamp: truncating at 63 can
// itself land on a hyphen (a 64-char name whose 63rd character is "-"), and
// Proxmox rejects a trailing hyphen just as it rejects an underscore.
export function toPveVmName(input) {
  // Only a string can name a VM. A JSON body can carry a number, an object or
  // an array here; stringifying those would invent a plausible-looking name
  // ({} becomes "object-object") for something the caller never asked for, so
  // reject the type outright and let the caller return a 400.
  if (typeof input !== 'string') return null;

  const name = input
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')   // spaces, underscores, dots, unicode → "-"
    .replace(/^-+|-+$/g, '')        // no leading/trailing hyphen
    .slice(0, PVE_VM_NAME_MAX)      // DNS label limit
    .replace(/-+$/, '');            // slice() can re-create a trailing hyphen

  return name || null;
}
