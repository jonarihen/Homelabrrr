import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { X509Certificate } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createIloTransport, createRuntimePatchTransport, IloError, normalizeTlsFingerprint, probeIloCertificate } from './iloAdapter.ts';
import { fixtureA, fixtureB } from './iloPinning.fixtures.ts';

// A real local TLS server stands in for an iLO with a self-signed
// certificate. The address guard is bypassed only to reach 127.0.0.1.
const pinA = new X509Certificate(fixtureA.cert).fingerprint256;
const pinB = new X509Certificate(fixtureB.cert).fingerprint256;
const local = { validateTarget: async () => '127.0.0.1' };
let server: https.Server;
let port = 0;
const seen: { path?: string; authorization?: string; method?: string }[] = [];

before(async () => {
  server = https.createServer({ key: fixtureA.key, cert: fixtureA.cert }, (req, res) => {
    seen.push({ path: req.url, authorization: req.headers.authorization, method: req.method });
    req.resume();
    req.on('end', () => {
      if (req.method === 'PATCH') { res.writeHead(204); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"PowerConsumedWatts":180}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

const config = (tlsFingerprint: string | null) => ({ host: 'ilo-pve01.lab.test', port, username: 'monitor', password: 'pinned-secret', verifyTls: false, tlsFingerprint });

test('fingerprints normalize from any common spelling', () => {
  assert.equal(normalizeTlsFingerprint(pinA.toLowerCase()), pinA);
  assert.equal(normalizeTlsFingerprint(pinA.replace(/:/g, '')), pinA);
  assert.equal(normalizeTlsFingerprint(pinA.replace(/:/g, ' ')), pinA);
  assert.equal(normalizeTlsFingerprint('AB:CD'), null);
  assert.equal(normalizeTlsFingerprint(null), null);
});

test('probe reads the self-signed certificate without sending credentials or an HTTP request', async () => {
  seen.length = 0;
  const probe = await probeIloCertificate('ilo-pve01.lab.test', port, local);
  assert.equal(probe.fingerprint256, pinA);
  assert.equal(probe.subject, 'ILO-FIXTURE-a');
  assert.equal(probe.selfSigned, true);
  assert.ok(probe.validTo);
  assert.equal(seen.length, 0, 'the probe never reaches the HTTP layer');
});

test('a matching pin connects to a self-signed iLO without ALLOW_INSECURE_UPSTREAM_TLS', async () => {
  const previous = process.env.ALLOW_INSECURE_UPSTREAM_TLS;
  delete process.env.ALLOW_INSECURE_UPSTREAM_TLS;
  try {
    seen.length = 0;
    const read = await createIloTransport(config(pinA), local);
    assert.deepEqual(await read('/redfish/v1/Chassis/1/Power'), { PowerConsumedWatts: 180 });
    assert.equal(seen[0].authorization, `Basic ${Buffer.from('monitor:pinned-secret').toString('base64')}`);
    const patch = await createRuntimePatchTransport(config(pinA), local);
    await patch('/redfish/v1/Systems/1', 'Hp', 'Dynamic');
    assert.equal(seen[1].method, 'PATCH');
  } finally { if (previous === undefined) delete process.env.ALLOW_INSECURE_UPSTREAM_TLS; else process.env.ALLOW_INSECURE_UPSTREAM_TLS = previous; }
});

test('a changed certificate stops the connection before the password is sent', async () => {
  seen.length = 0;
  const read = await createIloTransport(config(pinB), local);
  await assert.rejects(read('/redfish/v1/Chassis/1/Power'), (err: unknown) => {
    assert.ok(err instanceof IloError);
    assert.equal(err.code, 'tls_failed');
    assert.match(err.detail || '', /certificate changed/);
    assert.ok(err.detail?.includes(pinA) && err.detail.includes(pinB), 'detail shows the presented and the pinned fingerprint');
    assert.equal(err.detail?.includes('pinned-secret'), false);
    return true;
  });
  const patch = await createRuntimePatchTransport(config(pinB), local);
  await assert.rejects(patch('/redfish/v1/Systems/1', 'Hp', 'Max'), (err: unknown) => err instanceof IloError && err.code === 'tls_failed');
  assert.equal(seen.length, 0, 'no HTTP request (and so no Authorization header) reached the impostor');
});

test('without a pin, unverified TLS still needs the explicit server flag', async () => {
  const previous = process.env.ALLOW_INSECURE_UPSTREAM_TLS;
  delete process.env.ALLOW_INSECURE_UPSTREAM_TLS;
  try {
    await assert.rejects(createIloTransport(config(null), local), (err: unknown) => err instanceof IloError && err.code === 'tls_failed' && /pin the iLO certificate/.test(err.detail || ''));
  } finally { if (previous !== undefined) process.env.ALLOW_INSECURE_UPSTREAM_TLS = previous; }
});
