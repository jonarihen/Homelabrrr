import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { users, vmAssignments } from '../db/schema/index.ts';
import { nodeLookupCandidates } from './nodeRef.ts';
import { userHasPermission, effectivePermissions } from './permissions.ts';
import { canPerformVmOp } from './vmOps.ts';

// The facts canPerformVmOp (utils/vmOps.ts) decides on. `isAdmin: true`
// short-circuits; the remaining flags are only resolved for non-admins.
interface VmOpContext {
  isAdmin: boolean;
  isAssigned?: boolean;
  seeAllVms?: boolean;
  operateAllVms?: boolean;
  canEditHardware?: boolean;
}

// Read access to a VM: an assignment, the read-only fleet flag `see_all_vms`,
// or the operator flag `can_operate_all_vms` (operating implies seeing).
// Mutating/console routes must NOT use this — call userCanPerformVmOp instead.
export async function userCanAccessVm(
  userId: number,
  node: string,
  vmid: number | string,
  isAdmin: boolean,
): Promise<boolean> {
  if (isAdmin) return true;

  // Effective check: per-user column OR role grant
  if (await userHasPermission(userId, 'see_all_vms', 'can_operate_all_vms')) return true;

  return userOwnsVm(userId, node, vmid);
}

// Strict ownership: only an actual assignment counts (no see_all_vms /
// can_operate_all_vms bypass). Used for destructive operations like VM
// deletion, restore, and snapshot rollback.
export async function userOwnsVm(
  userId: number,
  node: string,
  vmid: number | string,
): Promise<boolean> {
  const parsedVmid = Number.parseInt(String(vmid), 10);
  const candidates = nodeLookupCandidates(node);
  if (candidates.length === 0) return false;
  const [row] = await db
    .select({ id: vmAssignments.id })
    .from(vmAssignments)
    .where(and(
      eq(vmAssignments.user_id, userId),
      eq(vmAssignments.vmid, parsedVmid),
      inArray(vmAssignments.node, candidates),
    ))
    .limit(1);
  return row !== undefined;
}

// Resolve the facts canPerformVmOp needs, with one user lookup rather than one
// per flag. Session admins short-circuit; a DB row flagged is_admin bypasses
// too, matching userHasPermission / requirePermission.
export async function vmOpContext(
  userId: number,
  node: string,
  vmid: number | string,
  isAdmin: boolean,
): Promise<VmOpContext> {
  if (isAdmin) return { isAdmin: true };

  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) return { isAdmin: false };
  if (user.is_admin) return { isAdmin: true };

  const perms = await effectivePermissions(user);
  return {
    isAdmin: false,
    isAssigned: await userOwnsVm(userId, node, vmid),
    seeAllVms: perms.see_all_vms,
    operateAllVms: perms.can_operate_all_vms,
    canEditHardware: perms.can_edit_vm_hardware,
  };
}

/**
 * The gate every VM route runs on. `op` is a key of VM_OP_TIERS (utils/vmOps.ts)
 * — the tier table there, not the call site, decides which permission applies.
 */
export async function userCanPerformVmOp(
  userId: number,
  node: string,
  vmid: number | string,
  isAdmin: boolean,
  op: string,
): Promise<boolean> {
  return canPerformVmOp(op, await vmOpContext(userId, node, vmid, isAdmin));
}

// True when the user sees the whole fleet inventory rather than just their
// assignments (drives the "all VMs" listing).
export async function userSeesAllVms(userId: number, isAdmin: boolean): Promise<boolean> {
  if (isAdmin) return true;
  return userHasPermission(userId, 'see_all_vms', 'can_operate_all_vms');
}
