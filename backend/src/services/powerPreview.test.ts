import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPowerPreview } from './powerPreview.ts';
import { scheduleBoundaryInstants, scheduledModeAt, weekdayPreset, type PowerPricePolicy } from './powerPolicy.ts';

const disabledPrice: PowerPricePolicy = {
  enabled: false, basis: 'variable_retail_including_vat', contractRef: '', area: '', version: 1,
  expensive: { enabled: false, threshold: '', hysteresis: '', capMode: 'dynamic' },
  cheap: { enabled: false, threshold: '', hysteresis: '' },
};

test('seven-day preset preview uses actual Copenhagen UTC boundaries', async () => {
  const schedule = weekdayPreset(); schedule.enabled = true;
  const now = new Date('2026-10-12T13:59:00Z');
  const preview = await buildPowerPreview({ now, controlEnabled: true, automationPaused: false,
    driftHold: false, actualMode: 'low', supportedModes: ['low', 'dynamic', 'high'],
    schedule, pricePolicy: disabledPrice }, [], async () => null);
  assert.equal(preview.nextKnownTransition, '2026-10-12T14:00:00.000Z');
  assert.equal(preview.nextScheduleTransition, '2026-10-12T14:00:00.000Z');
  assert.deepEqual(preview.segments.slice(0, 3).map((item) => [item.startUtc, item.selectedMode]), [
    ['2026-10-12T13:59:00.000Z', 'low'],
    ['2026-10-12T14:00:00.000Z', 'high'],
    ['2026-10-13T00:00:00.000Z', 'low'],
  ]);
  assert.ok(preview.segments.some((item) => item.startUtc === '2026-10-17T10:00:00.000Z' && item.selectedMode === 'high'));
});

test('spring gap advances start and autumn repeated hour does not oscillate', () => {
  const schedule = weekdayPreset(); schedule.enabled = true;
  schedule.windows = [{ days: 1, start: '02:30', end: '04:00', mode: 'high' }];
  assert.equal(scheduledModeAt(schedule, new Date('2026-03-29T00:59:00Z')), 'low');
  assert.equal(scheduledModeAt(schedule, new Date('2026-03-29T01:00:00Z')), 'high');
  assert.equal(scheduleBoundaryInstants(schedule, new Date('2026-03-29T00:00:00Z'), new Date('2026-03-29T04:00:00Z'))[0]?.toISOString(), '2026-03-29T01:00:00.000Z');
  schedule.windows = [{ days: 1, start: '02:30', end: '03:00', mode: 'high' }];
  assert.equal(scheduledModeAt(schedule, new Date('2026-10-25T00:29:00Z')), 'low');
  assert.equal(scheduledModeAt(schedule, new Date('2026-10-25T00:30:00Z')), 'high');
  assert.equal(scheduledModeAt(schedule, new Date('2026-10-25T01:00:00Z')), 'high');
  assert.equal(scheduledModeAt(schedule, new Date('2026-10-25T01:30:00Z')), 'high');
  assert.equal(scheduledModeAt(schedule, new Date('2026-10-25T02:00:00Z')), 'low');
});

test('published 15-minute prices show a known cap then unknown future baseline', async () => {
  const schedule = weekdayPreset(); schedule.enabled = true;
  const pricePolicy: PowerPricePolicy = { ...disabledPrice, enabled: true, contractRef: '1', area: 'DK2',
    expensive: { enabled: true, threshold: '3.00', hysteresis: '0', capMode: 'dynamic' } };
  const now = new Date('2026-10-12T14:00:00Z');
  const end = new Date('2026-10-12T14:15:00Z');
  const preview = await buildPowerPreview({ now, controlEnabled: true, automationPaused: false,
    driftHold: false, actualMode: 'low', supportedModes: ['low', 'dynamic', 'high'],
    schedule, pricePolicy }, [end], async (at) => at < end ? {
      dkk_per_kwh: '3.50', basis: pricePolicy.basis, contract_ref: '1', area: 'DK2',
      start_utc: now.toISOString(), end_utc: end.toISOString(), status: 'valid',
      contract_revision: '1', source_revision: 'fixture',
    } : null);
  assert.equal(preview.segments[0]?.selectedMode, 'dynamic');
  assert.equal(preview.segments[0]?.reason, 'price_high');
  assert.equal(preview.segments[1]?.startUtc, end.toISOString());
  assert.equal(preview.segments[1]?.baseMode, 'high');
  assert.equal(preview.segments[1]?.selectedMode, null);
  assert.equal(preview.segments[1]?.futurePriceUnknown, true);
  assert.equal(preview.nextKnownTransition, null);
  assert.equal(preview.nextScheduleTransition, '2026-10-13T00:00:00.000Z');
});

test('a future starting point without published prices has no asserted selected mode', async () => {
  const schedule = weekdayPreset(); schedule.enabled = true;
  const now = new Date('2026-10-12T14:00:00Z');
  const pricePolicy: PowerPricePolicy = { ...disabledPrice, enabled: true, contractRef: '1', area: 'DK2',
    cheap: { enabled: true, threshold: '1.00', hysteresis: '0' } };
  const preview = await buildPowerPreview({ now, controlEnabled: true, automationPaused: false,
    driftHold: false, actualMode: 'low', supportedModes: ['low', 'dynamic', 'high'],
    schedule, pricePolicy }, [], async () => null, 7, new Date('2026-10-11T14:00:00Z'));
  assert.equal(preview.segments[0]?.baseMode, 'high');
  assert.equal(preview.segments[0]?.selectedMode, null);
  assert.equal(preview.segments[0]?.futurePriceUnknown, true);
});
