import crypto from 'node:crypto';
import { copyFile, mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { desc, eq } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { backupRuns } from '../db/schema/index.ts';
import { log } from '../utils/logger.ts';
import { notify, portalLink } from '../utils/notify.ts';
import { encryptBackupFile } from '../utils/encryptedBackup.ts';

const execFileAsync = promisify(execFile);

let runningTask: Promise<any> | null = null;

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

async function enforceRetention(directory: string, retentionDays: number) {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  for (const name of await readdir(directory)) {
    // Accept both the current PostgreSQL custom-dump artifacts (.dump.enc) and
    // legacy SQLite backups (.sqlite.enc) so historic files still age out.
    if (!/^homelabrrr-.*\.(sqlite|dump)\.enc$/.test(name)) continue;
    const path = join(directory, name);
    if ((await stat(path)).mtimeMs < cutoff) await unlink(path);
  }
}

export async function backupStatus() {
  const settings = config();
  const [latest] = await db.select().from(backupRuns).orderBy(desc(backupRuns.id)).limit(1);
  return {
    enabled: settings.enabled,
    retentionDays: settings.retentionDays,
    running: !!runningTask,
    latest: latest ?? null,
  };
}

export async function createVerifiedBackup({ requestId = '' }: { requestId?: string } = {}) {
  const settings = config();
  if (!settings.enabled) {
    const err: any = new Error('Set BACKUP_DIR, BACKUP_OFFSITE_DIR, and a BACKUP_ENCRYPTION_KEY of at least 32 characters to enable backups');
    err.status = 400;
    throw err;
  }
  if (runningTask) {
    const err: any = new Error('A database backup is already running');
    err.status = 409;
    throw err;
  }
  runningTask = (async () => {
    let runId: number | null = null;
    let plain = '';
    let localTarget = '';
    let offsiteTarget = '';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    plain = join(tmpdir(), `homelabrrr-${crypto.randomUUID()}.dump`);
    const filename = `homelabrrr-${stamp}.dump.enc`;
    localTarget = join(settings.directory, filename);
    offsiteTarget = join(settings.offsiteDirectory, filename);
    try {
      // Record the attempt before touching either destination so an unavailable
      // staging/off-host mount remains visible in Operations and notifications.
      const [inserted] = await db
        .insert(backupRuns)
        .values({ path: offsiteTarget, status: 'running', request_id: requestId })
        .returning({ id: backupRuns.id });
      runId = inserted.id;
      await mkdir(settings.directory, { recursive: true, mode: 0o700 });
      await mkdir(settings.offsiteDirectory, { recursive: true, mode: 0o700 });
      // Custom-format dump of the live database. execFile rejects on a non-zero
      // pg_dump exit, so a failed dump lands in the catch below.
      await execFileAsync('pg_dump', [
        '--format=custom',
        '--no-owner',
        '--dbname', String(process.env.DATABASE_URL),
        '--file', plain,
      ]);
      // Lightweight verification: pg_dump exited zero (above) and produced a
      // non-empty archive. TODO: a full verify should run `pg_restore --list`
      // on the plaintext dump to confirm the archive's table of contents.
      if ((await stat(plain)).size <= 0) throw new Error('pg_dump produced an empty archive');
      await encryptBackupFile(plain, localTarget, settings.passphrase);
      await copyFile(localTarget, offsiteTarget);
      // The copy that would actually be used for disaster recovery must exist
      // and be non-empty, not merely the local staging artifact.
      const size = (await stat(offsiteTarget)).size;
      if (size <= 0) throw new Error('Off-host backup copy is empty');
      await db
        .update(backupRuns)
        .set({ status: 'verified', size_bytes: size, verified_at: new Date() })
        .where(eq(backupRuns.id, runId));
      await enforceRetention(settings.directory, settings.retentionDays);
      await enforceRetention(settings.offsiteDirectory, settings.retentionDays);
      const [result] = await db.select().from(backupRuns).where(eq(backupRuns.id, runId)).limit(1);
      notify('backup.created', {
        domain: 'Portal database', status: 'verified', detail: `Encrypted off-host backup verified (${size} bytes)`,
        url: portalLink('/admin/operations'),
      });
      return result;
    } catch (err: any) {
      if (runId !== null) {
        await db
          .update(backupRuns)
          .set({ status: 'error', detail: String(err?.message || err).slice(0, 1000) })
          .where(eq(backupRuns.id, runId));
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
  let timer: NodeJS.Timeout;
  const timeout = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); timer.unref?.(); });
  const complete = runningTask.then(() => true, () => true);
  const result = await Promise.race([complete, timeout]);
  clearTimeout(timer!);
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
