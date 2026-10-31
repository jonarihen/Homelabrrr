// PUT /servers/:id: leaving Caddyfile mode must first empty the Homelabrrr
// snippet, or snippet routes (no managed @id) outlive the switch (#330).
// Run with:  node --test src/routes/websitesModeSwitch.test.ts   (from backend/)
import test, { before, after, type TestContext } from 'node:test';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { Client as SSHClient } from 'ssh2';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '../testUtils/pgTestDb.ts';
import { caddyServers, caddySites } from '../db/schema/index.ts';

let testDb: TestDatabase;
let app: express.Express;
let closeDb: (() => Promise<void>) | undefined;
let generateSnippet: (sites: unknown[]) => string;
let CaddyClient: { prototype: Record<string, unknown> };

const readServer = async (id: number) => (await testDb.db.select().from(caddyServers).where(eq(caddyServers.id, id)))[0];
const snippetPath = '/etc/caddy/homelabrrr.caddy';

function mockCaddyHost(t: TestContext, options: {
  fail?: 'validate' | 'reload';
  rollbackFails?: boolean;
  beforeWrite?: () => Promise<void>;
  hangFirstMv?: boolean;
} = {}) {
  const previous = 'old.example.test {\n\treverse_proxy 192.0.2.1:80\n}\n';
  const files = new Map([[snippetPath, previous]]);
  const deployments: string[] = [];
  const commands: string[] = [];
  let hung = false;
  t.mock.method(SSHClient.prototype, 'connect', function () {
    queueMicrotask(() => this.emit('ready'));
    return this;
  });
  t.mock.method(SSHClient.prototype, 'end', function () { return this; });
  t.mock.method(SSHClient.prototype, 'sftp', (callback) => callback(null, {
    readFile(path, cb) { cb(null, Buffer.from(files.get(path) ?? '')); },
    writeFile(path, content, _attrs, cb) {
      Promise.resolve().then(async () => {
        await options.beforeWrite?.();
        if (options.rollbackFails && deployments.length > 0) return cb(new Error('rollback write refused'));
        files.set(path, content);
        cb(null);
      }).catch(cb);
    },
  }));
  t.mock.method(SSHClient.prototype, 'exec', (_command, callback) => {
    const command = String(_command);
    commands.push(command);
    const stream = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
    stream.stderr = new EventEmitter();
    callback(null, stream);
    queueMicrotask(() => {
      let code = 0;
      if (command.startsWith('mv ') && options.hangFirstMv && !hung) { hung = true; return; }
      if (command.startsWith('mv ')) {
        const content = files.get(`${snippetPath}.tmp`)!;
        files.set(snippetPath, content);
        files.delete(`${snippetPath}.tmp`);
        deployments.push(content);
      } else if (options.fail && command.startsWith(`caddy ${options.fail} `)) {
        code = 1;
        stream.stderr.emit('data', 'Caddy rejected the config');
      }
      stream.emit('close', code);
    });
  });
  return { previous, files, deployments, commands };
}

async function seedSnippetServer(withSite = false) {
  const { encryptSecret } = await import('../utils/secrets.ts');
  const [{ id }] = await testDb.db.insert(caddyServers).values({
    name: 'caddy-test-host', api_url: 'http://127.0.0.1:1', ssh_host: '127.0.0.1', ssh_user: 'caddy',
    ssh_auth_type: 'password', ssh_secret: encryptSecret('test-password'),
  }).returning({ id: caddyServers.id });
  if (withSite) {
    await testDb.db.insert(caddySites).values({
      server_id: id, domain: `site-${id}.example.test`, upstream_host: '192.0.2.1', upstream_port: 80, status: 'pending',
    });
  }
  return id;
}

async function holdFirstServerRead(t: TestContext) {
  const { pool } = await import('../db/client.ts');
  const query = pool.query.bind(pool);
  const loaded = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let held = false;
  t.mock.method(pool, 'query', async (...args) => {
    const result = await query(...args);
    if (!held && String(args[0]?.text).startsWith('select ') && String(args[0]?.text).includes('from "caddy_servers"')) {
      held = true;
      loaded.resolve();
      await release.promise;
    }
    return result;
  });
  return { loaded: loaded.promise, release: () => release.resolve() };
}

