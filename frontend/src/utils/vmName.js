// Proxmox requires a VM name to be a DNS label: only [a-zA-Z0-9-], at most 63
// characters, and no leading or trailing hyphen. The backend sanitizes whatever
// the user types before it reaches the Proxmox API, which means the VM that
// appears is often not named what was typed ("My Test VM" becomes "my-test-vm").
//
// This is a verbatim copy of backend/src/utils/vmName.js so the provisioning
// forms can preview that transformation live instead of surprising the user
// after the fact. Keep the two in sync — frontend/src/utils/vmName.test.js
// imports the backend copy and asserts both produce identical output.

// Proxmox caps VM names at 63 characters (DNS label limit).
export const PVE_VM_NAME_MAX = 63;

// Convert an arbitrary user-supplied string into a name Proxmox will accept, or
// null when nothing usable is left (e.g. the input was empty or pure
// punctuation) — which is exactly when the backend answers 400.
//
// Note the trailing-hyphen strip *after* the length clamp: truncating at 63 can
// itself land on a hyphen (a 64-char name whose 63rd character is "-"), and
// Proxmox rejects a trailing hyphen just as it rejects an underscore.
export function toPveVmName(input) {
  if (typeof input !== 'string') return null;

  const name = input
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')   // spaces, underscores, dots, unicode → "-"
    .replace(/^-+|-+$/g, '')        // no leading/trailing hyphen
    .slice(0, PVE_VM_NAME_MAX)      // DNS label limit
    .replace(/-+$/, '');            // slice() can re-create a trailing hyphen

  return name || null;
}
