import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase } from '../testUtils/pgTestDb.ts';
import { users, pveHosts, vmAssignments } from '../db/schema/index.ts';

test('host deletion reports references, blocks them, and deletes a clean host', async () => {
  const t = await createTestDatabase();
  // pveHostLifecycle imports the shared pool from db/client.ts, which reads
  // DATABASE_URL at module-eval time — point it at the throwaway database and
  // import lazily so the functions run against the same physical database our
  // fixtures write to.
  process.env.DATABASE_URL = t.url;
  const { deletePveHost, pveHostDependencies } = await import('./pveHostLifecycle.ts');
  try {
    const [user] = await t.db
      .insert(users)
      .values({ username: 'host-admin', password: 'x' })
      .returning({ id: users.id });
    const [anchor] = await t.db
      .insert(pveHosts)
      .values({ name: 'anchor', host: 'anchor.invalid', token_id: 'id', token_secret: 'secret' })
      .returning({ id: pveHosts.id });
    const [host] = await t.db
      .insert(pveHosts)
      .values({ name: 'offline', host: 'offline.invalid', token_id: 'id', token_secret: 'secret' })
      .returning({ id: pveHosts.id });

    await t.db.insert(vmAssignments).values({ user_id: user.id, node: `${host.id}~node-a`, vmid: 100 });

    const report = await pveHostDependencies(host.id);
    assert.equal(report.total, 1);
    assert.equal(report.dependencies[0].table, 'vm_assignments');
    await assert.rejects(
      () => deletePveHost(host.id),
      (error: { code?: string }) => error.code === 'PVE_HOST_HAS_DEPENDENCIES',
    );

    await t.db.delete(vmAssignments);
    assert.equal(await deletePveHost(host.id), 1);
    await assert.rejects(
      () => deletePveHost(anchor.id),
      (error: { code?: string }) => error.code === 'PVE_LAST_HOST',
    );
  } finally {
    await t.drop();
  }
});
