// Coverage for matching a listed backup against the vzdump task writing it.
// Run with:  node --test src/utils/backupTask.test.js   (from backend/)
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseUpid, backupBelongsToTask, inProgressVolids } from './backupTask.js';

// UPID:pve1:00001234:0000ABCD:65B0F1A2:vzdump:100:root@pam:
const UPID = 'UPID:pve1:00001234:0000ABCD:65B0F1A2:vzdump:100:root@pam:';
const START = 0x65b0f1a2; // 1706164130

test('parseUpid reads the node, hex start time and task identity', () => {
  assert.deepEqual(parseUpid(UPID), {
    node: 'pve1',
    startTime: START,
    type: 'vzdump',
    id: '100',
    user: 'root@pam',
  });
});

test('parseUpid returns null rather than throwing on junk', () => {
  for (const bad of ['', 'not-a-upid', 'UPID:pve1:1:2', 'UPID:pve1:x:y:zz:vzdump:100:root@pam:', null, undefined, 42, {}]) {
    assert.equal(parseUpid(bad), null, JSON.stringify(bad));
  }
  // A zero start time is not usable as a cutoff either.
  assert.equal(parseUpid('UPID:pve1:00001234:0000ABCD:0:vzdump:100:root@pam:'), null);
});

test('a backup on the task storage created after it started is the one being written', () => {
  const task = { storage: 'pbs01', upid: UPID, started_epoch: START };
  assert.equal(backupBelongsToTask({ storage: 'pbs01', ctime: START + 5 }, task), true);
  assert.equal(backupBelongsToTask({ storage: 'pbs01', ctime: START }, task), true);
});

test('a backup on another storage is never the one being written', () => {
  const task = { storage: 'pbs01', upid: UPID, started_epoch: START };
  assert.equal(backupBelongsToTask({ storage: 'local', ctime: START + 5 }, task), false);
});

test('an older backup on the same storage is left alone', () => {
  const task = { storage: 'pbs01', upid: UPID, started_epoch: START };
  assert.equal(backupBelongsToTask({ storage: 'pbs01', ctime: START - 3600 }, task), false);
});

test('a snapshot stamped just before the task record still matches', () => {
  // PBS timestamps the snapshot when the backup begins, which can precede the
  // task row by a beat.
  const task = { storage: 'pbs01', upid: UPID, started_epoch: START };
  assert.equal(backupBelongsToTask({ storage: 'pbs01', ctime: START - 30 }, task), true);
  assert.equal(backupBelongsToTask({ storage: 'pbs01', ctime: START - 600 }, task), false);
});

test('the start time falls back to the UPID when the row has none', () => {
  const task = { storage: 'pbs01', upid: UPID };
  assert.equal(backupBelongsToTask({ storage: 'pbs01', ctime: START + 5 }, task), true);
  // With neither, nothing can be matched — better than guessing.
  assert.equal(backupBelongsToTask({ storage: 'pbs01', ctime: START + 5 }, { storage: 'pbs01' }), false);
});

test('missing or malformed inputs match nothing', () => {
  const task = { storage: 'pbs01', upid: UPID, started_epoch: START };
  assert.equal(backupBelongsToTask(null, task), false);
  assert.equal(backupBelongsToTask({ storage: 'pbs01', ctime: 'soon' }, task), false);
  assert.equal(backupBelongsToTask({ storage: 'pbs01', ctime: START }, null), false);
  assert.equal(backupBelongsToTask({ storage: 'pbs01', ctime: START }, { storage: '', upid: UPID }), false);
});

test('inProgressVolids only counts tasks that are still running', () => {
  const backups = [
    { volid: 'pbs01:backup/vm-100-new', storage: 'pbs01', ctime: START + 5 },
    { volid: 'pbs01:backup/vm-100-old', storage: 'pbs01', ctime: START - 7200 },
    { volid: 'local:backup/vm-100-other', storage: 'local', ctime: START + 5 },
  ];
  const running = { status: 'running', storage: 'pbs01', upid: UPID, started_epoch: START };

  assert.deepEqual(inProgressVolids(backups, [running]), ['pbs01:backup/vm-100-new']);
  assert.deepEqual(inProgressVolids(backups, [{ ...running, status: 'ok' }]), []);
  assert.deepEqual(inProgressVolids(backups, []), []);
  assert.deepEqual(inProgressVolids([], [running]), []);
  assert.deepEqual(inProgressVolids(undefined, undefined), []);
});

test('a volid is listed once even when two running tasks could claim it', () => {
  const backups = [{ volid: 'pbs01:backup/vm-100-new', storage: 'pbs01', ctime: START + 5 }];
  const task = { status: 'running', storage: 'pbs01', upid: UPID, started_epoch: START };
  assert.deepEqual(inProgressVolids(backups, [task, { ...task }]), ['pbs01:backup/vm-100-new']);
});
