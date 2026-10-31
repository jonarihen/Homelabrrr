// Run with:  node --test src/utils/consoleSockets.test.ts   (from backend/)
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import net from 'node:net';
import { WebSocketServer } from 'ws';
import { trackConsoleSocket, closeSessionConsoles, closeUserConsoles } from './consoleSockets.ts';

class FakeSocket extends EventEmitter {
  readyState = 1;
  closedWith: unknown[] | null = null;
  terminated = false;
  close(...args: unknown[]) { this.closedWith = args; this.readyState = 2; }
  terminate() {
    if (this.readyState === 3) return;
    this.terminated = true;
    this.readyState = 3;
    this.emit('close');
  }
}

const live = { hasLiveSession: async () => true };
const revoked = { hasLiveSession: async () => false };

test('revoking a session terminates only that session\'s consoles', async () => {
  const a1 = new FakeSocket(); const a2 = new FakeSocket(); const b = new FakeSocket();
  assert.equal(await trackConsoleSocket(a1, 'sid-a', 1, live), true);
  await trackConsoleSocket(a2, 'sid-a', 1, live);
  await trackConsoleSocket(b, 'sid-b', 1, live);
  assert.equal(closeSessionConsoles('sid-a'), 2);
  assert.deepEqual(a1.closedWith, [4001, 'Session revoked']);
  assert.equal(a1.terminated, true);
  assert.equal(a1.readyState, 3);
  assert.equal(a2.terminated, true);
  assert.equal(b.terminated, false);
  assert.equal(closeSessionConsoles('sid-a'), 0, 'already closed sockets are forgotten');
  closeSessionConsoles('sid-b');
});

test('deleting a user terminates all of that user\'s consoles across sessions', async () => {
  const u1 = new FakeSocket(); const u2 = new FakeSocket(); const other = new FakeSocket();
  await trackConsoleSocket(u1, 'sid-1', 7, live);
  await trackConsoleSocket(u2, 'sid-2', 7, live);
  await trackConsoleSocket(other, 'sid-3', 8, live);
  assert.equal(closeUserConsoles(7), 2);
  assert.equal(u1.terminated && u2.terminated, true);
  assert.equal(other.terminated, false);
  closeUserConsoles(8);
});

test('a console that closed on its own is no longer tracked', async () => {
  const ws = new FakeSocket();
  await trackConsoleSocket(ws, 'sid-x', 9, live);
  ws.emit('close');
  assert.equal(closeSessionConsoles('sid-x'), 0);
  assert.equal(ws.closedWith, null);
});

test('a socket registered after its session was revoked is terminated, not proxied', async () => {
  const ws = new FakeSocket();
  assert.equal(closeSessionConsoles('sid-late'), 0, 'the revocation sweep ran before registration');
  assert.equal(await trackConsoleSocket(ws, 'sid-late', 3, revoked), false);
  assert.deepEqual(ws.closedWith, [4001, 'Session revoked']);
  assert.equal(ws.terminated, true);
  assert.equal(closeSessionConsoles('sid-late'), 0);
});

test('a revocation that lands while the session is being re-checked still wins', async () => {
  const ws = new FakeSocket();
  let release: (value: boolean) => void = () => {};
  const pending = trackConsoleSocket(ws, 'sid-race', 4, {
    hasLiveSession: () => new Promise<boolean>((resolve) => { release = resolve; }),
  });
  assert.equal(closeSessionConsoles('sid-race'), 1);
  assert.equal(ws.terminated, true);
  release(true);
  assert.equal(await pending, false);
});

test('a failed session re-check fails closed', async () => {
  const ws = new FakeSocket();
  const ok = await trackConsoleSocket(ws, 'sid-err', 5, { hasLiveSession: async () => { throw new Error('db down'); } });
  assert.equal(ok, false);
  assert.equal(ws.terminated, true);
});

test('a socket that already closed during the upgrade is not tracked', async () => {
  const ws = new FakeSocket();
  ws.readyState = 3;
  assert.equal(await trackConsoleSocket(ws, 'sid-gone', 6, live), false);
  assert.equal(closeSessionConsoles('sid-gone'), 0);
});

test('a revoked peer that never acknowledges the close frame is dropped immediately', async () => {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(wss, 'listening');
  const { port } = wss.address() as net.AddressInfo;
  const accepted = once(wss, 'connection');
  // A raw TCP peer: completes the handshake, then ignores every frame (no close ack).
  const peer = net.connect(port, '127.0.0.1', () => {
    peer.write('GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
      + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
  });
  peer.on('error', () => {});
  const [ws] = await accepted;
  const forwarded: unknown[] = [];
  ws.on('message', (data) => forwarded.push(data));
  assert.equal(await trackConsoleSocket(ws, 'sid-hostile', 11, live), true);

  const closed = once(ws, 'close');
  const started = Date.now();
  assert.equal(closeSessionConsoles('sid-hostile'), 1);
  await closed;
  assert.ok(Date.now() - started < 1000, 'closed without waiting for the 30s close handshake timeout');
  assert.equal(ws.readyState, 3);
  peer.write(Buffer.from([0x82, 0x80, 0, 0, 0, 0]));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(forwarded, []);
  peer.destroy();
  wss.close();
});
