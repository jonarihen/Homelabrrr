import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestDatabase, type TestDatabase } from '../testUtils/pgTestDb.ts';
import { users, notificationWebhooks } from '../db/schema/index.ts';

// notify.ts reads through the singleton db (src/db/client.ts), which requires
// DATABASE_URL at import time — so the module (and secrets.ts, which reads
// SECRET_ENCRYPTION_KEY at import time) is imported dynamically after the
// throwaway database exists and the env is set.
let testDb: TestDatabase;
let tmpDir: string;
let notifyMod: typeof import('./notify.ts');
let closeDb: (() => Promise<void>) | undefined;

// Local capture server standing in for Discord.
let server: http.Server;
let baseUrl: string;
const received: { path: string; body: any }[] = [];

// Fixture ids
let optedOutUserId: number;
let normalUserId: number;

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for webhook delivery');
    await new Promise((r) => setTimeout(r, 25));
  }
}

before(async () => {
  testDb = await createTestDatabase();
  process.env.DATABASE_URL = testDb.url;
  process.env.SECRET_ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef';

  // notify.ts transitively imports proxmox.ts → the legacy SQLite db.ts,
  // which still initializes (and bootstraps an admin) at import time
  // mid-branch. Point it at a scratch file and satisfy its env requirements.
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homelabrrr-notify-test-'));
  process.env.DB_PATH = path.join(tmpDir, 'legacy.sqlite');
  process.env.INITIAL_ADMIN_USERNAME ||= 'admin';
  process.env.INITIAL_ADMIN_PASSWORD ||= 'test-admin-password';

  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received.push({ path: req.url || '', body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      res.writeHead(204).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;

  ({ closeDb } = await import('../db/client.ts'));
  const { encryptSecret } = await import('./secrets.ts');
  notifyMod = await import('./notify.ts');

  const inserted = await testDb.db.insert(users).values([
    { username: 'optout', password: 'x', notify_opt_out: true },
    { username: 'normal', password: 'x', notify_opt_out: false },
  ]).returning({ id: users.id });
  optedOutUserId = inserted[0].id;
  normalUserId = inserted[1].id;

  await testDb.db.insert(notificationWebhooks).values([
    // Encrypted URL, matching events — should receive.
    { name: 'match', url: encryptSecret(`${baseUrl}/hook-match`), event_types: ['backup.created', 'node.unreachable'], enabled: true },
    // Enabled but subscribed to a different event — must stay silent.
    { name: 'other', url: encryptSecret(`${baseUrl}/hook-other`), event_types: ['deployment.failed'], enabled: true },
    // Matching events but disabled — must stay silent.
    { name: 'disabled', url: encryptSecret(`${baseUrl}/hook-disabled`), event_types: ['backup.created'], enabled: false },
    // Legacy plaintext URL (pre-encryption row) — decryptSecret passes it through.
    { name: 'plain', url: `${baseUrl}/hook-plain`, event_types: ['backup.created'], enabled: true },
  ]);
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  try { await closeDb?.(); } catch { /* final test already closed the pool */ }
  await testDb.drop();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('unknown event type resolves without sending anything', async () => {
  await notifyMod.notify('no.such.event', { detail: 'x' });
  assert.equal(received.length, 0);
});

test('owner opt-out suppresses owner-scoped events; others deliver with embed', async () => {
  // Suppressed event first, control event second: both target the same
  // webhook queues (FIFO), so the control arriving alone proves suppression.
  await notifyMod.notify('backup.created', { ownerUserId: optedOutUserId, vm: 'suppressed-vm' });
  await notifyMod.notify('backup.created', {
    ownerUserId: normalUserId, vm: 'vm-101', owner: 'normal', status: 'ok', detail: 'Backup done',
  });

  await waitFor(() => received.filter((r) => r.path === '/hook-match').length >= 1
    && received.filter((r) => r.path === '/hook-plain').length >= 1);

  const match = received.filter((r) => r.path === '/hook-match');
  assert.equal(match.length, 1);
  const embed = match[0].body.embeds[0];
  assert.equal(embed.title, 'Backup created');
  assert.equal(embed.description, 'Backup done');
  assert.deepEqual(
    embed.fields.map((f: any) => [f.name, f.value]),
    [['VM', 'vm-101'], ['Owner', 'normal'], ['Status', 'ok']]
  );

  // Legacy plaintext URL delivered too; non-matching/disabled hooks were
  // filtered inside notify() before any enqueue, so nothing can arrive later.
  assert.equal(received.filter((r) => r.path === '/hook-plain').length, 1);
  assert.equal(received.filter((r) => r.path === '/hook-other').length, 0);
  assert.equal(received.filter((r) => r.path === '/hook-disabled').length, 0);
});

test('non-owner-scoped events ignore the opt-out flag', async () => {
  const countBefore = received.filter((r) => r.path === '/hook-match').length;
  await notifyMod.notify('node.unreachable', { ownerUserId: optedOutUserId, domain: 'pve1', status: 'unreachable' });
  await waitFor(() => received.filter((r) => r.path === '/hook-match').length > countBefore);
  const latest = received.filter((r) => r.path === '/hook-match').at(-1)!;
  assert.equal(latest.body.embeds[0].title, 'Node unreachable');
});

test('portalLink builds absolute links from PORTAL_BASE_URL', () => {
  const prev = process.env.PORTAL_BASE_URL;
  process.env.PORTAL_BASE_URL = 'https://portal.example/';
  try {
    assert.equal(notifyMod.portalLink('/welcome'), 'https://portal.example/welcome');
    assert.equal(notifyMod.portalLink('welcome'), 'https://portal.example/welcome');
    assert.equal(notifyMod.portalLink(), 'https://portal.example');
  } finally {
    if (prev === undefined) delete process.env.PORTAL_BASE_URL;
    else process.env.PORTAL_BASE_URL = prev;
  }
});

// Must run last: notify()'s promise never rejects, even when the DB is gone.
test('notify resolves when the database is unreachable', async () => {
  await closeDb?.();
  await notifyMod.notify('backup.created', { ownerUserId: normalUserId, vm: 'vm-x' });
});
