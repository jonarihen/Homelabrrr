// VLAN placement authorization for VM provisioning and VLAN changes.
//
// The untagged / native VLAN is where core infrastructure lives, so it is
// reserved for admins. Non-admins must place every VM on a VLAN that is
// explicitly assigned to them (user_vlans). Historically the access check was
// gated on the tag being truthy, which meant "no VLAN" silently bypassed
// authorization — this helper closes that gap and is the single decision point
// shared by every route that sets a VM's VLAN.

// The db handle is passed in by callers (which already import it) so this
// module stays free of side effects and is unit-testable with a stub.
import { and, eq } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.ts';
import { vlans, userVlans } from '../db/schema/index.ts';

type ParsedVlanTag = { untagged: true } | { invalid: true } | { tag: number };

// 802.1Q tag range Proxmox accepts on a NIC's `tag=` property.
export const VLAN_TAG_MIN = 1;
export const VLAN_TAG_MAX = 4094;

// Proxmox NIC keys are net0..net31 — nothing else may be written as a config key.
const NET_INTERFACE_RE = /^net(?:[0-9]|[12][0-9]|3[01])$/;

// Interpret a VLAN tag from a request body.
//   { untagged: true }      — null / undefined / '' / 0 (the native network)
//   { tag: <1..4094> }      — a specific VLAN tag
//   { invalid: true }       — anything else
//
// The parse is deliberately strict: a NIC config is a comma-delimited list of
// `key=value` properties, so a value like "100,trunks=200" that Number.parseInt
// would happily read as 100 must NOT authorize as 100 and then be interpolated
// verbatim — that lets a caller append arbitrary network properties. Only a
// whole integer (or a string that is entirely digits) is accepted, and callers
// must configure the returned `tag`, never the raw input.
export function parseVlanTag(value: unknown): ParsedVlanTag {
  const raw = typeof value === 'string' ? value.trim() : value;
  if (raw === null || raw === undefined || raw === '' || raw === 0 || raw === '0') {
    return { untagged: true };
  }
  let tag: number;
  if (typeof raw === 'number') {
    tag = raw;
  } else if (typeof raw === 'string' && /^\d+$/.test(raw)) {
    tag = Number(raw);
  } else {
    return { invalid: true };
  }
  if (!Number.isInteger(tag) || tag < VLAN_TAG_MIN || tag > VLAN_TAG_MAX) return { invalid: true };
  return { tag };
}

// Normalize a NIC key from a request body to a supported `netN` interface,
// or null when it is not one. Guards the config key the same way parseVlanTag
// guards the config value.
export function parseNetInterface(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return 'net0';
  if (typeof value !== 'string') return null;
  const name = value.trim();
  return NET_INTERFACE_RE.test(name) ? name : null;
}

// Decide whether `userId` may place a VM on `vlanTag`. A malformed tag is
// rejected for everyone — admins included — so no caller can smuggle extra NIC
// properties past this gate. Admins may then use any well-formed VLAN,
// including untagged. Non-admins must target an assigned VLAN; untagged and
// unassigned tags are refused. Returns `null` when permitted, otherwise
// `{ status, error }` for the caller to return verbatim.
export async function checkVlanAssignment(
  db: DbOrTx,
  { userId, isAdmin, vlanTag }: { userId: number; isAdmin: boolean; vlanTag: unknown },
): Promise<{ status: number; error: string } | null> {
  const parsed = parseVlanTag(vlanTag);
  if ('invalid' in parsed) {
    return { status: 400, error: 'Invalid VLAN tag' };
  }
  if (isAdmin) return null;

  if ('untagged' in parsed) {
    return {
      status: 403,
      error: 'You must place this VM on a VLAN assigned to you. The untagged/native network is reserved for administrators.',
    };
  }

  const [allowed] = await db
    .select({ id: vlans.id })
    .from(vlans)
    .innerJoin(userVlans, eq(userVlans.vlan_id, vlans.id))
    .where(and(eq(userVlans.user_id, userId), eq(vlans.tag, parsed.tag)))
    .limit(1);
  if (!allowed) {
    return { status: 403, error: 'You do not have access to that VLAN' };
  }
  return null;
}
