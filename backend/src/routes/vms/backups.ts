import { Router } from 'express';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import { backupTasks, users } from '../../db/schema/index.ts';
import {
  getVMBackups, createVMBackup, deleteVMBackup, getBackupStorages, restoreVMBackup, listBackupFiles,
  downloadBackupFile, getGuestType, getTaskStatus, getTaskLog,
} from '../../proxmox.ts';
import { sendError } from '../../utils/httpError.ts';
import { logAudit } from '../../utils/audit.ts';
import { notify, portalLink } from '../../utils/notify.ts';
import { decodeNodeRef, nodeLookupCandidates } from '../../utils/nodeRef.ts';
import { assertStorageExposed } from '../../utils/storageVisibility.ts';
import { readTaskProgress } from '../../utils/taskProgress.ts';
import { parseUpid, inProgressVolids } from '../../utils/backupTask.ts';
import { resolveRestoreGuestType } from '../../utils/backupGuestType.ts';
import { allowOp } from './shared.ts';

const router = Router();

// Backup volume IDs embed the VMID they belong to. The route-level access
// check only covers :vmid, so every handler that forwards a caller-supplied
// volid to Proxmox must also verify the volid targets that same VM —
// otherwise any user could read, restore, or delete another tenant's
// backups by naming a foreign volid (IDOR). Unparseable volids are rejected.
function volidBelongsToVm(volid, vmid) {
  const s = String(volid || '');
  const target = Number.parseInt(vmid, 10);
  const found = [];
  // Classic vzdump archives: <storage>:backup/vzdump-qemu-100-2024_05_01-….vma.zst
  const vzdump = s.match(/vzdump-(?:qemu|lxc|openvz)-(\d+)-/);
  if (vzdump) found.push(Number.parseInt(vzdump[1], 10));
  // PBS snapshots: <storage>:backup/vm/100/2026-07-06T22:37:18Z
  const pbs = s.match(/(?:^|[:/])backup\/(?:vm|ct)\/(\d+)(?:\/|$)/);
  if (pbs) found.push(Number.parseInt(pbs[1], 10));
  // A volid that matches both forms must agree with the route VMID in both
  return found.length > 0 && found.every(id => id === target);
}

// ─── VM Backups ──────────────────────────────────────────────────────────────

// Manual vzdump runs are tracked so the UI can tell a finished archive from one
// Proxmox is still writing — the storage listing shows both the moment the file
// exists. Like vm_migrations, rows are refreshed lazily rather than by a
// background timer: the vzdump task keeps running on the node whatever the
// portal is doing, so re-checking it when someone asks is enough and survives a
// backend restart for free.
const BACKUP_LOG_BATCH = 512;
const BACKUP_LOG_MAX_BATCHES = 20; // bounds the catch-up read of a long dump

async function backupTaskRows(node, vmid, { limit = 10 } = {}) {
  const candidates = nodeLookupCandidates(node);
  if (candidates.length === 0) return [];
  return db
    .select()
    .from(backupTasks)
    .where(and(eq(backupTasks.vmid, parseInt(vmid, 10)), inArray(backupTasks.node, candidates)))
    .orderBy(desc(backupTasks.id))
    .limit(limit);
}

