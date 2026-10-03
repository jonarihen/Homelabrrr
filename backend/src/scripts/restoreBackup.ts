import { access, stat, unlink } from 'node:fs/promises';
import { decryptBackupFile, checkPostgresDumpToc } from '../utils/encryptedBackup.ts';

const [source, target] = process.argv.slice(2);
const passphrase = process.env.BACKUP_ENCRYPTION_KEY || '';
if (!source || !target) throw new Error('Usage: npm run restore-backup -- <backup.dump.enc> <restored.dump>');
if (passphrase.length < 32) throw new Error('BACKUP_ENCRYPTION_KEY must be set to the separate backup key');
try {
  await access(target);
  throw new Error(`Refusing to overwrite existing restore target: ${target}`);
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
}
try {
  await decryptBackupFile(source, target, passphrase);
  await checkPostgresDumpToc(target);
  const size = (await stat(target)).size;
  process.stdout.write(`Decrypted, TOC-checked pg_dump archive written to ${target} (${size} bytes); full restore not verified\n`);
  process.stdout.write('Restore it into a NEW database with:\n');
  process.stdout.write(`  pg_restore --no-owner --dbname=<new-database-url> ${target}\n`);
} catch (err) {
  await unlink(target).catch(() => {});
  throw err;
}
