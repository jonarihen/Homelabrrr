import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type https from 'node:https';
import { createIloTransport, createRuntimePatchTransport, discoverHardware, IloError, withDiscoveryDeadline } from './iloAdapter.ts';

const config = { host: '192.168.40.10', port: 443, username: 'fixture-reader', password: 'fixture-secret', verifyTls: true };

type Scenario = { status?: number; body?: string; error?: string; timeout?: boolean };
function fakeNetwork(scenario: Scenario) {
  const calls: { options: any; body: string | undefined }[] = [];
  const request = ((options: any, callback: (response: any) => void) => {
    const req = new EventEmitter() as any;
    req.destroy = (error: Error) => { req.emit('error', error); };
    req.end = (body?: string) => {
      calls.push({ options, body });
      queueMicrotask(() => {
        if (scenario.timeout) { req.emit('timeout'); return; }
        if (scenario.error) { req.emit('error', Object.assign(new Error('fixture-secret must not escape'), { code: scenario.error })); return; }
        const response = new EventEmitter() as any;
        response.statusCode = scenario.status ?? 200;
        response.resume = () => {};
        callback(response);
        if (scenario.body) response.emit('data', Buffer.from(scenario.body));
        response.emit('end');
      });
    };
    return req;
  }) as unknown as typeof https.request;
  return { request, calls };
}

test('read transport pins the validated address and accepts only bounded JSON objects', async () => {
  const fake = fakeNetwork({ body: '{"PowerConsumedWatts":172}' });
  const read = await createIloTransport(config, { request: fake.request });
  assert.deepEqual(await read('/redfish/v1/Chassis/A/Power'), { PowerConsumedWatts: 172 });
  const { options } = fake.calls[0];
  assert.equal(options.method, 'GET');
  assert.equal(options.rejectUnauthorized, true);
  assert.equal(options.timeout, 5000);
  assert.equal(options.path, '/redfish/v1/Chassis/A/Power');
  await new Promise<void>((resolve, reject) => options.lookup(config.host, {}, (err: Error | null, address: string) => {
    if (err) reject(err); else { assert.equal(address, config.host); resolve(); }
  }));
  assert.equal(fake.calls[0].body, undefined);
  await assert.rejects(read('https://attacker.example/'), (err: unknown) => err instanceof IloError && err.code === 'invalid_target');
  await assert.rejects(read('/redfish/v1/../Actions/Reset'), (err: unknown) => err instanceof IloError && err.code === 'invalid_target');
  assert.equal(fake.calls.length, 1, 'invalid paths never reach request factory');
});

for (const [scenario, code] of [
  [{ status: 302 }, 'invalid_target'], [{ status: 401 }, 'authentication_failed'], [{ status: 403 }, 'insufficient_privilege'],
  [{ status: 404 }, 'missing_endpoint'], [{ status: 503 }, 'unreachable'], [{ timeout: true }, 'timeout'],
  [{ error: 'ERR_TLS_CERT_ALTNAME_INVALID' }, 'tls_failed'], [{ body: 'not-json' }, 'malformed_response'],
  [{ body: '[]' }, 'malformed_response'], [{ body: 'x'.repeat(1024 * 1024 + 1) }, 'oversized_response'],
] as const) {
  test(`read transport reports ${code} without leaking credentials`, async () => {
    const fake = fakeNetwork(scenario);
    const read = await createIloTransport(config, { request: fake.request });
    await assert.rejects(read('/rest/v1/Chassis/A/Power'), (err: unknown) => {
      assert.ok(err instanceof IloError);
      assert.equal(err.code, code);
      assert.equal(err.message.includes(config.password), false);
      return true;
    });
  });
}

test('runtime PATCH transport permits only discovered System paths and a single mode property', async () => {
  const fake = fakeNetwork({ status: 204 });
  const patch = await createRuntimePatchTransport(config, { request: fake.request });
  await patch('/redfish/v1/Systems/42', 'Hpe', 'Dynamic');
  assert.equal(fake.calls[0].options.method, 'PATCH');
  assert.deepEqual(JSON.parse(fake.calls[0].body || ''), { Oem: { Hpe: { PowerRegulatorMode: 'Dynamic' } } });
  await assert.rejects(patch('/redfish/v1/Systems/42/Actions/ComputerSystem.Reset', 'Hpe', 'Dynamic'), IloError);
  assert.equal(fake.calls.length, 1);
});