before(async () => {
  testDb = await createTestDatabase();
  process.env.DATABASE_URL = testDb.url;
  process.env.SECRET_ENCRYPTION_KEY ||= '88'.repeat(32);
  ({ closeDb } = await import('../db/client.ts'));
  ({ generateSnippet } = await import('../utils/caddySnippet.ts'));
  ({ CaddyClient } = await import('../utils/caddy.ts'));

  const router = (await import('./websites.ts')).default;
  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { userId: 1, username: 'operator', isAdmin: true, reauthenticatedAt: Date.now() } as never;
    next();
  });
  app.use('/', router);
});

after(async () => {
  await closeDb?.();
  await testDb?.drop();
});

test('clearing sshHost is refused when the snippet cannot be emptied', async () => {
  const { encryptSecret } = await import('../utils/secrets.ts');
  // Port 1 on loopback refuses the SSH connection immediately.
  const [{ id }] = await testDb.db.insert(caddyServers).values({
    name: 'caddy-snippet', api_url: 'http://127.0.0.1:1', ssh_host: '127.0.0.1', ssh_port: 1, ssh_user: 'caddy',
    ssh_secret: encryptSecret('not-a-real-key'),
  }).returning({ id: caddyServers.id });

  const res = await request(app).put(`/servers/${id}`).send({ sshHost: '' });
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.match(res.body.error, /left in Caddyfile mode/);
  const row = await readServer(id);
  assert.equal(row.ssh_host, '127.0.0.1');
});

for (const fail of ['validate', 'reload'] as const) {
  test(`failed ${fail} restores the previous snippet and leaves the server in Caddyfile mode`, async (t) => {
    const host = mockCaddyHost(t, { fail });
    const id = await seedSnippetServer();
    const res = await request(app).put(`/servers/${id}`).send({ sshHost: '' });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.match(res.body.error, /Previous snippet restored/);
    assert.deepEqual(host.deployments, [generateSnippet([]), host.previous]);
    assert.equal(host.files.get(snippetPath), host.previous);
    assert.equal((await readServer(id)).ssh_host, '127.0.0.1');
    if (fail === 'validate') assert.ok(!host.commands.some((command) => command.startsWith('caddy reload ')));
  });
}

test('a failed rollback is reported without claiming that the snippet was restored', async (t) => {
  const host = mockCaddyHost(t, { fail: 'reload', rollbackFails: true });
  const id = await seedSnippetServer();
  const res = await request(app).put(`/servers/${id}`).send({ sshHost: '' });
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.match(res.body.error, /Could not restore the previous snippet/);
  assert.doesNotMatch(res.body.error, /Previous snippet restored/);
  assert.equal(host.files.get(snippetPath), generateSnippet([]));
  assert.equal((await readServer(id)).ssh_host, '127.0.0.1');
});

test('a mode switch waits for an active snippet writer before clearing the snippet', async (t) => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let writes = 0;
  const host = mockCaddyHost(t, { beforeWrite: async () => {
    if (writes++ !== 0) return;
    entered.resolve();
    await release.promise;
  } });
  const id = await seedSnippetServer(true);
  const writer = request(app).post(`/servers/${id}/sync`).then((res) => res);
  await entered.promise;
  const switching = request(app).put(`/servers/${id}`).send({ sshHost: '' }).then((res) => res);
  try {
    await Promise.race([switching, delay(100)]);
  } finally { release.resolve(); }
  assert.equal((await writer).status, 200);
  assert.equal((await switching).status, 200);
  assert.equal(host.deployments.length, 2);
  assert.match(host.deployments[0], new RegExp(`site-${id}\\.example\\.test`));
  assert.equal(host.deployments.at(-1), generateSnippet([]));
  assert.equal(host.files.get(snippetPath), generateSnippet([]));
  assert.equal((await readServer(id)).ssh_host, '');
});

