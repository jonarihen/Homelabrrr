import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase } from '../testUtils/pgTestDb.ts';
import { eloverblikConnections } from '../db/schema/index.ts';

const fixture = await createTestDatabase();
process.env.DATABASE_URL = fixture.url;
process.env.SECRET_ENCRYPTION_KEY = '66'.repeat(32);
const { manualSyncSelectedMeter } = await import('./eloverblik.ts');
const { closeDb } = await import('../db/client.ts');
test.after(async () => { await closeDb(); await fixture.drop(); });

test('manual meter resync is rate-limited by durable last-attempt time', async () => {
  const now = new Date('2026-10-08T15:00:00Z');
  await fixture.db.insert(eloverblikConnections).values({
    id: 1, enabled: false, last_attempt_at: new Date(now.getTime() - 90_000),
  });
  await assert.rejects(manualSyncSelectedMeter(now), (err: any) => {
    assert.equal(err.code, 'RATE_LIMIT');
    assert.equal(err.retryAfterMs, 210_000);
    return true;
  });
  assert.deepEqual(await manualSyncSelectedMeter(new Date(now.getTime() + 5 * 60_000)), { status: 'disabled' });
});
