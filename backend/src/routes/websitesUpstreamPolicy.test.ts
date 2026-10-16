import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '../testUtils/pgTestDb.ts';
import {
  auditLog, caddyServers, firewalls, caddySites, users, userVlans, vlans, vmAssignments, vmSshConfigs,
} from '../db/schema/index.ts';

let testDb: TestDatabase;
let websites: typeof import('./websites.ts');
let closeDb: (() => Promise<void>) | undefined;
let ownerId: number;
let serverId: number;

before(async () => {
  testDb = await createTestDatabase();
  process.env.DATABASE_URL = testDb.url;
  process.env.SECRET_ENCRYPTION_KEY ||= '89'.repeat(32);
  ({ closeDb } = await import('../db/client.ts'));
  websites = await import('./websites.ts');

  const [owner] = await testDb.db.insert(users).values({ username: 'site-owner', password: 'unused' }).returning({ id: users.id });
  ownerId = owner.id;
  const [vlan] = await testDb.db.insert(vlans).values({ name: 'lab', tag: 1010, mode: 'managed', subnet_cidr: '' }).returning({ id: vlans.id });
  await testDb.db.insert(userVlans).values({ user_id: ownerId, vlan_id: vlan.id });
  const [server] = await testDb.db.insert(caddyServers).values({ name: 'edge', api_url: 'http://127.0.0.1:1' }).returning({ id: caddyServers.id });
  serverId = server.id;
});

after(async () => {
  await closeDb?.();
  await testDb?.drop();
});

test('sites whose upstream the owner may no longer use are unpublished, not deleted', async () => {
  const [admin] = await testDb.db.insert(users).values({ username: 'site-admin', password: 'unused', is_admin: true }).returning({ id: users.id });
  const site = (domain: string, upstream_host: string, owner_user_id: number, status = 'live') => ({
    server_id: serverId, domain, upstream_host, upstream_port: 80, owner_user_id, managed: true, status,
  });
  const rows = await testDb.db.insert(caddySites).values([
    site('ok.example.test', '10.10.10.5', ownerId),
    site('stale.example.test', '192.168.1.5', ownerId),
    site('admin.example.test', '192.168.1.6', admin.id),
    site('parked.example.test', '192.168.1.7', ownerId, 'error'),
    { ...site('orphan.example.test', '10.10.10.8', ownerId), owner_user_id: null },
  ]).returning({ id: caddySites.id, domain: caddySites.domain });
  const idOf = (domain: string) => rows.find((r) => r.domain === domain)!.id;

  const disallowed = await websites.findDisallowedSites(serverId);
  // An ownerless site has nobody left to authorize it, even with an in-VLAN
  // upstream; an 'error' row is scanned too (its route may still be live).
  const revoked = ['orphan.example.test', 'parked.example.test', 'stale.example.test'];
  assert.deepEqual(disallowed.map((s) => s.domain).sort(), revoked);

  await websites.markSitesUnpublished(disallowed);
  const [stale] = await testDb.db.select().from(caddySites).where(eq(caddySites.id, idOf('stale.example.test')));
  assert.equal(stale.status, 'error');
  assert.equal(stale.upstream_host, '192.168.1.5', 'the site row and its settings are kept');
  const [ok] = await testDb.db.select().from(caddySites).where(eq(caddySites.id, idOf('ok.example.test')));
  assert.equal(ok.status, 'live');
  const audits = await testDb.db.select().from(auditLog).where(eq(auditLog.action, 'website_upstream_revoked'));
  assert.deepEqual(audits.map((a) => a.target).sort(), revoked);

  assert.ok(stale.status_detail.startsWith('Being unpublished'), 'parked until route/slot cleanup is confirmed');
  // The next tick still sees them, but parking and auditing happen only once.
  await websites.markSitesUnpublished(await websites.findDisallowedSites(serverId));
  assert.equal((await testDb.db.select().from(auditLog).where(eq(auditLog.action, 'website_upstream_revoked'))).length, 3);

  // The owner cannot bring a revoked site back with a retry.
  const app = express();
  app.use((req, _res, next) => {
    (req as express.Request & { session: unknown }).session = { userId: ownerId, username: 'site-owner', isAdmin: false };
    next();
  });
  app.use('/', websites.default);
  const retry = await request(app).post(`/sites/${idOf('stale.example.test')}/retry`);
  assert.equal(retry.status, 403);
  const [afterRetry] = await testDb.db.select().from(caddySites).where(eq(caddySites.id, idOf('stale.example.test')));
  assert.equal(afterRetry.status, 'error');
});

