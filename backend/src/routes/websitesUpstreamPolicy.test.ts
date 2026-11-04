import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '../testUtils/pgTestDb.ts';
import {
  auditLog, caddyServers, firewalls, caddySites, pveHosts, publicIpAssignments, publicIpPools, publicIps,
  users, userVlans, vlans, vmAssignments, vmSshConfigs,
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

test('a site saved between the revocation load and its cleanup keeps its new route', async () => {
  const { createCaddyClient, managedRouteId } = await import('../utils/caddy.ts');
  const [apiServer] = await testDb.db.insert(caddyServers).values({ name: 'race-edge', api_url: 'http://127.0.0.1:1' }).returning();
  const [row] = await testDb.db.insert(caddySites).values({
    server_id: apiServer.id, domain: 'race.example.test', upstream_host: '192.168.5.5', upstream_port: 80,
    owner_user_id: ownerId, managed: true, status: 'live',
  }).returning();
  await websites.markSitesUnpublished(await websites.findDisallowedSites(apiServer.id));

  const caddyProto = Object.getPrototypeOf(createCaddyClient(apiServer));
  const originals = { list: caddyProto.listManagedRouteIds, del: caddyProto.deleteRoute };
  const deleted = [];
  // Runs after finishRevocations loaded its pending rows: the owner repoints the
  // site (as PUT /sites/:id does) and the new route is already live.
  caddyProto.listManagedRouteIds = async () => {
    await testDb.db.update(caddySites).set({ upstream_host: '10.10.10.44', status: 'pushing', status_detail: '' })
      .where(eq(caddySites.id, row.id));
    return [managedRouteId(row.id)];
  };
  caddyProto.deleteRoute = async (id) => { deleted.push(id); };
  try {
    await websites.finishRevocations(apiServer);
    assert.deepEqual(deleted, [], 'the repointed site\'s route was deleted');
    const [after] = await testDb.db.select().from(caddySites).where(eq(caddySites.id, row.id));
    assert.equal(after.status, 'pushing');
    assert.equal(after.status_detail, '');
  } finally {
    caddyProto.listManagedRouteIds = originals.list;
    caddyProto.deleteRoute = originals.del;
  }
});

test('a route Caddy fails to delete keeps the site claimable until it is gone', async () => {
  const { createCaddyClient, managedRouteId } = await import('../utils/caddy.ts');
  const [apiServer] = await testDb.db.insert(caddyServers).values({ name: 'sticky-edge', api_url: 'http://127.0.0.1:1' }).returning();
  const [row] = await testDb.db.insert(caddySites).values({
    server_id: apiServer.id, domain: 'sticky.example.test', upstream_host: '192.168.6.6', upstream_port: 80,
    owner_user_id: ownerId, managed: true, status: 'live',
  }).returning();
  await websites.markSitesUnpublished(await websites.findDisallowedSites(apiServer.id));

  const caddyProto = Object.getPrototypeOf(createCaddyClient(apiServer));
  const originals = { list: caddyProto.listManagedRouteIds, del: caddyProto.deleteRoute };
  const live = new Set([managedRouteId(row.id)]);
  let deleteWorks = false;
  caddyProto.listManagedRouteIds = async () => [...live];
  // Like a Caddy DELETE answering 500, which deleteRoute swallows.
  caddyProto.deleteRoute = async (id) => { if (deleteWorks) live.delete(managedRouteId(id)); };
  const detail = async () => (await testDb.db.select().from(caddySites).where(eq(caddySites.id, row.id)))[0].status_detail;
  try {
    await websites.finishRevocations(apiServer);
    assert.ok((await detail()).startsWith('Being unpublished'), 'not finalized while the route is still live');
    deleteWorks = true;
    await websites.finishRevocations(apiServer);
    assert.equal(live.size, 0);
    assert.ok((await detail()).startsWith('Unpublished'));
  } finally {
    caddyProto.listManagedRouteIds = originals.list;
    caddyProto.deleteRoute = originals.del;
  }
});

test('access lost while the flow is pushing the route re-arms the revocation instead of publishing', async () => {
  const { createCaddyClient, managedRouteId } = await import('../utils/caddy.ts');
  const [user] = await testDb.db.insert(users).values({ username: 'push-race-owner', password: 'unused' }).returning({ id: users.id });
  const [vlan] = await testDb.db.insert(vlans).values({ name: 'push-race', tag: 1040, mode: 'managed', subnet_cidr: '' }).returning({ id: vlans.id });
  await testDb.db.insert(userVlans).values({ user_id: user.id, vlan_id: vlan.id });
  const [apiServer] = await testDb.db.insert(caddyServers).values({ name: 'push-race-edge', api_url: 'http://127.0.0.1:1' }).returning();
  const [row] = await testDb.db.insert(caddySites).values({
    server_id: apiServer.id, domain: 'push-race.example.test', upstream_host: '10.10.40.5', upstream_port: 80,
    owner_user_id: user.id, managed: true, status: 'pushing',
  }).returning();

  const caddyProto = Object.getPrototypeOf(createCaddyClient(apiServer));
  const originals = { list: caddyProto.listManagedRouteIds, del: caddyProto.deleteRoute, upsert: caddyProto.upsertRoute, conflicts: caddyProto.findConflicts };
  const live = new Set();
  caddyProto.listManagedRouteIds = async () => [...live];
  caddyProto.deleteRoute = async (id) => { live.delete(managedRouteId(id)); };
  caddyProto.findConflicts = async () => [];
  // While the push is in flight the owner loses the VLAN and a whole
  // maintenance pass revokes and cleans the site; then the push lands.
  caddyProto.upsertRoute = async (id) => {
    await testDb.db.delete(userVlans).where(eq(userVlans.user_id, user.id));
    await websites.markSitesUnpublished(await websites.findDisallowedSites(apiServer.id));
    await websites.finishRevocations(apiServer);
    live.add(managedRouteId(id));
    return { wildcard: '' };
  };
  try {
    await websites.runSiteFlow(row.id);
    const [afterFlow] = await testDb.db.select().from(caddySites).where(eq(caddySites.id, row.id));
    assert.equal(afterFlow.status, 'error', 'the flow did not overwrite the revocation');
    assert.ok(afterFlow.status_detail.startsWith('Being unpublished:'), 're-armed for the next tick');

    await websites.finishRevocations(apiServer);
    assert.equal(live.size, 0, 'the route the stale push installed was removed');
    const [done] = await testDb.db.select().from(caddySites).where(eq(caddySites.id, row.id));
    assert.ok(done.status_detail.startsWith('Unpublished'));
  } finally {
    Object.assign(caddyProto, { listManagedRouteIds: originals.list, deleteRoute: originals.del, upsertRoute: originals.upsert, findConflicts: originals.conflicts });
  }
});

test('access lost after the flow starts is re-checked right before the snippet is synced', async () => {
  const { createCaddyClient } = await import('../utils/caddy.ts');
  const [user] = await testDb.db.insert(users).values({ username: 'snippet-race-owner', password: 'unused' }).returning({ id: users.id });
  const [vlan] = await testDb.db.insert(vlans).values({ name: 'snippet-race', tag: 1050, mode: 'managed', subnet_cidr: '' }).returning({ id: vlans.id });
  await testDb.db.insert(userVlans).values({ user_id: user.id, vlan_id: vlan.id });
  const [sshServer] = await testDb.db.insert(caddyServers).values({
    name: 'snippet-race-edge', api_url: 'http://127.0.0.1:1', ssh_host: '127.0.0.1', ssh_user: 'caddy',
  }).returning();
  const [row] = await testDb.db.insert(caddySites).values({
    server_id: sshServer.id, domain: 'snippet-race.example.test', upstream_host: '10.10.50.5', upstream_port: 80,
    owner_user_id: user.id, managed: true, status: 'pushing',
  }).returning();

  const caddyProto = Object.getPrototypeOf(createCaddyClient(sshServer));
  const original = caddyProto.findWildcardSlot;
  // Runs after the flow's first check, before the snippet would be deployed.
  caddyProto.findWildcardSlot = async () => {
    await testDb.db.delete(userVlans).where(eq(userVlans.user_id, user.id));
    return null;
  };
  try {
    await websites.runSiteFlow(row.id);
    const [after] = await testDb.db.select().from(caddySites).where(eq(caddySites.id, row.id));
    assert.equal(after.status, 'error');
    assert.ok(after.status_detail.startsWith('Being unpublished'), 'parked before any snippet deploy was attempted');
  } finally {
    caddyProto.findWildcardSlot = original;
  }
});

test('a release skipped for the profile\'s last certificate stays retryable without re-syncing Caddy', async () => {
  const { encryptSecret } = await import('../utils/secrets.ts');
  const { createClient } = await import('../fortigate.ts');
  const { createCaddyClient } = await import('../utils/caddy.ts');
  const [fw] = await testDb.db.insert(firewalls).values({ name: 'fw-last', host: '127.0.0.1', api_key: encryptSecret('k') }).returning();
  const [apiServer] = await testDb.db.insert(caddyServers).values({ name: 'last-edge', api_url: 'http://127.0.0.1:1' }).returning();
  const [row] = await testDb.db.insert(caddySites).values({
    server_id: apiServer.id, domain: 'last.example.test', upstream_host: '192.168.7.7', upstream_port: 80,
    owner_user_id: ownerId, managed: true, status: 'live',
    fortigate_id: fw.id, inspection_profile: 'deep', cert_name: 'last.example.test_2026-01-01',
  }).returning();

  const fortiProto = Object.getPrototypeOf(createClient(fw));
  const caddyProto = Object.getPrototypeOf(createCaddyClient(apiServer));
  const originals = { detach: fortiProto.detachInspectionServerCert, list: caddyProto.listManagedRouteIds, del: caddyProto.deleteRoute };
  let onlyCert = true;
  let detachCalls = 0;
  let listCalls = 0;
  fortiProto.detachInspectionServerCert = async () => {
    detachCalls += 1;
    return onlyCert
      ? { removed: [], remaining: ['last.example.test_2026-01-01'], skipped: 'would empty the profile\'s server-certificate list' }
      : { removed: ['last.example.test_2026-01-01'], remaining: ['other'] };
  };
  caddyProto.listManagedRouteIds = async () => { listCalls += 1; return []; };
  caddyProto.deleteRoute = async () => {};
  try {
    const tick = async () => {
      await websites.markSitesUnpublished(await websites.findDisallowedSites(apiServer.id));
      await websites.finishRevocations(apiServer);
      return (await testDb.db.select().from(caddySites).where(eq(caddySites.id, row.id)))[0];
    };
    const first = await tick();
    assert.ok(first.status_detail.startsWith('Being unpublished'), 'a skipped release is not finalized');
    const listedOnce = listCalls;
    await tick();
    assert.equal(detachCalls, 2, 'the release is retried');
    assert.equal(listCalls, listedOnce, 'retrying the release does not touch Caddy again');

    // Another certificate joins the profile: the stale one can now be removed.
    onlyCert = false;
    const done = await tick();
    assert.equal(detachCalls, 3);
    assert.ok(done.status_detail.startsWith('Unpublished'), 'finalized once the slot is freed');
  } finally {
    fortiProto.detachInspectionServerCert = originals.detach;
    caddyProto.listManagedRouteIds = originals.list;
    caddyProto.deleteRoute = originals.del;
  }
});

test('a site is not revoked when its owner\'s IP cannot be verified because Proxmox is unreachable', async () => {
  const [user] = await testDb.db.insert(users).values({ username: 'pve-down-owner', password: 'unused' }).returning({ id: users.id });
  // Two hosts, both unreachable: which one the bare `pve` assignment lives on is unknowable.
  const [hostA] = await testDb.db.insert(pveHosts).values({ name: 'pve-down-a', host: '127.0.0.1', port: 1, token_id: 't', token_secret: 'x' }).returning({ id: pveHosts.id });
  await testDb.db.insert(pveHosts).values({ name: 'pve-down-b', host: '127.0.0.1', port: 1, token_id: 't', token_secret: 'x' });
  await testDb.db.insert(vmAssignments).values({ user_id: user.id, node: 'pve', vmid: 303 });
  const [fw] = await testDb.db.insert(firewalls).values({ name: 'fw-pve-down', host: 'fw.test', api_key: 'x' }).returning({ id: firewalls.id });
  const [pool] = await testDb.db.insert(publicIpPools).values({ firewall_id: fw.id, name: 'pool-pve-down', external_interface: 'wan1' }).returning({ id: publicIpPools.id });
  const [ip] = await testDb.db.insert(publicIps).values({ pool_id: pool.id, firewall_id: fw.id, address: '203.0.113.33' }).returning({ id: publicIps.id });
  await testDb.db.insert(publicIpAssignments).values({
    public_ip_id: ip.id, firewall_id: fw.id, user_id: user.id, proxmox_host_id: hostA.id, node: `${hostA.id}~pve`, vmid: 303, private_ip: '172.16.33.3',
  });
  const [apiServer] = await testDb.db.insert(caddyServers).values({ name: 'pve-down-edge', api_url: 'http://127.0.0.1:1' }).returning();
  const [row] = await testDb.db.insert(caddySites).values({
    server_id: apiServer.id, domain: 'pve-down.example.test', upstream_host: '172.16.33.3', upstream_port: 80,
    owner_user_id: user.id, managed: true, status: 'live',
  }).returning();

  const { userCanReachUpstream } = await import('../utils/websiteChecks.ts');
  const reach = await userCanReachUpstream(user.id, '172.16.33.3', false);
  assert.equal(reach.ok, false);
  assert.equal(reach.unknown, true, 'an unreachable Proxmox host is not a verdict');

  assert.deepEqual(await websites.findDisallowedSites(apiServer.id), [], 'the sweep defers');
  await websites.markSitesUnpublished([row]);
  const [after] = await testDb.db.select().from(caddySites).where(eq(caddySites.id, row.id));
  assert.equal(after.status, 'live');
  assert.equal((await testDb.db.select().from(auditLog).where(eq(auditLog.target, 'pve-down.example.test'))).length, 0);

  const app = express();
  app.use((req, _res, next) => {
    (req as express.Request & { session: unknown }).session = { userId: user.id, username: 'pve-down-owner', isAdmin: false };
    next();
  });
  app.use('/', websites.default);
  const retry = await request(app).post(`/sites/${row.id}/retry`);
  assert.equal(retry.status, 503, 'a retry is refused for now, not as a revocation');
});

test('API-mode reconciliation does not re-push a route whose upstream ownership cannot be verified', async () => {
  await testDb.db.delete(pveHosts);
  const { createCaddyClient } = await import('../utils/caddy.ts');
  const [user] = await testDb.db.insert(users).values({ username: 'recon-owner', password: 'unused' }).returning({ id: users.id });
  // Two hosts, both unreachable: which host the bare `pve` assignment lives on
  // is unknowable, so ownership is unknown rather than denied.
  const [hostA] = await testDb.db.insert(pveHosts).values({ name: 'recon-a', host: '127.0.0.1', port: 1, token_id: 't', token_secret: 'x' }).returning({ id: pveHosts.id });
  await testDb.db.insert(pveHosts).values({ name: 'recon-b', host: '127.0.0.1', port: 1, token_id: 't', token_secret: 'x' });
  await testDb.db.insert(vmAssignments).values({ user_id: user.id, node: 'pve', vmid: 404 });
  const [fw] = await testDb.db.insert(firewalls).values({ name: 'fw-recon', host: 'fw.test', api_key: 'x' }).returning({ id: firewalls.id });
  const [pool] = await testDb.db.insert(publicIpPools).values({ firewall_id: fw.id, name: 'pool-recon', external_interface: 'wan1' }).returning({ id: publicIpPools.id });
  const [ip] = await testDb.db.insert(publicIps).values({ pool_id: pool.id, firewall_id: fw.id, address: '203.0.113.44' }).returning({ id: publicIps.id });
  await testDb.db.insert(publicIpAssignments).values({
    public_ip_id: ip.id, firewall_id: fw.id, user_id: user.id, proxmox_host_id: hostA.id, node: 'pve', vmid: 404, private_ip: '172.16.44.4',
  });
  const [apiServer] = await testDb.db.insert(caddyServers).values({ name: 'recon-edge', api_url: 'http://127.0.0.1:1' }).returning();
  await testDb.db.insert(caddySites).values({
    server_id: apiServer.id, domain: 'recon.example.test', upstream_host: '172.16.44.4', upstream_port: 80,
    owner_user_id: user.id, managed: true, status: 'live',
  });

  const caddyProto = Object.getPrototypeOf(createCaddyClient(apiServer));
  const originals = { list: caddyProto.listManagedRouteIds, upsert: caddyProto.upsertRoute, conflicts: caddyProto.findConflicts };
  caddyProto.listManagedRouteIds = async () => [];
  caddyProto.findConflicts = async () => [];
  let upserts = 0;
  caddyProto.upsertRoute = async () => { upserts += 1; return { wildcard: '' }; };
  try {
    const memo = new Map();
    assert.deepEqual(await websites.findDisallowedSites(apiServer.id, memo), [], 'the sweep defers an unverifiable site');
    const { repaired, conflicted } = await websites.reconcileManagedRoutes(apiServer, memo);
    assert.equal(upserts, 0, 'reconciliation must not republish an unverified upstream');
    assert.deepEqual(repaired, []);
    assert.deepEqual(conflicted, []);
  } finally {
    Object.assign(caddyProto, { listManagedRouteIds: originals.list, upsertRoute: originals.upsert, findConflicts: originals.conflicts });
  }
});

test('API-mode reconciliation does not re-push a route whose ownership was definitely revoked by the scan', async () => {
  await testDb.db.delete(pveHosts);
  const { createCaddyClient } = await import('../utils/caddy.ts');
  const [user] = await testDb.db.insert(users).values({ username: 'recon-denied-owner', password: 'unused' }).returning({ id: users.id });
  // One host: the bare `pve` assignment resolves to it, and the IP row records
  // a different host id, so the upstream is a definite "no".
  const [host] = await testDb.db.insert(pveHosts).values({ name: 'recon-solo', host: '127.0.0.1', port: 1, token_id: 't', token_secret: 'x' }).returning({ id: pveHosts.id });
  await testDb.db.insert(vmAssignments).values({ user_id: user.id, node: 'pve', vmid: 405 });
  const [fw] = await testDb.db.insert(firewalls).values({ name: 'fw-recon-denied', host: 'fw.test', api_key: 'x' }).returning({ id: firewalls.id });
  const [pool] = await testDb.db.insert(publicIpPools).values({ firewall_id: fw.id, name: 'pool-recon-denied', external_interface: 'wan1' }).returning({ id: publicIpPools.id });
  const [ip] = await testDb.db.insert(publicIps).values({ pool_id: pool.id, firewall_id: fw.id, address: '203.0.113.45' }).returning({ id: publicIps.id });
  await testDb.db.insert(publicIpAssignments).values({
    public_ip_id: ip.id, firewall_id: fw.id, user_id: user.id, proxmox_host_id: host.id + 100, node: 'pve', vmid: 405, private_ip: '172.16.45.5',
  });
  const [apiServer] = await testDb.db.insert(caddyServers).values({ name: 'recon-denied-edge', api_url: 'http://127.0.0.1:1' }).returning();
  await testDb.db.insert(caddySites).values({
    server_id: apiServer.id, domain: 'recon-denied.example.test', upstream_host: '172.16.45.5', upstream_port: 80,
    owner_user_id: user.id, managed: true, status: 'live',
  });

  const caddyProto = Object.getPrototypeOf(createCaddyClient(apiServer));
  const originals = { list: caddyProto.listManagedRouteIds, upsert: caddyProto.upsertRoute, conflicts: caddyProto.findConflicts };
  caddyProto.listManagedRouteIds = async () => [];
  caddyProto.findConflicts = async () => [];
  let upserts = 0;
  caddyProto.upsertRoute = async () => { upserts += 1; return { wildcard: '' }; };
  try {
    const memo = new Map();
    const disallowed = await websites.findDisallowedSites(apiServer.id, memo);
    assert.equal(disallowed.length, 1, 'the scan revokes the site');
    const { repaired } = await websites.reconcileManagedRoutes(apiServer, memo);
    assert.equal(upserts, 0, 'the revoked upstream is not restored by reconciliation');
    assert.deepEqual(repaired, []);
  } finally {
    Object.assign(caddyProto, { listManagedRouteIds: originals.list, upsertRoute: originals.upsert, conflicts: originals.conflicts });
  }
});

test('authorization scans resolve each bare node once, not once per site or IP row', async () => {
  await testDb.db.delete(pveHosts);
  const [user] = await testDb.db.insert(users).values({ username: 'memo-owner', password: 'unused' }).returning({ id: users.id });
  const [host] = await testDb.db.insert(pveHosts).values({ name: 'memo-host', host: '127.0.0.1', port: 1, token_id: 't', token_secret: 'x' }).returning({ id: pveHosts.id });
  await testDb.db.insert(vmAssignments).values({ user_id: user.id, node: 'pve', vmid: 505 });
  const [fw] = await testDb.db.insert(firewalls).values({ name: 'fw-memo', host: 'fw.test', api_key: 'x' }).returning({ id: firewalls.id });
  const [pool] = await testDb.db.insert(publicIpPools).values({ firewall_id: fw.id, name: 'pool-memo', external_interface: 'wan1' }).returning({ id: publicIpPools.id });
  const ipRow = async (address: string, privateIp: string) => {
    const [ip] = await testDb.db.insert(publicIps).values({ pool_id: pool.id, firewall_id: fw.id, address }).returning({ id: publicIps.id });
    await testDb.db.insert(publicIpAssignments).values({
      public_ip_id: ip.id, firewall_id: fw.id, user_id: user.id, proxmox_host_id: host.id + 100, node: 'pve', vmid: 505, private_ip: privateIp,
    });
  };
  await ipRow('203.0.113.51', '172.16.51.1');
  await ipRow('203.0.113.52', '172.16.51.2');
  const [apiServer] = await testDb.db.insert(caddyServers).values({ name: 'memo-edge', api_url: 'http://127.0.0.1:1' }).returning();
  await testDb.db.insert(caddySites).values([
    { server_id: apiServer.id, domain: 'memo-a.example.test', upstream_host: '172.16.51.1', upstream_port: 80, owner_user_id: user.id, managed: true, status: 'live' },
    { server_id: apiServer.id, domain: 'memo-b.example.test', upstream_host: '172.16.51.2', upstream_port: 80, owner_user_id: user.id, managed: true, status: 'live' },
  ]);

  const memo = new Map();
  const disallowed = await websites.findDisallowedSites(apiServer.id, memo);
  assert.equal(disallowed.length, 2, 'both stale-IP sites are disallowed');
  assert.equal(memo.size, 1, 'the shared bare-node identity was resolved once for the whole scan');
});

test('a save during the certificate detach keeps the new state and is not finalized over', async () => {
  const { encryptSecret } = await import('../utils/secrets.ts');
  const { createClient } = await import('../fortigate.ts');
  const { createCaddyClient } = await import('../utils/caddy.ts');
  const [fw] = await testDb.db.insert(firewalls).values({ name: 'fw-claim-race', host: '127.0.0.1', api_key: encryptSecret('k') }).returning();
  const [apiServer] = await testDb.db.insert(caddyServers).values({ name: 'claim-race-edge', api_url: 'http://127.0.0.1:1' }).returning();
  const [row] = await testDb.db.insert(caddySites).values({
    server_id: apiServer.id, domain: 'claimrace.example.test', upstream_host: '192.168.9.9', upstream_port: 80,
    owner_user_id: ownerId, managed: true, status: 'live',
    fortigate_id: fw.id, inspection_profile: 'deep', cert_name: 'claimrace.example.test_2026-01-01',
  }).returning();
  await websites.markSitesUnpublished(await websites.findDisallowedSites(apiServer.id));

  const fortiProto = Object.getPrototypeOf(createClient(fw));
  const caddyProto = Object.getPrototypeOf(createCaddyClient(apiServer));
  const originals = { detach: fortiProto.detachInspectionServerCert, list: caddyProto.listManagedRouteIds, del: caddyProto.deleteRoute };
  caddyProto.listManagedRouteIds = async () => [];
  caddyProto.deleteRoute = async () => {};
  let detachCalls = 0;
  fortiProto.detachInspectionServerCert = async () => {
    detachCalls += 1;
    // The owner's save lands between the release claim and the detach, like
    // PUT /sites/:id clearing the detail while the firewall call is in flight.
    await testDb.db.update(caddySites).set({ upstream_host: '10.10.10.66', status: 'pushing', status_detail: '' })
      .where(eq(caddySites.id, row.id));
    return { removed: ['claimrace.example.test_2026-01-01'], remaining: ['other'] };
  };
  try {
    await websites.finishRevocations(apiServer);
    const [after] = await testDb.db.select().from(caddySites).where(eq(caddySites.id, row.id));
    assert.equal(after.status, 'pushing', 'the save wins; the release must not re-finalize over it');
    assert.equal(after.status_detail, '');
    assert.equal(detachCalls, 1, 'the detach ran against the row it claimed');
  } finally {
    fortiProto.detachInspectionServerCert = originals.detach;
    caddyProto.listManagedRouteIds = originals.list;
    caddyProto.deleteRoute = originals.del;
  }
});

test('a save or retry is refused while the certificate detach holds the row', async () => {
  const claimed = 'Being unpublished (releasing its certificate slot now): this upstream is no longer one you are allowed to proxy to. Point the site at an address in your VLAN and save it again.';
  const [row] = await testDb.db.insert(caddySites).values({
    server_id: serverId, domain: 'claimguard.example.test', upstream_host: '10.10.10.77', upstream_port: 80,
    owner_user_id: ownerId, managed: true, status: 'error', status_detail: claimed,
  }).returning();

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { session: unknown }).session = { userId: ownerId, username: 'site-owner', isAdmin: false };
    next();
  });
  app.use('/', websites.default);
  const save = await request(app).put(`/sites/${row.id}`).send({ upstreamHost: '10.10.10.77', upstreamPort: 80 });
  assert.equal(save.status, 409, 'a save cannot republish while the detach holds the row');
  const retry = await request(app).post(`/sites/${row.id}/retry`);
  assert.equal(retry.status, 409, 'a retry cannot republish while the detach holds the row');
  const [after] = await testDb.db.select().from(caddySites).where(eq(caddySites.id, row.id));
  assert.equal(after.status_detail, claimed);
});

