import db from '../db.js';
import { nodeLookupCandidates } from './nodeRef.js';

export function userCanAccessVm(userId, node, vmid, isAdmin) {
  if (isAdmin) return true;

  const user = db.prepare('SELECT see_all_vms FROM users WHERE id = ?').get(userId);
  if (user?.see_all_vms) return true;

  return userOwnsVm(userId, node, vmid);
}

// Strict ownership: only an actual assignment counts (no see_all_vms bypass).
// Used for destructive operations like VM deletion.
export function userOwnsVm(userId, node, vmid) {
  const parsedVmid = parseInt(vmid, 10);
  const candidates = nodeLookupCandidates(node);
  for (const candidate of candidates) {
    const row = db.prepare(
      'SELECT id FROM vm_assignments WHERE user_id = ? AND vmid = ? AND node = ? LIMIT 1'
    ).get(userId, parsedVmid, candidate);
    if (row) return true;
  }
  return false;
}
