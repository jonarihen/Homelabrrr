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
