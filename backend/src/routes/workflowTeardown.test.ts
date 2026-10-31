import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { eq, and } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '../testUtils/pgTestDb.ts';
import { users, firewalls, vlans, userVlans, firewallVlanSync, managedVips, workflows, workflowSteps } from '../db/schema/index.ts';
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

test('VLAN unsync removes port forwards targeting that VLAN interface only', async (t) => {
  t.mock.method(FortiGateAPI.prototype, 'deleteInterface', async () => {});
  const deletedVips: string[] = [];
  t.mock.method(FortiGateAPI.prototype, 'deleteVip', async (name: string) => { deletedVips.push(name); });
  t.mock.method(FortiGateAPI.prototype, 'deleteAddressObject', async () => {});
  await testDb.db.insert(firewallVlanSync).values({
    firewall_id: firewallId, vlan_id: vlanId, interface_name: 'vlan1099',
    artifacts: [{ type: 'interface', name: 'vlan1099' }],
  });
  await testDb.db.insert(managedVips).values([
    // Workflow-created row: torn down from its recorded artifacts, not the legacy name scheme.
    { firewall_id: firewallId, vip_name: 'pf-in-vlan', ext_port: 9001, mapped_ip: '10.99.0.20', mapped_port: 22, vlan_interface: 'vlan1099',
      artifacts: [{ type: 'vip', name: 'custom-vip-name', vdom: 'root' }] },
    { firewall_id: firewallId, vip_name: 'pf-other-vlan', ext_port: 9002, mapped_ip: '10.98.0.20', mapped_port: 22, vlan_interface: 'vlan1098' },
  ]);

  const res = await request(app).delete(`/vlans/${vlanId}/sync/${firewallId}`);
  assert.equal(res.status, 200);
  assert.deepEqual(deletedVips, ['custom-vip-name']);

  const remaining = await testDb.db.select({ vip_name: managedVips.vip_name }).from(managedVips)
    .where(eq(managedVips.firewall_id, firewallId));
  assert.deepEqual(remaining.map(r => r.vip_name), ['pf-other-vlan']);
  await testDb.db.delete(managedVips).where(eq(managedVips.firewall_id, firewallId));
});

test('VLAN unsync keeps the port forward and sync records when port-forward cleanup fails', async (t) => {
  const deleteInterface = t.mock.method(FortiGateAPI.prototype, 'deleteInterface', async () => {});
  t.mock.method(FortiGateAPI.prototype, 'deleteVip', async () => { throw new Error('Connection reset'); });
  t.mock.method(FortiGateAPI.prototype, 'deletePolicy', async () => {});
  t.mock.method(FortiGateAPI.prototype, 'deleteAddressObject', async () => {});
  t.mock.method(FortiGateAPI.prototype, 'deleteServiceObject', async () => {});
  await testDb.db.insert(firewallVlanSync).values({
    firewall_id: firewallId, vlan_id: vlanId, interface_name: 'vlan1099',
    artifacts: [{ type: 'interface', name: 'vlan1099' }],
  });
  // Legacy row (no artifacts) goes through the fixed cleanup sequence.
  await testDb.db.insert(managedVips).values({
    firewall_id: firewallId, vip_name: 'pf-legacy', ext_port: 9003, mapped_ip: '10.99.0.21', mapped_port: 22, vlan_interface: 'vlan1099',
  });

  const res = await request(app).delete(`/vlans/${vlanId}/sync/${firewallId}`);
  assert.equal(res.status, 502);
  assert.match(res.body.error, /pf-legacy/);
  assert.equal(deleteInterface.mock.callCount(), 0);
  const [pf] = await testDb.db.select().from(managedVips).where(eq(managedVips.vip_name, 'pf-legacy'));
  assert.ok(pf);
  const [sync] = await testDb.db.select().from(firewallVlanSync).where(eq(firewallVlanSync.firewall_id, firewallId));
  assert.ok(sync);
  await testDb.db.delete(managedVips).where(eq(managedVips.firewall_id, firewallId));
  await testDb.db.delete(firewallVlanSync).where(eq(firewallVlanSync.firewall_id, firewallId));
});

