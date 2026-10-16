// One definition of "which IPv4 networks does a user's VLAN access cover".
//
// A `managed` VLAN never stores a subnet: the portal provisions it on the
// derived <firstOctet>.<tag>/24 scheme (tag 1010 → 10.10.10.0/24 by default)
// and records the network each firewall sync provisioned in
// firewall_vlan_sync.subnet_cidr. Access follows that record, never the current
// workflow setting, so changing the setting cannot grant an unprovisioned range.
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
import { vlans, userVlans, firewallVlanSync } from '../db/schema/index.ts';

const CIDR_RE = /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/;

interface VlanRow {
  tag?: number | null;
  mode?: string | null;
  subnet_cidr?: string | null;
  // subnet a firewall sync of this VLAN recorded (firewall_vlan_sync.subnet_cidr)
  synced_cidr?: string | null;
}

/**
 * The network a single `vlans` row covers, or '' when it covers none.
 * A tagged-only VLAN covers only its explicit CIDR (none → nothing). A managed
 * VLAN covers what its sync recorded as provisioned; a stale explicit CIDR
 * never overrides that, and only applies when nothing was recorded.
 */
export function vlanRowCidr(row: VlanRow): string {
  const explicit = String(row?.subnet_cidr || '').trim();
  if (row?.mode === 'tagged_only') return CIDR_RE.test(explicit) ? explicit : '';
  const synced = String(row?.synced_cidr || '').trim();
  if (CIDR_RE.test(synced)) return synced;
  if (CIDR_RE.test(explicit)) return explicit;
  // Unsynced, or synced before the subnet was recorded: the default scheme.
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
    .select({ tag: vlans.tag, mode: vlans.mode, subnet_cidr: vlans.subnet_cidr, synced_cidr: firewallVlanSync.subnet_cidr })
    .from(vlans)
    .innerJoin(userVlans, eq(userVlans.vlan_id, vlans.id))
    // One row per firewall the VLAN is synced to, so each provisioned network is covered.
    .leftJoin(firewallVlanSync, eq(firewallVlanSync.vlan_id, vlans.id))
    .where(eq(userVlans.user_id, userId));
  return vlanRowsToCidrs(rows);
}
