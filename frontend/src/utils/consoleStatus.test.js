// Regression coverage for the console reconnect gate. A typo'd status string
// here means the Reconnect button never appears and the user is back to
// closing the console and opening a new one — the bug this replaced.
// Run with:  node --test src/utils/consoleStatus.test.js   (from frontend/)
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONNECTING,
  CONNECTED,
  DISCONNECTED,
  CONNECTION_LOST,
  CONNECTION_ERROR,
  canReconnect,
  isConnected,
} from './consoleStatus.js';

test('every dead state offers a reconnect', () => {
  // These are the exact strings the panels set: RFB's clean/unclean disconnect
  // events, the SSH ws onclose/onerror handlers, and the {type:'error'} frame.
  for (const s of [DISCONNECTED, CONNECTION_LOST, CONNECTION_ERROR]) {
    assert.equal(canReconnect(s), true, s);
  }
});

test('a live or pending connection does not', () => {
  // Connected: nothing to fix. Connecting: a second ticket request would race
  // the first against a Proxmox proxy that only accepts one.
  assert.equal(canReconnect(CONNECTED), false);
  assert.equal(canReconnect(CONNECTING), false);
});

test('unknown or non-string statuses do not offer a reconnect', () => {
  for (const v of [undefined, null, '', 'connected', 'disconnected', 'Reconnecting…', 42, {}]) {
    assert.equal(canReconnect(v), false, JSON.stringify(v));
  }
});

test('isConnected only matches the exact connected status', () => {
  assert.equal(isConnected(CONNECTED), true);
  for (const s of [CONNECTING, DISCONNECTED, CONNECTION_LOST, CONNECTION_ERROR, 'connected', undefined]) {
    assert.equal(isConnected(s), false, String(s));
  }
});
