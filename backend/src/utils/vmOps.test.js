// Regression coverage for the see_all_vms / can_operate_all_vms split (#73).
// The point of this file is the full matrix: `see_all_vms` alone must never
// reach a mutating or console operation, and neither fleet-wide flag may reach
// an owner-only one.
// Run with:  node --test src/utils/vmOps.test.js   (from backend/)
import test from 'node:test';
import assert from 'node:assert/strict';
import { canPerformVmOp, VM_OP_TIERS, HARDWARE_OPS, allVmOps } from './vmOps.js';

const READ_OPS = allVmOps().filter((op) => VM_OP_TIERS[op] === 'read');
const OPERATE_OPS = allVmOps().filter((op) => VM_OP_TIERS[op] === 'operate');
const OWN_OPS = allVmOps().filter((op) => VM_OP_TIERS[op] === 'own');
// Ops gated only by the tier, i.e. excluding the can_edit_vm_hardware axis.
const PLAIN_OPERATE_OPS = OPERATE_OPS.filter((op) => !HARDWARE_OPS.has(op));

// The four capability shapes a non-admin can have.
const nobody = { isAdmin: false, isAssigned: false, seeAllVms: false, operateAllVms: false, canEditHardware: false };
const viewer = { ...nobody, seeAllVms: true };
const operator = { ...nobody, operateAllVms: true, seeAllVms: true };
const assignee = { ...nobody, isAssigned: true };
const admin = { ...nobody, isAdmin: true };

test('the tier table covers every documented tier and nothing else', () => {
  for (const [op, tier] of Object.entries(VM_OP_TIERS)) {
    assert.ok(['read', 'operate', 'own'].includes(tier), `${op} has an unknown tier ${tier}`);
  }
  assert.ok(READ_OPS.length > 0 && OPERATE_OPS.length > 0 && OWN_OPS.length > 0);
});

// ─── see_all_vms is read-only ────────────────────────────────────────────────

test('see_all_vms alone allows every read op', () => {
  for (const op of READ_OPS) {
    assert.equal(canPerformVmOp(op, viewer), true, `${op} should be readable with see_all_vms`);
  }
});

test('see_all_vms alone denies every mutating/console op', () => {
  for (const op of OPERATE_OPS) {
    assert.equal(canPerformVmOp(op, viewer), false, `${op} must NOT be granted by see_all_vms`);
  }
  // Even with the hardware axis, which is orthogonal to fleet reach.
  for (const op of OPERATE_OPS) {
    assert.equal(canPerformVmOp(op, { ...viewer, canEditHardware: true }), false, `${op} must NOT be granted by see_all_vms + can_edit_vm_hardware`);
  }
});

test('see_all_vms alone denies every owner-only op', () => {
  for (const op of OWN_OPS) {
    assert.equal(canPerformVmOp(op, viewer), false, `${op} must NOT be granted by see_all_vms`);
  }
});

test('the console and power ops specifically named in issue #73 are denied to a see_all_vms holder', () => {
  for (const op of [
    'vm.power', 'vm.vnc', 'vm.ssh.connect', 'vm.sftp.connect', 'vm.vlan',
    'vm.hardware', 'vm.disk.resize', 'vm.snapshots.create', 'vm.snapshots.delete',
    'vm.snapshots.rollback', 'vm.backups.create', 'vm.ipManagement.write',
  ]) {
    assert.equal(canPerformVmOp(op, viewer), false, `${op} must be denied with only see_all_vms`);
  }
});

// ─── can_operate_all_vms ─────────────────────────────────────────────────────

test('can_operate_all_vms allows every read op (operating implies seeing)', () => {
  const operateOnly = { ...nobody, operateAllVms: true };
  for (const op of READ_OPS) {
    assert.equal(canPerformVmOp(op, operateOnly), true, `${op} should be readable with can_operate_all_vms`);
  }
});

test('can_operate_all_vms allows every mutating/console op', () => {
  for (const op of PLAIN_OPERATE_OPS) {
    assert.equal(canPerformVmOp(op, operator), true, `${op} should be allowed with can_operate_all_vms`);
  }
});

