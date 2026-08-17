// FortiGate caps object names (VIPs, firewall policies, ...) at 35 characters.
// Port-forward rule names are derived from a VM name plus a service/port label
// and routinely blow past that, so we shorten them deterministically:
//
//   - names already within the limit pass through untouched;
//   - overlong names keep a recognizable head and the trailing service label,
//     and gain a short, stable, collision-resistant hash so that two long names
//     which share a truncated prefix still map to distinct FortiGate names.
//
// The identical logic runs in the frontend (frontend/src/utils/vipName.js) so
// the name previewed in the UI matches what the backend persists on FortiGate.
// Keep the two copies in sync — including the hash — or previews will drift.

// Hard ceiling for any single FortiGate object name.
export const VIP_NAME_MAX = 35;

// The port_forward_create workflow names its firewall policies "PF: <name>"
// (see workflows/definitions.js). FortiOS policy names share the same 35-char
// limit, so the rule name itself must leave room for that prefix — otherwise
// the failure just moves from the VIP step to the policy step. Bounding the
// value substituted into {{name}} fixes both objects without having to touch
// the seeded workflow bundles already stored per firewall.
export const PORT_FORWARD_POLICY_PREFIX = 'PF: ';
export const PORT_FORWARD_NAME_MAX = VIP_NAME_MAX - PORT_FORWARD_POLICY_PREFIX.length; // 31

// FNV-1a (32-bit) rendered as fixed-width base36. Dependency-free and identical
// across Node and browser runtimes, so both copies of this module produce the
// same suffix for a given input.
export function vipNameHash(input, length = 4) {
  const str = String(input);
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(length, '0').slice(-length);
}

// Deterministically shorten `name` to at most `limit` characters. Names already
// within the limit are returned verbatim; longer names are truncated and tagged
// with a "~<hash>" suffix derived from the full original so distinct inputs stay
// distinct. When the name carries a " - <service>" tail (e.g. " - Custom
// 25565/tcp") that tail is preserved as long as at least one head character
// still fits, keeping the port/protocol visible.
export function shortenVipName(name, limit = VIP_NAME_MAX) {
  const trimmed = String(name ?? '').trim();
  if (trimmed.length <= limit) return trimmed;

  const tag = `~${vipNameHash(trimmed)}`; // 5 chars, e.g. "~1a2b"

  // Preserve the trailing " - <service>" label verbatim when the remaining
  // budget still leaves room for at least one character of the head.
  const sepIndex = trimmed.indexOf(' - ');
  if (sepIndex > 0) {
    const head = trimmed.slice(0, sepIndex);
    const tail = trimmed.slice(sepIndex); // includes the leading " - "
    const headBudget = limit - tag.length - tail.length;
    if (headBudget >= 1) {
      const clippedHead = head.slice(0, headBudget).replace(/[\s-]+$/, '');
      return `${clippedHead}${tag}${tail}`;
    }
  }

  // No usable separator, or the tail alone is too long: hard-truncate and tag.
  return `${trimmed.slice(0, limit - tag.length).replace(/[\s-]+$/, '')}${tag}`;
}
