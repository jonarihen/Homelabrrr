import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '../testUtils/pgTestDb.ts';
import {
  auditLog, caddyServers, caddySites, users, userVlans, vlans, vmAssignments, vmSshConfigs,
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
  ]).returning({ id: caddySites.id, domain: caddySites.domain });
  const idOf = (domain: string) => rows.find((r) => r.domain === domain)!.id;

  const disallowed = await websites.findDisallowedSites(serverId);
  assert.deepEqual(disallowed.map((s) => s.domain), ['stale.example.test']);

  await websites.markSitesUnpublished(disallowed);
  const [stale] = await testDb.db.select().from(caddySites).where(eq(caddySites.id, idOf('stale.example.test')));
  assert.equal(stale.status, 'error');
  assert.equal(stale.upstream_host, '192.168.1.5', 'the site row and its settings are kept');
  const [ok] = await testDb.db.select().from(caddySites).where(eq(caddySites.id, idOf('ok.example.test')));
  assert.equal(ok.status, 'live');
  const audits = await testDb.db.select().from(auditLog).where(eq(auditLog.action, 'website_upstream_revoked'));
  assert.equal(audits.length, 1);
  assert.equal(audits[0].target, 'stale.example.test');

  assert.deepEqual(await websites.findDisallowedSites(serverId), [], 'a parked site is not unpublished twice');
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
