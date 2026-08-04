import { Router } from 'express';
import db, { planEncryptedSecretRotation, rotateEncryptedSecrets } from '../db.js';
import { getTaskStatus } from '../proxmox.js';
import { requireAdmin, requireAuth, requireInteractiveSession, requirePermission, requireRecentReauthentication } from '../middleware/auth.js';
import { logAudit } from '../utils/audit.js';
import { sendError } from '../utils/httpError.js';
import { databaseMaintenanceStatus, runDatabaseMaintenance } from '../services/databaseMaintenance.js';
import { backupStatus, createVerifiedBackup } from '../services/backupService.js';
import { encryptionKeyStatus } from '../utils/secrets.js';
import { classifyUpstreamTask } from '../utils/reconciliation.js';
import { cleanupOperationTracking, operationPhase } from '../services/operationReconciliation.js';
import { boundedInteger, validateObject } from '../utils/validation.js';

const router = Router();
const canOperate = requirePermission('can_manage_hosts');
router.use(requireAuth, requireInteractiveSession, canOperate);

function listOperations() {
  const provisioning = db.prepare(`
    SELECT pv.id, 'provision' AS type, pv.node, pv.vmid, pv.name AS label, pv.status, pv.status_detail AS detail, pv.upid,
      pv.request_id, pv.user_id AS actor_user_id, u.username AS actor_username, pv.steps, pv.upstream_status, pv.upstream_checked_at,
      pv.created_at, NULL AS finished_at
    FROM provisioned_vms pv LEFT JOIN users u ON u.id = pv.user_id ORDER BY pv.id DESC LIMIT 100
  `).all();
  const migrations = db.prepare(`
    SELECT m.id, 'migration' AS type, m.source_node AS node, m.vmid, m.source_node || ' → ' || m.target_node AS label,
      m.status, m.status_detail AS detail, m.upid, m.request_id, m.user_id AS actor_user_id,
      u.username AS actor_username, m.steps, m.upstream_status, m.upstream_checked_at,
      m.created_at, m.finished_at
    FROM vm_migrations m LEFT JOIN users u ON u.id = m.user_id ORDER BY m.id DESC LIMIT 100
  `).all();
  return [...provisioning, ...migrations]
    .map((operation) => {
      const publicOperation = { ...operation };
      delete publicOperation.steps;
      return { ...publicOperation, phase: operationPhase(operation.steps) };
    })
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
    .slice(0, 150);
}

router.get('/', (req, res) => {
  res.json({
    operations: listOperations(),
    database: databaseMaintenanceStatus(),
    backups: backupStatus(),
    encryption: encryptionKeyStatus(),
    encryptionRotation: planEncryptedSecretRotation(),
    capabilities: { rotateEncryption: !!req.session.isAdmin },
  });
});

router.post('/database-maintenance', requireRecentReauthentication, (req, res) => {
  validateObject(req.body || {}, { fields: ['batchSize'] });
  const batchSize = req.body?.batchSize === undefined
    ? undefined
    : boundedInteger(req.body.batchSize, { field: 'batchSize', min: 1, max: 5000 });
  const result = runDatabaseMaintenance({ batchSize });
  logAudit(req, 'database_maintenance_run', 'sqlite', JSON.stringify(result.deleted));
  res.json(result);
});

router.post('/backups', requireRecentReauthentication, async (req, res) => {
  try {
    const result = await createVerifiedBackup({ requestId: req.requestId || '' });
    logAudit(req, 'database_backup_verified', String(result.id), `size=${result.size_bytes}`);
    res.status(201).json(result);
  } catch (err) { sendError(res, err); }
});

router.get('/encryption/rotation-plan', (_req, res) => {
  res.json(planEncryptedSecretRotation());
});

router.post('/encryption/rotate', requireAdmin, requireRecentReauthentication, (req, res) => {
  const plan = planEncryptedSecretRotation();
  if (plan.undecryptable > 0) {
    return res.status(409).json({ error: 'Rotation cannot start because some values cannot be decrypted with the configured keyring', plan });
  }
  const counts = rotateEncryptedSecrets();
  logAudit(req, 'secret_encryption_keys_rotated', encryptionKeyStatus().currentKeyId, `values=${Object.values(counts).reduce((sum, value) => sum + value, 0)}`);
  res.json({ ok: true, counts, remaining: planEncryptedSecretRotation() });
});

