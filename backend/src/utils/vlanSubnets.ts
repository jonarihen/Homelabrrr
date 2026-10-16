// One definition of "which IPv4 networks does a user's VLAN access cover".
//
// A `managed` VLAN never stores a subnet: the portal provisions it on the
// derived 10.<tag>/24 scheme (tag 1010 → 10.10.10.0/24, see vlanTagToSubnet)
// and writes an empty `subnet_cidr`. Only a `tagged_only` VLAN — one the portal
// does not address — carries an explicit CIDR. A caller that reads
// `subnet_cidr` alone therefore sees *nothing at all* for the common case,
// which is how browser SSH came to reject a VM sitting in the user's own VLAN.
//
// The db handle is passed in by callers (which already import it) so this
// module stays free of side effects and is unit-testable with a stub.

import { eq } from 'drizzle-orm';
import { vlanTagToSubnet } from '../fortigate.ts';
import type { DbOrTx } from '../db/client.ts';
import { vlans, userVlans } from '../db/schema/index.ts';

const CIDR_RE = /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/;

interface VlanRow {
  tag?: number | null;
  mode?: string | null;
  subnet_cidr?: string | null;
}

/**
 * The network a single `vlans` row covers, or '' when it covers none.
 * An explicit CIDR always wins; a tagged-only VLAN without one is not something
 * we can infer an address range for, so it grants nothing.
 */
export function vlanRowCidr(row: VlanRow): string {
  const explicit = String(row?.subnet_cidr || '').trim();
  if (CIDR_RE.test(explicit)) return explicit;
  if (row?.mode === 'tagged_only') return '';
  return vlanTagToSubnet(row?.tag)?.network || '';
}

/** Unique, empty-free CIDR list for a set of `vlans` rows. */
export function vlanRowsToCidrs(rows: VlanRow[]): string[] {
  const cidrs: string[] = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const cidr = vlanRowCidr(row);
    if (cidr && !cidrs.includes(cidr)) cidrs.push(cidr);
  }
  return cidrs;
}

/** Every network reachable through the VLANs assigned to `userId`. */
export async function userVlanCidrs(db: DbOrTx, userId: number): Promise<string[]> {
  const rows = await db
    .select({ tag: vlans.tag, mode: vlans.mode, subnet_cidr: vlans.subnet_cidr })
    .from(vlans)
    .innerJoin(userVlans, eq(userVlans.vlan_id, vlans.id))
    .where(eq(userVlans.user_id, userId));
  return vlanRowsToCidrs(rows);
}
