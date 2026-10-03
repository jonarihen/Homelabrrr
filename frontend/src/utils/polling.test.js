import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { CanceledError, isCancel } from 'axios';
import api from '../api.js';
import { startPolling } from './polling.js';

function setup(t, options = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const scheduled = t.mock.method(globalThis, 'setTimeout');
  const requests = [];
  const request = t.mock.fn(options.request || ((signal) => {
    const deferred = Promise.withResolvers();
    requests.push({ signal, ...deferred });
    return deferred.promise;
  }));
  const onUpdate = t.mock.fn(options.onUpdate);
  const onComplete = t.mock.fn();
  const stop = startPolling({
    ...options,
    request,
    onUpdate,
    onComplete,
    shouldContinue: (site) => site.status === 'pending',
  });
  t.after(stop);
  return { stop, request, requests, onUpdate, onComplete, scheduled };
}

function assertStopped(polling, scheduleCount) {
  assert.equal(polling.onUpdate.mock.callCount(), 0);
  assert.equal(polling.onComplete.mock.callCount(), 0);
  assert.equal(polling.scheduled.mock.callCount(), scheduleCount);
}

test('cleanup before the first tick prevents any request', (t) => {
  const polling = setup(t);
  polling.stop();
  t.mock.timers.tick(10000);
  assert.equal(polling.request.mock.callCount(), 0);
  assertStopped(polling, 1);
});

for (const status of ['pending', 'live']) {
  test(`cleanup aborts the request and ignores a late ${status} response`, async (t) => {
    const polling = setup(t);
    t.mock.timers.tick(2500);
    const request = polling.requests[0];
    assert.equal(request.signal.aborted, false);
    polling.stop();
    assert.equal(request.signal.aborted, true);
    request.resolve({ status });
    await setImmediate();
    assertStopped(polling, 1);
    t.mock.timers.tick(10000);
    assert.equal(polling.request.mock.callCount(), 1);
  });
}

for (const error of [new Error('Network Error'), new CanceledError()]) {
  test(`cleanup suppresses a late ${error.name} without scheduling a retry`, async (t) => {
    const polling = setup(t);
    t.mock.timers.tick(2500);
    polling.stop();
    polling.requests[0].reject(error);
    await setImmediate();
    assertStopped(polling, 1);
    t.mock.timers.tick(10000);
    assert.equal(polling.request.mock.callCount(), 1);
  });
}

test('pending responses update the card and schedule one non-overlapping tick', async (t) => {
  const polling = setup(t);
  t.mock.timers.tick(2499);
  assert.equal(polling.request.mock.callCount(), 0);
  t.mock.timers.tick(1);
  t.mock.timers.tick(10000);
  assert.equal(polling.request.mock.callCount(), 1);
  assert.equal(polling.scheduled.mock.callCount(), 1);
  const site = { status: 'pending' };
  polling.requests[0].resolve(site);
  await setImmediate();
  assert.equal(polling.onUpdate.mock.callCount(), 1);
  assert.equal(polling.onUpdate.mock.calls[0].arguments[0], site);
  assert.equal(polling.onComplete.mock.callCount(), 0);
  assert.equal(polling.scheduled.mock.callCount(), 2);
  t.mock.timers.tick(2499);
  assert.equal(polling.request.mock.callCount(), 1);
  t.mock.timers.tick(1);
  assert.equal(polling.request.mock.callCount(), 2);
});

for (const status of ['live', 'error', 'warning', 'blocked', 'conflict']) {
  test(`${status} responses update the card and notify the page once without polling again`, async (t) => {
    const polling = setup(t);
    t.mock.timers.tick(2500);
    const site = { status };
    polling.requests[0].resolve(site);
    await setImmediate();
    assert.equal(polling.onUpdate.mock.callCount(), 1);
    assert.equal(polling.onUpdate.mock.calls[0].arguments[0], site);
    assert.equal(polling.onComplete.mock.callCount(), 1);
    assert.equal(polling.scheduled.mock.callCount(), 1);
    t.mock.timers.tick(10000);
    assert.equal(polling.request.mock.callCount(), 1);
  });
}