router.post('/provision/:id/reconcile', requireRecentReauthentication, async (req, res) => {
  const row = db.prepare('SELECT * FROM provisioned_vms WHERE id = ?').get(req.params.id);
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
    db.prepare("UPDATE provisioned_vms SET status = ?, status_detail = ?, upstream_status = ?, upstream_checked_at = datetime('now') WHERE id = ?")
      .run(status, detail, upstreamStatus, row.id);
    logAudit(req, 'provision_operation_reconciled', String(row.id), `status=${status}; upid=${row.upid}`);
    res.json({ ...row, status, status_detail: detail, upstream_status: upstreamStatus, upstream: { status: task.status, exitstatus: task.exitstatus } });
  } catch (err) { sendError(res, err); }
});

router.post('/migration/:id/reconcile', requireRecentReauthentication, async (req, res) => {
  const row = db.prepare('SELECT * FROM vm_migrations WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Migration operation not found' });
  if (!row.upid) return res.status(400).json({ error: 'This operation has no upstream task identifier to reconcile' });
  try {
    const task = await getTaskStatus(row.source_node, row.upid);
    const classified = classifyUpstreamTask(task);
    const status = classified.status === 'error' ? 'error' : 'needs_review';
    const upstreamStatus = task.status === 'stopped' ? `stopped:${task.exitstatus || 'unknown'}` : String(task.status || 'running');
    db.prepare("UPDATE vm_migrations SET status = ?, status_detail = ?, upstream_status = ?, upstream_checked_at = datetime('now'), finished_at = CASE WHEN ? = 'error' THEN datetime('now') ELSE finished_at END WHERE id = ?")
      .run(status, classified.detail, upstreamStatus, status, row.id);
    logAudit(req, 'migration_operation_reconciled', String(row.id), `status=${status}; upid=${row.upid}`);
    res.json({ ...row, status, status_detail: classified.detail, upstream_status: upstreamStatus, upstream: { status: task.status, exitstatus: task.exitstatus } });
  } catch (err) { sendError(res, err); }
});

router.post('/migration/:id/resolve', requireRecentReauthentication, (req, res) => {
  const status = req.body?.status;
  if (!['ok', 'error'].includes(status)) return res.status(400).json({ error: 'status must be ok or error' });
  const row = db.prepare('SELECT id, status FROM vm_migrations WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Migration operation not found' });
  if (row.status !== 'needs_review') return res.status(409).json({ error: 'Only interrupted migrations awaiting review can be resolved manually' });
  const detail = status === 'ok'
    ? 'Manually verified by an administrator after upstream reconciliation.'
    : 'Marked failed by an administrator after upstream reconciliation.';
  db.prepare("UPDATE vm_migrations SET status = ?, status_detail = ?, finished_at = datetime('now') WHERE id = ?")
    .run(status, detail, row.id);
  logAudit(req, 'migration_operation_resolved', String(row.id), `from=${row.status}; to=${status}`);
  res.json({ ok: true, status, detail });
});

router.post('/provision/:id/resolve', requireRecentReauthentication, (req, res) => {
  const status = req.body?.status;
  if (!['ready', 'error'].includes(status)) return res.status(400).json({ error: 'status must be ready or error' });
  const row = db.prepare('SELECT id, status FROM provisioned_vms WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Provisioning operation not found' });
  if (row.status !== 'needs_review') return res.status(409).json({ error: 'Only interrupted provisioning awaiting review can be resolved manually' });
  const detail = status === 'ready' ? 'Manually verified by an administrator after reconciliation.' : 'Marked failed by an administrator after reconciliation.';
  db.prepare('UPDATE provisioned_vms SET status = ?, status_detail = ? WHERE id = ?').run(status, detail, row.id);
  logAudit(req, 'provision_operation_resolved', String(row.id), `from=${row.status}; to=${status}`);
  res.json({ ok: true, status, detail });
});

function cleanupOperation(req, res, type) {
  const result = cleanupOperationTracking(db, type, req.params.id);
  // Repeated cleanup is intentionally harmless so an operator can safely retry
  // after a lost response.
  if (result.alreadyAbsent) return res.json(result);
  if (result.blocked) {
    return res.status(409).json({
      error: `Cleanup only removes portal tracking after review or a terminal result; it never stops or deletes the Proxmox resource (current status: ${result.status})`,
    });
  }
  logAudit(req, `${type}_operation_tracking_cleaned`, String(result.removed.id), `status=${result.removed.status}; upstream resource/task unchanged`);
  return res.json({ ok: true, consequence: result.consequence });
}

router.delete('/provision/:id', requireRecentReauthentication, (req, res) => cleanupOperation(req, res, 'provision'));

router.delete('/migration/:id', requireRecentReauthentication, (req, res) => cleanupOperation(req, res, 'migration'));

export default router;
