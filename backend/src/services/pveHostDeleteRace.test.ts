import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase } from '../testUtils/pgTestDb.ts';
import { pveHosts } from '../db/schema/index.ts';

test('concurrent deletes cannot remove the last host', async () => {
  const t = await createTestDatabase();
  // pveHostLifecycle imports the shared pool from db/client.ts, which reads
  // DATABASE_URL at module-eval time — point it at the throwaway database and
  // import lazily so the functions run against the same physical database our
  // fixtures write to.
  process.env.DATABASE_URL = t.url;
  const { deletePveHost } = await import('./pveHostLifecycle.ts');
  try {
    const mk = (name: string) => t.db
      .insert(pveHosts)
      .values({ name, host: `${name}.invalid`, token_id: 'id', token_secret: 'secret' })
      .returning({ id: pveHosts.id });
    const [a] = await mk('race-a');
    const [b] = await mk('race-b');

    const outcomes = await Promise.allSettled([deletePveHost(a.id), deletePveHost(b.id)]);
    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter((o) => o.status === 'rejected');
    assert.equal(fulfilled.length, 1, 'exactly one of the racing deletes must win');
    assert.equal(rejected.length, 1);
    assert.equal((rejected[0] as PromiseRejectedResult).reason?.code, 'PVE_LAST_HOST');

    const remaining = await t.db.select({ id: pveHosts.id }).from(pveHosts);
    assert.equal(remaining.length, 1);
  } finally {
    await t.drop();
  }
});