test('VLAN unsync never deletes unlinked legacy forwards, but reports those in its subnet', async (t) => {
  t.mock.method(FortiGateAPI.prototype, 'deleteInterface', async () => {});
  const deleteVip = t.mock.method(FortiGateAPI.prototype, 'deleteVip', async () => {});
  await testDb.db.insert(firewallVlanSync).values({
    firewall_id: firewallId, vlan_id: vlanId, interface_name: 'vlan1099',
    artifacts: [{ type: 'interface', name: 'vlan1099' }],
  });
  // Tag 1099 → legacy 10.10.99.0/24. An IP overlap does not prove ownership.
  await testDb.db.insert(managedVips).values([
    { firewall_id: firewallId, vip_name: 'pf-legacy-in', ext_port: 9010, mapped_ip: '10.10.99.30', mapped_port: 22, vlan_interface: '' },
    { firewall_id: firewallId, vip_name: 'pf-legacy-out', ext_port: 9011, mapped_ip: '192.168.1.5', mapped_port: 22, vlan_interface: '' },
    { firewall_id: firewallId, vip_name: 'pf-modern-unassoc', ext_port: 9013, mapped_ip: '10.10.99.32', mapped_port: 22, vlan_interface: '',
      artifacts: [{ type: 'vip', name: 'pf-modern-unassoc', vdom: 'root' }] },
  ]);

  const res = await request(app).delete(`/vlans/${vlanId}/sync/${firewallId}`);
  assert.equal(res.status, 200);
  assert.equal(deleteVip.mock.callCount(), 0);
  assert.deepEqual(res.body.legacyForwardsNeedingReview, [{ firewallId, name: 'pf-legacy-in', mapped_ip: '10.10.99.30' }]);
  assert.equal(res.body.legacyForwardsNeedingReviewCount, 1);
  const remaining = await testDb.db.select({ vip_name: managedVips.vip_name }).from(managedVips)
    .where(eq(managedVips.firewall_id, firewallId));
  assert.equal(remaining.length, 3);
  await testDb.db.delete(managedVips).where(eq(managedVips.firewall_id, firewallId));
});

