import test from 'node:test';
import assert from 'node:assert/strict';
import { redact, redactText } from './logger.ts';

test('redaction removes nested credentials', () => {
  assert.deepEqual(redact({ nested: { tokenSecret: 'abc', ok: 'yes' } }), {
    nested: { tokenSecret: '[REDACTED]', ok: 'yes' },
  });
});

test('redaction removes credential-like URL and header values', () => {
  const text = redactText('Bearer abc.def url=?vncticket=sensitive&x=1 protocol=vmmgr-token-console-secret password=hunter2');
  assert.equal(text.includes('sensitive'), false);
  assert.equal(text.includes('abc.def'), false);
  assert.equal(text.includes('console-secret'), false);
  assert.equal(text.includes('hunter2'), false);
});
