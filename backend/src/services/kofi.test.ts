import test from 'node:test';
import assert from 'node:assert/strict';

// Pure rules only. The module imports the shared pool, which needs a URL at
// import time but opens no connection, so nothing here reaches a database.
process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.SECRET_ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef';
const kofi = await import('./kofi.ts');
const { manualReferenceKey } = await import('./manualContributions.ts');
const { kofiEvent, kofiSubscriptionEvent, kofiShopOrderEvent, kofiTimestamp, KOFI_SAMPLE_TRANSACTION_ID } = await import('../testUtils/kofiFixtures.ts');

const now = new Date('2026-11-09T12:00:00Z');
const classify = (overrides: Record<string, unknown>) => kofi.classifyKofiPayload(kofiEvent({ timestamp: kofiTimestamp(now), ...overrides }), now);
const reason = (overrides: Record<string, unknown>) => { const verdict = classify(overrides); return verdict.verdict === 'ok' ? 'ok' : verdict.code; };

test('amount strings convert to øre without floats', () => {
  assert.equal(kofi.decimalToMinorUnits('50.00'), 5000);
  assert.equal(kofi.decimalToMinorUnits('3'), 300);
  assert.equal(kofi.decimalToMinorUnits('0.1'), 10);
  // 19.99 * 100 is 1998.9999999999998 as a float; the string path is exact.
  assert.equal(kofi.decimalToMinorUnits('19.99'), 1999);
  assert.equal(kofi.decimalToMinorUnits('999999.99'), 99999999);
  for (const bad of [50, 50.5, '50,00', '50.000', '-1.00', '1e3', ' 50.00', '050.00', '', null, undefined, '1000000.00'])
    assert.equal(kofi.decimalToMinorUnits(bad), null, String(bad));
});

test('transaction ids normalize like manual reference keys', () => {
  const id = '0a1fac0c-f960-4506-a60e-824979a74e71';
  assert.equal(kofi.kofiTransactionKey(id), '0A1FAC0CF9604506A60E824979A74E71');
  assert.equal(kofi.kofiTransactionKey(id), manualReferenceKey(id), 'a manual report quoting the id produces the same key');
  assert.equal(kofi.kofiTransactionKey(id), manualReferenceKey(id.toUpperCase().replaceAll('-', ' ')));
  for (const bad of ['short', '--------', 'has space 12345', 'x'.repeat(65), 12345678, null, 'semi;colon1234'])
    assert.equal(kofi.kofiTransactionKey(bad), null, String(bad));
});

test('emails normalize and mask to a hint', () => {
  assert.equal(kofi.normalizeKofiEmail('  Anders.And@Example.DK '), 'anders.and@example.dk');
  for (const bad of ['no-at.example.dk', 'two@@example.dk', 'a b@example.dk', '@example.dk', 'a@', `${'x'.repeat(65)}@example.dk`, 42, null])
    assert.equal(kofi.normalizeKofiEmail(bad), null, String(bad));
  assert.equal(kofi.kofiEmailHint('anders.and@example.dk'), 'an…@example.dk');
  assert.equal(kofi.kofiEmailHint('ab@example.dk'), 'a…@example.dk');
  assert.equal(kofi.kofiEmailHint('a@example.dk'), 'a…@example.dk');
  const key = Buffer.alloc(32, 7);
  assert.equal(kofi.hashKofiEmail(key, 'a@example.dk'), kofi.hashKofiEmail(key, 'a@example.dk'));
  assert.notEqual(kofi.hashKofiEmail(key, 'a@example.dk'), kofi.hashKofiEmail(Buffer.alloc(32, 8), 'a@example.dk'), 'the hash depends on the install key');
  assert.match(kofi.hashKofiEmail(key, 'a@example.dk'), /^[0-9a-f]{64}$/);
});

test('only ko-fi.com page URLs are accepted', () => {
  assert.equal(kofi.normalizeKofiPageUrl('https://ko-fi.com/homelab'), 'https://ko-fi.com/homelab');
  assert.equal(kofi.normalizeKofiPageUrl(' https://www.ko-fi.com/Home_Lab/ '), 'https://ko-fi.com/Home_Lab');
  for (const bad of ['http://ko-fi.com/homelab', 'https://ko-fi.com.evil.example/homelab', 'https://evil.example/ko-fi.com/homelab',
    'https://ko-fi.com/', 'https://ko-fi.com/a/b', 'https://ko-fi.com/homelab?x=1', 'https://ko-fi.com/homelab#x', 'https://user:pw@ko-fi.com/homelab',
    'https://ko-fi.com:8443/homelab', 'javascript:alert(1)', 'ko-fi.com/homelab', '', null, 7])
    assert.equal(kofi.normalizeKofiPageUrl(bad), null, String(bad));
});

