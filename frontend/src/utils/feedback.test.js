import test from 'node:test';
import assert from 'node:assert/strict';
import { toastReducer, toastTimeout, TOAST_TIMEOUT_MS, confirmOptions } from './feedback.js';

test('toasts are added in order and dismissed by id', () => {
  let s = toastReducer([], { type: 'add', toast: { id: 1, kind: 'success', message: 'a' } });
  s = toastReducer(s, { type: 'add', toast: { id: 2, kind: 'error', message: 'b' } });
  assert.deepEqual(s.map((t) => t.id), [1, 2]);
  s = toastReducer(s, { type: 'dismiss', id: 1 });
  assert.deepEqual(s.map((t) => t.id), [2]);
  assert.equal(toastReducer(s, { type: 'dismiss', id: 99 }).length, 1);
  assert.equal(toastReducer(s, { type: 'nope' }), s);
});

test('errors persist; other toasts auto-dismiss', () => {
  assert.equal(toastTimeout('error'), null);
  assert.equal(toastTimeout('success'), TOAST_TIMEOUT_MS);
  assert.equal(toastTimeout('info'), TOAST_TIMEOUT_MS);
});

test('confirm options accept a string or an object', () => {
  assert.deepEqual(confirmOptions('Delete?'), { title: 'Confirm', message: 'Delete?', confirmLabel: 'Confirm', cancelLabel: 'Cancel', danger: false });
  const o = confirmOptions({ message: 'Stop?', confirmLabel: 'Stop', danger: true });
  assert.equal(o.title, 'Are you sure?');
  assert.equal(o.confirmLabel, 'Stop');
  assert.equal(o.danger, true);
  assert.equal(confirmOptions({ title: 'T', danger: true }).title, 'T');
});
