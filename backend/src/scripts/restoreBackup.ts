import { access, unlink } from 'node:fs/promises';
import { decryptBackupFile, verifySqliteBackup } from '../utils/encryptedBackup.ts';

const [source, target] = process.argv.slice(2);
const passphrase = process.env.BACKUP_ENCRYPTION_KEY || '';
if (!source || !target) throw new Error('Usage: npm run restore-backup -- <backup.sqlite.enc> <restored.sqlite>');
if (passphrase.length < 32) throw new Error('BACKUP_ENCRYPTION_KEY must be set to the separate backup key');
try {
  await access(target);
  throw new Error(`Refusing to overwrite existing restore target: ${target}`);
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}
try {
  await decryptBackupFile(source, target, passphrase);
  verifySqliteBackup(target);
  process.stdout.write(`Verified SQLite restore written to ${target}\n`);
} catch (err) {
  await unlink(target).catch(() => {});
  throw err;
}
