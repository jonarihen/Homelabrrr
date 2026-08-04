import crypto from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { appendFile, open, unlink, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';

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

export function verifySqliteBackup(path) {
  const restored = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const result = restored.pragma('integrity_check', { simple: true });
    if (result !== 'ok') throw new Error(`Restored database integrity check failed: ${result}`);
    restored.prepare('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1').get();
  } finally { restored.close(); }
}

export async function verifyEncryptedBackup(path, passphrase) {
  const temp = join(tmpdir(), `homelabrrr-verify-${crypto.randomUUID()}.sqlite`);
  try {
    await decryptBackupFile(path, temp, passphrase);
    verifySqliteBackup(temp);
  } finally { await unlink(temp).catch(() => {}); }
}
