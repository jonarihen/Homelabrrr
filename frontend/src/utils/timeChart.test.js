import test from 'node:test';
import assert from 'node:assert/strict';
import { binLabel, buildTimeChart, nearestMark, niceRange, niceScale, timeTicks } from './timeChart.js';

const FROM = '2026-11-08T18:00:00Z';
const THROUGH = '2026-11-09T18:00:00Z';
const at = (hour) => new Date(Date.parse(FROM) + hour * 3_600_000).toISOString();

test('the value axis ends on a round number that covers the data', () => {
  assert.deepEqual(niceScale(412), { max: 600, decimals: 0, ticks: [0, 200, 400, 600] });
  assert.deepEqual(niceScale(0.43), { max: 0.6, decimals: 1, ticks: [0, 0.2, 0.4, 0.6] });
  assert.deepEqual(niceScale(0.09), { max: 0.1, decimals: 3, ticks: [0, 0.025, 0.05, 0.075, 0.1] });
  assert.deepEqual(niceScale(100), { max: 100, decimals: 0, ticks: [0, 25, 50, 75, 100] });
  assert.equal(niceScale(0).max, 1, 'an all-zero series still gets an axis');
  assert.equal(niceScale(NaN).max, 1);
});

test('a line axis fits the data unless the data comes near zero', () => {
  assert.deepEqual(niceRange(381, 458), { min: 380, max: 460, decimals: 0, ticks: [380, 400, 420, 440, 460] });
  assert.deepEqual(niceRange(412, 412), { min: 410, max: 420, decimals: 0, ticks: [410, 420] }, 'a flat series still gets a readable band');
  assert.deepEqual(niceRange(40, 412), { min: 0, max: 600, decimals: 0, ticks: [0, 200, 400, 600] }, 'near zero stays zero-based');
  assert.equal(niceRange(0, 0).min, 0);
  const chart = buildTimeChart([{ at: at(0), watts: 380 }, { at: at(1), watts: 460 }], 'watts', FROM, THROUGH, 3600, { width: 520, height: 220, margin: { top: 10, right: 20, bottom: 30, left: 20 }, zero: false });
  assert.deepEqual([chart.min, chart.max], [380, 460]);
  assert.deepEqual(chart.marks.map((mark) => mark.y), [190, 10]);
});

test('a day gets four-hour ticks on the Copenhagen clock; a week gets local midnights', () => {
  const dayTicks = timeTicks(Date.parse(FROM), Date.parse(THROUGH), 8);
  // 18:00Z is 19:00 in Copenhagen (CET): first tick at local 20:00, then 00:00 named by its day.
  assert.deepEqual(dayTicks.map((tick) => tick.label), ['20:00', 'Mon 9', '04:00', '08:00', '12:00', '16:00']);
  assert.equal(new Date(dayTicks[1].at).toISOString(), '2026-11-08T23:00:00.000Z');
  const week = timeTicks(Date.parse('2026-11-02T18:00:00Z'), Date.parse(THROUGH), 8);
  assert.deepEqual(week.map((tick) => tick.label), ['Tue 3', 'Wed 4', 'Thu 5', 'Fri 6', 'Sat 7', 'Sun 8', 'Mon 9']);
  assert.equal(timeTicks(Date.parse('2026-11-02T18:00:00Z'), Date.parse(THROUGH), 4).length, 4, 'ticks are thinned when there is no room');
});

test('marks sit at the middle of their interval and gaps are not bridged', () => {
  const points = [{ at: at(0), watts: 200 }, { at: at(1), watts: 400 }, { at: at(5), watts: 300 }, { at: at(6), watts: null }, { at: 'bad', watts: 5 }];
  const chart = buildTimeChart(points, 'watts', FROM, THROUGH, 3600, { width: 520, height: 220, margin: { top: 10, right: 20, bottom: 30, left: 20 } });
  assert.equal(chart.marks.length, 3, 'missing and unparseable readings are left out, never drawn as zero');
  assert.equal(chart.max, 400);
  // Plot is 480 px wide for 24 hours: 20 px per hour, marks at the half hour.
  assert.deepEqual(chart.marks.map((mark) => mark.x), [30, 50, 130]);
  assert.deepEqual(chart.marks.map((mark) => mark.y), [100, 10, 55]);
  assert.deepEqual([chart.marks[0].left, chart.marks[0].right], [20, 40]);
  assert.deepEqual(chart.segments, ['M30.0,100.0 L50.0,10.0']);
  assert.deepEqual(chart.singles.map((mark) => mark.index), [2]);
  assert.equal(chart.yTicks[0].y, 190);
  assert.equal(chart.marks[2].point, points[2], 'the source point travels with its mark for the readout');
});

test('no chart is built without a trend or a valid range', () => {
  assert.equal(buildTimeChart([{ at: at(0), watts: 1 }], 'watts', FROM, THROUGH, 3600), null);
  assert.equal(buildTimeChart([], 'watts', FROM, THROUGH, 3600), null);
  assert.equal(buildTimeChart([{ at: at(0), watts: 1 }, { at: at(1), watts: 2 }], 'watts', THROUGH, FROM, 3600), null);
  assert.equal(buildTimeChart([{ at: at(0), watts: 1 }, { at: at(1), watts: 2 }], 'watts', FROM, THROUGH, undefined), null);
});

test('the pointer picks the closest mark, not only one it touches', () => {
  const marks = [{ x: 30 }, { x: 50 }, { x: 130 }];
  assert.equal(nearestMark(marks, 0), 0);
  assert.equal(nearestMark(marks, 41), 1);
  assert.equal(nearestMark(marks, 95), 2);
  assert.equal(nearestMark([], 10), -1);
});

test('the readout names the interval in local time', () => {
  assert.equal(binLabel(Date.parse('2026-11-09T13:00:00Z'), Date.parse('2026-11-09T14:00:00Z')), 'Mon 9 Nov, 14:00–15:00');
});