test('a revocation completed during the certificate poll blocks the inspection attach', async () => {
  const { encryptSecret } = await import('../utils/secrets.ts');
  const { createClient } = await import('../fortigate.ts');
  const { createCaddyClient, managedRouteId } = await import('../utils/caddy.ts');
  const [user] = await testDb.db.insert(users).values({ username: 'poll-owner', password: 'unused' }).returning({ id: users.id });
  const [vlan] = await testDb.db.insert(vlans).values({ name: 'poll', tag: 1060, mode: 'managed', subnet_cidr: '' }).returning({ id: vlans.id });
  await testDb.db.insert(userVlans).values({ user_id: user.id, vlan_id: vlan.id });
  const [fw] = await testDb.db.insert(firewalls).values({ name: 'fw-poll', host: '127.0.0.1', api_key: encryptSecret('k') }).returning();
  const [apiServer] = await testDb.db.insert(caddyServers).values({ name: 'poll-edge', api_url: 'http://127.0.0.1:1' }).returning();
  const [row] = await testDb.db.insert(caddySites).values({
    server_id: apiServer.id, domain: 'poll.example.test', upstream_host: '10.10.60.5', upstream_port: 80,
    owner_user_id: user.id, managed: true, status: 'pushing',
    fortigate_id: fw.id, inspection_profile: 'deep',
  }).returning();

  const fortiProto = Object.getPrototypeOf(createClient(fw));
  const caddyProto = Object.getPrototypeOf(createCaddyClient(apiServer));
  const originals = {
    getLocal: fortiProto.getLocalCertificates, attach: fortiProto.setInspectionServerCert,
    detach: fortiProto.detachInspectionServerCert,
    list: caddyProto.listManagedRouteIds, del: caddyProto.deleteRoute,
    upsert: caddyProto.upsertRoute, conflicts: caddyProto.findConflicts,
  };
  const live = new Set();
  caddyProto.listManagedRouteIds = async () => [...live];
  caddyProto.deleteRoute = async (id) => { live.delete(managedRouteId(id)); };
  caddyProto.upsertRoute = async (id) => { live.add(managedRouteId(id)); return { wildcard: '' }; };
  caddyProto.findConflicts = async () => [];
  let attachCalls = 0;
  fortiProto.setInspectionServerCert = async () => { attachCalls += 1; return { action: 'append', occupied: [] }; };
  fortiProto.detachInspectionServerCert = async () => ({ removed: ['poll.example.test_2026-01-01'], remaining: [] });
  let revoked = false;
  fortiProto.getLocalCertificates = async () => {
    if (!revoked) {
      revoked = true;
      // Access is lost and a full sweep+cleanup finalizes the revocation while
      // the flow polls for the certificate.
      await testDb.db.delete(userVlans).where(eq(userVlans.user_id, user.id));
      await websites.markSitesUnpublished(await websites.findDisallowedSites(apiServer.id));
      await websites.finishRevocations(apiServer);
    }
    return [{ name: 'poll.example.test_2026-01-01' }];
  };
  try {
    await websites.runSiteFlow(row.id);
    const [after] = await testDb.db.select().from(caddySites).where(eq(caddySites.id, row.id));
    assert.equal(attachCalls, 0, 'the flow must not attach a cert to a row revoked mid-poll');
    assert.equal(after.status, 'error');
    assert.ok(after.status_detail.startsWith('Being unpublished'), 'the revocation is re-armed after the skipped attach');
    await websites.finishRevocations(apiServer);
    const [done] = await testDb.db.select().from(caddySites).where(eq(caddySites.id, row.id));
    assert.ok(done.status_detail.startsWith('Unpublished'), 'the next tick finalizes the site');
    assert.equal(live.size, 0, 'the route the stale push installed is removed');
  } finally {
    Object.assign(fortiProto, {
      getLocalCertificates: originals.getLocal, setInspectionServerCert: originals.attach,
      detachInspectionServerCert: originals.detach,
    });
    Object.assign(caddyProto, {
      listManagedRouteIds: originals.list, deleteRoute: originals.del,
      upsertRoute: originals.upsert, findConflicts: originals.conflicts,
    });
  }
});

test('a certificate release claimed by a pass that died is handed back for retry on startup', async () => {
  const claimed = 'Being unpublished (releasing its certificate slot now): this upstream is no longer one you are allowed to proxy to. Point the site at an address in your VLAN and save it again.';
  const [row] = await testDb.db.insert(caddySites).values({
    server_id: serverId, domain: 'dead-claim.example.test', upstream_host: '192.168.9.9', upstream_port: 80,
    owner_user_id: ownerId, managed: true, status: 'error', status_detail: claimed,
  }).returning({ id: caddySites.id });
  const recovered = await websites.recoverClaimedReleases();
  assert.ok(recovered.some((r) => r.id === row.id));
  const [after] = await testDb.db.select().from(caddySites).where(eq(caddySites.id, row.id));
  assert.ok(after.status_detail.startsWith('Being unpublished (releasing its certificate slot):'));
  assert.deepEqual(await websites.recoverClaimedReleases(), [], 'nothing left to recover');
});