async function finalizeBackupTask(row, ok, detail) {
  // Atomic claim: only the update that flips a still-'running' row wins.
  const result = await db
    .update(backupTasks)
    .set({ status: ok ? 'ok' : 'failed', status_detail: detail || '', finished_at: new Date() })
    .where(and(eq(backupTasks.id, row.id), eq(backupTasks.status, 'running')));
  // Two pollers can land on the same finished task; only the one that actually
  // flipped the row gets to notify.
  if (result.rowCount === 0) return;

  const { nodeName } = decodeNodeRef(row.node);
  const vmLabel = `#${row.vmid}${nodeName ? ` on ${nodeName}` : ''}`;
  let owner = '';
  if (row.user_id) {
    const [u] = await db.select({ username: users.username }).from(users).where(eq(users.id, row.user_id)).limit(1);
    owner = u?.username || '';
  }
  // Until now `backup.failed` only ever fired when the *submission* failed, so
  // a dump that died halfway through notified nobody.
  notify(ok ? 'backup.created' : 'backup.failed', {
    vm: vmLabel,
    owner,
    ownerUserId: row.user_id || null,
    status: ok ? 'completed' : 'failed',
    detail: ok
      ? (row.storage ? `Backup to ${row.storage} finished` : 'Backup finished')
      : `Backup failed: ${detail || 'the vzdump task did not finish successfully'}`,
    url: portalLink(`/vm/${row.node}/${row.vmid}`),
  });
}

// Re-check still-'running' rows against their PVE task and scrape the percentage
// out of the task log. Mutates the rows in place so the caller can serialize
// them straight away.
// A row whose node stays unreachable would otherwise sit at 'running' forever,
// and a permanent "Backing up…" banner holds Restore and Delete hostage. No
// manual vzdump runs for a day, so past this point the row is written off.
const BACKUP_TASK_MAX_AGE_MS = 24 * 60 * 60 * 1000;

async function refreshBackupTasks(rows) {
  const refetch = async (id) => {
    const [fresh] = await db.select().from(backupTasks).where(eq(backupTasks.id, id)).limit(1);
    return fresh;
  };
  for (const row of rows) {
    if (row.status !== 'running' || !row.upid) continue;
    // created_at is a real timestamp now — read it straight off the row.
    const startedMs = row.created_at ? new Date(row.created_at).getTime() : NaN;
    if (Number.isFinite(startedMs) && Date.now() - startedMs > BACKUP_TASK_MAX_AGE_MS) {
      await finalizeBackupTask(row, false, 'Gave up tracking this backup after 24 hours — check the task log in Proxmox');
      Object.assign(row, await refetch(row.id));
      continue;
    }
    // Read the log before the status, so a task that finishes between the two
    // still gets its final progress line recorded. The read has its own catch:
    // a log endpoint that errors (PVE briefly 400s a task it has only just
    // accepted) must not stop the status check below from finalizing the row.
    try {
      const read = await readTaskProgress(
        (opts) => getTaskLog(row.node, row.upid, opts),
        { start: Number(row.log_offset) || 0, batch: BACKUP_LOG_BATCH, maxBatches: BACKUP_LOG_MAX_BATCHES },
      );
      if (read.progress) {
        await db.update(backupTasks)
          .set({ progress: read.progress.percent, progress_detail: read.progress.detail, log_offset: read.offset })
          .where(eq(backupTasks.id, row.id));
      } else {
        await db.update(backupTasks).set({ log_offset: read.offset }).where(eq(backupTasks.id, row.id));
      }
    } catch { /* no readable log yet — the status check still decides the row */ }

    try {
      const task = await getTaskStatus(row.node, row.upid);
      if (task.status === 'stopped') {
        const ok = task.exitstatus === 'OK';
        await finalizeBackupTask(row, ok, ok ? '' : task.exitstatus || 'The backup task failed');
      }
    } catch { /* node unreachable — leave it running and try again next poll */ }

    Object.assign(row, await refetch(row.id));
  }
}

function serializeBackupTask(row) {
  const { log_offset, user_id, ...rest } = row; // internal bookkeeping, not for the UI
  return {
    ...rest,
    nodeName: decodeNodeRef(row.node).nodeName || row.node,
    // null until the log carries a percentage — the UI falls back to a plain
    // running indicator for the early phase and for rsync-based LXC dumps.
    progress: Number.isFinite(row.progress) ? row.progress : null,
    progress_detail: row.progress_detail || '',
  };
}

