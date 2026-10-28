import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '../testUtils/pgTestDb.ts';
import { users, firewalls, vlans, firewallVlanSync, workflows, workflowSteps } from '../db/schema/index.ts';
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

async function firewallWithSteps(name: string, steps: unknown[], settings: unknown = {}) {
  const [fw] = await testDb.db.insert(firewalls)
    .values({ name, host: `${name}.example`, api_key: 'k', vdom: 'lab', verify_tls: false })
    .returning({ id: firewalls.id });
  const [wf] = await testDb.db.insert(workflows).values({ firewall_id: fw.id, trigger: 'vlan_provision', name: 'p', settings }).returning({ id: workflows.id });
  if (steps.length) {
    await testDb.db.insert(workflowSteps).values(steps.map((params, position) => ({
      workflow_id: wf.id, position, step_key: `iface${position}`, action: 'create_vlan_interface', params,
    })) as any);
  }
  return fw.id;
}

const ifaceStep = (vlanId: string, ip: string) => ({ name: `vlan${vlanId}`, vlanId, parentInterface: 'fortilink', ip, netmask: '255.255.255.0' });

test('GET /vlans/subnet/:tag previews what a sync to the firewall would record', async () => {
  assert.equal((await request(app).get('/vlans/subnet/1126')).body.network, '10.11.26.0/24');
  // Default-style step follows the firstOctet setting.
  const scheme = await firewallWithSteps('fw-preview-scheme', [ifaceStep('{{tag}}', '{{subnet.ip}}')], { subnet: { firstOctet: 192 } });
  const schemed = (await request(app).get(`/vlans/subnet/1126?firewallId=${scheme}`)).body;
  assert.equal(schemed.network, '192.11.26.0/24');
  assert.equal(schemed.recorded, true);
  // A customised step wins over the setting, exactly as the sync records it.
  const custom = await firewallWithSteps('fw-preview-custom', [ifaceStep('3999', '172.20.30.1'), ifaceStep('{{tag}}', '192.168.50.1')], { subnet: { firstOctet: 172 } });
  assert.equal((await request(app).get(`/vlans/subnet/1126?firewallId=${custom}`)).body.network, '192.168.50.0/24');
  // No interface step for the tag: nothing would be recorded, so the legacy default applies.
  const none = (await request(app).get(`/vlans/subnet/1126?firewallId=${firewallId}`)).body;
  assert.equal(none.network, '10.11.26.0/24');
  assert.equal(none.recorded, false);
  assert.equal((await request(app).get('/vlans/subnet/1126?firewallId=999999')).status, 404);
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

test('VLAN sync records no subnet when no interface step configured one', async () => {
  const [fw] = await testDb.db.insert(firewalls)
    .values({ name: 'fw-sync', host: '192.168.100.3', api_key: 'k', vdom: 'lab', verify_tls: false })
    .returning({ id: firewalls.id });
  // Step-less workflow: nothing was provisioned, so nothing may be recorded (readers → legacy default).
  await testDb.db.insert(workflows).values({
    firewall_id: fw.id, trigger: 'vlan_provision', name: 'VLAN provision', settings: { subnet: { firstOctet: 172 } },
  });
  const [vlan] = await testDb.db.insert(vlans).values({ name: 'new', tag: 1301, mode: 'managed' }).returning({ id: vlans.id });

  const res = await request(app).post(`/vlans/${vlan.id}/sync`).send({ firewallId: fw.id });
  assert.equal(res.body[0]?.status, 'ok', JSON.stringify(res.body));
  const [sync] = await testDb.db.select().from(firewallVlanSync).where(eq(firewallVlanSync.vlan_id, vlan.id));
  assert.equal(sync.subnet_cidr, null);
  // Nothing recorded: the response shows the legacy default readers use, labelled as such.
  assert.equal(res.body[0].subnet.network, '10.13.1.0/24');
  assert.equal(res.body[0].subnetRecorded, false);
});

test('VLAN sync records the subnet from the interface step output, not the setting', async (t) => {
  const [fw] = await testDb.db.insert(firewalls)
    .values({ name: 'fw-iface', host: '192.168.100.4', api_key: 'k', vdom: 'lab', verify_tls: false })
    .returning({ id: firewalls.id });
  // Setting says 172, but the customised interface step configures 192.168.50.1/24.
  const [wf] = await testDb.db.insert(workflows).values({
    firewall_id: fw.id, trigger: 'vlan_provision', name: 'VLAN provision', settings: { subnet: { firstOctet: 172 } },
  }).returning({ id: workflows.id });
  await testDb.db.insert(workflowSteps).values({
    workflow_id: wf.id, position: 0, step_key: 'iface', action: 'create_vlan_interface',
    params: { name: 'vlan{{tag}}', vlanId: '{{tag}}', parentInterface: 'fortilink', ip: '192.168.50.1', netmask: '255.255.255.0' },
  });
  t.mock.method(FortiGateAPI.prototype, 'getInterface', async () => null);
  t.mock.method(FortiGateAPI.prototype, 'request', async () => ({}));
  const [vlan] = await testDb.db.insert(vlans).values({ name: 'iface', tag: 1302, mode: 'managed' }).returning({ id: vlans.id });

  const res = await request(app).post(`/vlans/${vlan.id}/sync`).send({ firewallId: fw.id });
  assert.equal(res.body[0]?.status, 'ok', JSON.stringify(res.body));
  const [sync] = await testDb.db.select().from(firewallVlanSync).where(eq(firewallVlanSync.vlan_id, vlan.id));
  assert.equal(sync.subnet_cidr, '192.168.50.0/24');
  // The response reports the recorded network, not the 172 setting.
  assert.equal(res.body[0].subnet.network, '192.168.50.0/24');
  assert.equal(res.body[0].subnetRecorded, true);
});

async function syncWithSteps(t: any, name: string, tag: number, steps: unknown[], existingInterface: unknown = null) {
  const fwId = await firewallWithSteps(name, steps);
  t.mock.method(FortiGateAPI.prototype, 'getInterface', async () => existingInterface);
  t.mock.method(FortiGateAPI.prototype, 'request', async () => ({}));
  const [vlan] = await testDb.db.insert(vlans).values({ name, tag, mode: 'managed' }).returning({ id: vlans.id });
  const res = await request(app).post(`/vlans/${vlan.id}/sync`).send({ firewallId: fwId });
  const [sync] = await testDb.db.select().from(firewallVlanSync).where(eq(firewallVlanSync.vlan_id, vlan.id));
  return { res, sync };
}

test('VLAN sync records the subnet of the subject VLAN interface, not an auxiliary one', async (t) => {
  // An auxiliary interface step runs first; only the step for this VLAN's tag counts.
  const { res, sync } = await syncWithSteps(t, 'fw-two-ifaces', 1303, [ifaceStep('3999', '172.20.30.1'), ifaceStep('{{tag}}', '10.13.3.1')]);
  assert.equal(res.body[0]?.status, 'ok', JSON.stringify(res.body));
  assert.equal(sync.subnet_cidr, '10.13.3.0/24');
});

const existingIface = (tag: number, overrides = {}) => ({
  name: `vlan${tag}`, vlanid: tag, interface: 'fortilink', vdom: 'lab', ip: `10.13.${tag - 1300}.1 255.255.255.0`, ...overrides,
});

test('VLAN sync adopts an existing interface only when it is this VLAN as configured', async (t) => {
  const { res, sync } = await syncWithSteps(t, 'fw-existing', 1304, [ifaceStep('{{tag}}', '10.13.4.1')], existingIface(1304, { ip: '10.13.4.254 255.255.255.0' }));
  assert.equal(res.body[0]?.status, 'ok', JSON.stringify(res.body));
  assert.equal(sync.subnet_cidr, '10.13.4.0/24');
});

// Security: a colliding interface name must not let a sync record an unrelated network.
const clashes = [
  ['another VLAN ID', { vlanid: 42 }, /VLAN ID 42/],
  ['another parent interface', { interface: 'port9' }, /parent interface port9/],
  ['another VDOM', { vdom: 'root' }, /VDOM root/],
  ['an unrelated network', { ip: '192.168.1.1 255.255.255.0' }, /address 192\.168\.1\.1/],
  ['another netmask', { ip: '10.13.5.1 255.255.0.0' }, /address/],
  ['no address', { ip: undefined }, /address none/],
] as const;
clashes.forEach(([label, overrides, reason], i) => {
  const tag = 1310 + i;
  test(`VLAN sync refuses an existing interface with ${label}`, async (t) => {
    const { res, sync } = await syncWithSteps(t, `fw-clash-${label.replaceAll(' ', '-')}`, tag, [ifaceStep('{{tag}}', `10.13.${tag - 1300}.1`)], existingIface(tag, overrides));
    assert.equal(res.body[0]?.status, 'error', JSON.stringify(res.body));
    assert.match(res.body[0].error, reason);
    assert.match(res.body[0].error, /admin must remove or reconfigure/);
    assert.equal(sync, undefined);
  });
});
