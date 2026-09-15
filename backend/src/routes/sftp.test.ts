import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import ssh2 from 'ssh2';
import { requestContext } from '../utils/logger.ts';
import { createTestDatabase } from '../testUtils/pgTestDb.ts';

const { Server, utils } = ssh2;
const { STATUS_CODE } = utils.sftp;

// The router imports the Drizzle client and the secret helpers at load time, so
// both need to be satisfied before the dynamic import below. Nothing these
// tests touch queries PostgreSQL — every error path answers before the audit
// write — but the module must load.
process.env.SECRET_ENCRYPTION_KEY = '44'.repeat(32);
const testDb = await createTestDatabase();
process.env.DATABASE_URL = testDb.url;
const { default: sftpRouter, sftpSessions } = await import('./sftp.ts');

const USER_ID = 7;

/**
 * An SFTP subsystem that answers every request with a chosen status. Real
 * servers return these for an absent path, a directory that already exists, a
 * denied operation or a directory that still has children — the exact cases
 * where the route's error callbacks run.
 */
let plan: Record<string, { code: number; message?: string }> = {};
let liveConnections = 0;

const hostKey = utils.generateKeyPairSync('ed25519');
const clientKey = utils.generateKeyPairSync('ed25519');
const hostFingerprint = `SHA256:${createHash('sha256')
  .update(Buffer.from(String(hostKey.public).split(' ')[1], 'base64'))
  .digest('base64')}`;

const server = new Server({ hostKeys: [hostKey.private] }, (client) => {
  liveConnections += 1;
  client.on('close', () => { liveConnections -= 1; });
  client.on('error', () => { /* the route hangs up mid-session on failure */ });
  client.on('authentication', (ctx) => ctx.accept());
  client.on('ready', () => {
    client.on('session', (accept) => {
      const session = accept();
      session.on('sftp', (accept) => {
        const sftp = accept();
        // REALPATH always fails: the listing route deliberately swallows that
        // one and falls back to the requested path, which keeps this fixture
        // honest about which promise is under test.
        const answer = (event: string) => (reqid: number) => {
          const { code, message } = plan[event] || { code: STATUS_CODE.NO_SUCH_FILE };
          sftp.status(reqid, code, message);
        };
        for (const event of ['REALPATH', 'OPENDIR', 'READDIR', 'STAT', 'LSTAT', 'OPEN', 'MKDIR', 'REMOVE', 'RMDIR']) {
          sftp.on(event, answer(event));
        }
      });
    });
  });
});

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
const { port } = server.address() as { port: number };

const TOKEN = 'sftp-error-path-token';
sftpSessions.set(TOKEN, {
  userId: USER_ID,
  sessionId: 'test-session',
  node: 'host1~pve1',
  vmid: '101',
  host: '127.0.0.1',
  port,
  username: 'tester',
  hostFingerprint,
  privateKey: clientKey.private,
  passphrase: '',
  expires: Date.now() + 60 * 60 * 1000,
});

test.after(async () => {
  sftpSessions.delete(TOKEN);
  server.close();
  await testDb.drop();
});

function app() {
  const instance = express();
  instance.use(requestContext, express.json());
  instance.use((req, _res, next) => {
    (req as express.Request & { session: unknown }).session = { userId: USER_ID, username: 'operator', isAdmin: false };
    next();
  });
  instance.use('/api/sftp', sftpRouter);
  return instance;
}

/** The route closes the SSH connection in its `finally`; give the FIN a tick. */
async function waitForConnectionsToClose() {
  for (let attempt = 0; attempt < 100 && liveConnections > 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(liveConnections, 0, 'SSH connection was left open after a failed SFTP operation');
}

const REMOTE_PATH = '/srv/private/missing';

// Each case is an upstream SFTP failure that reaches an asynchronous error
// callback. Before the fix these threw `ReferenceError: reject is not defined`
// out of the ssh2 callback, past the route's try/catch, and took the process
// down instead of answering.
const cases = [
  {
    name: 'listing a directory that does not exist',
    plan: { OPENDIR: { code: STATUS_CODE.NO_SUCH_FILE } },
    send: () => request(app()).post('/api/sftp/ls').send({ token: TOKEN, path: REMOTE_PATH }),
    status: 404,
    code: 'SFTP_PATH_NOT_FOUND',
  },
  {
    name: 'listing a directory the remote user may not read',
    plan: { OPENDIR: { code: STATUS_CODE.PERMISSION_DENIED } },
    send: () => request(app()).post('/api/sftp/ls').send({ token: TOKEN, path: REMOTE_PATH }),
    status: 403,
    code: 'SFTP_PERMISSION_DENIED',
  },
  {
    name: 'downloading a file that does not exist',
    plan: { STAT: { code: STATUS_CODE.NO_SUCH_FILE } },
    send: () => request(app()).get('/api/sftp/download').query({ token: TOKEN, path: REMOTE_PATH }),
    status: 404,
    code: 'SFTP_PATH_NOT_FOUND',
  },
  {
    name: 'creating a directory that already exists',
    plan: { MKDIR: { code: STATUS_CODE.FAILURE, message: 'File already exists' } },
    send: () => request(app()).post('/api/sftp/mkdir').send({ token: TOKEN, path: REMOTE_PATH }),
    status: 409,
    code: 'SFTP_PATH_EXISTS',
  },
  {
    name: 'deleting a file that does not exist',
    plan: { REMOVE: { code: STATUS_CODE.NO_SUCH_FILE } },
    send: () => request(app()).post('/api/sftp/delete').send({ token: TOKEN, path: REMOTE_PATH }),
    status: 404,
    code: 'SFTP_PATH_NOT_FOUND',
  },
  {
    name: 'deleting a directory that is not empty',
    plan: { RMDIR: { code: STATUS_CODE.FAILURE, message: 'Directory not empty' } },
    send: () => request(app()).post('/api/sftp/delete').send({ token: TOKEN, path: REMOTE_PATH, isDirectory: true }),
    status: 500,
    code: 'SFTP_OPERATION_FAILED',
  },
];

for (const scenario of cases) {
  test(`SFTP error callbacks answer instead of crashing when ${scenario.name}`, async () => {
    plan = scenario.plan;
    const response = await scenario.send();

    assert.equal(response.status, scenario.status);
    assert.equal(response.body.code, scenario.code);
    assert.ok(response.body.requestId, 'sanitized SFTP errors carry a request ID');

    // Bounded and sanitized: no upstream text, no target, no key material.
    const body = JSON.stringify(response.body);
    assert.ok(body.length < 512, 'error payload stays bounded');
    assert.doesNotMatch(body, /127\.0\.0\.1|srv|private|missing|OPENSSH|tester/i);

    await waitForConnectionsToClose();
  });
}

test('the SFTP routes keep serving after an upstream failure', async () => {
  plan = { OPENDIR: { code: STATUS_CODE.NO_SUCH_FILE } };
  assert.equal((await request(app()).post('/api/sftp/ls').send({ token: TOKEN, path: REMOTE_PATH })).status, 404);
  // Same process, same session, a second time — a crash path would never get here.
  assert.equal((await request(app()).post('/api/sftp/ls').send({ token: TOKEN, path: REMOTE_PATH })).status, 404);
  await waitForConnectionsToClose();
});