router.get('/:node/:vmid/backups', async (req, res) => {
  const { node, vmid } = req.params;
  if (!(await allowOp(req, node, vmid, 'vm.backups.list'))) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    const backups = await getVMBackups(node, vmid);
    // Flag the archive a running dump is writing, so the UI can hold back
    // Restore/Delete/Browse and its misleading size and verification tags.
    const tasks = await backupTaskRows(node, vmid);
    await refreshBackupTasks(tasks);
    const inProgress = new Set(inProgressVolids(backups, tasks));
    res.json(backups.map((b) => (inProgress.has(b.volid) ? { ...b, inProgress: true } : b)));
  } catch (err) {
    sendError(res, err);
  }
});

// Backup tasks for this VM, newest first. Polled by the VM page while a dump is
// running; also the reason progress survives a page reload or a backend restart.
router.get('/:node/:vmid/backup-tasks', async (req, res) => {
  const { node, vmid } = req.params;
  if (!(await allowOp(req, node, vmid, 'vm.backups.tasks'))) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    const rows = await backupTaskRows(node, vmid, { limit: 5 });
    await refreshBackupTasks(rows);
    res.json(rows.map(serializeBackupTask));
  } catch (err) {
    sendError(res, err);
  }
});

router.get('/:node/:vmid/backup-storages', async (req, res) => {
  const { node, vmid } = req.params;
  if (!(await allowOp(req, node, vmid, 'vm.backups.storages'))) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    res.json(await getBackupStorages(node));
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/:node/:vmid/backup', async (req, res) => {
  const { node, vmid } = req.params;
  if (!(await allowOp(req, node, vmid, 'vm.backups.create'))) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const { mode, compress, storage, notes } = req.body;
  const { nodeName } = decodeNodeRef(node);
  const vmLabel = `#${vmid}${nodeName ? ` on ${nodeName}` : ''}`;
  try {
    await assertStorageExposed(node, storage, { isAdmin: req.session.isAdmin }, vmid);
    const upid = await createVMBackup(node, vmid, { mode, compress, storage, notes });
    await logAudit(req, 'backup_create', `${node}/${vmid}`, storage || '');
    // Track the task so the UI can mark the archive as in progress instead of
    // showing a half-written dump as a finished backup. The completion
    // notification is fired from finalizeBackupTask once the task actually ends.
    const [inserted] = await db.insert(backupTasks).values({
      user_id: req.session.userId,
      node,
      vmid: parseInt(vmid, 10),
      upid,
      storage: storage || '',
      started_epoch: parseUpid(upid)?.startTime || 0,
      request_id: req.requestId || '',
    }).returning({ id: backupTasks.id });
    res.json({ ok: true, upid, taskId: inserted.id });
  } catch (err) {
    notify('backup.failed', {
      vm: vmLabel,
      owner: req.session.username,
      ownerUserId: req.session.userId,
      status: 'failed',
      detail: 'Backup could not be started',
      url: portalLink(`/vm/${node}/${vmid}`),
    });
    sendError(res, err);
  }
});

