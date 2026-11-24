import test from 'node:test';
import assert from 'node:assert/strict';
import { AxiosError } from 'axios';
import api from './api.js';
import { setReauthHandler, shouldPromptReauth } from './utils/reauthPrompt.js';

const REQUIRED = { error: 'Please confirm', code: 'REAUTHENTICATION_REQUIRED' };

// Fails the first `failures` requests with the reauth 403, then succeeds.
function stubAdapter(failures, body = REQUIRED) {
  const calls = [];
  api.defaults.adapter = async (config) => {
    calls.push(config);
    if (calls.length <= failures) {
      const response = { status: 403, data: body, headers: {}, config };
      throw new AxiosError('forbidden', AxiosError.ERR_BAD_REQUEST, config, null, response);
    }
    return { status: 200, statusText: 'OK', data: { ok: true }, headers: {}, config };
  };
  return calls;
}

test('a confirmed reauth replays the original request with its body intact', async (t) => {
  const calls = stubAdapter(1);
  let prompts = 0;
  t.after(setReauthHandler(async () => { prompts += 1; return true; }));

  const { data } = await api.post('/admin/users', { username: 'new', password: 'long-enough-pw' });

  assert.deepEqual(data, { ok: true });
  assert.equal(prompts, 1);
  assert.equal(calls.length, 2);
  assert.deepEqual(JSON.parse(calls[1].data), { username: 'new', password: 'long-enough-pw' });
});

test('cancelling the prompt surfaces the original error without replaying', async (t) => {
  const calls = stubAdapter(1);
  t.after(setReauthHandler(async () => false));

  await assert.rejects(api.post('/admin/users', {}), (err) => err.response.data.code === REQUIRED.code);
  assert.equal(calls.length, 1);
});

test('a replay that is still refused does not prompt again', async (t) => {
  const calls = stubAdapter(5);
  let prompts = 0;
  t.after(setReauthHandler(async () => { prompts += 1; return true; }));

  await assert.rejects(api.delete('/admin/users/7'));
  assert.equal(prompts, 1);
  assert.equal(calls.length, 2);
});

test('concurrent refusals share one prompt', async (t) => {
  stubAdapter(2);
  let prompts = 0;
  t.after(setReauthHandler(async () => { prompts += 1; return true; }));

  await Promise.all([api.post('/admin/roles', {}), api.post('/admin/invites', {})]);
  assert.equal(prompts, 1);
});

test('only pages without their own dialog are prompted', () => {
  const err = (url) => ({ config: { url }, response: { data: REQUIRED } });
  for (const url of ['/admin/users', '/admin/users/3/password', '/admin/roles', '/admin/invites/1', '/admin/tokens/2', '/admin/power-control/global/pause']) {
    assert.equal(shouldPromptReauth(err(url)), true, url);
  }
  for (const url of ['/admin/operations/backups', '/auth/tokens', '/admin/usersfoo', '/payments/admin/config']) {
    assert.equal(shouldPromptReauth(err(url)), false, url);
  }
  assert.equal(shouldPromptReauth({ config: { url: '/admin/users' }, response: { data: { code: 'OTHER' } } }), false);
});
