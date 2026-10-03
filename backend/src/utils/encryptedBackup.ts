import crypto from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { appendFile, open, unlink, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { readBackupSanity, type BackupSanity } from './backupSanity.ts';

const execFileAsync = promisify(execFile);
const MAGIC = Buffer.from('HOMELABRRR-BACKUP-V1\n');

export async function encryptBackupFile(source, target, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(passphrase, salt, 32);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const header = Buffer.concat([MAGIC, salt, iv]);
  await writeFile(target, header, { mode: 0o600 });
  await pipeline(createReadStream(source), cipher, createWriteStream(target, { flags: 'a', mode: 0o600 }));
  await appendFile(target, cipher.getAuthTag());
}

export async function decryptBackupFile(source, target, passphrase) {
  const handle = await open(source, 'r');
  let size;
  let prefix;
  let tag;
  try {
    size = (await handle.stat()).size;
    if (size < MAGIC.length + 28 + 16) throw new Error('Backup is truncated');
    prefix = Buffer.alloc(MAGIC.length + 28);
    await handle.read(prefix, 0, prefix.length, 0);
    tag = Buffer.alloc(16);
    await handle.read(tag, 0, 16, size - 16);
  } finally { await handle.close(); }
  if (!prefix.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Backup format is not recognized');
  const salt = prefix.subarray(MAGIC.length, MAGIC.length + 16);
  const iv = prefix.subarray(MAGIC.length + 16, MAGIC.length + 28);
  const key = crypto.scryptSync(passphrase, salt, 32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  await pipeline(
    createReadStream(source, { start: prefix.length, end: size - 17 }),
    decipher,
    createWriteStream(target, { mode: 0o600 }),
  );
}

export async function checkPostgresDumpToc(path: string): Promise<void> {
  let toc: string;
  try {
    const { stdout } = await execFileAsync('pg_restore', ['--list', path], { maxBuffer: 64 * 1024 * 1024 });
    toc = stdout;
  } catch (err) {
    throw new Error(`Backup archive is not a readable pg_dump: ${(err as Error).message}`);
  }
  if (!/\bschema_migrations\b/.test(toc)) {
    throw new Error('Backup archive is missing the schema_migrations table — it is not a Homelabrrr database dump');
  }
}

export type RestoreVerificationOptions = {
  databaseUrl: string;
  expected?: BackupSanity;
};

export async function verifyPostgresDump(path: string, options: RestoreVerificationOptions): Promise<BackupSanity> {
  await checkPostgresDumpToc(path);
  const name = `homelabrrr_verify_${crypto.randomBytes(16).toString('hex')}`;
  const targetUrl = new URL(options.databaseUrl);
  targetUrl.pathname = `/${name}`;
  targetUrl.searchParams.delete('dbname');
  targetUrl.searchParams.delete('database');
  const admin = new pg.Client({ connectionString: options.databaseUrl, connectionTimeoutMillis: 10_000, statement_timeout: 30_000 });
  let created = false;
  let phase = 'connect to PostgreSQL';
  try {
    await admin.connect();
    phase = 'create disposable database (the backup role needs CREATEDB)';
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
    created = true;
    await admin.query(`REVOKE CONNECT ON DATABASE "${name}" FROM PUBLIC`);
    phase = 'restore archive data';
    await execFileAsync('pg_restore', [
      '--exit-on-error', '--single-transaction', '--no-owner', '--no-privileges',
      '--dbname', targetUrl.toString(), path,
    ], { timeout: 30 * 60 * 1000, maxBuffer: 1024 * 1024 });
    phase = 'check restored migrations and critical table row counts';
    const restored = new pg.Client({ connectionString: targetUrl.toString(), connectionTimeoutMillis: 10_000, query_timeout: 60_000 });
    let sanity: BackupSanity;
    try {
      await restored.connect();
      sanity = await readBackupSanity(drizzle(restored));
    } finally {
      await restored.end();
    }
    if (options.expected) {
      for (const table of Object.keys(options.expected) as (keyof BackupSanity)[]) {
        if (sanity[table] !== options.expected[table]) {
          throw new Error('Restored row count differs from the dump snapshot');
        }
      }
    }
    return sanity;
  } catch {
    throw new Error(`Full backup restore verification failed: could not ${phase}`);
  } finally {
    await admin.end().catch(() => {});
    if (created) {
      const cleaner = new pg.Client({ connectionString: options.databaseUrl, connectionTimeoutMillis: 10_000, statement_timeout: 30_000 });
      try {
        await cleaner.connect();
        await cleaner.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      } catch {
        throw new Error(`Full backup restore verification failed: could not drop disposable database ${name}; administrator cleanup required`);
      } finally {
        await cleaner.end();
      }
    }
  }
}

export async function verifyEncryptedBackup(path: string, passphrase: string, options: RestoreVerificationOptions): Promise<BackupSanity> {
  const temp = join(tmpdir(), `homelabrrr-verify-${crypto.randomUUID()}.dump`);
  try {
    await decryptBackupFile(path, temp, passphrase);
    return await verifyPostgresDump(temp, options);
  } finally { await unlink(temp).catch(() => {}); }
}