router.delete('/:node/:vmid/backups/:storage/*volid', async (req, res) => {
  const { node, vmid, storage } = req.params;
  const volid = Array.isArray(req.params.volid) ? req.params.volid.join('/') : req.params.volid;
  // Same tier as starting a dump and as snapshot deletion (issue #73): a
  // fleet operator who can fill a backup storage must be able to clean it up.
  // `see_all_vms` alone still cannot get here.
  if (!(await allowOp(req, node, vmid, 'vm.backups.delete'))) {
    return res.status(403).json({ error: 'You can only delete backups of VMs assigned to you' });
  }
  if (!volidBelongsToVm(volid, vmid)) {
    return res.status(403).json({ error: 'Backup does not belong to this VM' });
  }
  try {
    await deleteVMBackup(node, storage, volid);
    await logAudit(req, 'backup_delete', `${node}/${vmid}`, volid);
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

// ─── Restore VM from backup ──────────────────────────────────────────────────

router.post('/:node/:vmid/restore', async (req, res) => {
  const { node, vmid } = req.params;
  // Owner-only — restore overwrites the VM's disks (force: 1), so no
  // fleet-wide permission grants it.
  if (!(await allowOp(req, node, vmid, 'vm.restore'))) {
    return res.status(403).json({ error: 'You can only restore backups to VMs assigned to you' });
  }
  const { archive, storage } = req.body;
  if (!archive) return res.status(400).json({ error: 'archive (volid) is required' });
  if (!volidBelongsToVm(archive, vmid)) {
    return res.status(403).json({ error: 'Backup does not belong to this VM' });
  }
  // A restore has to go to /nodes/{node}/qemu or /nodes/{node}/lxc — the wrong
  // one is rejected upstream with a confusing error. The guest already at the
  // target VMID is authoritative; the volid is a cross-check that catches
  // restoring a container archive over a VM (and vice versa). Either can be
  // unknown — a fresh VMID has no guest to probe, and an unrecognised volid
  // shape tells us nothing — but if both are, refuse rather than assume qemu.
  try {
    await assertStorageExposed(node, storage, { isAdmin: req.session.isAdmin }, vmid);
    const detected = await getGuestType(node, vmid);
    const guest = resolveRestoreGuestType({ volid: archive, detected, vmid });
    if (guest.error) return res.status(guest.status).json({ error: guest.error });
    const upid = await restoreVMBackup(node, vmid, archive, storage, guest.vmtype);
    await logAudit(req, 'vm_restore', `${node}/${vmid}`, archive);
    res.json({ ok: true, upid });
  } catch (err) {
    sendError(res, err);
  }
});

// ─── File-level restore (browse backup contents) ────────────────────────────

router.get('/:node/:vmid/backup-files/:storage/*volid', async (req, res) => {
  const { node, vmid, storage } = req.params;
  const volid = Array.isArray(req.params.volid) ? req.params.volid.join('/') : req.params.volid;
  const { filepath = '/' } = req.query;
  if (!(await allowOp(req, node, vmid, 'vm.backups.browse'))) {
    return res.status(403).json({ error: 'Access denied' });
  }
  if (!volidBelongsToVm(volid, vmid)) {
    return res.status(403).json({ error: 'Backup does not belong to this VM' });
  }
  try {
    const files = await listBackupFiles(node, storage, volid, filepath);
    res.json(files);
  } catch (err) {
    sendError(res, err);
  }
});

router.get('/:node/:vmid/backup-download/:storage/*volid', async (req, res) => {
  const { node, vmid, storage } = req.params;
  const volid = Array.isArray(req.params.volid) ? req.params.volid.join('/') : req.params.volid;
  const { filepath } = req.query;
  if (!(await allowOp(req, node, vmid, 'vm.backups.browse'))) {
    return res.status(403).json({ error: 'Access denied' });
  }
  if (!volidBelongsToVm(volid, vmid)) {
    return res.status(403).json({ error: 'Backup does not belong to this VM' });
  }
  if (!filepath) return res.status(400).json({ error: 'filepath is required' });
  try {
    const { stream, headers } = await downloadBackupFile(node, storage, volid, filepath);
    const contentType = headers['content-type'] || 'application/octet-stream';
    // filepath is base64-encoded by Proxmox — decode to get real path
    let realName = 'download';
    try {
      const decoded = Buffer.from(filepath, 'base64').toString('utf-8');
      realName = decoded.split('/').filter(Boolean).pop() || 'download';
    } catch { /* use default */ }
    // Proxmox returns directories as tar archives
    const isArchive = contentType.includes('tar') || contentType.includes('octet-stream');
    if (isArchive && !realName.includes('.')) {
      realName += '.tar.zst';
    }
    // Sanitize filename to prevent header injection
    const safeName = realName.replace(/["\\\r\n]/g, '_').replace(/[^\x20-\x7E]/g, '_');
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    stream.pipe(res);
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
