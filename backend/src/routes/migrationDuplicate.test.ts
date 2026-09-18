import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase } from '../testUtils/pgTestDb.ts';
import { vmMigrations } from '../db/schema/index.ts';
import { isUniqueViolation } from '../db/errors.ts';

test('two concurrent running migrations for one VM collapse to a single row', async () => {
  const t = await createTestDatabase();
  try {
    const insert = () => t.db.insert(vmMigrations).values({
      user_id: 1,
      vmid: 101,
      source_node: '1~pve1',
      target_node: '2~pve2',
      status: 'running',
    });
    const outcomes = await Promise.allSettled([insert(), insert()]);
    const won = outcomes.filter((o) => o.status === 'fulfilled');
    const lost = outcomes.filter((o) => o.status === 'rejected');
    assert.equal(won.length, 1, 'exactly one racing migration insert must win');
    assert.equal(lost.length, 1);
    assert.equal(
      isUniqueViolation((lost[0] as PromiseRejectedResult).reason),
      true,
      'the loser must fail with a unique violation, which the route answers as 409',
    );

    const finished = await t.db.insert(vmMigrations).values({
      user_id: 1,
      vmid: 101,
      source_node: '1~pve1',
      target_node: '2~pve2',
      status: 'ok',
    }).returning({ id: vmMigrations.id });
    assert.equal(finished.length, 1, 'finished history rows must never trip the guard');
  } finally {
    await t.drop();
  }
});
