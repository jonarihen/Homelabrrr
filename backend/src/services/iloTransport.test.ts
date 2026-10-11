import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type https from 'node:https';
import { createIloTransport, createRuntimePatchTransport, IloError } from './iloAdapter.ts';

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
  [{ status: 302 }, 'invalid_target'], [{ status: 401 }, 'authentication_failed'], [{ status: 403 }, 'authentication_failed'],
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
