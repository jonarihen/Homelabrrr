// Regression coverage for FortiGate inspection-profile certificate slots.
// Run with:  node --test src/utils/certSlots.test.js   (from backend/)
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SERVER_CERT_MAX,
  ServerCertLimitError,
  certNameToSubject,
  certSlotKey,
  certWildcardCovers,
  isWildcardCertName,
  planServerCertList,
  stripCertDateSuffix,
} from './certSlots.js';
import { decodeHtmlEntities } from './sanitize.js';

// The real contents of JAHE-FW01's "inbound-deep-inspection" profile when
// publishing music.jackjack.dk hit the cap.
const FULL_PROFILE = [
  'www_tm_lestang_dk_22062026',
  'wildcard_aaris_wtf_21052026',
  'wildcard_aaris_tech_22062026',
  'tm_lestang_dk_21052026',
  'finebox_nikodyring_dev_22062026',
  'sif_nikodyring_dev_22062026',
  'antistasi_nikodyring_dev_17072026',
  'nikodyring_dev_17072026',
  'hofferson_com_21072026',
  'jackjack_dk_26072026',
];

test('the date stamp is stripped only when it is a plausible DDMMYYYY', () => {
  assert.equal(stripCertDateSuffix('jackjack_dk_26072026'), 'jackjack_dk');
  assert.equal(stripCertDateSuffix('hofferson-com-21072026'), 'hofferson-com');
  // 99 is not a day and 99 is not a month — leave the name alone.
  assert.equal(stripCertDateSuffix('weird_99999999'), 'weird_99999999');
  assert.equal(stripCertDateSuffix('no_suffix_here'), 'no_suffix_here');
});

test('cert names resolve back to the subject they were minted for', () => {
  assert.equal(certNameToSubject('jackjack_dk_26072026'), 'jackjack.dk');
  assert.equal(certNameToSubject('music_jackjack_dk_30072026'), 'music.jackjack.dk');
  assert.equal(certNameToSubject('wildcard_aaris_tech_22062026'), '*.aaris.tech');
  assert.equal(certNameToSubject('star-example-com'), '*.example.com');
  assert.equal(certNameToSubject('_.example.com'), '*.example.com');
  assert.equal(certNameToSubject('www_tm_lestang_dk_22062026'), 'www.tm.lestang.dk');
});

test('a renewal and its predecessor share one slot key', () => {
  assert.equal(certSlotKey('jackjack_dk_26072026'), certSlotKey('jackjack_dk_28082026'));
  assert.notEqual(certSlotKey('jackjack_dk_26072026'), certSlotKey('music_jackjack_dk_30072026'));
  // A hand-uploaded name with no recognizable subject keys to itself.
  assert.equal(certSlotKey('Fortinet_Factory'), 'fortinet.factory');
});

test('wildcard coverage matches a single label, like Caddy host matching', () => {
  assert.ok(isWildcardCertName('wildcard_jackjack_dk_30072026'));
  assert.ok(!isWildcardCertName('jackjack_dk_26072026'));
  assert.ok(certWildcardCovers('wildcard_jackjack_dk_30072026', 'music.jackjack.dk'));
  // The apex is NOT covered by *.jackjack.dk — it needs its own SAN.
  assert.ok(!certWildcardCovers('wildcard_jackjack_dk_30072026', 'jackjack.dk'));
  // Neither is a deeper label.
  assert.ok(!certWildcardCovers('wildcard_jackjack_dk_30072026', 'a.b.jackjack.dk'));
  assert.ok(!certWildcardCovers('jackjack_dk_26072026', 'music.jackjack.dk'));
});

