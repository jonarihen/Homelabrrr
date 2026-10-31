// waitForTask retries transient poll errors but surfaces them once they have
// persisted for maxErrorMs, instead of swallowing them for the full timeout (#283).
// Run with:  node --test src/proxmoxWaitForTask.test.ts   (from backend/)
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase, type TestDatabase } from './testUtils/pgTestDb.ts';
import { pveHosts } from './db/schema/index.ts';

let testDb: TestDatabase;
let closeDb: (() => Promise<void>) | undefined;
let hostId: number;

before(async () => {
  testDb = await createTestDatabase();
  process.env.DATABASE_URL = testDb.url;
  process.env.SECRET_ENCRYPTION_KEY ||= '66'.repeat(32);
  ({ closeDb } = await import('./db/client.ts'));
  const { encryptSecret } = await import('./utils/secrets.ts');
  // Port 1 on loopback refuses every connection, so each status poll fails fast.
  [{ id: hostId }] = await testDb.db.insert(pveHosts).values({
    name: 'dead', host: '127.0.0.1', port: 1, token_id: 'root@pam!t', token_secret: encryptSecret('s'),
  }).returning({ id: pveHosts.id });
});

after(async () => {
  await closeDb?.();
  await testDb.drop();
});

test('persistent poll errors end the wait with the underlying error', async () => {
  const { waitForTask } = await import('./proxmox.ts');
  const started = Date.now();
  await assert.rejects(
    waitForTask(`${hostId}~pve1`, 'UPID:pve1:00000001:00000001:00000001:qmstart:100:root@pam:', { intervalMs: 20, maxErrorMs: 200 }),
    /Lost track of Proxmox task.*ECONNREFUSED|Lost track of Proxmox task/,
  );
  assert.ok(Date.now() - started < 5000, 'gave up long before the task timeout');
});