test('the upstream picker matches SSH hosts on node and VMID', async () => {
  await testDb.db.insert(vmAssignments).values({ user_id: ownerId, node: '1~pve-a', vmid: 101 });
  // Same VMID on another cluster, inserted first so a VMID-only lookup picks it.
  await testDb.db.insert(vmSshConfigs).values({ node: '2~pve-b', vmid: 101, host: '10.10.10.99' });
  await testDb.db.insert(vmSshConfigs).values({ node: '1~pve-a', vmid: 101, host: '10.10.10.7' });

  const app = express();
  app.use((req, _res, next) => {
    (req as express.Request & { session: unknown }).session = { userId: ownerId, username: 'site-owner', isAdmin: false };
    next();
  });
  app.use('/', websites.default);
  const res = await request(app).get('/upstream-options');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.vms, [{ vmid: 101, node: '1~pve-a', ip: '10.10.10.7' }]);
});

test('revoked siblings sharing a certificate do not keep its inspection slot in use', async () => {
  const [fw] = await testDb.db.insert(firewalls).values({ name: 'fw', host: 'fw.test', api_key: 'x' }).returning({ id: firewalls.id });
  const shared = { server_id: serverId, upstream_port: 80, owner_user_id: ownerId, managed: true, fortigate_id: fw.id, inspection_profile: 'deep', cert_name: 'wild.example.test_2026-01-01' };
  const rows = await testDb.db.insert(caddySites).values([
    { ...shared, domain: 'a.wild.example.test', upstream_host: '192.168.2.1', status: 'live' },
    { ...shared, domain: 'b.wild.example.test', upstream_host: '192.168.2.2', status: 'live' },
  ]).returning();
  await websites.markSitesUnpublished(rows);
  const parked = await testDb.db.select().from(caddySites).where(eq(caddySites.cert_name, shared.cert_name));
  for (const row of parked) assert.equal(await websites.certStillInUse(row), false);

  // A sibling that is still published keeps the slot.
  await testDb.db.insert(caddySites).values({ ...shared, domain: 'c.wild.example.test', upstream_host: '10.10.10.9', status: 'live' });
  assert.equal(await websites.certStillInUse(parked[0]), true);
});

test('a site repointed after the scan is not parked from the stale snapshot', async () => {
  const [row] = await testDb.db.insert(caddySites).values({
    server_id: serverId, domain: 'moved.example.test', upstream_host: '192.168.3.3', upstream_port: 80,
    owner_user_id: ownerId, managed: true, status: 'live',
  }).returning();
  const snapshot = (await websites.findDisallowedSites(serverId)).filter((s) => s.id === row.id);
  assert.equal(snapshot.length, 1);
  // The owner repoints the site into their VLAN before the park runs.
  await testDb.db.update(caddySites).set({ upstream_host: '10.10.10.33', status: 'pushing' }).where(eq(caddySites.id, row.id));
  await websites.markSitesUnpublished(snapshot);
  const [after] = await testDb.db.select().from(caddySites).where(eq(caddySites.id, row.id));
  assert.equal(after.status, 'pushing');
  const audits = await testDb.db.select().from(auditLog).where(eq(auditLog.target, 'moved.example.test'));
  assert.equal(audits.length, 0);
});

