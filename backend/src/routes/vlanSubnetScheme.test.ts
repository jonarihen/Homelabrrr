import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { createTestDatabase, type TestDatabase } from '../testUtils/pgTestDb.ts';
import { users, firewalls, vlans, firewallVlanSync, workflows } from '../db/schema/index.ts';
import { FortiGateAPI } from '../fortigate.ts';

// #315: policies, the VLAN list and the subnet helper must follow the
// firewall's configurable subnet first octet, like VLAN sync does.

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
    .values({ username: 'subnet-admin', password: 'x', is_admin: true })
    .returning({ id: users.id });
  const [fw] = await testDb.db.insert(firewalls)
    .values({ name: 'fw-172', host: '192.168.100.1', api_key: 'k', vdom: 'lab', verify_tls: false })
    .returning({ id: firewalls.id });
  firewallId = fw.id;
  await testDb.db.insert(workflows).values({
    firewall_id: firewallId, trigger: 'vlan_provision', name: 'VLAN provision', settings: { subnet: { firstOctet: 172 } },
  });
  const [src] = await testDb.db.insert(vlans).values({ name: 'src', tag: 1126, mode: 'managed' }).returning({ id: vlans.id });
  const [dst] = await testDb.db.insert(vlans).values({ name: 'dst', tag: 1127, mode: 'managed' }).returning({ id: vlans.id });
  await testDb.db.insert(vlans).values({ name: 'unsynced', tag: 1128, mode: 'managed' });
  await testDb.db.insert(firewallVlanSync).values([
    { firewall_id: firewallId, vlan_id: src.id, interface_name: 'vlan1126' },
    { firewall_id: firewallId, vlan_id: dst.id, interface_name: 'vlan1127' },
  ]);

  const adminRouter = (await import('./admin.ts')).default;
  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { userId: admin.id, username: 'subnet-admin', isAdmin: true, reauthenticatedAt: Date.now() } as never;
    next();
  });
  app.use('/', adminRouter);
});

after(async () => {
  await closeDb?.();
  await testDb.drop();
});

test('POST /policies builds address objects on the firewall subnet scheme', async (t) => {
  const created: string[] = [];
  t.mock.method(FortiGateAPI.prototype, 'getAddressObject', async () => null);
  t.mock.method(FortiGateAPI.prototype, 'createAddressObject', async (name: string, subnet: string) => {
    created.push(`${name}=${subnet}`);
  });
  // A duplicate policy stops the request before the workflow runs.
  t.mock.method(FortiGateAPI.prototype, 'getPolicies', async () => [
    { policyid: 7, srcintf: [{ name: 'vlan1126' }], dstintf: [{ name: 'vlan1127' }] },
  ]);

  const res = await request(app).post('/policies').send({ firewallId, srcVlanTag: 1126, dstVlanTag: 1127 });
  assert.equal(res.status, 409);
  assert.deepEqual(created, [
    'NET-172.11.26.0_24=172.11.26.0 255.255.255.0',
    'NET-172.11.27.0_24=172.11.27.0 255.255.255.0',
  ]);
});

test('GET /vlans shows synced VLANs on their firewall scheme and unsynced on the default', async () => {
  const res = await request(app).get('/vlans');
  assert.equal(res.status, 200);
  const byTag = Object.fromEntries(res.body.map((v: any) => [v.tag, v.subnet?.network]));
  assert.equal(byTag[1126], '172.11.26.0/24');
  assert.equal(byTag[1128], '10.11.28.0/24');
});

test('GET /vlans/subnet/:tag honours an optional firewallId', async () => {
  assert.equal((await request(app).get('/vlans/subnet/1126')).body.network, '10.11.26.0/24');
  assert.equal((await request(app).get(`/vlans/subnet/1126?firewallId=${firewallId}`)).body.network, '172.11.26.0/24');
});
