import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { vmSshConfigs, vmSshUserConfigs } from '../db/schema/index.ts';
import { nodeLookupCandidates } from './nodeRef.ts';

export async function getGlobalSshConfig(node: string, vmid: number | string) {
  const parsedVmid = parseInt(String(vmid), 10);
  const candidates = nodeLookupCandidates(node);
  if (candidates.length === 0) return null;
  // Legacy rows may store the bare node name — match any candidate in one query,
  // then honour the candidate order (full ref preferred over bare name).
  const rows = await db
    .select({
      node: vmSshConfigs.node,
      host: vmSshConfigs.host,
      port: vmSshConfigs.port,
      host_fingerprint: vmSshConfigs.host_fingerprint,
    })
    .from(vmSshConfigs)
    .where(and(inArray(vmSshConfigs.node, candidates), eq(vmSshConfigs.vmid, parsedVmid)));
  return firstMatchByCandidate(rows, candidates);
}

export async function getUserSshConfig(userId: number, node: string, vmid: number | string) {
  const parsedVmid = parseInt(String(vmid), 10);
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
  return firstMatchByCandidate(rows, candidates);
}

function firstMatchByCandidate<T extends { node: string }>(rows: T[], candidates: string[]): T | null {
  for (const candidate of candidates) {
    const row = rows.find((r) => r.node === candidate);
    if (row) return row;
  }
  return null;
}