test('runtime PATCH sends a validated If-Match and maps 412 to a conflict', async () => {
  const fake = fakeNetwork({ status: 412 });
  const patch = await createRuntimePatchTransport(config, { request: fake.request });
  await assert.rejects(patch('/redfish/v1/Systems/42', 'Hpe', 'Max', '"etag-1"'),
    (err: unknown) => err instanceof IloError && err.code === 'conflict');
  assert.equal(fake.calls[0].options.headers['If-Match'], '"etag-1"');
  await assert.rejects(patch('/redfish/v1/Systems/42', 'Hpe', 'Max', '"bad\r\nheader"'), IloError);
  assert.equal(fake.calls.length, 1);
});

test('runtime PATCH timeout and redirect are uncertain/fail closed and never include secret text', async () => {
  for (const [scenario, code] of [[{ timeout: true }, 'timeout'], [{ status: 302 }, 'invalid_target']] as const) {
    const fake = fakeNetwork(scenario);
    const patch = await createRuntimePatchTransport(config, { request: fake.request });
    await assert.rejects(patch('/redfish/v1/Systems/42', 'Hp', 'Min'), (err: unknown) => {
      assert.ok(err instanceof IloError);
      assert.equal(err.code, code);
      assert.equal(err.message.includes(config.password), false);
      return true;
    });
  }
});

// A device that keeps the socket busy with one byte at a time never trips the
// idle `timeout`; only the wall-clock deadline ends the request.
function slowDripNetwork() {
  const calls: { options: any }[] = [];
  let timers: ReturnType<typeof setInterval>[] = [];
  const request = ((options: any, callback: (response: any) => void) => {
    const req = new EventEmitter() as any;
    let timer: ReturnType<typeof setInterval> | undefined;
    req.destroy = (error: Error) => { clearInterval(timer); req.emit('error', error); req.emit('close'); };
    req.end = () => {
      calls.push({ options });
      queueMicrotask(() => {
        const response = new EventEmitter() as any;
        response.statusCode = options.method === 'PATCH' ? 204 : 200;
        response.resume = () => {};
        callback(response);
        timer = setInterval(() => response.emit('data', Buffer.from(' ')), 5);
        timers.push(timer);
      });
    };
    return req;
  }) as unknown as typeof https.request;
  return { request, calls, stop: () => { timers.forEach(clearInterval); timers = []; } };
}

test('slow-drip read and PATCH responses end at the wall-clock deadline', async () => {
  const fake = slowDripNetwork();
  try {
    const read = await createIloTransport(config, { request: fake.request, requestDeadlineMs: 60 });
    const started = Date.now();
    await assert.rejects(read('/redfish/v1/'), (err: unknown) => err instanceof IloError && err.code === 'timeout');
    assert.ok(Date.now() - started < 1000, 'deadline, not the drip, ends the request');
    const patch = await createRuntimePatchTransport(config, { request: fake.request, requestDeadlineMs: 60 });
    await assert.rejects(patch('/redfish/v1/Systems/1', 'Hpe', 'Dynamic'), (err: unknown) => err instanceof IloError && err.code === 'timeout');
  } finally { fake.stop(); }
});

test('discovery has an overall deadline across individually slow reads', async () => {
  let calls = 0;
  const slow = async () => { calls += 1; await new Promise((resolve) => setTimeout(resolve, 30)); return { Systems: { '@odata.id': '/redfish/v1/Systems/' }, Members: [{ '@odata.id': '/redfish/v1/Systems/1/' }] } as Record<string, any>; };
  await assert.rejects(discoverHardware(config, slow, () => new Date(), 45), (err: unknown) => err instanceof IloError && err.code === 'timeout');
  assert.ok(calls <= 2);
  let clock = 0;
  const guarded = withDiscoveryDeadline(async () => ({}), 100, () => clock);
  assert.deepEqual(await guarded('/redfish/v1/'), {});
  clock = 100;
  await assert.rejects(guarded('/redfish/v1/'), (err: unknown) => err instanceof IloError && err.code === 'timeout');
});

test('PATCH distinguishes rejected credentials from missing write privilege', async () => {
  for (const [status, code] of [[401, 'authentication_failed'], [403, 'insufficient_privilege']] as const) {
    const patch = await createRuntimePatchTransport(config, { request: fakeNetwork({ status }).request });
    await assert.rejects(patch('/redfish/v1/Systems/1', 'Hpe', 'Dynamic'), (err: unknown) => err instanceof IloError && err.code === code);
  }
});
