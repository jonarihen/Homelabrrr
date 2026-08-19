import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { count, eq } from 'drizzle-orm';
import { createTestDatabase } from '../testUtils/pgTestDb.ts';
import { buildFixtureSqlite } from '../scripts/sqliteFixture.ts';
import { users, settings } from './schema/index.ts';

// The fixture module bootstraps its SQLite with this key; the importer copies
// encrypted columns verbatim, so initDatabase must run under the same key.
const FIXTURE_KEY = '33'.repeat(32);

test('initDatabase auto-imports a legacy db.sqlite once and is idempotent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'homelabrrr-autoimport-'));
  const sqlitePath = join(dir, 'db.sqlite');
  const t = await createTestDatabase();
  const prevEnv = { ...process.env };
  try {
    buildFixtureSqlite(sqlitePath);

    process.env.DATABASE_URL = t.url;
    process.env.DB_PATH = sqlitePath;
    process.env.SECRET_ENCRYPTION_KEY = FIXTURE_KEY;
    process.env.SESSION_SECRET = 'auto-import-test-session-secret-long';
    delete process.env.INITIAL_ADMIN_USERNAME;
    delete process.env.INITIAL_ADMIN_PASSWORD;

    // Fresh import of init.ts so it binds the test DATABASE_URL.
    const { initDatabase } = await import(`./init.ts?autoimport=${Date.now()}`);
    await initDatabase();

    const [{ c: userCount }] = await t.db.select({ c: count() }).from(users);
    assert.ok(userCount >= 3, `expected the fixture users to be imported, got ${userCount}`);
    const [flag] = await t.db.select({ value: settings.value }).from(settings).where(eq(settings.key, 'sqlite_auto_import')).limit(1);
    assert.ok(flag, 'the auto-import flag should be set');
    assert.match(flag.value, /"rows":\s*\d+/);

    // A second run must not re-import or duplicate rows.
    await initDatabase();
    const [{ c: afterSecond }] = await t.db.select({ c: count() }).from(users);
    assert.equal(afterSecond, userCount, 'a second initDatabase must not re-import');
  } finally {
    Object.assign(process.env, prevEnv);
    for (const k of Object.keys(process.env)) if (!(k in prevEnv)) delete process.env[k];
    rmSync(dir, { recursive: true, force: true });
    await t.drop();
  }
});