test('can_operate_all_vms still denies every owner-only op', () => {
  for (const op of OWN_OPS) {
    assert.equal(canPerformVmOp(op, operator), false, `${op} must require an assignment`);
  }
});

test('rollback is denied with can_operate_all_vms but no assignment', () => {
  assert.equal(canPerformVmOp('vm.snapshots.rollback', operator), false);
  assert.equal(canPerformVmOp('vm.snapshots.rollback', { ...operator, canEditHardware: true }), false);
  // …and allowed for the actual assignee.
  assert.equal(canPerformVmOp('vm.snapshots.rollback', assignee), true);
});

test('backup create and delete sit on the same tier — no dumps you cannot clean up', () => {
  assert.equal(VM_OP_TIERS['vm.backups.create'], VM_OP_TIERS['vm.backups.delete']);
  assert.equal(canPerformVmOp('vm.backups.create', operator), true);
  assert.equal(canPerformVmOp('vm.backups.delete', operator), true);
  assert.equal(canPerformVmOp('vm.backups.create', viewer), false);
  assert.equal(canPerformVmOp('vm.backups.delete', viewer), false);
});

test('VLAN change is never looser than VM deletion for a fleet viewer', () => {
  assert.equal(canPerformVmOp('vm.vlan', viewer), false);
  assert.equal(canPerformVmOp('vm.delete', viewer), false);
  // An operator may retag (reversible, and the target VLAN is separately
  // authorized by checkVlanAssignment) but still may not delete.
  assert.equal(canPerformVmOp('vm.vlan', operator), true);
  assert.equal(canPerformVmOp('vm.delete', operator), false);
});

// ─── assignment ──────────────────────────────────────────────────────────────

test('an assignee may do everything except hardware ops without can_edit_vm_hardware', () => {
  for (const op of allVmOps()) {
    const expected = !HARDWARE_OPS.has(op);
    assert.equal(canPerformVmOp(op, assignee), expected, `${op} for a plain assignee`);
  }
});

test('an assignee with can_edit_vm_hardware may do everything', () => {
  const owner = { ...assignee, canEditHardware: true };
  for (const op of allVmOps()) {
    assert.equal(canPerformVmOp(op, owner), true, `${op} for an assignee with hardware rights`);
  }
});

// ─── can_edit_vm_hardware is an independent axis ─────────────────────────────

test('hardware ops need can_edit_vm_hardware on top of the operate tier', () => {
  for (const op of HARDWARE_OPS) {
    assert.equal(canPerformVmOp(op, operator), false, `${op} without can_edit_vm_hardware`);
    assert.equal(canPerformVmOp(op, { ...operator, canEditHardware: true }), true, `${op} with can_edit_vm_hardware`);
  }
});

test('can_edit_vm_hardware alone grants nothing — it is not a reach permission', () => {
  const hardwareOnly = { ...nobody, canEditHardware: true };
  for (const op of allVmOps()) {
    assert.equal(canPerformVmOp(op, hardwareOnly), false, `${op} with only can_edit_vm_hardware`);
  }
});

// ─── admin and fail-closed behaviour ─────────────────────────────────────────

test('admin is allowed everything, including hardware ops', () => {
  for (const op of allVmOps()) {
    assert.equal(canPerformVmOp(op, admin), true, `${op} for an admin`);
  }
});

test('a user with no permissions and no assignment is denied everything', () => {
  for (const op of allVmOps()) {
    assert.equal(canPerformVmOp(op, nobody), false, `${op} for an unprivileged user`);
  }
});

test('unknown ops fail closed for everyone except admins', () => {
  for (const ctx of [nobody, viewer, operator, assignee]) {
    assert.equal(canPerformVmOp('vm.does.not.exist', ctx), false);
  }
  assert.equal(canPerformVmOp('vm.does.not.exist', admin), true);
});

test('a missing context object denies rather than throws', () => {
  assert.equal(canPerformVmOp('vm.status'), false);
  assert.equal(canPerformVmOp('vm.power'), false);
});
