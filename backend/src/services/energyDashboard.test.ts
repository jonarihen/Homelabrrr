import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEnergyMonth, parseHistoryRange, safeHosts } from './energyDashboard.ts';

test('Copenhagen month follows local clock at UTC day boundaries', () => {
  assert.equal(parseEnergyMonth(undefined, new Date('2026-10-31T23:30:00Z')), '2026-11');
  assert.equal(parseEnergyMonth('2026-02'), '2026-02');
  assert.throws(() => parseEnergyMonth('2026-13'), /INVALID_MONTH/);
  assert.throws(() => parseEnergyMonth(['2026-02']), /INVALID_MONTH/);
});
test('history ranges are bounded', () => {
  assert.equal(parseHistoryRange(undefined), '24h');
  assert.equal(parseHistoryRange('7d'), '7d');
  assert.throws(() => parseHistoryRange('30d'), /INVALID_RANGE/);
});
test('member host DTO allows only safe aliases and observations', () => {
  const source = { id: 29, target_host: 'ilo.secret.internal', username: 'admin', system_uuid: 'private',
    watts: '144.5', mode: 'Low', observed_at: new Date('2026-10-08T12:00:00Z'), collection_enabled: true,
    last_error_code: null };
  const [host] = safeHosts([source], new Date('2026-10-08T12:01:00Z'));
  assert.equal(host.alias, 'Server 01');
  assert.equal(host.watts, 144.5);
  assert.equal(JSON.stringify(host).includes('secret'), false);
  assert.equal(JSON.stringify(host).includes('private'), false);
  assert.equal(JSON.stringify(host).includes('admin'), false);
});
