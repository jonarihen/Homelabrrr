// Per-host certificate pinning for every PVE connection path (#275).
// A real local TLS server with a self-signed certificate stands in for PVE.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import tls from 'node:tls';
import { probeIloCertificate } from './services/iloAdapter.ts';
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
const { agentForHost, classifyConnectionError, getHostCertFingerprint, hostDelete, hostPost, testHostConnection } = await import('./proxmox.ts');
const dropped: { method: string | undefined; body: string }[] = [];

const pinA = new X509Certificate(fixtureA.cert).fingerprint256;
const pinB = new X509Certificate(fixtureB.cert).fingerprint256;
const GOOD = 'PVEAPIToken=root@pam!t=sekret';
const seen: (string | undefined)[] = [];
const sniSeen: (string | undefined)[] = [];
let server: https.Server;
let port = 0;

before(async () => {
  server = https.createServer({
    key: fixtureA.key,
    cert: fixtureA.cert,
    SNICallback: (servername, cb) => { sniSeen.push(servername); cb(null, tls.createSecureContext({ key: fixtureA.key, cert: fixtureA.cert })); },
  }, (req, res) => {
    seen.push(req.headers.authorization);
    if (req.url?.endsWith('/drop')) {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        dropped.push({ method: req.method, body });
        req.socket.destroy();
      });
      return;
    }
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

for (const method of ['DELETE', 'POST']) {
  test(`a ${method} accepted by a pinned self-signed host counts as submitted when the response drops`, async () => {
    seen.length = 0;
    dropped.length = 0;
    const payload = { vmid: 123, name: 'create-or-clone' };
    const request = method === 'POST' ? hostPost(host(), '/drop', payload) : hostDelete(host(), '/drop');
    const err = await request.then(() => null, (e) => e);
    assert.ok(err, 'the dropped request fails');
    assert.equal(err.submissionStarted, true);
    assert.deepEqual(seen, [GOOD]);
    assert.deepEqual(dropped, [{ method, body: method === 'POST' ? JSON.stringify(payload) : '' }]);
  });
}

test('a POST rejected by the pin never starts submission or reaches the server', async () => {
  seen.length = 0;
  dropped.length = 0;
  await assert.rejects(hostPost(host({ tls_fingerprint: pinB }), '/drop', { vmid: 123 }), (err: any) => {
    assert.equal(err.code, 'PVE_TLS_PIN_MISMATCH');
    assert.equal(err.submissionStarted, false);
    return true;
  });
  assert.deepEqual(seen, []);
  assert.deepEqual(dropped, []);
});

test('pinned DNS hosts send SNI on every path and IP literals never do', async () => {
  const dnsHost = host({ host: 'localhost' });
  const ipHost = host({ host: '127.0.0.1' });
  const waitForSni = async () => {
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (sniSeen.length) break;
    }
  };
  // REST path through the pinned agent (opens the TLS socket itself).
  sniSeen.length = 0;
  await testHostConnection(dnsHost);
  await waitForSni();
  assert.ok(sniSeen.length > 0, 'REST path sent SNI for a DNS host');
  assert.ok(sniSeen.every((name) => name === 'localhost'));
  // Migration fingerprint reader.
  sniSeen.length = 0;
  await getHostCertFingerprint(dnsHost);
  await waitForSni();
  assert.ok(sniSeen.length > 0, 'fingerprint reader sent SNI for a DNS host');
  assert.ok(sniSeen.every((name) => name === 'localhost'));
  // Certificate probe (same helper as the PVE admin endpoint).
  sniSeen.length = 0;
  const probe = await probeIloCertificate('localhost', port, { validateTarget: async (h) => h });
  assert.equal(probe.fingerprint256, pinA);
  await waitForSni();
  assert.ok(sniSeen.length > 0, 'certificate probe sent SNI for a DNS host');
  assert.ok(sniSeen.every((name) => name === 'localhost'));
  // IP literals must never be offered as SNI (RFC 6066 3).
  sniSeen.length = 0;
  assert.deepEqual(await testHostConnection(ipHost), { ok: true, version: '8.2.4' });
  assert.deepEqual(sniSeen, [], 'an IP-literal host must not send SNI');
});
