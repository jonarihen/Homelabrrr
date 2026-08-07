// Coverage for the published-website edit form's Save-button guards.
// Run with:  node --test src/utils/siteEdit.test.js   (from frontend/)
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUpstreamPort, normalizeUpstreamHost, isUpstreamDraftValid, hasUpstreamChanged, isInspectionOn, hasSiteChanged } from './siteEdit.js';

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

test('inspection is on only when the site carries a profile name', () => {
  assert.equal(isInspectionOn({ inspectionProfile: 'inbound-deep-inspection' }), true);
  assert.equal(isInspectionOn({ inspectionProfile: '' }), false);
  assert.equal(isInspectionOn({ inspectionProfile: '   ' }), false);
  assert.equal(isInspectionOn({}), false);
  assert.equal(isInspectionOn(undefined), false);
});

test('toggling SSL inspection is saveable on its own', () => {
  const on = { upstreamHost: '10.11.26.5', upstreamPort: 8080, inspectionProfile: 'inbound-deep-inspection' };
  const unchanged = { upstreamHost: '10.11.26.5', upstreamPort: '8080' };

  // Turning it off frees a slot on the profile — a real change with an
  // unchanged upstream, which hasUpstreamChanged alone would call a no-op.
  assert.equal(hasSiteChanged(on, { ...unchanged, inspect: false }), true);
  assert.equal(hasSiteChanged(on, { ...unchanged, inspect: true }), false);

  const off = { ...on, inspectionProfile: '' };
  assert.equal(hasSiteChanged(off, { ...unchanged, inspect: true }), true);
  assert.equal(hasSiteChanged(off, { ...unchanged, inspect: false }), false);
});

test('a form that omits the inspection flag never reads as turning it off', () => {
  const on = { upstreamHost: '10.11.26.5', upstreamPort: 8080, inspectionProfile: 'inbound-deep-inspection' };
  assert.equal(hasSiteChanged(on, { upstreamHost: '10.11.26.5', upstreamPort: '8080' }), false);
  // ...but a genuine upstream edit still saves.
  assert.equal(hasSiteChanged(on, { upstreamHost: '10.11.26.9', upstreamPort: '8080' }), true);
});
