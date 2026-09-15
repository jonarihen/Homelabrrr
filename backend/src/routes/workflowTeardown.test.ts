import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { eq, and } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '../testUtils/pgTestDb.ts';
import { users, firewalls, vlans, firewallVlanSync, managedVips } from '../db/schema/index.ts';
import { FortiGateAPI } from '../fortigate.ts';

let testDb: TestDatabase;
let app: express.Express;
let closeDb: (() => Promise<void>) | undefined;
let adminUserId: number;
let firewallId: number;
let vlanId: number;

const originalDeleteVip = FortiGateAPI.prototype.deleteVip;
const originalDeleteAddressObject = FortiGateAPI.prototype.deleteAddressObject;
const originalDeletePolicy = FortiGateAPI.prototype.deletePolicy;
const originalDeleteInterface = FortiGateAPI.prototype.deleteInterface;

before(async () => {
  testDb = await createTestDatabase();
  process.env.DATABASE_URL = testDb.url;
  process.env.SECRET_ENCRYPTION_KEY ||= '55'.repeat(32);
  ({ closeDb } = await import('../db/client.ts'));

  const [admin] = await testDb.db
    .insert(users)
    .values({
      username: 'teardown-admin',
      password: 'x',
      is_admin: true,
      can_manage_firewalls: true,
      can_manage_vlans: true,
      can_manage_port_forwards: true,
    })
    .returning({ id: users.id });
  adminUserId = admin.id;

  const [fw] = await testDb.db
    .insert(firewalls)
    .values({
      name: 'fw-test',
      host: '192.168.100.1',
      api_key: 'testkey',
      vdom: 'lab',
      root_vdom: 'root',
      verify_tls: false,
    })
    .returning({ id: firewalls.id });
  firewallId = fw.id;

  const [vlan] = await testDb.db
    .insert(vlans)
    .values({
      name: 'vlan-test',
      tag: 1099,
      mode: 'managed',
      subnet_cidr: '10.99.0.0/24',
    })
    .returning({ id: vlans.id });
  vlanId = vlan.id;

  const adminRouter = (await import('./admin.ts')).default;
  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = {
      userId: adminUserId,
      username: 'teardown-admin',
      isAdmin: true,
      reauthenticatedAt: Date.now(),
    } as never;
    next();
  });
  app.use('/', adminRouter);
});

after(async () => {
  FortiGateAPI.prototype.deleteVip = originalDeleteVip;
  FortiGateAPI.prototype.deleteAddressObject = originalDeleteAddressObject;
  FortiGateAPI.prototype.deletePolicy = originalDeletePolicy;
  FortiGateAPI.prototype.deleteInterface = originalDeleteInterface;
  await closeDb?.();
  await testDb.drop();
});

test('VIP deletion preserves database record and returns 502 when teardown has errors', async (t) => {
  const vipName = 'vip-fail-test';
  await testDb.db.insert(managedVips).values({
    firewall_id: firewallId,
    vip_name: vipName,
    ext_port: 8080,
    mapped_ip: '10.99.0.10',
    mapped_port: 80,
    artifacts: [
      { type: 'vip', name: vipName, vdom: 'root' },
    ],
  });

  t.mock.method(FortiGateAPI.prototype, 'deleteVip', async () => {
    throw new Error('FortiGate connection timeout');
  });

  const res = await request(app).delete(`/firewalls/${firewallId}/vips/${vipName}`);
  assert.equal(res.status, 502);
  assert.match(res.body.error, /Failed to remove port forward from firewall/);

  const [persisted] = await testDb.db.select().from(managedVips)
    .where(and(eq(managedVips.firewall_id, firewallId), eq(managedVips.vip_name, vipName))).limit(1);
  assert.ok(persisted);
  assert.equal(persisted.vip_name, vipName);
});

