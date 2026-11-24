import { Router } from 'express';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  vmSchedules, vmSshConfigs, vmSshUserConfigs, vmAssignments, vmMigrations, vmLeases, provisionedVms,
  backupTasks, vmDetectedIps, users,
} from '../../db/schema/index.ts';
import { getVMBackups, deleteVMBackup, deleteVM, resolveLegacyVmNode } from '../../proxmox.ts';
import { httpError, sendError } from '../../utils/httpError.ts';
import { logAudit } from '../../utils/audit.ts';
import { decodeNodeRef, nodeLookupCandidates } from '../../utils/nodeRef.ts';
import { isUniqueViolation } from '../../db/errors.ts';
import { assertVmPolicyLocation, vmMigrationPending, withVmMigrationLock } from '../../utils/vmMigrationLock.ts';
import { allowOp } from './shared.ts';

const router = Router();

// ─── VM Deletion ──────────────────────────────────────────────────────────────

router.delete('/:node/:vmid', async (req, res) => {
  const { node, vmid } = req.params;

  // Admins can delete any VM; regular users only VMs assigned to them.
  // 'vm.delete' is an owner-only op — neither see_all_vms nor
  // can_operate_all_vms grants deletion.
  if (!(await allowOp(req, node, vmid, 'vm.delete'))) {
    return res.status(403).json({ error: 'You can only delete VMs assigned to you' });
  }

  try {
    const parsedVmid = parseInt(vmid, 10);
    const result = await withVmMigrationLock(parsedVmid, async (database) => {
      if (await vmMigrationPending(database, parsedVmid)) {
        throw httpError(409, 'VM migration is running or awaiting review; deletion is blocked');
      }
      const [latestMigration] = await database.select().from(vmMigrations)
        .where(and(eq(vmMigrations.vmid, parsedVmid), eq(vmMigrations.status, 'ok')))
        .orderBy(desc(vmMigrations.id)).limit(1);
      if (latestMigration?.kept_source) {
        const requested = decodeNodeRef(node);
        const source = decodeNodeRef(latestMigration.source_node);
        const target = decodeNodeRef(latestMigration.target_node);
        const isSource = source.nodeName === requested.nodeName
          && (source.hostId === null ? requested.nodeRef !== target.nodeRef : requested.hostId === null || requested.hostId === source.hostId);
        if (isSource) throw httpError(400, 'This is the migrated-away source copy; remove only its config, not its shared disks');
      }
      let currentNode = await assertVmPolicyLocation(database, node, parsedVmid);
      const currentRef = decodeNodeRef(currentNode);
      const cleanupTables: any[] = [vmAssignments, vmSshConfigs, vmSshUserConfigs, provisionedVms, vmLeases, vmSchedules];
      let hasLegacyRows = currentRef.hostId === null;
      for (const table of cleanupTables) {
        const [legacy] = await database.select({ id: table.id }).from(table)
          .where(and(eq(table.vmid, parsedVmid), eq(table.node, currentRef.nodeName))).limit(1);
        if (legacy) hasLegacyRows = true;
      }
      if (hasLegacyRows) {
        const verifiedNode = await resolveLegacyVmNode(currentRef.nodeName, parsedVmid, database);
        if (currentRef.hostId !== null && verifiedNode !== currentRef.nodeRef) {
          throw httpError(409, 'Legacy VM records belong to another host; reload its canonical location before deletion');
        }
        currentNode = verifiedNode;
      }
      const candidates = nodeLookupCandidates(currentNode);
      const [actor] = await database.select({ is_admin: users.is_admin }).from(users).where(eq(users.id, req.session.userId));
      const assignments = await database.select().from(vmAssignments)
        .where(and(eq(vmAssignments.vmid, parsedVmid), inArray(vmAssignments.node, candidates)));
      if (!actor || (!actor.is_admin && !assignments.some((assignment) => assignment.user_id === req.session.userId))) {
        throw httpError(403, 'You can only delete VMs assigned to you');
      }
      if (hasLegacyRows) {
        try {
          await database.transaction(async (tx) => {
            for (const table of cleanupTables) {
              await tx.update(table).set({ node: currentNode })
                .where(and(eq(table.vmid, parsedVmid), eq(table.node, currentRef.nodeName)));
            }
          });
        } catch (err) {
          if (isUniqueViolation(err)) throw httpError(409, 'Conflicting legacy VM aliases must be reconciled before deletion');
          throw err;
        }
      }
      let backups = [];
      try {
        backups = await getVMBackups(currentNode, vmid, database);
      } catch (err) {
        console.warn(`[vm-delete] Could not list backups for ${node}/${vmid}: ${err.message}`);
      }
      const deleted = await deleteVM(currentNode, vmid, { allowMissing: true }, database);
      let deletedBackups = 0;
      const failedBackups = [];
      for (const backup of backups) {
        try {
          await deleteVMBackup(currentNode, backup.storage, backup.volid, database);
          deletedBackups += 1;
        } catch (err) {
          console.warn(`[vm-delete] Failed to delete backup ${backup.volid}: ${err.message}`);
          failedBackups.push(backup.volid);
        }
      }
      if (currentNode) {
        await database.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL lock_timeout = '2s'`);
          await tx.execute(sql`LOCK TABLE ${sql.join(cleanupTables.map((table) => sql`${table}`), sql`, `)} IN SHARE ROW EXCLUSIVE MODE`);
          for (const table of cleanupTables) {
            const [unexpected] = await tx.select({ id: table.id }).from(table)
              .where(and(eq(table.vmid, parsedVmid), eq(table.node, decodeNodeRef(currentNode).nodeName))).limit(1);
            if (unexpected) throw httpError(409, 'New legacy VM aliases appeared during deletion; reconcile them before cleanup');
          }
          for (const table of cleanupTables) {
            await tx.delete(table).where(and(eq(table.vmid, parsedVmid), eq(table.node, currentNode)));
          }
          await tx.delete(vmDetectedIps).where(and(eq(vmDetectedIps.vmid, parsedVmid), inArray(vmDetectedIps.node, nodeLookupCandidates(currentNode))));
          await tx.delete(backupTasks).where(and(eq(backupTasks.vmid, parsedVmid), inArray(backupTasks.node, nodeLookupCandidates(currentNode))));
          await tx.delete(vmMigrations).where(and(eq(vmMigrations.vmid, parsedVmid), inArray(vmMigrations.status, ['ok', 'error', 'failed', 'timeout'])));
        });
      }
      return { ok: true, deletedBackups, failedBackups, alreadyAbsent: Boolean(deleted.alreadyAbsent) };
    });
    await logAudit(req, 'vm_delete', `${node}/${vmid}`, `backups_deleted=${result.deletedBackups}; already_absent=${result.alreadyAbsent}`);
    res.json(result);
  } catch (err) { sendError(res, err); }
});

export default router;