test('a manual sync holding an old server snapshot is refused after the mode switch', async (t) => {
  const host = mockCaddyHost(t);
  const id = await seedSnippetServer(true);
  const hold = await holdFirstServerRead(t);
  const writer = request(app).post(`/servers/${id}/sync`).then((res) => res);
  await hold.loaded;
  try {
    const res = await request(app).put(`/servers/${id}`).send({ sshHost: '' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  } finally { hold.release(); }
  const res = await writer;
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.match(res.body.error, /no longer in Caddyfile mode/);
  assert.deepEqual(host.deployments, [generateSnippet([])]);
  assert.equal(host.files.get(snippetPath), generateSnippet([]));
  assert.equal((await readServer(id)).ssh_host, '');
});

test('a site flow that loaded the server before the mode switch publishes through the API instead', async (t) => {
  const host = mockCaddyHost(t);
  const pushed: unknown[] = [];
  t.mock.method(CaddyClient.prototype, 'findWildcardSlot', async () => null);
  t.mock.method(CaddyClient.prototype, 'findConflicts', async () => []);
  t.mock.method(CaddyClient.prototype, 'upsertRoute', async (siteId) => {
    pushed.push(siteId);
    return { wildcard: '', serverName: 'srv0' };
  });
  const id = await seedSnippetServer(true);
  const [site] = await testDb.db.select().from(caddySites).where(eq(caddySites.server_id, id));
  const hold = await holdFirstServerRead(t);
  const retry = await request(app).post(`/sites/${site.id}/retry`);
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  await hold.loaded;
  try {
    const res = await request(app).put(`/servers/${id}`).send({ sshHost: '' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  } finally { hold.release(); }
  const deadline = Date.now() + 10_000;
  let row = site;
  while (Date.now() < deadline) {
    [row] = await testDb.db.select().from(caddySites).where(eq(caddySites.id, site.id));
    if (row.status !== 'pushing') break;
    await delay(25);
  }
  assert.notEqual(row.status, 'pushing');
  assert.deepEqual(pushed, [site.id]);
  assert.deepEqual(host.deployments, [generateSnippet([])]);
  assert.equal(host.files.get(snippetPath), generateSnippet([]));
});

test('a server without a stored SSH credential switches to API mode directly', async () => {
  const [{ id }] = await testDb.db.insert(caddyServers).values({
    name: 'caddy-never-deployed', api_url: 'http://127.0.0.1:1', ssh_host: '127.0.0.1', ssh_port: 1, ssh_user: 'caddy',
  }).returning({ id: caddyServers.id });

  const res = await request(app).put(`/servers/${id}`).send({ sshHost: '' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal((await readServer(id)).ssh_host, '');
});

test('in-flight sites are re-published through the API when leaving Caddyfile mode', async (t) => {
  mockCaddyHost(t);
  const pushed: unknown[] = [];
  t.mock.method(CaddyClient.prototype, 'listManagedRouteIds', async () => []);
  t.mock.method(CaddyClient.prototype, 'findConflicts', async () => []);
  t.mock.method(CaddyClient.prototype, 'findWildcardSlot', async () => null);
  t.mock.method(CaddyClient.prototype, 'upsertRoute', async (siteId) => {
    pushed.push(siteId);
    return { wildcard: '', serverName: 'srv0' };
  });
  const id = await seedSnippetServer(true);
  const [site] = await testDb.db.select().from(caddySites).where(eq(caddySites.server_id, id));
  await testDb.db.update(caddySites).set({ status: 'issuing' }).where(eq(caddySites.id, site.id));
  const res = await request(app).put(`/servers/${id}`).send({ sshHost: '' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(pushed, [site.id]);
});

test('a failed database update restores the snippet that was emptied', async (t) => {
  const host = mockCaddyHost(t);
  const id = await seedSnippetServer(true);
  const { db } = await import('../db/client.ts');
  const update = db.update.bind(db);
  t.mock.method(db, 'update', (table) => {
    if (table === caddyServers) throw new Error('connection reset');
    return update(table);
  });
  const res = await request(app).put(`/servers/${id}`).send({ sshHost: '' });
  assert.equal(res.status, 500, JSON.stringify(res.body));
  assert.equal(host.deployments.length, 2);
  assert.equal(host.deployments[0], generateSnippet([]));
  assert.match(host.files.get(snippetPath)!, new RegExp(`site-${id}\\.example\\.test`));
  assert.equal((await readServer(id)).ssh_host, '127.0.0.1');
});

test('a stalled SSH operation times out and releases the per-server lock', async (t) => {
  process.env.CADDY_SSH_OP_TIMEOUT_MS = '150';
  t.after(() => { delete process.env.CADDY_SSH_OP_TIMEOUT_MS; });
  const host = mockCaddyHost(t, { hangFirstMv: true });
  const id = await seedSnippetServer(true);
  const first = await request(app).post(`/servers/${id}/sync`);
  assert.notEqual(first.status, 200);
  assert.match(JSON.stringify(first.body), /timed out/);
  const second = await request(app).post(`/servers/${id}/sync`);
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(host.deployments.length, 1);
});
