import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { request as httpRequest } from 'node:http';
import { posix } from 'node:path';
import express from 'express';
import request from 'supertest';
import ssh2 from 'ssh2';
import { requestContext } from '../utils/logger.ts';
import { createTestDatabase } from '../testUtils/pgTestDb.ts';
import { users } from '../db/schema/index.ts';

process.env.SECRET_ENCRYPTION_KEY = '88'.repeat(32);
const testDb = await createTestDatabase();
process.env.DATABASE_URL = testDb.url;
const { default: sftpRouter, sftpSessions } = await import('./sftp.ts');
const { closeDb } = await import('../db/client.ts');
const [{ id: userId }] = await testDb.db.insert(users).values({ username: 'uploader', password: 'unused' }).returning();

const TOKEN = 'sftp-upload-token';
const REMOTE_PATH = '/srv/files/example.txt';
const ORIGINAL = Buffer.from('original contents');
const REPLACEMENT = Buffer.from('replacement contents');

sftpSessions.set(TOKEN, {
  userId, sessionId: 'upload-session', node: 'host1~pve1', vmid: '101',
  expires: Date.now() + 60 * 60 * 1000,
});

test.after(async () => {
  sftpSessions.delete(TOKEN);
  await closeDb();
  await testDb.drop();
});

function app(capture?: (req: express.Request, res: express.Response) => void) {
  const instance = express();
  instance.use(requestContext);
  instance.use((req, res, next) => {
    req.session = { userId, username: 'uploader', isAdmin: false };
    req.sessionID = 'upload-session';
    capture?.(req, res);
    next();
  });
  instance.use('/api/sftp', sftpRouter);
  return instance;
}

type Plan = {
  extension?: 'supported' | 'unadvertised' | 'unsupported' | 'missing';
  openError?: boolean;
  writeError?: boolean;
  closeError?: boolean;
  renameError?: boolean;
  holdRename?: boolean;
  holdOpen?: boolean;
};

function fixture(t: test.TestContext, plan: Plan = {}, existing = true) {
  const files = new Map<string, Buffer>(existing ? [[REMOTE_PATH, ORIGINAL]] : []);
  const opened: string[] = [];
  const removed: string[] = [];
  const renamed: Array<{ kind: string; from: string; to: string }> = [];
  const events: string[] = [];
  let stream: Writable;
  let ends = 0;
  let releaseRename: () => void;
  let releaseOpen: () => void;
  let wrote: () => void;
  const written = new Promise<void>((resolve) => { wrote = resolve; });
  let openRequested: () => void;
  const opening = new Promise<void>((resolve) => { openRequested = resolve; });
  const error = (message: string, code = ssh2.utils.sftp.STATUS_CODE.FAILURE) => Object.assign(new Error(message), { code });

  const rename = (kind: string, from: string, to: string, cb: (err?: Error) => void) => {
    renamed.push({ kind, from, to });
    releaseRename = () => {
      if (plan.renameError) return cb(error('Permission denied', ssh2.utils.sftp.STATUS_CODE.PERMISSION_DENIED));
      if (kind === 'plain' && files.has(to)) return cb(error('File already exists'));
      assert.ok(files.has(from));
      files.set(to, files.get(from)!);
      files.delete(from);
      events.push('renamed');
      cb();
    };
    if (!plan.holdRename) queueMicrotask(releaseRename);
  };

  const sftp = {
    open(path: string, flags: string, cb: (err: Error | null, handle?: Buffer) => void) {
      assert.equal(flags, 'wx');
      assert.equal(posix.dirname(path), posix.dirname(REMOTE_PATH));
      assert.notEqual(path, REMOTE_PATH);
      assert.match(posix.basename(path), /^\.homelabrrr-upload-[\da-f-]+\.tmp$/);
      opened.push(path);
      releaseOpen = () => {
        if (plan.openError) {
          files.set(path, Buffer.from('unrelated existing temp'));
          return cb(error('File already exists'));
        }
        assert.equal(files.has(path), false);
        files.set(path, Buffer.alloc(0));
        cb(null, Buffer.from(path));
      };
      openRequested();
      if (!plan.holdOpen) queueMicrotask(releaseOpen);
    },
    close(handle: Buffer, cb: () => void) {
      assert.ok(files.has(handle.toString()));
      events.push('closed');
      queueMicrotask(cb);
    },
    createWriteStream(path: string, options: { handle: Buffer }) {
      assert.equal(options.handle.toString(), path);
      stream = new Writable({
        autoDestroy: true,
        write(chunk, _encoding, cb) {
          if (plan.writeError) return cb(error('Write failed'));
          files.set(path, Buffer.concat([files.get(path)!, chunk]));
          wrote();
          cb();
        },
        destroy(err, cb) {
          events.push('closed');
          cb(plan.closeError ? error('Close failed') : err);
        },
      });
      return stream;
    },
    unlink(path: string, cb: () => void) {
      removed.push(path);
      assert.notEqual(path, REMOTE_PATH);
      files.delete(path);
      queueMicrotask(cb);
    },
    rename(from: string, to: string, cb: (err?: Error) => void) {
      rename('plain', from, to, cb);
    },
    ext_openssh_rename: plan.extension === 'missing' ? undefined : (from: string, to: string, cb: (err?: Error) => void) => {
      if (plan.extension === 'unadvertised') throw new Error('Server does not support this extended request');
      if (plan.extension === 'unsupported') {
        return queueMicrotask(() => cb(error('Unsupported', ssh2.utils.sftp.STATUS_CODE.OP_UNSUPPORTED)));
      }
      rename('posix', from, to, cb);
    },
  };

  t.mock.method(ssh2.Client.prototype, 'connect', function () {
    queueMicrotask(() => this.emit('ready'));
    return this;
  });
  t.mock.method(ssh2.Client.prototype, 'sftp', (cb) => queueMicrotask(() => cb(null, sftp)));
  t.mock.method(ssh2.Client.prototype, 'end', function () {
    ends += 1;
    events.push('ended');
    return this;
  });

  return {
    files, opened, removed, renamed, events, written, opening,
    get stream() { return stream; },
    get ends() { return ends; },
    releaseRename: () => releaseRename(),
    releaseOpen: () => releaseOpen(),
  };
}

