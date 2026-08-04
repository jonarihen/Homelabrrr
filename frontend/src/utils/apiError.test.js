// Regression coverage for the <ErrorCallout> input normaliser (issue #69).
// The load-bearing property is the fallback: the ~167 call sites that still
// hand it a plain string must keep rendering exactly that string.
// Run with:  node --test src/utils/apiError.test.js   (from frontend/)
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeApiError, errorHrefLabel } from './apiError.js';

test('the translated payload renders as title + detail + action + href', () => {
  const err = {
    response: {
      data: {
        error: 'VM is locked by another Proxmox task — … Wait for it.',
        title: 'VM is locked by another Proxmox task',
        detail: 'Proxmox is already running a "backup" task on this VM.',
        action: 'Wait for the running task to finish, then try again.',
      },
    },
  };
  assert.deepEqual(normalizeApiError(err), {
    title: 'VM is locked by another Proxmox task',
    detail: 'Proxmox is already running a "backup" task on this VM.',
    action: 'Wait for the running task to finish, then try again.',
    href: '',
  });
});

test('href is carried through when the payload has one', () => {
  const err = { response: { data: { title: 'T', detail: 'D', action: 'A', href: '/admin/hosts' } } };
  assert.equal(normalizeApiError(err).href, '/admin/hosts');
});

test('an unconverted endpoint falls back to its plain error string', () => {
  const err = { response: { data: { error: 'Failed to start VM' } } };
  assert.deepEqual(normalizeApiError(err), {
    title: 'Failed to start VM', detail: '', action: '', href: '',
  });
});

test('a bare string — what most call sites still keep in state — renders as-is', () => {
  assert.deepEqual(normalizeApiError('Access denied'), {
    title: 'Access denied', detail: '', action: '', href: '',
  });
});

test('a response body passed directly works the same as an axios error', () => {
  assert.equal(normalizeApiError({ error: 'nope' }).title, 'nope');
  assert.equal(normalizeApiError({ title: 'T', detail: 'D', action: 'A' }).detail, 'D');
});

test('a network failure falls back to the Error message', () => {
  assert.equal(normalizeApiError(new Error('Network Error')).title, 'Network Error');
  assert.equal(normalizeApiError({ message: 'timeout of 0ms exceeded' }).title, 'timeout of 0ms exceeded');
});

test('an HTML/text error body renders as the line it is', () => {
  assert.equal(normalizeApiError({ response: { data: '502 Bad Gateway' } }).title, '502 Bad Gateway');
});

test('empty and missing input uses the caller fallback', () => {
  for (const input of [null, undefined, false, '', '   ', {}, { response: { data: {} } }]) {
    assert.equal(normalizeApiError(input, 'Failed to load VMs').title, 'Failed to load VMs', String(input));
  }
});

test('there is a fallback even when the caller supplies none', () => {
  const shape = normalizeApiError(null);
  assert.equal(typeof shape.title, 'string');
  assert.ok(shape.title.length > 0);
});

test('a blank title in the payload does not win over the error string', () => {
  const err = { response: { data: { title: '   ', error: 'Failed to start VM' } } };
  assert.equal(normalizeApiError(err).title, 'Failed to start VM');
});

test('every branch returns the same four string keys', () => {
  for (const input of [null, 'x', new Error('y'), { error: 'z' }, { title: 'a', detail: 'b', action: 'c' }]) {
    const shape = normalizeApiError(input);
    assert.deepEqual(Object.keys(shape).sort(), ['action', 'detail', 'href', 'title']);
    for (const v of Object.values(shape)) assert.equal(typeof v, 'string');
  }
});

test('never throws, whatever it is handed', () => {
  for (const input of [0, 42, Symbol('s'), [], () => {}, { response: null }]) {
    assert.doesNotThrow(() => normalizeApiError(input));
  }
});

test('href labels match the hrefs the backend emits', () => {
  assert.equal(errorHrefLabel('/admin/hosts'), 'Proxmox hosts');
  assert.equal(errorHrefLabel('/admin/firewalls'), 'Firewalls');
  assert.equal(errorHrefLabel('/somewhere/else'), 'settings');
});
