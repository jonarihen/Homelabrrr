// Per-VM operation authorization — the single decision table behind every VM
// route. Pure on purpose (no db handle, no req): callers resolve the four facts
// about the user, this module decides. See vmAccess.js for the DB-backed wrapper
// and vmOps.test.js for the full allow/deny matrix.
//
// Three tiers, from widest to narrowest:
//
//   'read'    — inspecting a VM. Granted by an assignment, `see_all_vms`, or
//               `can_operate_all_vms` (operating implies seeing).
//   'operate' — mutating the VM or getting a shell/console on it. Granted by an
//               assignment or `can_operate_all_vms`. NOT by `see_all_vms`:
//               console + SSH on the whole fleet is effectively root on the
//               fleet, and must not ride along with a visibility flag.
//   'own'     — destroys or overwrites the VM's live state, or spends a
//               resource booked against its owner. Granted ONLY by an actual
//               assignment (admins still bypass). No fleet-wide permission
//               reaches these, by design.
//
// The dividing line between 'operate' and 'own' is what the operation destroys:
// auxiliary artifacts (snapshots, backup archives) are 'operate'; the VM's own
// current disks/state (delete, restore, rollback) are 'own'.

export const VM_OP_TIERS = {
  // ─── read ────────────────────────────────────────────────────────────────
  'vm.status': 'read',
  'vm.config': 'read',
  'vm.rrd': 'read',
  'vm.ipManagement.read': 'read',
  'vm.cloudinit.read': 'read',
  'vm.snapshots.list': 'read',
  'vm.backups.list': 'read',
  'vm.backups.tasks': 'read',
  'vm.backups.storages': 'read',
  'vm.schedule.read': 'read',
  'vm.sshConfig.read': 'read',

  // ─── operate ─────────────────────────────────────────────────────────────
  'vm.power': 'operate',
  'vm.vnc': 'operate',
  'vm.ssh.connect': 'operate',
  'vm.sftp.connect': 'operate',
  'vm.sshConfig.write': 'operate',
  'vm.sshConfig.scan': 'operate',
  'vm.vlan': 'operate',
  'vm.hardware': 'operate',
  'vm.disk.resize': 'operate',
  'vm.snapshots.create': 'operate',
  'vm.snapshots.delete': 'operate',
  'vm.backups.create': 'operate',
  'vm.backups.delete': 'operate',
  // Reading files out of a backup archive is the same capability as pulling
  // them over SFTP — it must not be looser than the SFTP gate.
  'vm.backups.browse': 'operate',
  'vm.ipManagement.write': 'operate',

  // ─── own ─────────────────────────────────────────────────────────────────
  'vm.delete': 'own',
  'vm.restore': 'own',
  // As destructive as a restore: it throws away the VM's current disks.
  'vm.snapshots.rollback': 'own',
  'vm.cloudinit.credentials': 'own',
  'vm.lease.renew': 'own',
  'vm.schedule.write': 'own',
};

// Operations that additionally require the separate `can_edit_vm_hardware`
// axis — even the VM's own assignee needs it (matching the existing
// requirePermission('can_edit_vm_hardware') middleware on those routes).
export const HARDWARE_OPS = new Set(['vm.hardware', 'vm.disk.resize']);

/**
 * Decide whether a user may perform `op` on one VM.
 *
 * @param {string} op  a key of VM_OP_TIERS (unknown ops fail closed)
 * @param {object} ctx
 * @param {boolean} ctx.isAdmin          account-level admin — bypasses everything
 * @param {boolean} ctx.isAssigned       this VM is assigned to the user
 * @param {boolean} ctx.seeAllVms        effective `see_all_vms`
 * @param {boolean} ctx.operateAllVms    effective `can_operate_all_vms`
 * @param {boolean} ctx.canEditHardware  effective `can_edit_vm_hardware`
 * @returns {boolean} true = allow
 */
export function canPerformVmOp(op, {
  isAdmin = false,
  isAssigned = false,
  seeAllVms = false,
  operateAllVms = false,
  canEditHardware = false,
} = {}) {
  if (isAdmin) return true;

  const tier = VM_OP_TIERS[op];
  if (!tier) return false; // unknown operation — fail closed

  // Independent axis, checked before the tier so it also binds the assignee.
  if (HARDWARE_OPS.has(op) && !canEditHardware) return false;

  if (isAssigned) return true;

  if (tier === 'own') return false;
  if (tier === 'operate') return operateAllVms;
  return seeAllVms || operateAllVms; // 'read'
}

/** Every op key, handy for exhaustive tests. */
export function allVmOps() {
  return Object.keys(VM_OP_TIERS);
}
