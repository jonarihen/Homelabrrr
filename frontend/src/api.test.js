import test from 'node:test';
import assert from 'node:assert/strict';
import api from './api.js';
import { isSftpSessionExpired, SFTP_SESSION_EXPIRED } from './utils/sftpSession.js';

async function rejectResponse(t, { status, data, pathname = '/dashboard', url = '/sftp/ls' }) {
  globalThis.window = { location: { pathname, href: pathname } };
  t.after(() => { delete globalThis.window; });
  const err = new Error('Request failed');
  err.response = { status, data };
  await assert.rejects(api.request({ url, adapter: () => Promise.reject(err) }), actual => actual === err);
  return err;
}

for (const status of [401, 403, 409, 410]) {
  test(`SFTP expiry with status ${status} stays on the portal and can be reconnected`, async t => {
    const err = await rejectResponse(t, { status, data: { code: SFTP_SESSION_EXPIRED } });
    assert.equal(window.location.href, '/dashboard');
    assert.equal(isSftpSessionExpired(err), true);
  });
}

test('a Blob download expiry is decoded for the reconnect action without redirecting', async t => {
  const err = await rejectResponse(t, {
    status: 410,
    url: '/sftp/download',
    data: new Blob([JSON.stringify({ code: SFTP_SESSION_EXPIRED, error: 'SFTP session expired or invalid' })], { type: 'application/json; charset=utf-8' }),
  });
  assert.equal(isSftpSessionExpired(err), true);
  assert.equal(window.location.href, '/dashboard');
  assert.equal(err.response.data.error, 'SFTP session expired or invalid');
});

test('a legacy 401 Blob expiry is decoded before deciding whether to redirect', async t => {
  const err = await rejectResponse(t, {
    status: 401,
    url: '/sftp/download',
    data: new Blob([JSON.stringify({ code: SFTP_SESSION_EXPIRED })], { type: 'application/json' }),
  });
  assert.equal(isSftpSessionExpired(err), true);
  assert.equal(window.location.href, '/dashboard');
});

for (const blob of [false, true]) {
  for (const url of ['/sftp/ls', '/sftp/download', '/sftp/upload', '/sftp/connect', '/auth/me']) {
    test(`portal-auth 401 from ${url} still redirects (${blob ? 'Blob' : 'JSON'})`, async t => {
      const body = { error: 'Unauthorized' };
      const data = blob ? new Blob([JSON.stringify(body)], { type: 'application/json' }) : body;
      const err = await rejectResponse(t, { status: 401, data, url });
      assert.equal(window.location.href, '/login');
      assert.equal(isSftpSessionExpired(err), false);
    });
  }
}

for (const pathname of ['/login', '/invite/token']) {
  test(`portal-auth 401 on ${pathname} still stays on the public page`, async t => {
    await rejectResponse(t, { status: 401, data: { error: 'Unauthorized' }, pathname });
    assert.equal(window.location.href, pathname);
  });
}

for (const body of [{ code: 'SFTP_PERMISSION_DENIED' }, { error: 'Access denied' }]) {
  for (const blob of [false, true]) {
    test(`permission denial is not mistaken for token expiry (${JSON.stringify(body)}, ${blob ? 'Blob' : 'JSON'})`, async t => {
      const data = blob ? new Blob([JSON.stringify(body)], { type: 'application/json' }) : body;
      const err = await rejectResponse(t, { status: 403, data });
      assert.equal(window.location.href, '/dashboard');
      assert.equal(isSftpSessionExpired(err), false);
    });
  }
}

for (const type of ['application/json', 'application/octet-stream']) {
  test(`an unparseable ${type} Blob does not swallow a real 401`, async t => {
    const data = new Blob(['not JSON'], { type });
    const err = await rejectResponse(t, { status: 401, data });
    assert.equal(window.location.href, '/login');
    assert.equal(err.response.data, data);
  });
}
