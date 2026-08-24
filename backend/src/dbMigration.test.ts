import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';

const KEY = '33'.repeat(32);

function importDatabase(path, { bootstrap = false } = {}) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    const { default: db } = await import('./src/scripts/legacySqliteDb.ts');
    const migrations = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((row) => row.version);
    assert.deepEqual(migrations, [2026080400, 2026080401, 2026080402, 2026080403]);
    assert.equal(db.pragma('quick_check', { simple: true }), 'ok');
    db.close();
  `], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      DB_PATH: path,
      SECRET_ENCRYPTION_KEY: KEY,
      SESSION_SECRET: 'migration-test-session-secret-is-long-enough',
      ...(bootstrap ? {
        INITIAL_ADMIN_USERNAME: 'migration-admin',
        INITIAL_ADMIN_PASSWORD: 'migration-password-strong',
      } : {
        INITIAL_ADMIN_USERNAME: '',
        INITIAL_ADMIN_PASSWORD: '',
      }),
    },
  });
}

test('ordered migrations create a fresh database once and reopen idempotently', () => {
  const directory = mkdtempSync(join(tmpdir(), 'homelabrrr-migration-'));
  try {
    const path = join(directory, 'database.sqlite');
    const first = importDatabase(path, { bootstrap: true });
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const second = importDatabase(path);
    assert.equal(second.status, 0, second.stderr || second.stdout);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a legacy database without migration metadata is adopted without losing users', () => {
  const directory = mkdtempSync(join(tmpdir(), 'homelabrrr-legacy-'));
  try {
    const path = join(directory, 'database.sqlite');
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        is_admin INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      );
      INSERT INTO users (username, password, is_admin) VALUES ('existing-admin', 'preserved-hash', 1);
    `);
    legacy.close();
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      const { default: db } = await import('./src/scripts/legacySqliteDb.ts');
      assert.equal(db.prepare("SELECT password FROM users WHERE username = 'existing-admin'").get().password, 'preserved-hash');
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count, 4);
      db.close();
    `], {
      cwd: process.cwd(), encoding: 'utf8', env: {
        ...process.env,
        DB_PATH: path,
        SECRET_ENCRYPTION_KEY: KEY,
        SESSION_SECRET: 'migration-test-session-secret-is-long-enough',
        INITIAL_ADMIN_USERNAME: '',
        INITIAL_ADMIN_PASSWORD: '',
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('corrupt SQLite input stops startup instead of being mistaken for an applied migration', () => {
  const directory = mkdtempSync(join(tmpdir(), 'homelabrrr-corrupt-'));
  try {
    const path = join(directory, 'database.sqlite');
    writeFileSync(path, 'this is not a sqlite database');
    const result = importDatabase(path, { bootstrap: true });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /database|sqlite|file is not a database/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('restart moves interrupted operations with and without UPIDs into manual reconciliation', () => {
  const directory = mkdtempSync(join(tmpdir(), 'homelabrrr-reconcile-'));
  const path = join(directory, 'database.sqlite');
  try {
    const first = spawnSync(process.execPath, ['--input-type=module', '-e', `
      const { default: db } = await import('./src/scripts/legacySqliteDb.ts');
      const user = db.prepare('SELECT id FROM users LIMIT 1').get();
      db.prepare("INSERT INTO provisioned_vms (user_id, node, vmid, name, status, upid) VALUES (?, '1~pve', 301, 'with-upid', 'creating', 'UPID:test')").run(user.id);
      db.prepare("INSERT INTO provisioned_vms (user_id, node, vmid, name, status, upid) VALUES (?, '1~pve', 302, 'without-upid', 'configuring', '')").run(user.id);
      db.prepare("INSERT INTO vm_migrations (user_id, vmid, source_node, target_node, status, upid) VALUES (?, 303, '1~pve', '2~pve', 'running', '')").run(user.id);
      db.close();
    `], {
      cwd: process.cwd(), encoding: 'utf8', env: {
        ...process.env,
        DB_PATH: path,
        SECRET_ENCRYPTION_KEY: KEY,
        SESSION_SECRET: 'migration-test-session-secret-is-long-enough',
        INITIAL_ADMIN_USERNAME: 'migration-admin',
        INITIAL_ADMIN_PASSWORD: 'migration-password-strong',
      },
    });
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const second = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      const { default: db } = await import('./src/scripts/legacySqliteDb.ts');
      assert.deepEqual(db.prepare("SELECT status FROM provisioned_vms WHERE vmid IN (301, 302) ORDER BY vmid").all(), [{ status: 'needs_review' }, { status: 'needs_review' }]);
      assert.equal(db.prepare('SELECT status FROM vm_migrations WHERE vmid = 303').get().status, 'needs_review');
      db.close();
    `], {
      cwd: process.cwd(), encoding: 'utf8', env: {
        ...process.env,
        DB_PATH: path,
        SECRET_ENCRYPTION_KEY: KEY,
        SESSION_SECRET: 'migration-test-session-secret-is-long-enough',
        INITIAL_ADMIN_USERNAME: '',
        INITIAL_ADMIN_PASSWORD: '',
      },
    });
    assert.equal(second.status, 0, second.stderr || second.stdout);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
