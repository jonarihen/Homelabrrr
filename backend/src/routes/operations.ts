import { Router } from 'express';
import { eq, desc, sql } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { provisionedVms, vmMigrations, users } from '../db/schema/index.ts';
import { planEncryptedSecretRotation, rotateEncryptedSecrets } from '../db/init.ts';
import { getTaskStatus } from '../proxmox.ts';
import { requireAdmin, requireAuth, requireInteractiveSession, requirePermission, requireRecentReauthentication } from '../middleware/auth.ts';
import { logAudit } from '../utils/audit.ts';
import { sendError } from '../utils/httpError.ts';
import { databaseMaintenanceStatus, runDatabaseMaintenance } from '../services/databaseMaintenance.ts';
import { backupStatus, createVerifiedBackup } from '../services/backupService.ts';
import { encryptionKeyStatus } from '../utils/secrets.ts';
import { classifyUpstreamTask } from '../utils/reconciliation.ts';
import { cleanupOperationTracking, operationPhase } from '../services/operationReconciliation.ts';
import { boundedInteger, validateObject } from '../utils/validation.ts';

const router = Router();
const canOperate = requirePermission('can_manage_hosts');
router.use(requireAuth, requireInteractiveSession, canOperate);

async function listOperations() {
  const provisioning = await db
    .select({
      id: provisionedVms.id,
      type: sql<string>`'provision'`.as('type'),
      node: provisionedVms.node,
      vmid: provisionedVms.vmid,
      label: provisionedVms.name,
      status: provisionedVms.status,
      detail: provisionedVms.status_detail,
      upid: provisionedVms.upid,
      request_id: provisionedVms.request_id,
      actor_user_id: provisionedVms.user_id,
      actor_username: users.username,
      steps: provisionedVms.steps,
      upstream_status: provisionedVms.upstream_status,
      upstream_checked_at: provisionedVms.upstream_checked_at,
      created_at: provisionedVms.created_at,
      finished_at: sql`NULL`.as('finished_at'),
    })
    .from(provisionedVms)
    .leftJoin(users, eq(users.id, provisionedVms.user_id))
    .orderBy(desc(provisionedVms.id))
    .limit(100);
  const migrations = await db
    .select({
      id: vmMigrations.id,
      type: sql<string>`'migration'`.as('type'),
      node: vmMigrations.source_node,
      vmid: vmMigrations.vmid,
      label: sql<string>`${vmMigrations.source_node} || ' → ' || ${vmMigrations.target_node}`.as('label'),
      status: vmMigrations.status,
      detail: vmMigrations.status_detail,
      upid: vmMigrations.upid,
      request_id: vmMigrations.request_id,
      actor_user_id: vmMigrations.user_id,
      actor_username: users.username,
      steps: vmMigrations.steps,
      upstream_status: vmMigrations.upstream_status,
      upstream_checked_at: vmMigrations.upstream_checked_at,
      created_at: vmMigrations.created_at,
      finished_at: vmMigrations.finished_at,
    })
    .from(vmMigrations)
    .leftJoin(users, eq(users.id, vmMigrations.user_id))
    .orderBy(desc(vmMigrations.id))
    .limit(100);
  return [...provisioning, ...migrations]
    .map((operation) => {
      // steps is a jsonb column now — pass the parsed array straight to operationPhase.
      const { steps, ...publicOperation } = operation as any;
      return { ...publicOperation, phase: operationPhase(steps) };
    })
    // created_at is a Date now; sort by timestamp so newest sorts first.
    .sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime())
    .slice(0, 150);
}

router.get('/', async (req, res) => {
  res.json({
    operations: await listOperations(),
    database: databaseMaintenanceStatus(),
    backups: await backupStatus(),
    encryption: encryptionKeyStatus(),
    encryptionRotation: await planEncryptedSecretRotation(),
    capabilities: { rotateEncryption: !!req.session.isAdmin },
  });
});

router.post('/database-maintenance', requireRecentReauthentication, async (req, res) => {
  validateObject(req.body || {}, { fields: ['batchSize'] });
  const batchSize = req.body?.batchSize === undefined
    ? undefined
    : boundedInteger(req.body.batchSize, { field: 'batchSize', min: 1, max: 5000 });
  const result = runDatabaseMaintenance({ batchSize });
  await logAudit(req, 'database_maintenance_run', 'sqlite', JSON.stringify(result.deleted));
  res.json(result);
});

router.post('/backups', requireRecentReauthentication, async (req, res) => {
  try {
    const result = await createVerifiedBackup({ requestId: req.requestId || '' });
    logAudit(req, 'database_backup_verified', String(result.id), `size=${result.size_bytes}`);
    res.status(201).json(result);
  } catch (err) { sendError(res, err); }
});

router.get('/encryption/rotation-plan', async (_req, res) => {
  res.json(await planEncryptedSecretRotation());
});

router.post('/encryption/rotate', requireAdmin, requireRecentReauthentication, async (req, res) => {
  const plan = await planEncryptedSecretRotation();
  if (plan.undecryptable > 0) {
    return res.status(409).json({ error: 'Rotation cannot start because some values cannot be decrypted with the configured keyring', plan });
  }
  const counts = await rotateEncryptedSecrets();
  await logAudit(req, 'secret_encryption_keys_rotated', encryptionKeyStatus().currentKeyId, `values=${Object.values(counts).reduce((sum, value) => sum + value, 0)}`);
  res.json({ ok: true, counts, remaining: await planEncryptedSecretRotation() });
});

