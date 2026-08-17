import crypto from 'node:crypto';
import { copyFile, mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import db from '../db.ts';
import { log } from '../utils/logger.ts';
import { notify, portalLink } from '../utils/notify.ts';
import { encryptBackupFile, verifyEncryptedBackup } from '../utils/encryptedBackup.ts';
let runningTask = null;

function config() {
  const directory = String(process.env.BACKUP_DIR || '').trim();
  const offsiteDirectory = String(process.env.BACKUP_OFFSITE_DIR || '').trim();
  const passphrase = String(process.env.BACKUP_ENCRYPTION_KEY || '');
  const retentionDays = Math.max(1, Number.parseInt(process.env.BACKUP_RETENTION_DAYS || '14', 10) || 14);
  return {
    directory,
    offsiteDirectory,
    passphrase,
    retentionDays,
    enabled: !!directory && !!offsiteDirectory && passphrase.length >= 32,
  };
}

async function enforceRetention(directory, retentionDays) {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  for (const name of await readdir(directory)) {
    if (!/^homelabrrr-.*\.sqlite\.enc$/.test(name)) continue;
    const path = join(directory, name);
    if ((await stat(path)).mtimeMs < cutoff) await unlink(path);
  }
}

export function backupStatus() {
  const settings = config();
  const latest = db.prepare('SELECT * FROM backup_runs ORDER BY id DESC LIMIT 1').get() || null;
  return {
    enabled: settings.enabled,
    retentionDays: settings.retentionDays,
    running: !!runningTask,
    latest,
  };
}

export async function createVerifiedBackup({ requestId = '' } = {}) {
  const settings = config();
  if (!settings.enabled) {
    const err = new Error('Set BACKUP_DIR, BACKUP_OFFSITE_DIR, and a BACKUP_ENCRYPTION_KEY of at least 32 characters to enable backups');
    err.status = 400;
    throw err;
  }
  if (runningTask) {
    const err = new Error('A database backup is already running');
    err.status = 409;
    throw err;
  }
  runningTask = (async () => {
    let row = null;
    let plain = '';
    let localTarget = '';
    let offsiteTarget = '';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    plain = join(tmpdir(), `homelabrrr-${crypto.randomUUID()}.sqlite`);
    const filename = `homelabrrr-${stamp}.sqlite.enc`;
    localTarget = join(settings.directory, filename);
    offsiteTarget = join(settings.offsiteDirectory, filename);
    try {
      // Record the attempt before touching either destination so an unavailable
      // staging/off-host mount remains visible in Operations and notifications.
      row = db.prepare("INSERT INTO backup_runs (path, status, request_id) VALUES (?, 'running', ?)").run(offsiteTarget, requestId);
      await mkdir(settings.directory, { recursive: true, mode: 0o700 });
      await mkdir(settings.offsiteDirectory, { recursive: true, mode: 0o700 });
      await db.backup(plain);
      await encryptBackupFile(plain, localTarget, settings.passphrase);
      await verifyEncryptedBackup(localTarget, settings.passphrase);
      await copyFile(localTarget, offsiteTarget);
      // Verify the copy that would actually be used for disaster recovery,
      // not merely the local staging artifact.
      await verifyEncryptedBackup(offsiteTarget, settings.passphrase);
      const size = (await stat(offsiteTarget)).size;
      db.prepare("UPDATE backup_runs SET status = 'verified', size_bytes = ?, verified_at = datetime('now') WHERE id = ?")
        .run(size, row.lastInsertRowid);
      await enforceRetention(settings.directory, settings.retentionDays);
      await enforceRetention(settings.offsiteDirectory, settings.retentionDays);
      const result = db.prepare('SELECT * FROM backup_runs WHERE id = ?').get(row.lastInsertRowid);
      notify('backup.created', {
        domain: 'Portal database', status: 'verified', detail: `Encrypted off-host backup verified (${size} bytes)`,
        url: portalLink('/admin/operations'),
      });
      return result;
    } catch (err) {
      if (row) {
        db.prepare("UPDATE backup_runs SET status = 'error', detail = ? WHERE id = ?")
          .run(String(err.message || err).slice(0, 1000), row.lastInsertRowid);
      }
      if (localTarget) await unlink(localTarget).catch(() => {});
      if (offsiteTarget) await unlink(offsiteTarget).catch(() => {});
      notify('backup.failed', {
        domain: 'Portal database', status: 'failed', detail: 'Encrypted off-host backup or restore verification failed',
        url: portalLink('/admin/operations'),
      });
      throw err;
    } finally {
      if (plain) await unlink(plain).catch(() => {});
    }
  })();
  try {
    return await runningTask;
  } finally {
    runningTask = null;
  }
}

export async function waitForBackupIdle(timeoutMs = 10_000) {
  if (!runningTask) return true;
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); timer.unref?.(); });
  const complete = runningTask.then(() => true, () => true);
  const result = await Promise.race([complete, timeout]);
  clearTimeout(timer);
  return result;
}

export function startBackupScheduler() {
  const settings = config();
  if (!settings.enabled) return () => {};
  const intervalMs = Math.max(60 * 60 * 1000, Number.parseInt(process.env.BACKUP_INTERVAL_MS || '86400000', 10) || 86_400_000);
  const scheduled = () => createVerifiedBackup().catch((err) => {
    log('error', 'database_backup_failed', { error: err });
  });
  const first = setTimeout(scheduled, 60_000);
  const interval = setInterval(scheduled, intervalMs);
  first.unref?.();
  interval.unref?.();
  return () => { clearTimeout(first); clearInterval(interval); };
}
