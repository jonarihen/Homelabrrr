// Coverage for the published-website edit form's Save-button guards.
// Run with:  node --test src/utils/siteEdit.test.js   (from frontend/)
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUpstreamPort, normalizeUpstreamHost, isUpstreamDraftValid, hasUpstreamChanged } from './siteEdit.js';

test('port normalization matches the backend range', () => {
  assert.equal(normalizeUpstreamPort(80), 80);
  assert.equal(normalizeUpstreamPort('8080'), 8080);
  assert.equal(normalizeUpstreamPort(' 443 '), 443);
  assert.equal(normalizeUpstreamPort(1), 1);
  assert.equal(normalizeUpstreamPort(65535), 65535);
  for (const bad of ['', '   ', 0, -1, 65536, 'http', null, undefined, NaN, {}]) {
    assert.equal(normalizeUpstreamPort(bad), null, JSON.stringify(bad));
  }
});

test('host normalization trims and tolerates missing values', () => {
  assert.equal(normalizeUpstreamHost('  10.11.26.5 '), '10.11.26.5');
  assert.equal(normalizeUpstreamHost(''), '');
  assert.equal(normalizeUpstreamHost(undefined), '');
  assert.equal(normalizeUpstreamHost(null), '');
});

test('a draft is submittable only with a host and a valid port', () => {
  assert.equal(isUpstreamDraftValid({ upstreamHost: '10.11.26.5', upstreamPort: '8080' }), true);
  assert.equal(isUpstreamDraftValid({ upstreamHost: 'app.lan', upstreamPort: 80 }), true);
  // A cleared field (the number input hands back '') must not be submittable.
  assert.equal(isUpstreamDraftValid({ upstreamHost: '10.11.26.5', upstreamPort: '' }), false);
  assert.equal(isUpstreamDraftValid({ upstreamHost: '   ', upstreamPort: '80' }), false);
  assert.equal(isUpstreamDraftValid({}), false);
  assert.equal(isUpstreamDraftValid(undefined), false);
});

test('an unchanged draft is not saveable — it would restart the publish flow for nothing', () => {
  const site = { upstreamHost: '10.11.26.5', upstreamPort: 8080 };
  assert.equal(hasUpstreamChanged(site, { upstreamHost: '10.11.26.5', upstreamPort: '8080' }), false);
  // The form keeps the port as a string; whitespace around the host is noise too.
  assert.equal(hasUpstreamChanged(site, { upstreamHost: ' 10.11.26.5 ', upstreamPort: 8080 }), false);
});

test('a changed host or port is saveable', () => {
  const site = { upstreamHost: '10.11.26.5', upstreamPort: 8080 };
  assert.equal(hasUpstreamChanged(site, { upstreamHost: '10.11.26.6', upstreamPort: '8080' }), true);
  assert.equal(hasUpstreamChanged(site, { upstreamHost: '10.11.26.5', upstreamPort: '3000' }), true);
  assert.equal(hasUpstreamChanged(site, { upstreamHost: 'app.lan', upstreamPort: '80' }), true);
});