test('token comparison is length-independent', () => {
  const token = '8c2a3835-4544-4f27-a53a-adfd1fcc5664';
  assert.equal(kofi.kofiTokenMatches(token, token), true);
  // Different lengths must compare false rather than throw (raw timingSafeEqual throws).
  for (const wrong of ['x', token.slice(0, -1), `${token}x`, token.toUpperCase(), '', 'a'.repeat(5000)])
    assert.equal(kofi.kofiTokenMatches(wrong, token), false, wrong.slice(0, 40));
  for (const wrong of [undefined, null, 42, {}, [token], true]) assert.equal(kofi.kofiTokenMatches(wrong, token), false);
  // No stored token never matches, not even an empty or missing presented one.
  for (const stored of [null, undefined, '']) {
    assert.equal(kofi.kofiTokenMatches(token, stored), false);
    assert.equal(kofi.kofiTokenMatches('', stored), false);
    assert.equal(kofi.kofiTokenMatches(undefined, stored), false);
  }
});

test('events are classified in rule order and never from a float or a loose date', () => {
  const ok = classify({ amount: '50.00', email: ' Jo@Example.com' });
  assert.equal(ok.verdict, 'ok');
  if (ok.verdict === 'ok') {
    assert.equal(ok.facts.kind, 'kofi_donation');
    assert.equal(ok.facts.grossOre, 5000);
    assert.equal(ok.facts.foreign, false);
    assert.equal(ok.facts.email, 'jo@example.com');
    assert.equal(ok.facts.effectiveAt.toISOString(), '2026-11-09T12:00:00.000Z');
  }
  const subscription = kofi.classifyKofiPayload(kofiSubscriptionEvent(true, { timestamp: kofiTimestamp(now) }), now);
  assert.equal(subscription.verdict === 'ok' && subscription.facts.kind, 'kofi_subscription');
  // Rule 1 wins over everything else, including a foreign currency.
  assert.deepEqual(classify({ kofi_transaction_id: KOFI_SAMPLE_TRANSACTION_ID, currency: 'USD', type: 'Shop Order' }), { verdict: 'ignored', code: 'TEST_EVENT' });
  assert.equal(kofi.classifyKofiPayload(kofiShopOrderEvent({ timestamp: kofiTimestamp(now) }), now).verdict, 'review');
  assert.equal(reason({ type: 'Commission' }), 'UNSUPPORTED_TYPE');
  assert.equal(reason({ type: 'Shop Order', currency: 'usd' }), 'UNSUPPORTED_TYPE', 'type is checked before currency');
  assert.equal(reason({ type: 'Refund' }), 'UNKNOWN_TYPE');
  assert.equal(reason({ type: undefined }), 'UNKNOWN_TYPE');
  for (const currency of ['dkk', 'EURO', 'DK', '', null, 208]) assert.equal(reason({ currency }), 'INVALID_CURRENCY', String(currency));
  for (const amount of [50, '50,00', '0.99', '10000.01', null]) assert.equal(reason({ amount }), 'INVALID_AMOUNT', String(amount));
  assert.equal(reason({ amount: '1.00' }), 'ok');
  assert.equal(reason({ amount: '10000.00' }), 'ok');
  assert.equal(reason({ kofi_transaction_id: 'bad id' }), 'INVALID_TRANSACTION_ID');
  assert.equal(reason({ kofi_transaction_id: undefined }), 'INVALID_TRANSACTION_ID');
  for (const timestamp of ['yesterday', '1', '2026-11-09', 1794225600, null, kofiTimestamp(new Date(now.getTime() + 25 * 3_600_000)),
    kofiTimestamp(new Date(now.getTime() - 401 * 86_400_000))]) assert.equal(reason({ timestamp }), 'INVALID_TIMESTAMP', String(timestamp));
  assert.equal(reason({ timestamp: '2026-11-09T11:00:00' }), 'ok', 'a timestamp without a zone is read as UTC');
  assert.equal(reason({ timestamp: '2026-11-09T13:00:00+01:00' }), 'ok');
});

test('another currency is valid but never becomes a DKK amount', () => {
  const eur = classify({ currency: 'EUR', amount: '5.00' });
  assert.equal(eur.verdict, 'ok');
  if (eur.verdict === 'ok') {
    assert.equal(eur.facts.foreign, true);
    assert.equal(eur.facts.grossOre, null, 'no DKK gross is derived from a foreign amount');
    assert.equal(eur.facts.amount, '5.00');
    assert.equal(eur.facts.currency, 'EUR');
  }
  // The foreign range is 0.01–100 000.00; the DKK range does not apply.
  assert.equal(reason({ currency: 'EUR', amount: '0.01' }), 'ok');
  assert.equal(reason({ currency: 'EUR', amount: '100000.00' }), 'ok');
  assert.equal(reason({ currency: 'EUR', amount: '0.00' }), 'INVALID_AMOUNT');
  assert.equal(reason({ currency: 'EUR', amount: '100000.01' }), 'INVALID_AMOUNT');
  assert.equal(reason({ currency: 'EUR', kofi_transaction_id: 'x' }), 'INVALID_TRANSACTION_ID', 'a later rule still wins over the currency');
});

test('the retry delay grows and is capped', () => {
  assert.equal(kofi.kofiInboxRetryDelayMs(1), 5 * 60_000);
  assert.equal(kofi.kofiInboxRetryDelayMs(2), 10 * 60_000);
  assert.equal(kofi.kofiInboxRetryDelayMs(50), 6 * 60 * 60_000);
});