test('a renewal replaces its predecessor in place, even on a full profile', () => {
  const plan = planServerCertList(FULL_PROFILE, 'jackjack_dk_28082026', 'jackjack.dk');
  assert.equal(plan.action, 'replace');
  assert.equal(plan.replaced, 'jackjack_dk_26072026');
  assert.equal(plan.list.length, SERVER_CERT_MAX);
  assert.ok(plan.list.includes('jackjack_dk_28082026'));
  assert.ok(!plan.list.includes('jackjack_dk_26072026'));
  // Order is preserved so unrelated entries keep their positions.
  assert.deepEqual(plan.list.slice(0, 9), FULL_PROFILE.slice(0, 9));
});

test('the exact name already attached is a no-op', () => {
  const plan = planServerCertList(FULL_PROFILE, 'jackjack_dk_26072026', 'jackjack.dk');
  assert.equal(plan.action, 'already-attached');
  assert.equal(plan.list, null);
});

test('a host already covered by a wildcard in the profile costs no slot', () => {
  const withWildcard = [...FULL_PROFILE.slice(0, 9), 'wildcard_jackjack_dk_30072026'];
  const plan = planServerCertList(withWildcard, 'music_jackjack_dk_30072026', 'music.jackjack.dk');
  assert.equal(plan.action, 'covered');
  assert.equal(plan.coveredBy, 'wildcard_jackjack_dk_30072026');
  assert.equal(plan.list, null);
});

test('a new subject on a full profile reports the limit instead of PUTting', () => {
  const plan = planServerCertList(FULL_PROFILE, 'music_jackjack_dk_30072026', 'music.jackjack.dk');
  assert.equal(plan.action, 'limit');
  assert.equal(plan.list, null);
  assert.deepEqual(plan.occupied, FULL_PROFILE);
});

test('a new subject with a slot free is appended', () => {
  const plan = planServerCertList(FULL_PROFILE.slice(0, 9), 'music_jackjack_dk_30072026', 'music.jackjack.dk');
  assert.equal(plan.action, 'append');
  assert.equal(plan.list.length, 10);
  assert.equal(plan.list[9], 'music_jackjack_dk_30072026');
});

test('object-shaped and string-shaped server-cert entries behave the same', () => {
  const asObjects = FULL_PROFILE.map((name) => ({ name, 'q_origin_key': name }));
  assert.deepEqual(
    planServerCertList(asObjects, 'jackjack_dk_28082026', 'jackjack.dk').list,
    planServerCertList(FULL_PROFILE, 'jackjack_dk_28082026', 'jackjack.dk').list,
  );
  assert.equal(planServerCertList([], 'jackjack_dk_28082026', 'jackjack.dk').action, 'append');
});

test('the limit error names the profile and every occupied slot', () => {
  const err = new ServerCertLimitError('inbound-deep-inspection', FULL_PROFILE);
  assert.equal(err.code, 'server_cert_limit');
  assert.ok(err.message.includes('inbound-deep-inspection'));
  assert.ok(err.message.includes('jackjack_dk_26072026'));
  assert.ok(err.message.includes(String(SERVER_CERT_MAX)));
  // Never tells the user to just retry — the cap does not clear on its own.
  assert.ok(!/^.*\bYou can retry\b/.test(err.message));
});

test('FortiOS HTML-escaped error text is decoded before it reaches the UI', () => {
  const raw = 'Command fail. Return code -4 &#40;reached the maximum number of entries&#41;';
  assert.equal(
    decodeHtmlEntities(raw),
    'Command fail. Return code -4 (reached the maximum number of entries)',
  );
  assert.equal(decodeHtmlEntities('a &amp; b &lt;c&gt; &quot;d&quot;'), 'a & b <c> "d"');
  assert.equal(decodeHtmlEntities('hex &#x28;paren&#x29;'), 'hex (paren)');
  // An already-escaped ampersand must not be re-expanded into a bracket.
  assert.equal(decodeHtmlEntities('&amp;#40;'), '&#40;');
  // Unknown entities and control code points are left as-is.
  assert.equal(decodeHtmlEntities('&nope; &#0;'), '&nope; &#0;');
  assert.equal(decodeHtmlEntities(''), '');
});