test('VIP deletion deletes record and returns ok when retry succeeds', async (t) => {
  const vipName = 'vip-fail-test';
  t.mock.method(FortiGateAPI.prototype, 'deleteVip', async () => {});

  const res = await request(app).delete(`/firewalls/${firewallId}/vips/${vipName}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);

  const [persisted] = await testDb.db.select().from(managedVips)
    .where(and(eq(managedVips.firewall_id, firewallId), eq(managedVips.vip_name, vipName))).limit(1);
  assert.equal(persisted, undefined);
});

test('VIP deletion supports idempotent retry across partially deleted artifacts', async (t) => {
  const vipName = 'vip-partial-test';
  const addressName = 'addr-vip-partial';
  await testDb.db.insert(managedVips).values({
    firewall_id: firewallId,
    vip_name: vipName,
    ext_port: 8081,
    mapped_ip: '10.99.0.11',
    mapped_port: 81,
    artifacts: [
      { type: 'address', name: addressName, vdom: 'root' },
      { type: 'vip', name: vipName, vdom: 'root' },
    ],
  });

  let addressDeleted = false;
  t.mock.method(FortiGateAPI.prototype, 'deleteAddressObject', async () => {
    if (addressDeleted) {
      const err = new Error('Entry not found');
      (err as any).statusCode = 404;
      throw err;
    }
    addressDeleted = true;
  });

  let vipAttempts = 0;
  t.mock.method(FortiGateAPI.prototype, 'deleteVip', async () => {
    vipAttempts += 1;
    if (vipAttempts === 1) {
      throw new Error('Connection refused by firewall');
    }
  });

  const res1 = await request(app).delete(`/firewalls/${firewallId}/vips/${vipName}`);
  assert.equal(res1.status, 502);

  const [stillThere] = await testDb.db.select().from(managedVips)
    .where(and(eq(managedVips.firewall_id, firewallId), eq(managedVips.vip_name, vipName))).limit(1);
  assert.ok(stillThere);

  const res2 = await request(app).delete(`/firewalls/${firewallId}/vips/${vipName}`);
  assert.equal(res2.status, 200);
  assert.equal(res2.body.ok, true);

  const [afterSuccess] = await testDb.db.select().from(managedVips)
    .where(and(eq(managedVips.firewall_id, firewallId), eq(managedVips.vip_name, vipName))).limit(1);
  assert.equal(afterSuccess, undefined);
});

test('VLAN unsync preserves database record and returns 502 when teardown has errors', async (t) => {
  await testDb.db.insert(firewallVlanSync).values({
    firewall_id: firewallId,
    vlan_id: vlanId,
    interface_name: 'vlan1099',
    artifacts: [
      { type: 'interface', name: 'vlan1099' },
    ],
  });

  t.mock.method(FortiGateAPI.prototype, 'deleteInterface', async () => {
    throw new Error('Device busy');
  });

  const res = await request(app).delete(`/vlans/${vlanId}/sync/${firewallId}`);
  assert.equal(res.status, 502);
  assert.match(res.body.error, /Failed to remove VLAN from firewall/);

  const [persisted] = await testDb.db.select().from(firewallVlanSync)
    .where(and(eq(firewallVlanSync.vlan_id, vlanId), eq(firewallVlanSync.firewall_id, firewallId))).limit(1);
  assert.ok(persisted);
  assert.equal(persisted.interface_name, 'vlan1099');
});

test('VLAN unsync via POST /firewalls/:id/vlans/:vlanId/unsync also returns 502 on failure and succeeds on retry', async (t) => {
  let attempt = 0;
  t.mock.method(FortiGateAPI.prototype, 'deleteInterface', async () => {
    attempt += 1;
    if (attempt === 1) {
      throw new Error('Temporary switch failure');
    }
  });

  const failRes = await request(app).post(`/firewalls/${firewallId}/vlans/${vlanId}/unsync`);
  assert.equal(failRes.status, 502);

  const [persisted] = await testDb.db.select().from(firewallVlanSync)
    .where(and(eq(firewallVlanSync.vlan_id, vlanId), eq(firewallVlanSync.firewall_id, firewallId))).limit(1);
  assert.ok(persisted);

  const okRes = await request(app).post(`/firewalls/${firewallId}/vlans/${vlanId}/unsync`);
  assert.equal(okRes.status, 200);
  assert.equal(okRes.body.ok, true);

  const [afterRetry] = await testDb.db.select().from(firewallVlanSync)
    .where(and(eq(firewallVlanSync.vlan_id, vlanId), eq(firewallVlanSync.firewall_id, firewallId))).limit(1);
  assert.equal(afterRetry, undefined);
});
