// Per-host certificate pinning for every PVE connection path (#275).
// A real local TLS server with a self-signed certificate stands in for PVE.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import net from 'node:net';
import { X509Certificate } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { fixtureA, fixtureB } from './services/iloPinning.fixtures.ts';

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/test';
process.env.SECRET_ENCRYPTION_KEY ||= '44'.repeat(32);
// Pinning must work without the break-glass flag (read once at import).
delete process.env.ALLOW_INSECURE_UPSTREAM_TLS;

const { encryptSecret } = await import('./utils/secrets.ts');
const { agentForHost, classifyConnectionError, getHostCertFingerprint, testHostConnection } = await import('./proxmox.ts');

const pinA = new X509Certificate(fixtureA.cert).fingerprint256;
const pinB = new X509Certificate(fixtureB.cert).fingerprint256;
const GOOD = 'PVEAPIToken=root@pam!t=sekret';
const seen: (string | undefined)[] = [];
let server: https.Server;
let port = 0;

before(async () => {
  server = https.createServer({ key: fixtureA.key, cert: fixtureA.cert }, (req, res) => {
    seen.push(req.headers.authorization);
    const ok = req.headers.authorization === GOOD;
    res.writeHead(ok ? 200 : 401, { 'Content-Type': 'application/json' });
    res.end(ok ? '{"data":{"version":"8.2.4"}}' : '{"data":null}');
  });
  new WebSocketServer({ server }).on('connection', (ws) => ws.send('hello'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});
after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));

const host = (over: Record<string, unknown> = {}) => ({
  name: 'pve-test', host: '127.0.0.1', port, token_id: 'root@pam!t', token_secret: encryptSecret('sekret'),
  verify_tls: false, tls_fingerprint: pinA, ...over,
});

test('a matching pin connects to a self-signed PVE without ALLOW_INSECURE_UPSTREAM_TLS', async () => {
  seen.length = 0;
  assert.deepEqual(await testHostConnection(host()), { ok: true, version: '8.2.4' });
  // The pin replaces CA validation even when verify_tls is on.
  assert.equal((await testHostConnection(host({ verify_tls: true, tls_fingerprint: pinA.toLowerCase() }))).ok, true);
  assert.deepEqual(seen, [GOOD, GOOD]);
});

test('a changed certificate fails before the token is sent', async () => {
  seen.length = 0;
  const result = await testHostConnection(host({ tls_fingerprint: pinB }));
  assert.equal(result.ok, false);
  assert.equal(result.category, 'fingerprint_mismatch');
  assert.equal(result.presentedFingerprint, pinA);
  assert.equal(seen.length, 0, 'no HTTP request reached the impostor');
});

test('without a pin, verify_tls behaves as before', async () => {
  seen.length = 0;
  assert.equal((await testHostConnection(host({ verify_tls: true, tls_fingerprint: null }))).category, 'tls_untrusted');
  assert.equal((await testHostConnection(host({ verify_tls: false, tls_fingerprint: null }))).category, 'tls_untrusted', 'insecure needs the break-glass flag');
  assert.equal(seen.length, 0);
  assert.throws(() => agentForHost(host({ verify_tls: false, tls_fingerprint: null })), /ALLOW_INSECURE_UPSTREAM_TLS/);
  assert.equal(agentForHost(host({ verify_tls: true, tls_fingerprint: null })).options.rejectUnauthorized, true);
});

test('test connection categorizes auth, unreachable and timeout failures', async () => {
  const auth = await testHostConnection(host({ token_secret: encryptSecret('wrong') }));
  assert.equal(auth.category, 'auth_failed');
  assert.equal(JSON.stringify(auth).includes('wrong'), false);
  const closed = net.createServer();
  await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const closedPort = (closed.address() as AddressInfo).port;
  await new Promise<void>((resolve) => closed.close(() => resolve()));
  assert.equal((await testHostConnection(host({ port: closedPort }))).category, 'unreachable');
  assert.equal(classifyConnectionError(new Error('Proxmox request timeout')), 'timeout');
  assert.equal(classifyConnectionError(Object.assign(new Error('x'), { code: 'ETIMEDOUT' })), 'timeout');
  assert.equal(classifyConnectionError(Object.assign(new Error('x'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' })), 'tls_untrusted');
});

test('the noVNC websocket path honours the pin', async () => {
  const url = `wss://127.0.0.1:${port}/api2/json/nodes/pve/qemu/100/vncwebsocket`;
  const message = await new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { agent: agentForHost(host()), headers: { Authorization: GOOD } });
    ws.once('message', (data) => { ws.close(); resolve(String(data)); });
    ws.once('error', reject);
  });
  assert.equal(message, 'hello');
  const err = await new Promise<Error & { code?: string }>((resolve) => {
    const ws = new WebSocket(url, { agent: agentForHost(host({ tls_fingerprint: pinB })) });
    ws.once('error', resolve);
    ws.once('open', () => { ws.close(); resolve(new Error('opened')); });
  });
  assert.equal(err.code, 'PVE_TLS_PIN_MISMATCH');
  assert.match(err.message, /certificate changed/);
});

test('remote-migrate fingerprint read checks the pin', async () => {
  assert.equal(await getHostCertFingerprint(host()), pinA);
  await assert.rejects(getHostCertFingerprint(host({ tls_fingerprint: pinB })), { code: 'PVE_TLS_PIN_MISMATCH' });
});
