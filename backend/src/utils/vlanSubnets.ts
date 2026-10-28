// One definition of "which IPv4 networks does a user's VLAN access cover".
//
// A `managed` VLAN never stores a subnet: the portal provisions it on the
// derived 10.<tag>/24 scheme (tag 1010 → 10.10.10.0/24, see vlanTagToSubnet)
// and writes an empty `subnet_cidr`. Only a `tagged_only` VLAN — one the portal
// does not address — carries an explicit CIDR. A caller that reads
// `subnet_cidr` alone therefore sees *nothing at all* for the common case,
// which is how browser SSH came to reject a VM sitting in the user's own VLAN.
//
// Precedence per VLAN (#331): (1) the /24s firewall syncs recorded in
// `firewall_vlan_sync.subnet_cidr` — what the firewall actually provisioned,
// one per firewall, all of them granted since the VLAN is the user's on each;
// (2) an explicit `vlans.subnet_cidr`; (3) the default tag scheme, only when
// nothing is recorded. Recorded data wins a conflict (with a warning) and is
// never widened by the other two.
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
  /** Subnets recorded by this VLAN's firewall syncs (null = sync predates recording). */
  synced?: (string | null)[];
}

/**
 * The network a `vlans` row covers ignoring sync records, or '' when it covers
 * none. An explicit CIDR wins; a tagged-only VLAN without one is not something
 * we can infer an address range for, so it grants nothing.
 */
export function vlanRowCidr(row: VlanRow): string {
  const explicit = String(row?.subnet_cidr || '').trim();
  if (CIDR_RE.test(explicit)) return explicit;
  if (row?.mode === 'tagged_only') return '';
  return vlanTagToSubnet(row?.tag)?.network || '';
}

/** Every network a `vlans` row covers, applying the precedence above. */
export function vlanRowCidrList(row: VlanRow): string[] {
  const recorded = [...new Set((row?.synced || []).map((c) => String(c || '').trim()).filter((c) => CIDR_RE.test(c)))];
  if (!recorded.length) {
    const cidr = vlanRowCidr(row);
    return cidr ? [cidr] : [];
  }
  const explicit = String(row?.subnet_cidr || '').trim();
  if (CIDR_RE.test(explicit) && !recorded.includes(explicit)) {
    console.warn(`[vlanSubnets] VLAN ${row?.tag}: subnet_cidr ${explicit} conflicts with recorded sync subnet(s) ${recorded.join(', ')}; using the recorded ones`);
  }
  return recorded;
}

/** Unique, empty-free CIDR list for a set of `vlans` rows. */
export function vlanRowsToCidrs(rows: VlanRow[]): string[] {
  const cidrs: string[] = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    for (const cidr of vlanRowCidrList(row)) if (!cidrs.includes(cidr)) cidrs.push(cidr);
  }
  return cidrs;
}

/** Every network reachable through the VLANs assigned to `userId`. */
export async function userVlanCidrs(db: DbOrTx, userId: number): Promise<string[]> {
  const rows = await db
    .select({ id: vlans.id, tag: vlans.tag, mode: vlans.mode, subnet_cidr: vlans.subnet_cidr, synced: firewallVlanSync.subnet_cidr })
    .from(vlans)
    .innerJoin(userVlans, eq(userVlans.vlan_id, vlans.id))
    .leftJoin(firewallVlanSync, eq(firewallVlanSync.vlan_id, vlans.id))
    .where(eq(userVlans.user_id, userId))
    .orderBy(vlans.id, firewallVlanSync.firewall_id);
  // One row per (VLAN, sync) — fold the syncs back onto their VLAN.
  const byVlan = new Map<number, VlanRow & { synced: (string | null)[] }>();
  for (const { id, synced, ...row } of rows) {
    const entry = byVlan.get(id) ?? { ...row, synced: [] };
    entry.synced.push(synced);
    byVlan.set(id, entry);
  }
  return vlanRowsToCidrs([...byVlan.values()]);
}
