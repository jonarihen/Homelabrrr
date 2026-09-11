import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { vmSshConfigs, vmSshUserConfigs } from '../db/schema/index.ts';
import { nodeLookupCandidates } from './nodeRef.ts';
function pickByCandidateOrder(rows, candidates) {
  for (const candidate of candidates) {
    const row = rows.find((r) => r.node === candidate);
    if (row) return row;
  }
  return null;
}

export async function getGlobalSshConfig(node, vmid) {
  const parsedVmid = parseInt(vmid, 10);
  const candidates = nodeLookupCandidates(node);
  if (candidates.length === 0) return null;
  const rows = await db
    .select({
      node: vmSshConfigs.node,
      host: vmSshConfigs.host,
      port: vmSshConfigs.port,
      host_fingerprint: vmSshConfigs.host_fingerprint,
    })
    .from(vmSshConfigs)
    .where(and(inArray(vmSshConfigs.node, candidates), eq(vmSshConfigs.vmid, parsedVmid)));
  return pickByCandidateOrder(rows, candidates);
}

export async function getUserSshConfig(userId, node, vmid) {
  const parsedVmid = parseInt(vmid, 10);
  const candidates = nodeLookupCandidates(node);
  if (candidates.length === 0) return null;
  const rows = await db
    .select({ node: vmSshUserConfigs.node, username: vmSshUserConfigs.username })
    .from(vmSshUserConfigs)
    .where(and(
      eq(vmSshUserConfigs.user_id, userId),
      inArray(vmSshUserConfigs.node, candidates),
      eq(vmSshUserConfigs.vmid, parsedVmid),
    ));
  return pickByCandidateOrder(rows, candidates);
}
