import db from '../db.js';

export function userCanAccessVm(userId, node, vmid, isAdmin) {
  if (isAdmin) return true;

  const user = db.prepare('SELECT see_all_vms FROM users WHERE id = ?').get(userId);
  if (user?.see_all_vms) return true;

  return !!db.prepare(
    'SELECT id FROM vm_assignments WHERE user_id = ? AND node = ? AND vmid = ?'
  ).get(userId, node, parseInt(vmid, 10));
}