test('a failed inspection-slot release is retried on the next tick', async () => {
  const { encryptSecret } = await import('../utils/secrets.ts');
  const { createClient } = await import('../fortigate.ts');
  const { createCaddyClient } = await import('../utils/caddy.ts');
  const [fw] = await testDb.db.insert(firewalls).values({ name: 'fw-retry', host: '127.0.0.1', api_key: encryptSecret('k') }).returning();
  const [apiServer] = await testDb.db.insert(caddyServers).values({ name: 'api-edge', api_url: 'http://127.0.0.1:1' }).returning();
  const [row] = await testDb.db.insert(caddySites).values({
    server_id: apiServer.id, domain: 'slot.example.test', upstream_host: '192.168.4.4', upstream_port: 80,
    owner_user_id: ownerId, managed: true, status: 'live',
    fortigate_id: fw.id, inspection_profile: 'deep', cert_name: 'slot.example.test_2026-01-01',
  }).returning();

  const fortiProto = Object.getPrototypeOf(createClient(fw));
  const caddyProto = Object.getPrototypeOf(createCaddyClient(apiServer));
  const originals = { detach: fortiProto.detachInspectionServerCert, list: caddyProto.listManagedRouteIds, del: caddyProto.deleteRoute };
  let detachCalls = 0;
  fortiProto.detachInspectionServerCert = async () => {
    detachCalls += 1;
    if (detachCalls === 1) throw new Error('firewall unreachable');
    return { removed: ['slot.example.test_2026-01-01'], remaining: ['other'] };
  };
  caddyProto.listManagedRouteIds = async () => [];
  caddyProto.deleteRoute = async () => {};
  try {
    const tick = async () => {
      await websites.markSitesUnpublished(await websites.findDisallowedSites(apiServer.id));
      await websites.finishRevocations(apiServer);
      return (await testDb.db.select().from(caddySites).where(eq(caddySites.id, row.id)))[0];
    };
    const first = await tick();
    assert.equal(first.status, 'error');
    assert.ok(first.status_detail.startsWith('Being unpublished'), 'stays pending after a failed release');
    const second = await tick();
    assert.equal(detachCalls, 2);
    assert.ok(second.status_detail.startsWith('Unpublished'), 'finalized once the release succeeds');
    await tick();
    assert.equal(detachCalls, 2, 'a finalized site is not released again');
  } finally {
    fortiProto.detachInspectionServerCert = originals.detach;
    caddyProto.listManagedRouteIds = originals.list;
    caddyProto.deleteRoute = originals.del;
  }
});

test('a site whose owner loses access before its publish flow starts is revoked and its route removed', async () => {
  const { createCaddyClient, managedRouteId } = await import('../utils/caddy.ts');
  const [user] = await testDb.db.insert(users).values({ username: 'flow-owner', password: 'unused' }).returning({ id: users.id });
  const [vlan] = await testDb.db.insert(vlans).values({ name: 'flow', tag: 1030, mode: 'managed', subnet_cidr: '' }).returning({ id: vlans.id });
  await testDb.db.insert(userVlans).values({ user_id: user.id, vlan_id: vlan.id });
  const [apiServer] = await testDb.db.insert(caddyServers).values({ name: 'flow-edge', api_url: 'http://127.0.0.1:1' }).returning();
  const [row] = await testDb.db.insert(caddySites).values({
    server_id: apiServer.id, domain: 'flow.example.test', upstream_host: '10.10.30.5', upstream_port: 80,
    owner_user_id: user.id, managed: true, status: 'pushing',
  }).returning();

  // The retry check passed; access is lost before the flow runs.
  await testDb.db.delete(userVlans).where(eq(userVlans.user_id, user.id));

  const caddyProto = Object.getPrototypeOf(createCaddyClient(apiServer));
  const originals = { list: caddyProto.listManagedRouteIds, del: caddyProto.deleteRoute };
  const live = new Set([managedRouteId(row.id)]);
  caddyProto.listManagedRouteIds = async () => [...live];
  caddyProto.deleteRoute = async (id) => { live.delete(managedRouteId(id)); };
  try {
    await websites.runSiteFlow(row.id);
    const [parked] = await testDb.db.select().from(caddySites).where(eq(caddySites.id, row.id));
    assert.equal(parked.status, 'error');
    assert.ok(parked.status_detail.startsWith('Being unpublished'));
    assert.equal(live.size, 1, 'the flow itself does not publish or remove anything');

    await websites.finishRevocations(apiServer);
    const [done] = await testDb.db.select().from(caddySites).where(eq(caddySites.id, row.id));
    assert.equal(live.size, 0, 'the live route was removed');
    assert.ok(done.status_detail.startsWith('Unpublished'));
    const audits = await testDb.db.select().from(auditLog).where(eq(auditLog.target, 'flow.example.test'));
    assert.equal(audits.length, 1);
  } finally {
    caddyProto.listManagedRouteIds = originals.list;
    caddyProto.deleteRoute = originals.del;
  }
});
