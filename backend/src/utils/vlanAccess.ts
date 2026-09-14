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

export function isValidVmNetInterface(value: unknown): value is string {
  return typeof value === 'string' && /^net(?:[0-9]|[12][0-9]|3[01])(?![\s\S])/.test(value);
}

export function parseVlanTag(value: unknown): ParsedVlanTag {
  if (value === null || value === undefined || value === '' || value === 0 || value === '0') {
    return { untagged: true };
  }
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^[0-9]+(?![\s\S])/.test(value))) {
    return { invalid: true };
  }
  const tag = Number(value);
  if (!Number.isInteger(tag) || tag < 1 || tag > 4094) return { invalid: true };
  return { tag };
}

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
