// VLAN placement authorization for VM provisioning and VLAN changes.
//
// The untagged / native VLAN is where core infrastructure lives, so it is
// reserved for admins. Non-admins must place every VM on a VLAN that is
// explicitly assigned to them (user_vlans). Historically the access check was
// gated on the tag being truthy, which meant "no VLAN" silently bypassed
// authorization — this helper closes that gap and is the single decision point
// shared by every route that sets a VM's VLAN.

// SQL kept here so the assignment lookup is defined once. The db handle is
// passed in by callers (which already import it) so this module stays free of
// side effects and is unit-testable with a stub.
const ASSIGNED_VLAN_SQL =
  'SELECT v.id FROM vlans v JOIN user_vlans uv ON uv.vlan_id = v.id WHERE uv.user_id = ? AND v.tag = ?';

// Interpret a VLAN tag from a request body.
//   { untagged: true }      — null / undefined / '' / 0 (the native network)
//   { tag: <positive int> } — a specific VLAN tag
//   { invalid: true }       — a malformed value (non-numeric, <= 0)
export function parseVlanTag(value) {
  if (value === null || value === undefined || value === '' || value === 0 || value === '0') {
    return { untagged: true };
  }
  const tag = Number.parseInt(value, 10);
  if (!Number.isInteger(tag) || tag < 1) return { invalid: true };
  return { tag };
}

// Decide whether `userId` may place a VM on `vlanTag`. Admins may use anything,
// including untagged. Non-admins must target an assigned VLAN; untagged and
// unassigned tags are refused. Returns `null` when permitted, otherwise
// `{ status, error }` for the caller to return verbatim.
export function checkVlanAssignment(db, { userId, isAdmin, vlanTag }) {
  if (isAdmin) return null;

  const parsed = parseVlanTag(vlanTag);
  if (parsed.invalid) {
    return { status: 400, error: 'Invalid VLAN tag' };
  }
  if (parsed.untagged) {
    return {
      status: 403,
      error: 'You must place this VM on a VLAN assigned to you. The untagged/native network is reserved for administrators.',
    };
  }

  const allowed = db.prepare(ASSIGNED_VLAN_SQL).get(userId, parsed.tag);
  if (!allowed) {
    return { status: 403, error: 'You do not have access to that VLAN' };
  }
  return null;
}
