import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const OLD_KEY = '11'.repeat(32);
const NEW_KEY = '22'.repeat(32);

function runModule(code, env) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

test('versioned keyring decrypts legacy ciphertext, rotates it, and permits old-key retirement', () => {
  const oldCiphertext = runModule(
    "import { encryptSecret } from './src/utils/secrets.js'; process.stdout.write(encryptSecret('mixed-key-secret'));",
    { SECRET_ENCRYPTION_KEY_ID: 'old', SECRET_ENCRYPTION_KEY: OLD_KEY, SECRET_ENCRYPTION_PREVIOUS_KEYS: '' },
  );
  assert.match(oldCiphertext, /^enc:v2:old:/);

  const rotated = JSON.parse(runModule(
    "import { decryptSecret, encryptSecret, secretNeedsMigration } from './src/utils/secrets.js'; const old=process.env.VALUE; process.stdout.write(JSON.stringify({plain:decryptSecret(old),needs:secretNeedsMigration(old),next:encryptSecret(decryptSecret(old))}));",
    {
      SECRET_ENCRYPTION_KEY_ID: 'new',
      SECRET_ENCRYPTION_KEY: NEW_KEY,
      SECRET_ENCRYPTION_PREVIOUS_KEYS: JSON.stringify({ old: OLD_KEY }),
      VALUE: oldCiphertext,
    },
  ));
  assert.deepEqual({ plain: rotated.plain, needs: rotated.needs }, { plain: 'mixed-key-secret', needs: true });
  assert.match(rotated.next, /^enc:v2:new:/);

  const retiredPlaintext = runModule(
    "import { decryptSecret } from './src/utils/secrets.js'; process.stdout.write(decryptSecret(process.env.VALUE));",
    { SECRET_ENCRYPTION_KEY_ID: 'new', SECRET_ENCRYPTION_KEY: NEW_KEY, SECRET_ENCRYPTION_PREVIOUS_KEYS: '', VALUE: rotated.next },
  );
  assert.equal(retiredPlaintext, 'mixed-key-secret');
});

test('missing legacy keys fail closed without exposing plaintext', () => {
  const oldCiphertext = runModule(
    "import { encryptSecret } from './src/utils/secrets.js'; process.stdout.write(encryptSecret('do-not-print-me'));",
    { SECRET_ENCRYPTION_KEY_ID: 'old', SECRET_ENCRYPTION_KEY: OLD_KEY, SECRET_ENCRYPTION_PREVIOUS_KEYS: '' },
  );
  const message = runModule(
    "import { decryptSecret } from './src/utils/secrets.js'; try { decryptSecret(process.env.VALUE); } catch (error) { process.stdout.write(error.message); }",
    { SECRET_ENCRYPTION_KEY_ID: 'new', SECRET_ENCRYPTION_KEY: NEW_KEY, SECRET_ENCRYPTION_PREVIOUS_KEYS: '', VALUE: oldCiphertext },
  );
  assert.match(message, /unavailable key id old/);
  assert.doesNotMatch(message, /do-not-print-me/);
});

test('startup leaves previous-key v2 values pending for an explicit reviewed rotation', () => {
  const directory = mkdtempSync(join(tmpdir(), 'homelabrrr-keyring-plan-'));
  const databasePath = join(directory, 'rotation.sqlite');
  try {
    runModule(`
      const { default: db } = await import('./src/db.js');
      const { encryptSecret } = await import('./src/utils/secrets.js');
      const user = db.prepare('SELECT id FROM users LIMIT 1').get();
      db.prepare('INSERT INTO ssh_keys (user_id, name, private_key) VALUES (?, ?, ?)').run(user.id, 'pending-old', encryptSecret('review-before-rotation'));
      db.close();
    `, {
      DB_PATH: databasePath,
      INITIAL_ADMIN_USERNAME: 'rotation-admin',
      INITIAL_ADMIN_PASSWORD: 'rotation-password-strong',
      SESSION_SECRET: 'rotation-session-secret-that-is-long-enough',
      SECRET_ENCRYPTION_KEY_ID: 'old',
      SECRET_ENCRYPTION_KEY: OLD_KEY,
      SECRET_ENCRYPTION_PREVIOUS_KEYS: '',
    });
    runModule(`
      import assert from 'node:assert/strict';
      const { default: db, planEncryptedSecretRotation } = await import('./src/db.js');
      const stored = db.prepare("SELECT private_key FROM ssh_keys WHERE name = 'pending-old'").get().private_key;
      assert.match(stored, /^enc:v2:old:/);
      assert.deepEqual(
        { total: planEncryptedSecretRotation().total, decryptable: planEncryptedSecretRotation().decryptable },
        { total: 1, decryptable: 1 },
      );
      db.close();
    `, {
      DB_PATH: databasePath,
      INITIAL_ADMIN_USERNAME: '',
      INITIAL_ADMIN_PASSWORD: '',
      SESSION_SECRET: 'rotation-session-secret-that-is-long-enough',
      SECRET_ENCRYPTION_KEY_ID: 'new',
      SECRET_ENCRYPTION_KEY: NEW_KEY,
      SECRET_ENCRYPTION_PREVIOUS_KEYS: JSON.stringify({ old: OLD_KEY }),
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('database rotation rolls back every earlier update when one record is undecryptable', () => {
  const oldCiphertext = runModule(
    "import { encryptSecret } from './src/utils/secrets.js'; process.stdout.write(encryptSecret('transaction-secret'));",
    { SECRET_ENCRYPTION_KEY_ID: 'old', SECRET_ENCRYPTION_KEY: OLD_KEY, SECRET_ENCRYPTION_PREVIOUS_KEYS: '' },
  );
  const directory = mkdtempSync(join(tmpdir(), 'homelabrrr-keyring-'));
  try {
    runModule(`
      import assert from 'node:assert/strict';
      const { default: db, planEncryptedSecretRotation, rotateEncryptedSecrets } = await import('./src/db.js');
      const user = db.prepare('SELECT id FROM users LIMIT 1').get();
      db.prepare('INSERT INTO ssh_keys (user_id, name, private_key) VALUES (?, ?, ?)').run(user.id, 'good-old', process.env.OLD_VALUE);
      db.prepare('INSERT INTO ssh_keys (user_id, name, private_key) VALUES (?, ?, ?)').run(user.id, 'missing-key', process.env.OLD_VALUE.replace('enc:v2:old:', 'enc:v2:missing:'));
      assert.equal(planEncryptedSecretRotation().undecryptable, 1);
      assert.throws(() => rotateEncryptedSecrets());
      assert.equal(db.prepare("SELECT private_key FROM ssh_keys WHERE name = 'good-old'").get().private_key, process.env.OLD_VALUE);
      db.prepare("DELETE FROM ssh_keys WHERE name = 'missing-key'").run();
      rotateEncryptedSecrets();
      assert.match(db.prepare("SELECT private_key FROM ssh_keys WHERE name = 'good-old'").get().private_key, /^enc:v2:new:/);
      db.close();
    `, {
      DB_PATH: join(directory, 'rotation.sqlite'),
      INITIAL_ADMIN_USERNAME: 'rotation-admin',
      INITIAL_ADMIN_PASSWORD: 'rotation-password-strong',
      SESSION_SECRET: 'rotation-session-secret-that-is-long-enough',
      SECRET_ENCRYPTION_KEY_ID: 'new',
      SECRET_ENCRYPTION_KEY: NEW_KEY,
      SECRET_ENCRYPTION_PREVIOUS_KEYS: JSON.stringify({ old: OLD_KEY }),
      OLD_VALUE: oldCiphertext,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
