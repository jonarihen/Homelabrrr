import db from '../db.js';
import { nodeLookupCandidates } from './nodeRef.js';
import { userHasPermission, effectivePermissions } from './permissions.js';
import { canPerformVmOp } from './vmOps.js';

// Read access to a VM: an assignment, the read-only fleet flag `see_all_vms`,
// or the operator flag `can_operate_all_vms` (operating implies seeing).
// Mutating/console routes must NOT use this — call userCanPerformVmOp instead.
export function userCanAccessVm(userId, node, vmid, isAdmin) {
  if (isAdmin) return true;

  // Effective check: per-user column OR role grant
  if (userHasPermission(userId, 'see_all_vms', 'can_operate_all_vms')) return true;

  return userOwnsVm(userId, node, vmid);
}

// Strict ownership: only an actual assignment counts (no see_all_vms /
// can_operate_all_vms bypass). Used for destructive operations like VM
// deletion, restore, and snapshot rollback.
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

// Resolve the facts canPerformVmOp needs, with one user lookup rather than one
// per flag. Session admins short-circuit; a DB row flagged is_admin bypasses
// too, matching userHasPermission / requirePermission.
export function vmOpContext(userId, node, vmid, isAdmin) {
  if (isAdmin) return { isAdmin: true };

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return { isAdmin: false };
  if (user.is_admin === 1) return { isAdmin: true };

  const perms = effectivePermissions(user);
  return {
    isAdmin: false,
    isAssigned: userOwnsVm(userId, node, vmid),
    seeAllVms: perms.see_all_vms,
    operateAllVms: perms.can_operate_all_vms,
    canEditHardware: perms.can_edit_vm_hardware,
  };
}

/**
 * The gate every VM route runs on. `op` is a key of VM_OP_TIERS (utils/vmOps.js)
 * — the tier table there, not the call site, decides which permission applies.
 */
export function userCanPerformVmOp(userId, node, vmid, isAdmin, op) {
  return canPerformVmOp(op, vmOpContext(userId, node, vmid, isAdmin));
}

// True when the user sees the whole fleet inventory rather than just their
// assignments (drives the "all VMs" listing).
export function userSeesAllVms(userId, isAdmin) {
  if (isAdmin) return true;
  return userHasPermission(userId, 'see_all_vms', 'can_operate_all_vms');
}
