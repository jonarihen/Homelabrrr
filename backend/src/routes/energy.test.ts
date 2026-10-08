import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { createTestDatabase, type TestDatabase } from '../testUtils/pgTestDb.ts';
import { hardwareConnections, pveHosts, users } from '../db/schema/index.ts';

let fixture: TestDatabase;
let closeDb: () => Promise<void>;
let app: express.Express;
let memberId: number;

before(async () => {
  fixture = await createTestDatabase();
  process.env.DATABASE_URL = fixture.url;
  process.env.SECRET_ENCRYPTION_KEY ||= '55'.repeat(32);
  ({ closeDb } = await import('../db/client.ts'));
  const [member] = await fixture.db.insert(users).values({ username: 'energy-member', password: 'fixture', is_admin: false }).returning();
  memberId = member.id;
  const [host] = await fixture.db.insert(pveHosts).values({ name: 'private-cluster', host: 'pve-private.internal', token_id: 'private-token-id', token_secret: 'private-token-secret' }).returning();
  await fixture.db.insert(hardwareConnections).values({ pve_host_id: host.id, node_ref: `${host.id}~private-node`,
    target_host: 'ilo-private.internal', username: 'private-operator', secret: 'private-ilo-secret' });
  app = express();
  app.use((req, _res, next) => {
    const kind = req.header('x-test-session');
    if (kind) req.session = { userId: memberId, isAdmin: false } as never;
    if (kind === 'token') req.apiToken = { id: 1 } as never;
    next();
  });
  app.use('/', (await import('./energy.ts')).default);
});
after(async () => { await closeDb?.(); await fixture?.drop(); });

test('private energy routes reject anonymous and machine-token reads', async () => {
  for (const path of ['/summary', '/history', '/hosts']) {
    assert.equal((await request(app).get(path)).status, 401);
    assert.equal((await request(app).get(path).set('x-test-session', 'token')).status, 403);
  }
});

test('member responses are no-store aggregates without management identifiers', async () => {
  for (const path of ['/summary?month=2026-10', '/history?range=24h', '/hosts']) {
    const response = await request(app).get(path).set('x-test-session', 'member');
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.match(response.headers['cache-control'], /private, no-store/);
    assert.doesNotMatch(JSON.stringify(response.body), /pve-private|ilo-private|private-node|private-operator|private-token|private-ilo-secret|payer_email|contributor_id|selected_meter_id/i);
  }
});
