import test from 'node:test';
import assert from 'node:assert/strict';
import { PowerController, type ControlRepository, type ControlSnapshot, type ClaimOutcome } from './powerController.ts';
import { weekdayPreset, type PowerDecision } from './powerPolicy.ts';

const instant = new Date('2026-10-12T16:00:00Z'); // Monday 18:00 Copenhagen

function snapshot(): ControlSnapshot {
  const schedule = weekdayPreset(); schedule.enabled = true;
  return {
    hardwareId: 1, configVersion: 1, policyVersion: 1,
    controlEnabled: true, automationEnabled: true, paused: false, driftHold: false,
    supportedModes: ['low', 'dynamic', 'high'], schedule,
    pricePolicy: {
      enabled: false, basis: 'variable_retail_including_vat', contractRef: '', area: '',
      expensive: { enabled: false, threshold: '', hysteresis: '', capMode: 'dynamic' },
      cheap: { enabled: false, threshold: '', hysteresis: '' }, version: 1,
    },
    latch: null, manualOverride: null, lastVerifiedMode: null,
    ilo: { host: 'ilo.fixture', port: 443, username: 'fixture', password: 'fixture', verifyTls: true },
  };
}

function repository(state: ControlSnapshot) {
  let claimed = false;
  const finished: ClaimOutcome[] = [];
  const observed: PowerDecision[] = [];
  const value: ControlRepository = {
    load: async () => structuredClone(state),
    claim: async () => { if (claimed) return false; claimed = true; return true; },
    claimStillCurrent: async () => claimed,
    finish: async (_id, _token, result) => { finished.push(result); claimed = false; },
    observe: async (_id, _version, result) => { observed.push(result); },
    holdExternalDrift: async () => { state.driftHold = true; },
  };
  return { value, finished, observed };
}

test('one controller handles weekly selection and skips no-op mode', async () => {
  const state = snapshot();
  const repo = repository(state);
  let writes = 0;
  const controller = new PowerController({ repository: repo.value, getApplicablePrice: async () => null,
    readMode: async () => 'low', now: () => instant,
    writeMode: async (_config, target, _read, _patch, guard) => {
      assert.equal(target, 'high'); assert.equal(await guard?.(), true); writes += 1;
      return { prior: 'low', target, outcome: 'verified' };
    },
  });
  assert.equal((await controller.reconcile(1)).status, 'verified');
  assert.equal(writes, 1);
  assert.equal(repo.finished[0].decision.reason, 'schedule');
  const already = new PowerController({ repository: repo.value, getApplicablePrice: async () => null,
    readMode: async () => 'high', now: () => instant,
    writeMode: async () => { throw new Error('must not write'); },
  });
  assert.equal((await already.reconcile(1)).status, 'already_set');
  assert.equal(repo.observed.length, 1);
});

test('disabled and paused automation never reads hardware or writes', async () => {
  const state = snapshot(); state.controlEnabled = false;
  const repo = repository(state);
  const controller = new PowerController({ repository: repo.value, getApplicablePrice: async () => null,
    readMode: async () => { throw new Error('must not read'); },
    writeMode: async () => { throw new Error('must not write'); }, now: () => instant,
  });
  assert.equal((await controller.reconcile(1)).status, 'disabled');
  state.controlEnabled = true; state.paused = true;
  const paused = new PowerController({ repository: repo.value, getApplicablePrice: async () => null,
    readMode: async () => 'low', writeMode: async () => { throw new Error('must not write'); }, now: () => instant,
  });
  assert.equal((await paused.reconcile(1)).status, 'hold');
});

test('version change after claim aborts before any PATCH', async () => {
  const state = snapshot();
  const repo = repository(state);
  repo.value.claim = async () => { state.policyVersion += 1; return true; };
  let writes = 0;
  const controller = new PowerController({ repository: repo.value, getApplicablePrice: async () => null,
    readMode: async () => 'low', now: () => instant,
    writeMode: async () => { writes += 1; return { prior: 'low', target: 'high', outcome: 'verified' }; },
  });
  assert.equal((await controller.reconcile(1)).status, 'stale');
  assert.equal(writes, 0);
});

test('one physical node is reconciled once while a prior read is in flight', async () => {
  const repo = repository(snapshot());
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const controller = new PowerController({ repository: repo.value, getApplicablePrice: async () => null,
    readMode: async () => { await waiting; return 'high'; }, now: () => instant,
  });
  const first = controller.reconcile(1);
  assert.equal((await controller.reconcile(1)).status, 'busy');
  release();
  assert.equal((await first).status, 'already_set');
});

test('an unexpected external mode change holds automatic writes', async () => {
  const state = snapshot(); state.lastVerifiedMode = 'dynamic';
  const repo = repository(state);
  const controller = new PowerController({ repository: repo.value, getApplicablePrice: async () => null,
    readMode: async () => 'low', writeMode: async () => { throw new Error('must not write'); }, now: () => instant,
  });
  assert.equal((await controller.reconcile(1)).status, 'hold');
  assert.equal(state.driftHold, true);
});