function upload(instance = app()) {
  return request(instance).post('/api/sftp/upload')
    .field('token', TOKEN).field('path', posix.dirname(REMOTE_PATH))
    .attach('file', REPLACEMENT, 'example.txt');
}

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 200 && !predicate(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(predicate(), 'upload did not reach the expected state');
}

function assertCleaned(f: ReturnType<typeof fixture>) {
  assert.deepEqual(f.files.get(REMOTE_PATH), ORIGINAL);
  assert.deepEqual(f.removed, f.opened);
  assert.equal(f.files.size, 1);
  assert.equal(f.ends, 1);
}

test('an overwrite stays unchanged until the closed temporary file is atomically renamed', async (t) => {
  const f = fixture(t, { holdRename: true });
  const pending = upload().then((response) => response);
  await waitFor(() => f.renamed.length === 1);
  assert.deepEqual(f.files.get(REMOTE_PATH), ORIGINAL);
  assert.deepEqual(f.files.get(f.opened[0]), REPLACEMENT);
  assert.equal(f.ends, 0);
  assert.deepEqual(f.renamed, [{ kind: 'posix', from: f.opened[0], to: REMOTE_PATH }]);
  assert.deepEqual(f.events, ['closed']);
  f.releaseRename();
  const response = await pending;
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { ok: true, path: REMOTE_PATH, size: REPLACEMENT.length });
  assert.deepEqual(f.files.get(REMOTE_PATH), REPLACEMENT);
  assert.equal(f.files.size, 1);
  assert.deepEqual(f.removed, []);
  assert.deepEqual(f.events, ['closed', 'renamed', 'ended']);
});

