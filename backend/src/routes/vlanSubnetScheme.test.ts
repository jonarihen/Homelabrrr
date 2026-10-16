import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '../testUtils/pgTestDb.ts';
import { users, firewalls, vlans, firewallVlanSync, workflows } from '../db/schema/index.ts';
import { FortiGateAPI } from '../fortigate.ts';

// #315: policies and the VLAN list must use the subnet each firewall sync
// actually provisioned (recorded in firewall_vlan_sync.subnet_cidr), and the
// subnet helper previews the firewall's configured first octet.

let testDb: TestDatabase;
let app: express.Express;
let closeDb: (() => Promise<void>) | undefined;
let firewallId: number;
let legacyFirewallId: number;

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
    // Changed after the VLANs below were provisioned on 172: must not move them.
    firewall_id: firewallId, trigger: 'vlan_provision', name: 'VLAN provision', settings: { subnet: { firstOctet: 192 } },
  });
  const [legacyFw] = await testDb.db.insert(firewalls)
    .values({ name: 'fw-legacy', host: '192.168.100.2', api_key: 'k', vdom: 'lab', verify_tls: false })
    .returning({ id: firewalls.id });
  legacyFirewallId = legacyFw.id;
  const [src] = await testDb.db.insert(vlans).values({ name: 'src', tag: 1126, mode: 'managed' }).returning({ id: vlans.id });
  const [dst] = await testDb.db.insert(vlans).values({ name: 'dst', tag: 1127, mode: 'managed' }).returning({ id: vlans.id });
  await testDb.db.insert(vlans).values({ name: 'unsynced', tag: 1128, mode: 'managed' });
  await testDb.db.insert(firewallVlanSync).values([
    { firewall_id: firewallId, vlan_id: src.id, interface_name: 'vlan1126', subnet_cidr: '172.11.26.0/24' },
    { firewall_id: firewallId, vlan_id: dst.id, interface_name: 'vlan1127', subnet_cidr: '172.11.27.0/24' },
    // Synced before the subnet was recorded → default scheme.
    { firewall_id: legacyFirewallId, vlan_id: src.id, interface_name: 'vlan1126' },
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

test('POST /policies builds address objects for the provisioned subnets', async (t) => {
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

test('GET /vlans returns the provisioned subnet per synced firewall', async () => {
  const res = await request(app).get('/vlans');
  assert.equal(res.status, 200);
  const byTag = Object.fromEntries(res.body.map((v: any) => [v.tag, v]));
  assert.deepEqual(byTag[1126].firewallSync.map((s: any) => [s.firewallId, s.subnet]), [
    [firewallId, '172.11.26.0/24'],
    [legacyFirewallId, '10.11.26.0/24'],
  ]);
  assert.equal(byTag[1126].subnet.network, '172.11.26.0/24');
  assert.equal(byTag[1126].subnet.gateway, '172.11.26.1');
  assert.equal(byTag[1128].subnet.network, '10.11.28.0/24');
});

test('GET /vlans/subnet/:tag previews the firewall scheme with an optional firewallId', async () => {
  assert.equal((await request(app).get('/vlans/subnet/1126')).body.network, '10.11.26.0/24');
  assert.equal((await request(app).get(`/vlans/subnet/1126?firewallId=${firewallId}`)).body.network, '192.11.26.0/24');
});

test('syncedSubnet rebuilds the full recorded /24, not one derived from the current tag', async () => {
  const { syncedSubnet } = await import('../workflows/subnet.ts');
  const subnet = syncedSubnet(1200, '172.11.26.0/24');
  assert.equal(subnet.network, '172.11.26.0/24');
  assert.equal(subnet.gateway, '172.11.26.1');
  assert.equal(syncedSubnet(1126, null).network, '10.11.26.0/24');
});

test('PUT /vlans/:id refuses a tag change while the VLAN is synced', async () => {
  const [src] = (await request(app).get('/vlans')).body.filter((v: any) => v.tag === 1126);
  const res = await request(app).put(`/vlans/${src.id}`).send({ name: src.name, tag: 1200 });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Unsync/);
});

test('VLAN sync records the subnet it provisioned in firewall_vlan_sync.subnet_cidr', async () => {
  const [fw] = await testDb.db.insert(firewalls)
    .values({ name: 'fw-sync', host: '192.168.100.3', api_key: 'k', vdom: 'lab', verify_tls: false })
    .returning({ id: firewalls.id });
  // A step-less workflow keeps FortiGate out of the test; the subnet comes from its settings.
  await testDb.db.insert(workflows).values({
    firewall_id: fw.id, trigger: 'vlan_provision', name: 'VLAN provision', settings: { subnet: { firstOctet: 172 } },
  });
  const [vlan] = await testDb.db.insert(vlans).values({ name: 'new', tag: 1301, mode: 'managed' }).returning({ id: vlans.id });

  const res = await request(app).post(`/vlans/${vlan.id}/sync`).send({ firewallId: fw.id });
  assert.equal(res.status, 200);
  assert.equal(res.body[0]?.status, 'ok', JSON.stringify(res.body));
  const [sync] = await testDb.db.select().from(firewallVlanSync).where(eq(firewallVlanSync.vlan_id, vlan.id));
  assert.equal(sync.subnet_cidr, '172.13.1.0/24');
});
