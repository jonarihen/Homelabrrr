import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import ssh2 from 'ssh2';
import { createSshConnection, proxySshShell } from './sshConnect.ts';

const { Server, utils } = ssh2;

function fixtureKeyPair() {
  for (let attempt = 0; attempt < 10; attempt++) {
    const key = utils.generateKeyPairSync('ed25519');
    if (!(utils.parseKey(key.private) instanceof Error)) return key;
  }
  throw new Error('Could not generate a parseable SSH fixture key');
}

const hostKey = fixtureKeyPair();
const clientKey = fixtureKeyPair();
const hostFingerprint = `SHA256:${createHash('sha256')
  .update(Buffer.from(String(hostKey.public).split(' ')[1], 'base64'))
  .digest('base64')}`;

let liveConnections = 0;
let authDelayMs = 0;
let refuseShell = false;

const server = new Server({ hostKeys: [hostKey.private] }, (client) => {
  liveConnections += 1;
  let closed = false;
  client.on('close', () => { closed = true; liveConnections -= 1; });
  client.on('error', () => { /* the proxy hangs up mid-handshake on purpose */ });
  // Accepting on a connection the proxy already dropped arms ssh2's 60s keepalive timer.
  client.on('authentication', (ctx) => setTimeout(() => { if (!closed) ctx.accept(); }, authDelayMs));
  client.on('ready', () => {
    client.on('session', (accept) => {
      const session = accept();
      session.on('pty', (accept) => accept?.());
      session.on('shell', (accept, reject) => {
        if (refuseShell) { reject(); return; }
        accept();
      });
    });
  });
});

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
const { port } = server.address() as { port: number };
test.after(() => server.close());

/** Minimal stand-in for the `ws` socket the console proxy writes to. */
function fakeClient() {
  const ws = new EventEmitter() as EventEmitter & { readyState: number; sent: Array<Record<string, unknown>>; send: (m: string) => void; close: () => void };
  ws.readyState = 1;
  ws.sent = [];
  ws.send = (m) => { ws.sent.push(JSON.parse(m)); };
  ws.close = () => {
    if (ws.readyState !== 1) return;
    ws.readyState = 3;
    ws.emit('close');
  };
  return ws;
}

const session = () => ({
  host: '127.0.0.1', port, username: 'tester', privateKey: clientKey.private, passphrase: '', hostFingerprint,
  requestId: 'req', node: 'host1~pve1', vmid: 101,
});

async function waitForConnectionsToClose() {
  for (let attempt = 0; attempt < 100 && liveConnections > 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(liveConnections, 0, 'SSH connection was left open');
}

test('a client that leaves during the SSH handshake does not leak the connection', async () => {
  authDelayMs = 150;
  const ws = fakeClient();
  const done = proxySshShell(ws, session());
  setTimeout(() => ws.close(), 50);
  await done;
  authDelayMs = 0;
  assert.ok(!ws.sent.some((m) => m.status === 'connected'));
  await waitForConnectionsToClose();
});

test('a client that leaves mid-handshake aborts it instead of waiting for ready', async () => {
  authDelayMs = 5000;
  const ws = fakeClient();
  const started = Date.now();
  const done = proxySshShell(ws, session());
  setTimeout(() => ws.close(), 50);
  await done;
  await waitForConnectionsToClose();
  authDelayMs = 0;
  assert.ok(Date.now() - started < 2000, 'the pending handshake was not aborted');
  assert.equal(ws.sent.length, 0);
});

test('a refused shell ends the SSH connection and reports an error', async () => {
  refuseShell = true;
  const ws = fakeClient();
  await proxySshShell(ws, session());
  await waitForConnectionsToClose();
  refuseShell = false;
  assert.equal(ws.readyState, 3);
  assert.ok(ws.sent.some((m) => m.type === 'error' && typeof m.code === 'string'));
});

test('closing the console ends an established shell', async () => {
  const ws = fakeClient();
  await proxySshShell(ws, session());
  for (let attempt = 0; attempt < 100 && !ws.sent.some((m) => m.status === 'connected'); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await new Promise((resolve) => setTimeout(resolve, 50)); // let the shell open
  ws.close();
  await waitForConnectionsToClose();
});

test('a host key mismatch is reported without connecting', async () => {
  const ws = fakeClient();
  await proxySshShell(ws, { ...session(), hostFingerprint: `SHA256:${'A'.repeat(43)}` });
  assert.equal(ws.readyState, 3);
  assert.ok(ws.sent.some((m) => m.type === 'error'));
  await waitForConnectionsToClose();
});

test('a shell that cannot open because the transport dropped is reported, not thrown', async () => {
  // ssh2 throws synchronously ("Not connected") when the server hangs up right
  // after ready; force that branch deterministically.
  const originalShell = ssh2.Client.prototype.shell;
  ssh2.Client.prototype.shell = function () { throw new Error('Not connected'); };
  try {
    const ws = fakeClient();
    await proxySshShell(ws, session()); // must resolve, not reject
    assert.equal(ws.readyState, 3);
    assert.ok(ws.sent.some((m) => m.type === 'error' && typeof m.code === 'string'));
    await waitForConnectionsToClose();
  } finally {
    ssh2.Client.prototype.shell = originalShell;
  }
});

test('a target that hangs up cleanly during the handshake rejects instead of hanging', async () => {
  // Completes the key exchange, then hangs up during auth: ssh2 emits only
  // end/close here, never error.
  const silent = new Server({ hostKeys: [hostKey.private] }, (client) => {
    client.on('error', () => { /* hanging up is the point */ });
    client.on('authentication', () => client.end());
  });
  await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', () => resolve()));
  try {
    const { port: silentPort } = silent.address() as { port: number };
    const started = Date.now();
    await assert.rejects(() => createSshConnection({ ...session(), port: silentPort }), /closed during handshake/);
    assert.ok(Date.now() - started < 5000, 'settled before the ready timeout');
  } finally {
    silent.close();
  }
});

test('a transport error after ready reaches the browser as an error frame', async () => {
  const clients = [];
  const originalConnect = ssh2.Client.prototype.connect;
  ssh2.Client.prototype.connect = function (...args) { clients.push(this); return originalConnect.apply(this, args); };
  try {
    const ws = fakeClient();
    await proxySshShell(ws, session());
    assert.ok(ws.sent.some((m) => m.status === 'connected'));
    const [client] = clients;
    client.emit('error', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
    assert.equal(ws.readyState, 3);
    assert.ok(ws.sent.some((m) => m.type === 'error' && typeof m.code === 'string'));
    client.end();
    await waitForConnectionsToClose();
  } finally {
    ssh2.Client.prototype.connect = originalConnect;
  }
});