for (const extension of ['unadvertised', 'unsupported', 'missing'] as const) {
  test(`plain rename creates a new file when the POSIX extension is ${extension}`, async (t) => {
    const f = fixture(t, { extension }, false);
    const response = await upload();
    assert.equal(response.status, 200);
    assert.deepEqual(f.files.get(REMOTE_PATH), REPLACEMENT);
    assert.equal(f.files.size, 1);
    assert.equal(f.renamed[0].kind, 'plain');
    assert.deepEqual(f.removed, []);
    assert.equal(f.ends, 1);
  });

  test(`a rejected plain-rename overwrite preserves the original when the POSIX extension is ${extension}`, async (t) => {
    const f = fixture(t, { extension });
    const response = await upload();
    assert.equal(response.status, 500);
    assert.equal(response.body.code, 'SFTP_PATH_EXISTS');
    await waitFor(() => f.ends === 1);
    assertCleaned(f);
    assert.equal(f.renamed[0].kind, 'plain');
  });
}

for (const failure of ['writeError', 'closeError', 'renameError'] as const) {
  test(`${failure} removes only the temporary upload and preserves the original`, async (t) => {
    const f = fixture(t, { [failure]: true });
    const response = await upload();
    assert.equal(response.status, 500);
    await waitFor(() => f.ends === 1);
    assertCleaned(f);
    assert.equal(f.renamed.length, failure === 'renameError' ? 1 : 0);
    assert.ok(response.body.requestId);
  });
}

test('an exclusive temporary-file open failure does not delete any existing file', async (t) => {
  const f = fixture(t, { openError: true });
  assert.equal((await upload()).status, 500);
  await waitFor(() => f.ends === 1);
  assert.deepEqual(f.files.get(REMOTE_PATH), ORIGINAL);
  assert.deepEqual(f.files.get(f.opened[0]), Buffer.from('unrelated existing temp'));
  assert.deepEqual(f.removed, []);
  assert.deepEqual(f.renamed, []);
});

test('temporary filenames are unique for repeated uploads to the same destination', async (t) => {
  const f = fixture(t);
  assert.equal((await upload()).status, 200);
  assert.equal((await upload()).status, 200);
  assert.equal(new Set(f.opened).size, 2);
});

async function partialUpload(t: test.TestContext, instance = app()) {
  const server = instance.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const { port } = server.address() as { port: number };
  const client = httpRequest({
    host: '127.0.0.1', port, method: 'POST', path: '/api/sftp/upload',
    headers: { 'Content-Type': 'multipart/form-data; boundary=upload-boundary' },
  });
  client.on('error', () => {});
  client.on('response', (response) => response.resume());
  t.after(() => client.destroy());
  client.write(`--upload-boundary\r\nContent-Disposition: form-data; name="token"\r\n\r\n${TOKEN}\r\n`);
  client.write(`--upload-boundary\r\nContent-Disposition: form-data; name="path"\r\n\r\n${posix.dirname(REMOTE_PATH)}\r\n`);
  client.write('--upload-boundary\r\nContent-Disposition: form-data; name="file"; filename="example.txt"\r\nContent-Type: application/octet-stream\r\n\r\n');
  client.write(REPLACEMENT);
  return client;
}

test('a client abort destroys the write stream and discards only the partial replacement', async (t) => {
  const f = fixture(t);
  const client = await partialUpload(t);
  await f.written;
  assert.deepEqual(f.files.get(REMOTE_PATH), ORIGINAL);
  client.destroy();
  await waitFor(() => f.ends === 1);
  assertCleaned(f);
  assert.equal(f.stream.destroyed, true);
  assert.deepEqual(f.renamed, []);
});

test('an abort while the exclusive open is pending cleans up after open without creating a stream', async (t) => {
  const f = fixture(t, { holdOpen: true });
  let response: express.Response;
  const client = await partialUpload(t, app((_req, res) => { response = res; }));
  await f.opening;
  client.destroy();
  await waitFor(() => response.destroyed);
  f.releaseOpen();
  await waitFor(() => f.ends === 1);
  assertCleaned(f);
  assert.equal(f.stream, undefined);
  assert.deepEqual(f.renamed, []);
});

test('a malformed file part preserves the original and discards the partial upload', async (t) => {
  const f = fixture(t);
  const client = await partialUpload(t);
  await f.written;
  client.end();
  await waitFor(() => f.ends === 1);
  assertCleaned(f);
  assert.deepEqual(f.renamed, []);
});
