// Run with:  node --test src/services/provisionFailure.test.ts   (from backend/)
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '../testUtils/pgTestDb.ts';
import { users, provisionedVms } from '../db/schema/index.ts';

let testDb: TestDatabase;
let closeDb: (() => Promise<void>) | undefined;
let userId: number;

before(async () => {
  testDb = await createTestDatabase();
  process.env.DATABASE_URL = testDb.url;
  process.env.SECRET_ENCRYPTION_KEY ||= '77'.repeat(32);
  ({ closeDb } = await import('../db/client.ts'));
  [{ id: userId }] = await testDb.db.insert(users).values({ username: 'prov-fail', password: 'x' }).returning({ id: users.id });
});

after(async () => {
  await closeDb?.();
  await testDb.drop();
});

const insertRow = async (status: string, status_detail = '') => (await testDb.db.insert(provisionedVms)
  .values({ user_id: userId, node: '1~pve1', vmid: 100, name: 'vm', status, status_detail })
  .returning({ id: provisionedVms.id }))[0].id;
const readRow = async (id: number) => (await testDb.db.select().from(provisionedVms).where(eq(provisionedVms.id, id)))[0];

test('an escaped background error moves an in-progress row to needs_review with the cause', async () => {
  const { recordBackgroundProvisionFailure } = await import('./provisionFailure.ts');
  const id = await insertRow('creating');
  await recordBackgroundProvisionFailure(id, 100, 'provision_test_failed', new Error('tag sync exploded'));
  const row = await readRow(id);
  assert.equal(row.status, 'needs_review');
  assert.match(row.status_detail, /tag sync exploded/);
});

test('a status already set by an inner handler is left alone', async () => {
  const { recordBackgroundProvisionFailure } = await import('./provisionFailure.ts');
  for (const [status, detail] of [['needs_review', 'Cloud-init configuration failed'], ['ready', ''], ['error', 'Task failed']]) {
    const id = await insertRow(status, detail);
    await recordBackgroundProvisionFailure(id, 100, 'provision_test_failed', new Error('late failure'));
    const row = await readRow(id);
    assert.equal(row.status, status);
    assert.equal(row.status_detail, detail);
  }
});
