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
import { sessions, users, vmAssignments } from '../db/schema/index.ts';

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

test.beforeEach(async () => {
  await testDb.db.delete(sessions);
  await testDb.db.delete(vmAssignments);
  await testDb.db.insert(sessions).values({
    sid: 'upload-session', sess: { userId }, expire: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });
  await testDb.db.insert(vmAssignments).values({ user_id: userId, node: 'host1~pve1', vmid: 101 });
  sftpSessions.set(TOKEN, {
    userId, sessionId: 'upload-session', node: 'host1~pve1', vmid: 101,
    expires: Date.now() + 30 * 60 * 1000,
    absoluteExpires: Date.now() + 8 * 60 * 60 * 1000,
  });
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

type Metadata = {
  uid?: number;
  gid?: number;
  mode?: number;
  size?: number;
  mtime?: number;
  extended?: Record<string, Buffer>;
};

const ORIGINAL_METADATA = { uid: 123, gid: 456, mode: 0o100640, size: ORIGINAL.length, mtime: 100 };
const UPLOADER_METADATA = { uid: 1000, gid: 1000, mode: 0o100600, size: 0, mtime: 200 };

type Plan = {
  extension?: 'supported' | 'unadvertised' | 'unsupported' | 'missing';
  openError?: boolean;
  writeError?: boolean;
  closeError?: boolean;
  renameError?: boolean;
  holdRename?: boolean;
  holdOpen?: boolean;
  metadata?: Metadata;
  statError?: boolean;
  chownError?: boolean;
  chmodError?: boolean;
  ignoreChown?: boolean;
  ignoreChmod?: boolean;
  changeDestination?: Metadata;
  holdChown?: boolean;
  changeAtRead?: number;
  tempStatError?: boolean;
};

function fixture(t: test.TestContext, plan: Plan = {}, existing = true) {
  const files = new Map<string, Buffer>(existing ? [[REMOTE_PATH, ORIGINAL]] : []);
  const metadata = new Map<string, Metadata>(existing ? [[REMOTE_PATH, { ...(plan.metadata ?? ORIGINAL_METADATA) }]] : []);
  const inspected: string[] = [];
  const attributes: Array<{ path: string; attrs: Metadata }> = [];
  let destinationReads = 0;
  let releaseChown: () => void;
  const opened: string[] = [];
  const removed: string[] = [];
  const renamed: Array<{ kind: string; from: string; to: string }> = [];
  const events: string[] = [];
  let stream: Writable;
  let connects = 0;
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
      metadata.set(to, metadata.get(from)!);
      files.delete(from);
      metadata.delete(from);
      events.push('renamed');
      cb();
    };
    if (!plan.holdRename) queueMicrotask(releaseRename);
  };

  const sftp = {
    lstat(path: string, cb: (err: Error | null, attrs?: Metadata & { isFile(): boolean; isSymbolicLink(): boolean }) => void) {
      inspected.push(path);
      if (path === REMOTE_PATH) {
        destinationReads += 1;
        if (plan.statError) return queueMicrotask(() => cb(error('Permission denied', ssh2.utils.sftp.STATUS_CODE.PERMISSION_DENIED)));
        if (destinationReads >= (plan.changeAtRead ?? 2) && plan.changeDestination) metadata.set(path, plan.changeDestination);
      } else if (plan.tempStatError) {
        return queueMicrotask(() => cb(error('Permission denied', ssh2.utils.sftp.STATUS_CODE.PERMISSION_DENIED)));
      }
      const attrs = metadata.get(path);
      if (!attrs) return queueMicrotask(() => cb(error('No such file', ssh2.utils.sftp.STATUS_CODE.NO_SUCH_FILE)));
      queueMicrotask(() => cb(null, {
        ...attrs,
        isFile: () => (attrs.mode! & 0o170000) === 0o100000,
        isSymbolicLink: () => (attrs.mode! & 0o170000) === 0o120000,
      }));
    },
    fstat(handle: Buffer, cb: (err: Error | null, attrs?: Metadata & { isFile(): boolean; isSymbolicLink(): boolean }) => void) {
      sftp.lstat(handle.toString(), cb);
    },
    fchown(handle: Buffer, uid: number, gid: number, cb: (err?: Error) => void) {
      const path = handle.toString();
      assert.notEqual(path, REMOTE_PATH);
      attributes.push({ path, attrs: { uid, gid } });
      releaseChown = () => {
        if (!metadata.has(path)) return cb(error('Handle closed'));
        if (plan.chownError) return cb(error('Permission denied', ssh2.utils.sftp.STATUS_CODE.PERMISSION_DENIED));
        if (!plan.ignoreChown) metadata.set(path, { ...metadata.get(path), uid, gid, mode: metadata.get(path)!.mode! & ~0o6000 });
        events.push('chown');
        cb();
      };
      if (!plan.holdChown) queueMicrotask(releaseChown);
    },
    fchmod(handle: Buffer, mode: number, cb: (err?: Error) => void) {
      const path = handle.toString();
      assert.notEqual(path, REMOTE_PATH);
      attributes.push({ path, attrs: { mode } });
      if (plan.chmodError) return queueMicrotask(() => cb(error('Permission denied', ssh2.utils.sftp.STATUS_CODE.PERMISSION_DENIED)));
      if (!plan.ignoreChmod) metadata.set(path, { ...metadata.get(path), mode: 0o100000 | mode });
      events.push('chmod');
      queueMicrotask(cb);
    },
    open(path: string, flags: string, mode: number, cb: (err: Error | null, handle?: Buffer) => void) {
      assert.equal(flags, 'wx');
      assert.equal(mode, 0o600);
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
        metadata.set(path, { ...UPLOADER_METADATA });
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
    createWriteStream(path: string, options: { handle: Buffer; autoClose: boolean }) {
      assert.equal(options.handle.toString(), path);
      assert.equal(options.autoClose, false);
      stream = new Writable({
        autoDestroy: false,
        write(chunk, _encoding, cb) {
          if (plan.writeError) return cb(error('Write failed'));
          files.set(path, Buffer.concat([files.get(path)!, chunk]));
          metadata.set(path, { ...metadata.get(path), size: files.get(path)!.length });
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
      metadata.delete(path);
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
    connects += 1;
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
    files, metadata, inspected, attributes, opened, removed, renamed, events, written, opening,
    releaseChown: () => releaseChown(),
    get stream() { return stream; },
    get connects() { return connects; },
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
  assert.deepEqual(f.events, ['chown', 'chmod', 'closed']);
  assert.deepEqual(f.metadata.get(REMOTE_PATH), ORIGINAL_METADATA);
  assert.deepEqual(f.attributes, [
    { path: f.opened[0], attrs: { uid: ORIGINAL_METADATA.uid, gid: ORIGINAL_METADATA.gid } },
    { path: f.opened[0], attrs: { mode: ORIGINAL_METADATA.mode & 0o7777 } },
  ]);
  f.releaseRename();
  const response = await pending;
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { ok: true, path: REMOTE_PATH, size: REPLACEMENT.length });
  assert.deepEqual(f.files.get(REMOTE_PATH), REPLACEMENT);
  assert.equal(f.files.size, 1);
  assert.deepEqual(f.removed, []);
  assert.deepEqual(f.events, ['chown', 'chmod', 'closed', 'renamed', 'ended']);
  assert.deepEqual(f.metadata.get(REMOTE_PATH), {
    uid: ORIGINAL_METADATA.uid, gid: ORIGINAL_METADATA.gid, mode: ORIGINAL_METADATA.mode,
    size: REPLACEMENT.length, mtime: UPLOADER_METADATA.mtime,
  });
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
    assert.deepEqual(f.metadata.get(REMOTE_PATH), { ...UPLOADER_METADATA, mode: 0o100666, size: REPLACEMENT.length });
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

for (const expiry of ['expires', 'absoluteExpires']) {
  test(`an upload with ${expiry} elapsed returns 410 without touching either remote path`, async (t) => {
    const f = fixture(t);
    sftpSessions.get(TOKEN)[expiry] = Date.now();
    const response = await upload();
    assert.equal(response.status, 410);
    assert.equal(response.body.code, 'SFTP_SESSION_EXPIRED');
    assert.equal(sftpSessions.has(TOKEN), false);
    assert.equal(f.connects, 0);
    assert.deepEqual(f.inspected, []);
    assert.deepEqual(f.opened, []);
    assert.deepEqual(f.renamed, []);
    assert.deepEqual(f.removed, []);
    assert.deepEqual(f.files.get(REMOTE_PATH), ORIGINAL);
  });
}

for (const denied of ['other-session', 'api-token', 'revoked-permission', 'revoked-session', 'unauthenticated']) {
  test(`${denied} uploads cannot reach temporary-file creation or replacement`, async (t) => {
    const f = fixture(t);
    if (denied === 'revoked-permission') await testDb.db.delete(vmAssignments);
    if (denied === 'revoked-session') await testDb.db.delete(sessions);
    const instance = app((req) => {
      if (denied === 'other-session') req.sessionID = 'other-session';
      if (denied === 'api-token') req.apiToken = { id: 1 };
      if (denied === 'unauthenticated') req.session = {};
    });
    const response = await upload(instance);
    assert.equal(response.status, denied === 'unauthenticated' ? 401 : denied === 'revoked-session' ? 410 : 403);
    assert.equal(response.body.code, denied === 'revoked-session' ? 'SFTP_SESSION_EXPIRED' : undefined);
    assert.equal(f.connects, 0);
    assert.deepEqual(f.inspected, []);
    assert.deepEqual(f.opened, []);
    assert.deepEqual(f.renamed, []);
    assert.deepEqual(f.removed, []);
    assert.deepEqual(f.files.get(REMOTE_PATH), ORIGINAL);
  });
}

for (const extension of ['supported', 'unadvertised'] as const) {
  for (const dangling of [false, true]) {
    test(`a ${dangling ? 'dangling' : 'live'} symbolic-link destination is rejected with ${extension} rename support`, async (t) => {
      const attrs = { ...ORIGINAL_METADATA, mode: 0o120777 };
      const f = fixture(t, { extension, metadata: attrs });
      const target = '/srv/files/target.txt';
      if (!dangling) f.files.set(target, ORIGINAL);
      const before = new Map(f.files);
      const response = await upload();
      assert.equal(response.status, 409);
      assert.equal(response.body.code, 'SFTP_SYMLINK_DESTINATION');
      assert.match(response.body.error, /choose the target file directly/);
      assert.deepEqual(f.files, before);
      assert.deepEqual(f.metadata.get(REMOTE_PATH), attrs);
      assert.deepEqual(f.opened, []);
      assert.deepEqual(f.removed, []);
      assert.deepEqual(f.renamed, []);
      assert.equal(f.ends, 1);
    });
  }
}

for (const attrs of [
  { ...ORIGINAL_METADATA, mode: 0o040750 },
  { ...ORIGINAL_METADATA, mode: 0o010600 },
  { ...ORIGINAL_METADATA, uid: undefined },
  { ...ORIGINAL_METADATA, gid: undefined },
  { ...ORIGINAL_METADATA, mode: undefined },
  { ...ORIGINAL_METADATA, extended: { 'acl@example': Buffer.from('private') } },
]) {
  test(`unsupported overwrite metadata ${JSON.stringify(attrs)} fails before opening a temporary file`, async (t) => {
    const f = fixture(t, { metadata: attrs });
    const response = await upload();
    assert.equal(response.status, 409);
    assert.equal(response.body.code, 'SFTP_UNSAFE_OVERWRITE');
    assert.deepEqual(f.files.get(REMOTE_PATH), ORIGINAL);
    assert.deepEqual(f.metadata.get(REMOTE_PATH), attrs);
    assert.deepEqual(f.opened, []);
    assert.deepEqual(f.renamed, []);
    assert.deepEqual(f.removed, []);
  });
}

test('an unreadable destination does not get treated as a new file', async (t) => {
  const f = fixture(t, { statError: true });
  assert.equal((await upload()).status, 500);
  assert.deepEqual(f.files.get(REMOTE_PATH), ORIGINAL);
  assert.deepEqual(f.opened, []);
  assert.deepEqual(f.renamed, []);
  assert.equal(f.ends, 1);
});

for (const mode of [0o600, 0o644, 0o755, 0o6750]) {
  test(`replacement preserves service UID/GID and mode ${mode.toString(8)} after writing`, async (t) => {
    const attrs = { ...ORIGINAL_METADATA, uid: 0, gid: 42, mode: 0o100000 | mode };
    const f = fixture(t, { metadata: attrs });
    assert.equal((await upload()).status, 200);
    assert.deepEqual(f.files.get(REMOTE_PATH), REPLACEMENT);
    assert.deepEqual(f.metadata.get(REMOTE_PATH), { ...attrs, size: REPLACEMENT.length, mtime: UPLOADER_METADATA.mtime });
    assert.deepEqual(f.events, ['chown', 'chmod', 'closed', 'renamed', 'ended']);
  });
}

test('same-owner overwrite avoids unnecessary chown but still preserves mode', async (t) => {
  const attrs = { ...ORIGINAL_METADATA, uid: UPLOADER_METADATA.uid, gid: UPLOADER_METADATA.gid, mode: 0o100750 };
  const f = fixture(t, { metadata: attrs });
  assert.equal((await upload()).status, 200);
  assert.deepEqual(f.attributes, [{ path: f.opened[0], attrs: { mode: 0o750 } }]);
  assert.deepEqual(f.metadata.get(REMOTE_PATH), { ...attrs, size: REPLACEMENT.length, mtime: UPLOADER_METADATA.mtime });
});

for (const failure of ['chownError', 'chmodError', 'ignoreChown', 'ignoreChmod', 'tempStatError'] as const) {
  test(`${failure} fails without replacing the destination or changing its metadata`, async (t) => {
    const f = fixture(t, { [failure]: true });
    const response = await upload();
    assert.equal(response.status, failure.startsWith('ignore') ? 409 : 500);
    await waitFor(() => f.ends === 1);
    assertCleaned(f);
    assert.deepEqual(f.metadata.get(REMOTE_PATH), ORIGINAL_METADATA);
    assert.deepEqual(f.renamed, []);
  });
}

for (const changeAtRead of [2, 3]) {
  test(`a symlink substituted before destination check ${changeAtRead} is never renamed over`, async (t) => {
    const attrs = { ...ORIGINAL_METADATA, mode: 0o120777 };
    const f = fixture(t, { changeDestination: attrs, changeAtRead });
    const response = await upload();
    assert.equal(response.status, 409);
    assert.equal(response.body.code, 'SFTP_SYMLINK_DESTINATION');
    await waitFor(() => f.ends === 1);
    assertCleaned(f);
    assert.deepEqual(f.metadata.get(REMOTE_PATH), attrs);
    assert.deepEqual(f.renamed, []);
  });
}

test('a symlink substituted before the plain-rename fallback is rejected', async (t) => {
  const attrs = { ...ORIGINAL_METADATA, mode: 0o120777 };
  const f = fixture(t, { extension: 'unadvertised', changeDestination: attrs, changeAtRead: 4 });
  const response = await upload();
  assert.equal(response.status, 409);
  assert.equal(response.body.code, 'SFTP_SYMLINK_DESTINATION');
  await waitFor(() => f.ends === 1);
  assertCleaned(f);
  assert.deepEqual(f.metadata.get(REMOTE_PATH), attrs);
  assert.deepEqual(f.renamed, []);
});

test('concurrent ownership changes reject the overwrite instead of applying stale ownership', async (t) => {
  const attrs = { ...ORIGINAL_METADATA, uid: 999 };
  const f = fixture(t, { changeDestination: attrs });
  const response = await upload();
  assert.equal(response.status, 409);
  assert.equal(response.body.code, 'SFTP_DESTINATION_CHANGED');
  await waitFor(() => f.ends === 1);
  assertCleaned(f);
  assert.deepEqual(f.metadata.get(REMOTE_PATH), attrs);
  assert.deepEqual(f.attributes, []);
  assert.deepEqual(f.renamed, []);
});

test('an abort while ownership preservation is pending never commits the replacement', async (t) => {
  const f = fixture(t, { holdChown: true });
  let response: express.Response;
  const pending = upload(app((_req, res) => { response = res; })).then((res) => res, () => null);
  await waitFor(() => f.attributes.length === 1);
  response.destroy();
  await waitFor(() => f.ends === 1);
  f.releaseChown();
  await pending;
  await new Promise((resolve) => setTimeout(resolve, 10));
  assertCleaned(f);
  assert.deepEqual(f.metadata.get(REMOTE_PATH), ORIGINAL_METADATA);
  assert.deepEqual(f.renamed, []);
  assert.equal(f.attributes.length, 1);
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