test('a VLAN-only delegate gets just the count of legacy forwards needing review', async (t) => {
  t.mock.method(FortiGateAPI.prototype, 'deleteInterface', async () => {});
  const [delegate] = await testDb.db.insert(users)
    .values({ username: 'vlan-delegate', password: 'x', can_manage_vlans: true }).returning({ id: users.id });
  await testDb.db.insert(userVlans).values({ user_id: delegate.id, vlan_id: vlanId });
  await testDb.db.insert(firewallVlanSync).values({
    firewall_id: firewallId, vlan_id: vlanId, interface_name: 'vlan1099', artifacts: [{ type: 'interface', name: 'vlan1099' }],
  });
  await testDb.db.insert(managedVips).values({
    firewall_id: firewallId, vip_name: 'pf-legacy-hidden', ext_port: 9015, mapped_ip: '10.10.99.35', mapped_port: 22, vlan_interface: '',
  });
  const adminRouter = (await import('./admin.ts')).default;
  const delegateApp = express();
  delegateApp.use(express.json());
  delegateApp.use((req, _res, next) => {
    req.session = { userId: delegate.id, username: 'vlan-delegate', isAdmin: false, reauthenticatedAt: Date.now() } as never;
    next();
  });
  delegateApp.use('/', adminRouter);

  const res = await request(delegateApp).delete(`/vlans/${vlanId}/sync/${firewallId}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.legacyForwardsNeedingReviewCount, 1);
  assert.equal(res.body.legacyForwardsNeedingReview, undefined);
  await testDb.db.delete(managedVips).where(eq(managedVips.firewall_id, firewallId));
  await testDb.db.delete(userVlans).where(eq(userVlans.user_id, delegate.id));
});

test('VLAN delete refuses when a sync commits while it runs', async () => {
  const [late] = await testDb.db.insert(vlans).values({ name: 'late', tag: 1096, mode: 'managed' }).returning({ id: vlans.id });
  let locked!: () => void;
  const lockedP = new Promise<void>(r => { locked = r; });
  let release!: () => void;
  const held = new Promise<void>(r => { release = r; });
  // Simulates a sync's tracking transaction: VLAN row FOR SHARE, then insert.
  const tx = testDb.db.transaction(async (t) => {
    await t.select({ id: vlans.id }).from(vlans).where(eq(vlans.id, late.id)).for('share');
    await t.insert(firewallVlanSync).values({ firewall_id: firewallId, vlan_id: late.id, interface_name: 'vlan1096' });
    locked();
    await held;
  });
  await lockedP;
  const del = request(app).delete(`/vlans/${late.id}`).then(r => r);
  await new Promise(r => setTimeout(r, 200));
  release();
  await tx;
  const res = await del;
  assert.equal(res.status, 409);
  assert.ok((await testDb.db.select().from(vlans).where(eq(vlans.id, late.id)))[0]);
  await testDb.db.delete(vlans).where(eq(vlans.id, late.id));
});

test('PUT /vlans/:id refuses a tag change while the VLAN is synced', async () => {
  await testDb.db.insert(firewallVlanSync).values({ firewall_id: firewallId, vlan_id: vlanId, interface_name: 'vlan1099' });
  const res = await request(app).put(`/vlans/${vlanId}`).send({ name: 'vlan-test', tag: 1098 });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Unsync/);
  await testDb.db.delete(firewallVlanSync).where(eq(firewallVlanSync.firewall_id, firewallId));
});

test('VLAN sync removes what it created when the VLAN is deleted mid-run', async (t) => {
  const [doomed] = await testDb.db.insert(vlans).values({ name: 'doomed', tag: 1097, mode: 'managed' }).returning({ id: vlans.id });
  const [wf] = await testDb.db.insert(workflows).values({ firewall_id: firewallId, trigger: 'vlan_provision', name: 'p' }).returning({ id: workflows.id });
  await testDb.db.insert(workflowSteps).values({
    workflow_id: wf.id, position: 0, step_key: 'addr', action: 'create_address_object', params: { name: 'NET-doomed', subnet: '10.10.97.0 255.255.255.0' },
  });
  t.mock.method(FortiGateAPI.prototype, 'getAddressObject', async () => null);
  // Simulates a concurrent delete landing while the FortiGate call runs.
  t.mock.method(FortiGateAPI.prototype, 'createAddressObject', async () => {
    await testDb.db.delete(vlans).where(eq(vlans.id, doomed.id));
  });
  const removed: string[] = [];
  t.mock.method(FortiGateAPI.prototype, 'deleteAddressObject', async (name: string) => { removed.push(name); });

  const res = await request(app).post(`/vlans/${doomed.id}/sync`).send({ firewallId });
  assert.equal(res.status, 200);
  assert.equal(res.body[0].status, 'error');
  assert.match(res.body[0].error, /deleted during provisioning/);
  assert.deepEqual(removed, ['NET-doomed']);
  await testDb.db.delete(workflows).where(eq(workflows.id, wf.id));
});

test('port-forward create tears down its objects when the VLAN is unsynced mid-run', async (t) => {
  await testDb.db.update(firewalls).set({ external_ip: '203.0.113.10' }).where(eq(firewalls.id, firewallId));
  await testDb.db.insert(firewallVlanSync).values({ firewall_id: firewallId, vlan_id: vlanId, interface_name: 'vlan1099' });
  const [wf] = await testDb.db.insert(workflows).values({ firewall_id: firewallId, trigger: 'port_forward_create', name: 'pf' }).returning({ id: workflows.id });
  await testDb.db.insert(workflowSteps).values({
    workflow_id: wf.id, position: 0, step_key: 'addr', action: 'create_address_object', params: { name: 'PF-race', subnet: '10.10.99.40 255.255.255.255' },
  });
  t.mock.method(FortiGateAPI.prototype, 'getVips', async () => []);
  t.mock.method(FortiGateAPI.prototype, 'getServiceObject', async () => null);
  t.mock.method(FortiGateAPI.prototype, 'getAddressObject', async () => null);
  // A concurrent unsync removes the sync row while the FortiGate call runs.
  t.mock.method(FortiGateAPI.prototype, 'createAddressObject', async () => {
    await testDb.db.delete(firewallVlanSync).where(eq(firewallVlanSync.firewall_id, firewallId));
  });
  const removed: string[] = [];
  t.mock.method(FortiGateAPI.prototype, 'deleteAddressObject', async (name: string) => { removed.push(name); });

  const res = await request(app).post(`/firewalls/${firewallId}/vips`).send({
    name: 'race', extPort: 9020, mappedIp: '10.10.99.40', mappedPort: 22, dstInterface: 'lab-root1', vlanInterface: 'vlan1099',
  });
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.deepEqual(removed, ['PF-race']);
  assert.equal((await testDb.db.select().from(managedVips).where(eq(managedVips.firewall_id, firewallId))).length, 0);
  await testDb.db.delete(workflows).where(eq(workflows.id, wf.id));
});

test('unsync keeps the sync row when a port forward into the VLAN appears during it', async (t) => {
  await testDb.db.insert(firewallVlanSync).values({
    firewall_id: firewallId, vlan_id: vlanId, interface_name: 'vlan1099', artifacts: [{ type: 'interface', name: 'vlan1099' }],
  });
  // The forward lands after unsync's cleanup query, while it tears down the VLAN.
  t.mock.method(FortiGateAPI.prototype, 'deleteInterface', async () => {
    await testDb.db.insert(managedVips).values({
      firewall_id: firewallId, vip_name: 'pf-late', ext_port: 9021, mapped_ip: '10.10.99.41', mapped_port: 22, vlan_interface: 'vlan1099',
      artifacts: [{ type: 'vip', name: 'pf-late', vdom: 'root' }],
    });
  });

  const res = await request(app).delete(`/vlans/${vlanId}/sync/${firewallId}`);
  assert.equal(res.status, 409);
  assert.ok((await testDb.db.select().from(firewallVlanSync).where(eq(firewallVlanSync.firewall_id, firewallId)))[0]);
  await testDb.db.delete(managedVips).where(eq(managedVips.firewall_id, firewallId));
  await testDb.db.delete(firewallVlanSync).where(eq(firewallVlanSync.firewall_id, firewallId));
});

test('legacy VIP delete clears the record when the VIP is already gone upstream', async (t) => {
  t.mock.method(FortiGateAPI.prototype, 'getPolicies', async () => []);
  t.mock.method(FortiGateAPI.prototype, 'deleteVip', async () => {
    throw Object.assign(new Error('Entry not found'), { statusCode: 404 });
  });
  await testDb.db.insert(managedVips).values({
    firewall_id: firewallId, vip_name: 'pf-stale', ext_port: 9012, mapped_ip: '10.10.99.31', mapped_port: 22,
  });

  const res = await request(app).delete(`/firewalls/${firewallId}/vips/pf-stale`);
  assert.equal(res.status, 200);
  const [row] = await testDb.db.select().from(managedVips).where(eq(managedVips.vip_name, 'pf-stale'));
  assert.equal(row, undefined);
});

test('firewall delete waits for an in-flight tracking insert and then refuses', async () => {
  let locked!: () => void;
  const lockedP = new Promise<void>(r => { locked = r; });
  let release!: () => void;
  const held = new Promise<void>(r => { release = r; });
  // Simulates a creator's tracking transaction: firewall row FOR SHARE, then insert.
  const tx = testDb.db.transaction(async (t) => {
    await t.select({ id: firewalls.id }).from(firewalls).where(eq(firewalls.id, firewallId)).for('share');
    await t.insert(managedVips).values({ firewall_id: firewallId, vip_name: 'pf-inflight', ext_port: 9030, mapped_ip: '10.10.99.50', mapped_port: 22 });
    locked();
    await held;
  });
  await lockedP;
  const del = request(app).delete(`/firewalls/${firewallId}`).then(r => r);
  await new Promise(r => setTimeout(r, 200));
  release();
  await tx;
  const res = await del;
  assert.equal(res.status, 409);
  await testDb.db.delete(managedVips).where(eq(managedVips.firewall_id, firewallId));
});

test('firewall delete returns 409 while sync or port-forward records exist', async () => {
  await testDb.db.insert(managedVips).values({
    firewall_id: firewallId, vip_name: 'pf-blocker', ext_port: 9004, mapped_ip: '10.99.0.22', mapped_port: 22,
  });
  const blocked = await request(app).delete(`/firewalls/${firewallId}`);
  assert.equal(blocked.status, 409);
  const [stillThere] = await testDb.db.select().from(firewalls).where(eq(firewalls.id, firewallId));
  assert.ok(stillThere);

  await testDb.db.delete(managedVips).where(eq(managedVips.firewall_id, firewallId));
  await testDb.db.insert(firewallVlanSync).values({ firewall_id: firewallId, vlan_id: vlanId, interface_name: 'vlan1099' });
  assert.equal((await request(app).delete(`/firewalls/${firewallId}`)).status, 409);

  await testDb.db.delete(firewallVlanSync).where(eq(firewallVlanSync.firewall_id, firewallId));
  const ok = await request(app).delete(`/firewalls/${firewallId}`);
  assert.equal(ok.status, 200);
  const [gone] = await testDb.db.select().from(firewalls).where(eq(firewalls.id, firewallId));
  assert.equal(gone, undefined);
});
