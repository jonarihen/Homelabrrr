import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import { userVlans } from '../../db/schema/index.ts';
import { requirePermission } from '../../middleware/auth.ts';
import { decodeNodeRef } from '../../utils/nodeRef.ts';
import { userHasPermission } from '../../utils/permissions.ts';

// Permission middleware shortcuts
export const pUsers       = requirePermission('can_manage_users');
export const pAssignments = requirePermission('can_manage_assignments', 'can_manage_users');
export const pHosts       = requirePermission('can_manage_hosts');
export const pFirewalls   = requirePermission('can_manage_firewalls');
export const pPortForwards = requirePermission('can_manage_firewalls', 'can_manage_port_forwards');
export const pVlans       = requirePermission('can_manage_vlans');
export const pPolicies    = requirePermission('can_manage_policies');
export const pAudit       = requirePermission('can_view_audit_log');
export const ALLOW_INSECURE_UPSTREAM_TLS = process.env.ALLOW_INSECURE_UPSTREAM_TLS === 'true';

// Check if a non-admin user has access to a VLAN via user_vlans
export async function userOwnsVlan(userId, vlanId) {
  const [row] = await db.select({ one: sql`1` }).from(userVlans)
    .where(and(eq(userVlans.user_id, userId), eq(userVlans.vlan_id, vlanId))).limit(1);
  return !!row;
}

export function serializeNodeIdentity(nodeValue) {
  const { nodeName, nodeRef } = decodeNodeRef(nodeValue);
  return {
    node: nodeName || String(nodeValue || ''),
    nodeRef: nodeRef || String(nodeValue || ''),
  };
}

// Effective check — a role that grants can_manage_firewalls counts, so never
// read the legacy users.can_manage_firewalls column here.
export async function canManageAllPortForwards(req) {
  return !!req.session.isAdmin || await userHasPermission(req.session.userId, 'can_manage_firewalls');
}
