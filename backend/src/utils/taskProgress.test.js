// Coverage for the Proxmox task-log progress parser (migration progress bar).
// Run with:  node --test src/utils/taskProgress.test.js   (from backend/)
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProgressLine, parseTaskProgress, readTaskProgress } from './taskProgress.js';

// A fake PVE task log: `fetchLines({ start, limit })` over a fixed line list.
function fakeLog(texts, calls = []) {
  const lines = texts.map((t, i) => ({ n: i + 1, t }));
  return async ({ start, limit }) => {
    calls.push({ start, limit });
    return lines.slice(start, start + limit);
  };
}

test('parses the qemu drive-mirror line remote_migrate emits', () => {
  const p = parseProgressLine('2026-07-26 21:00:03 drive-scsi0: transferred 1.5 GiB of 32.0 GiB (4.69%) in 3s');
  assert.equal(p.percent, 4.69);
  assert.equal(p.disk, 'scsi0');
  assert.equal(p.detail, 'scsi0: 1.5 GiB of 32.0 GiB');
});

test('parses a transferred line without a drive prefix', () => {
  const p = parseProgressLine('transferred 512.0 MiB of 8.0 GiB (6.25%)');
  assert.equal(p.percent, 6.25);
  assert.equal(p.disk, '');
  assert.equal(p.detail, '512.0 MiB of 8.0 GiB');
});

test('a timestamp is never mistaken for a disk name', () => {
  const p = parseProgressLine('2026-07-26 21:00:03 transferred 0.0 B of 32.0 GiB (0.00%)');
  assert.equal(p.percent, 0);
  assert.equal(p.disk, '');
  assert.equal(p.detail, '0.0 B of 32.0 GiB');
});

test('parses the percent-first form used by offline disk moves', () => {
  const p = parseProgressLine(' 42% (13.4 GiB of 32.0 GiB) in 1m 4s');
  assert.equal(p.percent, 42);
  assert.equal(p.detail, '13.4 GiB of 32.0 GiB');
});

test('non-progress log lines yield null', () => {
  const lines = [
    '2026-07-26 21:00:00 starting migration of VM 100 to node pve2',
    'create full clone of drive scsi0 (local-lvm:vm-100-disk-0)',
    '2026-07-26 21:00:01 migration status: active',
    'all mirroring jobs are ready',
    '',
  ];
  for (const line of lines) assert.equal(parseProgressLine(line), null);
  assert.equal(parseProgressLine(undefined), null);
  assert.equal(parseProgressLine(null), null);
});

test('a batch reports its newest progress line', () => {
  const p = parseTaskProgress([
    '2026-07-26 21:00:03 drive-scsi0: transferred 1.5 GiB of 32.0 GiB (4.69%) in 3s',
    '2026-07-26 21:00:04 drive-scsi0: transferred 2.0 GiB of 32.0 GiB (6.25%) in 4s',
    '2026-07-26 21:00:05 auto-detecting bandwidth limits',
  ]);
  assert.equal(p.percent, 6.25);
  assert.equal(p.detail, 'scsi0: 2.0 GiB of 32.0 GiB');
});

test('multi-disk transfers report the disk currently copying', () => {
  const p = parseTaskProgress([
    'drive-scsi0: transferred 32.0 GiB of 32.0 GiB (100.00%) in 4m 2s',
    'drive-scsi1: transferred 1.0 GiB of 100.0 GiB (1.00%) in 6s',
  ]);
  assert.equal(p.disk, 'scsi1');
  assert.equal(p.percent, 1);
});

test('a batch with no progress at all (LXC rsync) yields null', () => {
  assert.equal(parseTaskProgress(['starting migration', 'rsync status: 0']), null);
  assert.equal(parseTaskProgress([]), null);
  assert.equal(parseTaskProgress(null), null);
});

test('percentages are clamped to 0–100', () => {
  assert.equal(parseProgressLine('transferred 33.0 GiB of 32.0 GiB (103.12%)').percent, 100);
});

test('a log read returns the newest progress and the resume offset', async () => {
  const calls = [];
  const { offset, progress } = await readTaskProgress(fakeLog([
    'starting migration of VM 100',
    'drive-scsi0: transferred 1.0 GiB of 32.0 GiB (3.12%) in 2s',
    'drive-scsi0: transferred 2.0 GiB of 32.0 GiB (6.25%) in 4s',
  ], calls), { batch: 512 });
  assert.equal(offset, 3);
  assert.equal(progress.percent, 6.25);
  assert.deepEqual(calls, [{ start: 0, limit: 512 }]);
});

test('reading resumes at the stored offset and re-reads nothing', async () => {
  const calls = [];
  const fetch = fakeLog([
    'drive-scsi0: transferred 1.0 GiB of 32.0 GiB (3.12%) in 2s',
    'drive-scsi0: transferred 2.0 GiB of 32.0 GiB (6.25%) in 4s',
  ], calls);
  const { offset, progress } = await readTaskProgress(fetch, { start: 1, batch: 512 });
  assert.equal(calls[0].start, 1);
  assert.equal(offset, 2);
  assert.equal(progress.percent, 6.25);
});

test('nothing new leaves the offset alone and reports no progress', async () => {
  const { offset, progress } = await readTaskProgress(fakeLog([
    'drive-scsi0: transferred 2.0 GiB of 32.0 GiB (6.25%) in 4s',
  ]), { start: 1 });
  assert.equal(offset, 1);
  assert.equal(progress, null);
});

test('a backlog is drained across batches (restart mid-transfer)', async () => {
  const texts = [];
  for (let i = 1; i <= 250; i++) texts.push(`drive-scsi0: transferred ${i}.0 MiB of 1000.0 MiB (${(i / 10).toFixed(2)}%) in ${i}s`);
  const calls = [];
  const { offset, progress } = await readTaskProgress(fakeLog(texts, calls), { batch: 100 });
  assert.equal(calls.length, 3);
  assert.equal(offset, 250);
  assert.equal(progress.percent, 25);
});

test('the catch-up read is bounded by maxBatches', async () => {
  const texts = Array.from({ length: 100 }, (_, i) => `line ${i}`);
  const calls = [];
  const { offset } = await readTaskProgress(fakeLog(texts, calls), { batch: 10, maxBatches: 3 });
  assert.equal(calls.length, 3);
  assert.equal(offset, 30);
});

test('progress from an earlier batch survives a tail with none', async () => {
  const { progress } = await readTaskProgress(fakeLog([
    'drive-scsi0: transferred 32.0 GiB of 32.0 GiB (100.00%) in 4m',
    'all mirroring jobs are ready',
  ]), { batch: 1 });
  assert.equal(progress.percent, 100);
});

test('a log without line numbers still advances the offset', async () => {
  const fetch = async ({ start, limit }) => (start >= 2 ? [] : [{ t: 'x' }, { t: 'y' }].slice(0, limit));
  const { offset } = await readTaskProgress(fetch, { batch: 2 });
  assert.equal(offset, 2);
});
