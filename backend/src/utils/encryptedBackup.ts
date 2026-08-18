import crypto from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { appendFile, open, unlink, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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

// Verify a pg_dump custom-format archive is intact and structurally sane by
// reading its table of contents (pg_restore --list rejects a corrupt archive
// and never touches a live database). Confirm the schema_migrations table is
// present so a truncated dump can't pass.
export async function verifyPostgresDump(path: string): Promise<void> {
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

export async function verifyEncryptedBackup(path: string, passphrase: string): Promise<void> {
  const temp = join(tmpdir(), `homelabrrr-verify-${crypto.randomUUID()}.dump`);
  try {
    await decryptBackupFile(path, temp, passphrase);
    await verifyPostgresDump(temp);
  } finally { await unlink(temp).catch(() => {}); }
}
