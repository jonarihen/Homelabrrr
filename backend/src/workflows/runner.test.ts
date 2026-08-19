import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/test';
const { runBundle } = await import('./runner.ts');

const args = {
  bundle: { workflow: { id: 12, trigger: 'vlan_provision' }, steps: [{ id: 1 }] },
  context: { tag: 1015 },
  client: {},
  firewall: { id: 4 },
  subjectType: 'vlan',
  subjectId: 1015,
  subjectLabel: 'VLAN 1015',
};

test('runBundle awaits successful run recording and returns a numeric run ID', async () => {
  let recordingFinished = false;
  const result = await runBundle(args, {
    executeWorkflow: async () => ({ status: 'success', outputs: {}, artifacts: [], log: [] }),
    saveRun: async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      recordingFinished = true;
      return 73;
    },
  });

  assert.equal(recordingFinished, true);
  assert.equal(result.runId, 73);
  assert.equal(typeof result.runId, 'number');
});

test('runBundle records a failed workflow before rethrowing it', async () => {
  const original = Object.assign(new Error('FortiGate rejected the step'), {
    workflowRun: { status: 'failed', log: [{ status: 'error' }], artifacts: [{ type: 'address' }] },
  });
  let recorded;

  await assert.rejects(
    runBundle(args, {
      executeWorkflow: async () => { throw original; },
      saveRun: async (run) => { recorded = run; return 74; },
    }),
    (err) => err === original,
  );
  assert.equal(recorded.status, 'failed');
  assert.deepEqual(recorded.artifacts, original.workflowRun.artifacts);
});

test('failed-run recording errors do not mask the workflow error', async (t) => {
  const original = new Error('original workflow failure');
  let loggingErrors = 0;
  t.mock.method(console, 'error', () => { loggingErrors += 1; });

  await assert.rejects(
    runBundle(args, {
      executeWorkflow: async () => { throw original; },
      saveRun: async () => { throw new Error('database logging failure'); },
    }),
    (err) => err === original,
  );
  assert.equal(loggingErrors, 1);
});

test('VLAN, policy, and port-forward entry points await and validate their bundles', async () => {
  const admin = await readFile(new URL('../routes/admin.ts', import.meta.url), 'utf8');
  const entryPoints = [
    ['vlan_provision', 'VLAN provision workflow is unavailable'],
    ['policy_create', 'Policy creation workflow is unavailable'],
    ['port_forward_create', 'Port-forward workflow is unavailable'],
  ];

  for (const [trigger, missingMessage] of entryPoints) {
    const resolution = `const bundle = await getWorkflowBundle(fw.id, '${trigger}');`;
    const resolutionAt = admin.indexOf(resolution);
    assert.notEqual(resolutionAt, -1, `${trigger} must resolve its bundle asynchronously`);
    const executionAt = admin.indexOf('await runBundle({', resolutionAt);
    assert.notEqual(executionAt, -1, `${trigger} must execute its resolved bundle`);
    const guardAt = admin.indexOf(missingMessage, resolutionAt);
    assert.ok(guardAt > resolutionAt && guardAt < executionAt, `${trigger} must reject a missing bundle before execution`);
  }
});
