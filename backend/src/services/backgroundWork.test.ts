import test from 'node:test';
import assert from 'node:assert/strict';
import {
  backgroundWorkStatus,
  startBackgroundWork,
  stopAcceptingBackgroundWork,
  waitForBackgroundWork,
} from './backgroundWork.ts';

test('tracks admitted work, drains it, and rejects jobs admitted after shutdown', async () => {
  let release;
  const blocker = new Promise((resolve) => { release = resolve; });
  let ran = false;

  const task = startBackgroundWork(async () => {
    ran = true;
    await blocker;
  }, { kind: 'provision', id: 42, requestId: 'req-test' });

  await Promise.resolve();
  assert.equal(ran, true);
  assert.deepEqual(backgroundWorkStatus(), {
    accepting: true,
    active: [{ kind: 'provision', id: 42, requestId: 'req-test' }],
  });

  stopAcceptingBackgroundWork();
  let lateRan = false;
  await assert.rejects(
    startBackgroundWork(() => { lateRan = true; }),
    (error) => error.code === 'BACKGROUND_WORK_STOPPING' && error.status === 503,
  );
  assert.equal(lateRan, false);

  release();
  await task;
  await waitForBackgroundWork();
  assert.deepEqual(backgroundWorkStatus(), { accepting: false, active: [] });
});