test('transient failures retry silently after four seconds while active', async (t) => {
  const polling = setup(t);
  t.mock.timers.tick(2500);
  polling.requests[0].reject(new Error('Network Error'));
  await setImmediate();
  assert.equal(polling.onUpdate.mock.callCount(), 0);
  assert.equal(polling.onComplete.mock.callCount(), 0);
  assert.equal(polling.scheduled.mock.callCount(), 2);
  t.mock.timers.tick(3999);
  assert.equal(polling.request.mock.callCount(), 1);
  t.mock.timers.tick(1);
  assert.equal(polling.request.mock.callCount(), 2);
  polling.requests[1].resolve({ status: 'live' });
  await setImmediate();
  assert.equal(polling.onUpdate.mock.callCount(), 1);
  assert.equal(polling.onComplete.mock.callCount(), 1);
});

for (const fail of [false, true]) {
  test(`cleanup clears a queued ${fail ? 'retry' : 'normal'} tick`, async (t) => {
    const polling = setup(t);
    t.mock.timers.tick(2500);
    if (fail) polling.requests[0].reject(new Error('Network Error'));
    else polling.requests[0].resolve({ status: 'pending' });
    await setImmediate();
    assert.equal(polling.scheduled.mock.callCount(), 2);
    polling.stop();
    t.mock.timers.tick(10000);
    assert.equal(polling.request.mock.callCount(), 1);
  });
}

for (const status of ['pending', 'live']) {
  test(`cleanup during onUpdate prevents ${status === 'pending' ? 'scheduling' : 'onComplete'}`, async (t) => {
    const polling = setup(t, { onUpdate: () => polling.stop() });
    t.mock.timers.tick(2500);
    polling.requests[0].resolve({ status });
    await setImmediate();
    assert.equal(polling.onUpdate.mock.callCount(), 1);
    assert.equal(polling.onComplete.mock.callCount(), 0);
    assert.equal(polling.scheduled.mock.callCount(), 1);
  });
}

test('a replacement effect is isolated from the stopped effect', async (t) => {
  const oldRequest = Promise.withResolvers();
  const newRequest = Promise.withResolvers();
  const signals = [];
  const request = t.mock.fn((signal) => {
    signals.push(signal);
    return signals.length === 1 ? oldRequest.promise : newRequest.promise;
  });
  const old = setup(t, { request });
  t.mock.timers.tick(2500);
  old.stop();
  const onUpdate = t.mock.fn();
  const onComplete = t.mock.fn();
  const stop = startPolling({ request, onUpdate, onComplete, shouldContinue: () => false });
  t.after(stop);
  t.mock.timers.tick(2500);
  assert.equal(signals[0].aborted, true);
  assert.equal(signals[1].aborted, false);
  assert.notEqual(signals[0], signals[1]);
  oldRequest.resolve({ status: 'live' });
  await setImmediate();
  assertStopped(old, 2);
  assert.equal(onUpdate.mock.callCount(), 0);
  newRequest.resolve({ status: 'live' });
  await setImmediate();
  assert.equal(onUpdate.mock.callCount(), 1);
  assert.equal(onComplete.mock.callCount(), 1);
  t.mock.timers.tick(10000);
  assert.equal(request.mock.callCount(), 2);
});

test('page polling also aborts and ignores a late list response', async (t) => {
  const polling = setup(t, { interval: 4000 });
  t.mock.timers.tick(3999);
  assert.equal(polling.request.mock.callCount(), 0);
  t.mock.timers.tick(1);
  polling.stop();
  assert.equal(polling.requests[0].signal.aborted, true);
  polling.requests[0].resolve([{ id: 1, status: 'pending' }]);
  await setImmediate();
  assertStopped(polling, 1);
});

test('the shared API forwards the signal and rejects cancellation without redirecting or retrying', async (t) => {
  let signal;
  let cancellation;
  const polling = setup(t, {
    request: async (abortSignal) => {
      try {
        return (await api.get('/websites/sites/1/status', {
          signal: abortSignal,
          adapter: (config) => new Promise((resolve, reject) => {
            signal = config.signal;
            signal.addEventListener('abort', () => reject(new CanceledError(null, config)), { once: true });
          }),
        })).data;
      } catch (error) {
        cancellation = error;
        throw error;
      }
    },
  });
  t.mock.timers.tick(2500);
  assert.ok(signal instanceof AbortSignal);
  assert.equal(signal.aborted, false);
  polling.stop();
  await setImmediate();
  assert.equal(signal.aborted, true);
  assert.equal(cancellation.code, 'ERR_CANCELED');
  assert.equal(isCancel(cancellation), true);
  assert.equal(cancellation.response, undefined);
  assertStopped(polling, 1);
  t.mock.timers.tick(10000);
  assert.equal(polling.request.mock.callCount(), 1);
});
