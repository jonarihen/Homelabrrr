import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { and, eq } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '../testUtils/pgTestDb.ts';
import { users, firewalls, vlans, firewallVlanSync, workflows } from '../db/schema/index.ts';
import { FortiGateAPI } from '../fortigate.ts';

// #316: the workflow `enabled` toggle must actually stop the workflow, and
// never-run delete triggers must not be offered.

let testDb: TestDatabase;
let app: express.Express;
let closeDb: (() => Promise<void>) | undefined;
let firewallId: number;

before(async () => {
  testDb = await createTestDatabase();
  process.env.DATABASE_URL = testDb.url;
  process.env.SECRET_ENCRYPTION_KEY ||= '55'.repeat(32);
  ({ closeDb } = await import('../db/client.ts'));

  const [admin] = await testDb.db.insert(users)
    .values({ username: 'wf-admin', password: 'x', is_admin: true })
    .returning({ id: users.id });
  const [fw] = await testDb.db.insert(firewalls)
    .values({ name: 'fw-wf', host: '192.168.100.1', api_key: 'k', vdom: 'lab', verify_tls: false })
    .returning({ id: firewalls.id });
  firewallId = fw.id;
  const [src] = await testDb.db.insert(vlans).values({ name: 'src', tag: 1126, mode: 'managed' }).returning({ id: vlans.id });
  const [dst] = await testDb.db.insert(vlans).values({ name: 'dst', tag: 1127, mode: 'managed' }).returning({ id: vlans.id });
  await testDb.db.insert(firewallVlanSync).values([
    { firewall_id: firewallId, vlan_id: src.id, interface_name: 'vlan1126' },
    { firewall_id: firewallId, vlan_id: dst.id, interface_name: 'vlan1127' },
  ]);

  const adminRouter = (await import('./admin.ts')).default;
  const workflowsRouter = (await import('./workflows.ts')).default;
  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { userId: admin.id, username: 'wf-admin', isAdmin: true, reauthenticatedAt: Date.now() } as never;
    next();
  });
  app.use('/workflows', workflowsRouter);
  app.use('/', adminRouter);
});

after(async () => {
  await closeDb?.();
  await testDb.drop();
});

test('workflow listing hides legacy rows for the removed delete triggers', async () => {
  // Seeded by older versions; they never ran.
  await testDb.db.insert(workflows).values({ firewall_id: firewallId, trigger: 'policy_delete', name: 'Default: Policy — delete' });

  const res = await request(app).get('/workflows').query({ firewallId });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.map((w: any) => w.trigger).sort(), ['policy_create', 'port_forward_create', 'vlan_provision']);

  const catalog = await request(app).get('/workflows/catalog');
  assert.deepEqual(catalog.body.triggers.map((t: any) => t.trigger), ['vlan_provision', 'port_forward_create', 'policy_create']);
});

test('POST /policies answers 409 and creates no policy when policy_create is disabled', async (t) => {
  await testDb.db.update(workflows).set({ enabled: false })
    .where(and(eq(workflows.firewall_id, firewallId), eq(workflows.trigger, 'policy_create')));
  t.mock.method(FortiGateAPI.prototype, 'getAddressObject', async () => ({ name: 'exists' }));
  t.mock.method(FortiGateAPI.prototype, 'getPolicies', async () => []);
  const createPolicy = t.mock.method(FortiGateAPI.prototype, 'createPolicy', async () => ({ mkey: 1 }));

  const res = await request(app).post('/policies').send({ firewallId, srcVlanTag: 1126, dstVlanTag: 1127 });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /disabled/);
  assert.equal(createPolicy.mock.callCount(), 0);
});
