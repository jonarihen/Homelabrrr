import { access, stat, unlink } from 'node:fs/promises';
import { decryptBackupFile, verifyPostgresDump } from '../utils/encryptedBackup.ts';

// Decrypt and verify an encrypted Homelabrrr backup into a plain pg_dump
// custom-format archive. The operator then loads it with pg_restore, e.g.
//   createdb homelabrrr_restored
//   pg_restore --no-owner --dbname=postgres://.../homelabrrr_restored restored.dump
// (restore into a NEW database, never over a live one).
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
  await verifyPostgresDump(target);
  const size = (await stat(target)).size;
  process.stdout.write(`Verified pg_dump archive written to ${target} (${size} bytes)\n`);
  process.stdout.write('Restore it into a NEW database with:\n');
  process.stdout.write(`  pg_restore --no-owner --dbname=<new-database-url> ${target}\n`);
} catch (err) {
  await unlink(target).catch(() => {});
  throw err;
}
