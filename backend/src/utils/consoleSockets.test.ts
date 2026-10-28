// Run with:  node --test src/utils/consoleSockets.test.ts   (from backend/)
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { trackConsoleSocket, closeSessionConsoles, closeUserConsoles } from './consoleSockets.ts';

class FakeSocket extends EventEmitter {
  closedWith: unknown[] | null = null;
  close(...args: unknown[]) { this.closedWith = args; this.emit('close'); }
}

test('revoking a session closes only that session\'s consoles', () => {
  const a1 = new FakeSocket(); const a2 = new FakeSocket(); const b = new FakeSocket();
  trackConsoleSocket(a1, 'sid-a', 1);
  trackConsoleSocket(a2, 'sid-a', 1);
  trackConsoleSocket(b, 'sid-b', 1);
  assert.equal(closeSessionConsoles('sid-a'), 2);
  assert.deepEqual(a1.closedWith, [4001, 'Session revoked']);
  assert.ok(a2.closedWith);
  assert.equal(b.closedWith, null);
  assert.equal(closeSessionConsoles('sid-a'), 0, 'already closed sockets are forgotten');
  closeSessionConsoles('sid-b');
});

test('deleting a user closes all of that user\'s consoles across sessions', () => {
  const u1 = new FakeSocket(); const u2 = new FakeSocket(); const other = new FakeSocket();
  trackConsoleSocket(u1, 'sid-1', 7);
  trackConsoleSocket(u2, 'sid-2', 7);
  trackConsoleSocket(other, 'sid-3', 8);
  assert.equal(closeUserConsoles(7), 2);
  assert.equal(other.closedWith, null);
  closeUserConsoles(8);
});

test('a console that closed on its own is no longer tracked', () => {
  const ws = new FakeSocket();
  trackConsoleSocket(ws, 'sid-x', 9);
  ws.emit('close');
  assert.equal(closeSessionConsoles('sid-x'), 0);
  assert.equal(ws.closedWith, null);
});
