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

// Interpret a VLAN tag from a request body.
//   { untagged: true }      — null / undefined / '' / 0 (the native network)
//   { tag: <positive int> } — a specific VLAN tag
//   { invalid: true }       — a malformed value (non-numeric, <= 0)
export function parseVlanTag(value: unknown): ParsedVlanTag {
  if (value === null || value === undefined || value === '' || value === 0 || value === '0') {
    return { untagged: true };
  }
  const tag = Number.parseInt(value as string, 10);
  if (!Number.isInteger(tag) || tag < 1) return { invalid: true };
  return { tag };
}

// Decide whether `userId` may place a VM on `vlanTag`. Admins may use anything,
// including untagged. Non-admins must target an assigned VLAN; untagged and
// unassigned tags are refused. Returns `null` when permitted, otherwise
// `{ status, error }` for the caller to return verbatim.
export async function checkVlanAssignment(
  db: DbOrTx,
  { userId, isAdmin, vlanTag }: { userId: number; isAdmin: boolean; vlanTag: unknown },
): Promise<{ status: number; error: string } | null> {
  if (isAdmin) return null;

  const parsed = parseVlanTag(vlanTag);
  if ('invalid' in parsed) {
    return { status: 400, error: 'Invalid VLAN tag' };
  }
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