router.post('/provision/:id/reconcile', requireRecentReauthentication, async (req, res) => {
  const [row] = await db.select().from(provisionedVms).where(eq(provisionedVms.id, Number(req.params.id))).limit(1);
  if (!row) return res.status(404).json({ error: 'Provisioning operation not found' });
  if (!row.upid) return res.status(400).json({ error: 'This operation has no upstream task identifier to reconcile' });
  try {
    const task = await getTaskStatus(row.node, row.upid);
    const classified = classifyUpstreamTask(task);
    // A successful UPID proves only that the saved upstream phase completed;
    // it does not prove later portal-side assignment/configuration did. Keep it
    // reviewable until an operator adopts the verified final state.
    const status = classified.status === 'error' ? 'error' : 'needs_review';
    const detail = classified.detail;
    const upstreamStatus = task.status === 'stopped' ? `stopped:${task.exitstatus || 'unknown'}` : String(task.status || 'running');
    await db.update(provisionedVms)
      .set({ status, status_detail: detail, upstream_status: upstreamStatus, upstream_checked_at: new Date() })
      .where(eq(provisionedVms.id, row.id));
    await logAudit(req, 'provision_operation_reconciled', String(row.id), `status=${status}; upid=${row.upid}`);
    res.json({ ...row, status, status_detail: detail, upstream_status: upstreamStatus, upstream: { status: task.status, exitstatus: task.exitstatus } });
  } catch (err) { sendError(res, err); }
});

router.post('/migration/:id/reconcile', requireRecentReauthentication, async (req, res) => {
  const [row] = await db.select().from(vmMigrations).where(eq(vmMigrations.id, Number(req.params.id))).limit(1);
  if (!row) return res.status(404).json({ error: 'Migration operation not found' });
  if (!row.upid) return res.status(400).json({ error: 'This operation has no upstream task identifier to reconcile' });
  try {
    const task = await getTaskStatus(row.source_node, row.upid);
    const classified = classifyUpstreamTask(task);
    const status = classified.status === 'error' ? 'error' : 'needs_review';
    const upstreamStatus = task.status === 'stopped' ? `stopped:${task.exitstatus || 'unknown'}` : String(task.status || 'running');
    // finished_at is only stamped on the error transition; otherwise left unchanged.
    const set: any = { status, status_detail: classified.detail, upstream_status: upstreamStatus, upstream_checked_at: new Date() };
    if (status === 'error') set.finished_at = new Date();
    await db.update(vmMigrations).set(set).where(eq(vmMigrations.id, row.id));
    await logAudit(req, 'migration_operation_reconciled', String(row.id), `status=${status}; upid=${row.upid}`);
    res.json({ ...row, status, status_detail: classified.detail, upstream_status: upstreamStatus, upstream: { status: task.status, exitstatus: task.exitstatus } });
  } catch (err) { sendError(res, err); }
});

router.post('/migration/:id/resolve', requireRecentReauthentication, async (req, res) => {
  const status = req.body?.status;
  if (!['ok', 'error'].includes(status)) return res.status(400).json({ error: 'status must be ok or error' });
  const [row] = await db.select({ id: vmMigrations.id, status: vmMigrations.status }).from(vmMigrations).where(eq(vmMigrations.id, Number(req.params.id))).limit(1);
  if (!row) return res.status(404).json({ error: 'Migration operation not found' });
  if (row.status !== 'needs_review') return res.status(409).json({ error: 'Only interrupted migrations awaiting review can be resolved manually' });
  const detail = status === 'ok'
    ? 'Manually verified by an administrator after upstream reconciliation.'
    : 'Marked failed by an administrator after upstream reconciliation.';
  await db.update(vmMigrations).set({ status, status_detail: detail, finished_at: new Date() }).where(eq(vmMigrations.id, row.id));
  await logAudit(req, 'migration_operation_resolved', String(row.id), `from=${row.status}; to=${status}`);
  res.json({ ok: true, status, detail });
});

router.post('/provision/:id/resolve', requireRecentReauthentication, async (req, res) => {
  const status = req.body?.status;
  if (!['ready', 'error'].includes(status)) return res.status(400).json({ error: 'status must be ready or error' });
  const [row] = await db.select({ id: provisionedVms.id, status: provisionedVms.status }).from(provisionedVms).where(eq(provisionedVms.id, Number(req.params.id))).limit(1);
  if (!row) return res.status(404).json({ error: 'Provisioning operation not found' });
  if (row.status !== 'needs_review') return res.status(409).json({ error: 'Only interrupted provisioning awaiting review can be resolved manually' });
  const detail = status === 'ready' ? 'Manually verified by an administrator after reconciliation.' : 'Marked failed by an administrator after reconciliation.';
  await db.update(provisionedVms).set({ status, status_detail: detail }).where(eq(provisionedVms.id, row.id));
  await logAudit(req, 'provision_operation_resolved', String(row.id), `from=${row.status}; to=${status}`);
  res.json({ ok: true, status, detail });
});

async function cleanupOperation(req: any, res: any, type: string) {
  const result = await cleanupOperationTracking(db, type, Number(req.params.id));
  // Repeated cleanup is intentionally harmless so an operator can safely retry
  // after a lost response.
  if (result.alreadyAbsent) return res.json(result);
  if (result.blocked) {
    return res.status(409).json({
      error: `Cleanup only removes portal tracking after review or a terminal result; it never stops or deletes the Proxmox resource (current status: ${result.status})`,
    });
  }
  await logAudit(req, `${type}_operation_tracking_cleaned`, String(result.removed.id), `status=${result.removed.status}; upstream resource/task unchanged`);
  return res.json({ ok: true, consequence: result.consequence });
}

router.delete('/provision/:id', requireRecentReauthentication, (req, res) => cleanupOperation(req, res, 'provision'));

router.delete('/migration/:id', requireRecentReauthentication, (req, res) => cleanupOperation(req, res, 'migration'));

export default router;
