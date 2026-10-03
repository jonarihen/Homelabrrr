import crypto from 'node:crypto';
import { copyFile, mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { desc, eq, isNotNull, sql } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { backupRuns } from '../db/schema/index.ts';
import { log } from '../utils/logger.ts';
import { notify, portalLink } from '../utils/notify.ts';
import { decryptBackupFile, encryptBackupFile, verifyEncryptedBackup } from '../utils/encryptedBackup.ts';
import { readBackupSanity } from '../utils/backupSanity.ts';

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
  const [lastFullRestore] = await db.select({ verified_at: backupRuns.full_restore_verified_at }).from(backupRuns)
    .where(isNotNull(backupRuns.full_restore_verified_at)).orderBy(desc(backupRuns.full_restore_verified_at)).limit(1);
  return {
    enabled: settings.enabled,
    retentionDays: settings.retentionDays,
    running: !!runningTask,
    latest: latest ?? null,
    lastFullRestoreVerifiedAt: lastFullRestore?.verified_at ?? null,
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
      await writeFile(plain, '', { mode: 0o600, flag: 'wx' });
      const expected = await db.transaction(async (tx) => {
        const snapshot = await tx.execute(sql`SELECT pg_export_snapshot() AS snapshot`);
        const sanity = await readBackupSanity(tx);
        try {
          await execFileAsync('pg_dump', [
            '--format=custom', '--no-owner', '--no-privileges',
            '--snapshot', String(snapshot.rows[0].snapshot),
            '--dbname', String(process.env.DATABASE_URL),
            '--file', plain,
          ], { timeout: 30 * 60 * 1000, maxBuffer: 1024 * 1024 });
        } catch {
          throw new Error('PostgreSQL backup dump failed');
        }
        return sanity;
      }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
      if ((await stat(plain)).size <= 0) throw new Error('pg_dump produced an empty archive');
      await encryptBackupFile(plain, localTarget, settings.passphrase);
      await copyFile(localTarget, offsiteTarget);
      await decryptBackupFile(localTarget, plain, settings.passphrase);
      await verifyEncryptedBackup(offsiteTarget, settings.passphrase, {
        databaseUrl: String(process.env.DATABASE_URL), expected,
      });
      const size = (await stat(offsiteTarget)).size;
      if (size <= 0) throw new Error('Off-host backup copy is empty');
      const verifiedAt = new Date();
      await enforceRetention(settings.directory, settings.retentionDays);
      await enforceRetention(settings.offsiteDirectory, settings.retentionDays);
      await db
        .update(backupRuns)
        .set({ status: 'verified', size_bytes: size, verified_at: verifiedAt, full_restore_verified_at: verifiedAt })
        .where(eq(backupRuns.id, runId));
      const [result] = await db.select().from(backupRuns).where(eq(backupRuns.id, runId)).limit(1);
      notify('backup.created', {
        domain: 'Portal database', status: 'verified', detail: `Encrypted off-host backup full restore verified (${size} bytes)`,
        url: portalLink('/admin/operations'),
      });
      return result;
    } catch (err: any) {
      if (runId !== null) {
        await db
          .update(backupRuns)
          .set({ status: 'error', verified_at: null, full_restore_verified_at: null, detail: String(err?.message || err).slice(0, 1000) })
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
