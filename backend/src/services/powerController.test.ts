import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PowerController, type ControlRepository, type ControlSnapshot, type ClaimOutcome, type ObservationNote,
} from './powerController.ts';
import { weekdayPreset, type PowerDecision, type ApplicablePowerPrice } from './powerPolicy.ts';
import { IloError, type HardwareMode, type RuntimeState } from './iloAdapter.ts';

const instant = new Date('2026-10-12T16:00:00Z'); // Monday 18:00 Copenhagen

function snapshot(): ControlSnapshot {
  const schedule = weekdayPreset(); schedule.enabled = true;
  return {
    hardwareId: 1, configVersion: 1, policyVersion: 1,
    controlEnabled: true, automationEnabled: true, paused: false, driftHold: false, driftHoldUntil: null,
    supportedModes: ['low', 'dynamic', 'high'], schedule,
    pricePolicy: {
      enabled: false, basis: 'variable_retail_including_vat', contractRef: '', area: '',
      expensive: { enabled: false, threshold: '', hysteresis: '', capMode: 'dynamic' },
      cheap: { enabled: false, threshold: '', hysteresis: '' }, version: 1,
    },
    latch: null, manualOverride: null, lastVerifiedMode: null, lastAutomaticUpshiftAt: null,
    failureCount: 0, nextAttemptAt: null, pendingTarget: null, pendingOperationId: null,
    ilo: { host: 'ilo.fixture', port: 443, username: 'fixture', password: 'fixture', verifyTls: true },
  };
}

// In-memory repository mirroring the store's state transitions closely
// enough to exercise controller ordering without a database.
function repository(state: ControlSnapshot) {
  let claimed: string | null = null;
  const finished: ClaimOutcome[] = [];
  const observed: PowerDecision[] = [];
  const notes: ObservationNote[] = [];
  const requested: ClaimOutcome[] = [];
  const holds: Array<{ actual: HardwareMode; until: Date | null | undefined }> = [];
  const value: ControlRepository = {
    load: async () => structuredClone(state),
    claim: async (_s, token) => { if (claimed) return false; claimed = token; return true; },
    renewClaim: async (_id, token) => claimed === token,
    claimStillCurrent: async (_s, token) => claimed === token,
    recordRequested: async (_id, token, outcome) => { if (claimed !== token) return null; requested.push(outcome); return requested.length; },
    finish: async (_id, token, result) => {
      finished.push(result);
      if (claimed !== token) return;
      claimed = null;
      if (result.outcome === 'verified' || result.outcome === 'already_set') {
        Object.assign(state, { lastVerifiedMode: result.target, failureCount: 0, nextAttemptAt: null, pendingTarget: null });
      } else if (result.outcome === 'unknown' || result.outcome === 'failed') {
        state.failureCount = (state.failureCount ?? 0) + 1;
        state.nextAttemptAt = new Date(instant.getTime() + 60_000);
        if (result.outcome === 'unknown') { state.pendingTarget = result.target; state.pendingOperationId = result.operationId ?? null; }
      }
    },
    observe: async (_id, _version, result, actual, note) => {
      observed.push(result); if (note) notes.push(note);
      if (result.target === actual) state.lastVerifiedMode = actual;
      state.latch = result.latch;
    },
    holdExternalDrift: async (_id, _v, actual, until) => { holds.push({ actual, until }); state.driftHold = true; state.driftHoldUntil = until ?? null; state.policyVersion += 1; },
    releaseDriftHold: async (_id, _v, actual) => { state.driftHold = false; state.driftHoldUntil = null; state.lastVerifiedMode = actual; state.policyVersion += 1; return true; },
    resolvePending: async (_id, _op, verified, actual) => { state.pendingTarget = null; if (verified) state.lastVerifiedMode = actual; },
    recordUnavailable: async (_id, note) => { notes.push(note); if (note.countsAsFailure) state.failureCount = (state.failureCount ?? 0) + 1; },
  };
  return { value, finished, observed, notes, requested, holds, isClaimed: () => claimed !== null };
}

const on = (mode: HardwareMode): RuntimeState => ({ mode, powerState: 'on' });
const noWrite = async () => { throw new Error('must not write'); };
const fast = async () => {};

test('one controller handles weekly selection and skips no-op mode', async () => {
  const state = snapshot();
  const repo = repository(state);
  let writes = 0;
  const controller = new PowerController({ repository: repo.value, getApplicablePrice: async () => null,
    readState: async () => on('low'), now: () => instant, sleep: fast,
    writeMode: async (_config, target, _read, _patch, guard) => {
      assert.equal(target, 'high'); assert.equal(await guard?.(), true); writes += 1;
      return { prior: 'low', target, outcome: 'verified' };
    },
  });
  assert.equal((await controller.reconcile(1)).status, 'verified');
  assert.equal(writes, 1);
  assert.equal(repo.requested.length, 1, 'a requested row precedes the dispatch');
  assert.equal(repo.finished[0].decision.reason, 'schedule');
  assert.equal(repo.finished[0].operationId, 1);
  assert.equal(repo.finished[0].audit?.policyVersion, 1);
  assert.equal(repo.finished[0].audit?.scheduleVersion, 1);
  const already = new PowerController({ repository: repo.value, getApplicablePrice: async () => null,
    readState: async () => on('high'), now: () => instant, writeMode: noWrite,
  });
  assert.equal((await already.reconcile(1)).status, 'already_set');
  assert.equal(repo.observed.length, 1);
});

test('disabled and paused automation never reads hardware or writes', async () => {
  const state = snapshot(); state.controlEnabled = false;
  const repo = repository(state);
  const controller = new PowerController({ repository: repo.value, getApplicablePrice: async () => null,
    readState: async () => { throw new Error('must not read'); }, writeMode: noWrite, now: () => instant,
  });
  assert.equal((await controller.reconcile(1)).status, 'disabled');
  state.controlEnabled = true; state.paused = true;
  const paused = new PowerController({ repository: repo.value, getApplicablePrice: async () => null,
    readState: async () => on('low'), writeMode: noWrite, now: () => instant,
  });
  assert.equal((await paused.reconcile(1)).status, 'hold');
});

test('version change after claim aborts before any PATCH', async () => {
  const state = snapshot();
  const repo = repository(state);
  const original = repo.value.claim;
  repo.value.claim = async (...args) => { const ok = await original(...args); state.policyVersion += 1; return ok; };
  let writes = 0;
  const controller = new PowerController({ repository: repo.value, getApplicablePrice: async () => null,
    readState: async () => on('low'), now: () => instant,
    writeMode: async () => { writes += 1; return { prior: 'low', target: 'high', outcome: 'verified' }; },
  });
  assert.equal((await controller.reconcile(1)).status, 'stale');
  assert.equal(writes, 0);
  assert.equal(repo.isClaimed(), false, 'a stale claim is always released');
});

test('one physical node is reconciled once while a prior read is in flight', async () => {
  const repo = repository(snapshot());
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const controller = new PowerController({ repository: repo.value, getApplicablePrice: async () => null,
    readState: async () => { await waiting; return on('high'); }, now: () => instant,
  });
  const first = controller.reconcile(1);
  assert.equal((await controller.reconcile(1)).status, 'busy');
  release();
  assert.equal((await first).status, 'already_set');
});

test('external drift holds until the next weekly boundary; price-only and OS Control wait for Resume', async () => {
  const state = snapshot(); state.lastVerifiedMode = 'dynamic';
  const repo = repository(state);
  const controller = new PowerController({ repository: repo.value, getApplicablePrice: async () => null,
    readState: async () => on('low'), writeMode: noWrite, now: () => instant,
  });
  assert.equal((await controller.reconcile(1)).status, 'hold');
  assert.equal(state.driftHold, true);
  assert.equal(repo.holds[0].until?.toISOString(), '2026-10-13T00:00:00.000Z'); // Tuesday 02:00 Copenhagen

  const priceOnly = snapshot(); priceOnly.lastVerifiedMode = 'dynamic'; priceOnly.schedule.enabled = false;
  const priceRepo = repository(priceOnly);
  await new PowerController({ repository: priceRepo.value, getApplicablePrice: async () => null,
    readState: async () => on('low'), writeMode: noWrite, now: () => instant }).reconcile(1);
  assert.equal(priceRepo.holds[0].until, null);

  const os = snapshot(); os.lastVerifiedMode = 'dynamic';
  const osRepo = repository(os);
  await new PowerController({ repository: osRepo.value, getApplicablePrice: async () => null,
    readState: async () => on('os_control'), writeMode: noWrite, now: () => instant }).reconcile(1);
  assert.equal(osRepo.holds[0].until, null);
});

test('drift hold auto-releases at its boundary and adopts the fresh mode before reconciling', async () => {
  const state = snapshot();
  state.driftHold = true; state.lastVerifiedMode = 'dynamic';
  state.driftHoldUntil = new Date(instant.getTime() - 1);
  const repo = repository(state);
  let writes = 0;
  const controller = new PowerController({ repository: repo.value, getApplicablePrice: async () => null,
    readState: async () => on('low'), now: () => instant, sleep: fast,
    writeMode: async (_c, target, _r, _p, guard) => { assert.equal(await guard?.(), true); writes++; return { prior: 'low', target, outcome: 'verified' }; },
  });
  assert.equal((await controller.reconcile(1)).status, 'verified');
  assert.equal(writes, 1);
  assert.equal(state.driftHold, false);
  // Before the boundary the hold stays, and a price boundary cannot bypass it.
  const held = snapshot(); held.driftHold = true; held.lastVerifiedMode = 'low';
  held.driftHoldUntil = new Date(instant.getTime() + 60_000);
  const heldRepo = repository(held);
  const r = await new PowerController({ repository: heldRepo.value, getApplicablePrice: async () => null,
    readState: async () => on('low'), writeMode: noWrite, now: () => instant }).reconcile(1);
  assert.equal(r.decision?.reason, 'drift_hold');
});

test('an unknown outcome is verified read-only next tick and is never reported as drift', async () => {
  const state = snapshot(); state.lastVerifiedMode = 'low';
  const repo = repository(state);
  let actual: HardwareMode = 'low';
  let writes = 0;
  let clock = instant;
  const controller = new PowerController({ repository: repo.value, getApplicablePrice: async () => null,
    readState: async () => on(actual), now: () => clock, sleep: fast,
    writeMode: async (_c, target, _r, _p, guard) => { assert.equal(await guard?.(), true); writes++; return { prior: 'low', target, outcome: 'unknown' }; },
  });
  assert.equal((await controller.reconcile(1)).status, 'unknown');
  assert.equal(state.pendingTarget, 'high');
  // Inside backoff nothing is read or written.
  assert.equal((await controller.reconcile(1)).status, 'backoff');
  // The PATCH applied late: verified on read, no drift hold, no second write.
  actual = 'high';
  clock = new Date(instant.getTime() + 61_000);
  assert.equal((await controller.reconcile(1)).status, 'already_set');
  assert.equal(writes, 1);
  assert.equal(state.driftHold, false);
  assert.equal(repo.holds.length, 0);
});

test('a failed write backs off instead of re-PATCHing every tick', async () => {
  const state = snapshot();
  const repo = repository(state);
  let writes = 0;
  const controller = new PowerController({ repository: repo.value, getApplicablePrice: async () => null,
    readState: async () => on('low'), now: () => instant, sleep: fast,
    writeMode: async (_c, _t, _r, _p, guard) => { assert.equal(await guard?.(), true); writes++; throw new Error('fixture refusal'); },
  });
  assert.equal((await controller.reconcile(1)).status, 'unknown'); // dispatched, then threw: may have applied
  assert.equal((await controller.reconcile(1)).status, 'backoff');
  assert.equal(writes, 1);
  // A failure before dispatch is a plain failure.
  const pre = snapshot();
  const preRepo = repository(pre);
  const failing = new PowerController({ repository: preRepo.value, getApplicablePrice: async () => null,
    readState: async () => on('low'), now: () => instant, writeMode: async () => { throw new Error('discovery failed'); } });
  assert.equal((await failing.reconcile(1)).status, 'failed');
  assert.equal(preRepo.finished[0].outcome, 'failed');
});

test('read errors and powered-off or booting hosts are persisted safely without writes', async () => {
  const state = snapshot();
  const repo = repository(state);
  const unreadable = new PowerController({ repository: repo.value, getApplicablePrice: async () => null,
    readState: async () => { throw new Error('unreachable'); }, writeMode: noWrite, now: () => instant });
  assert.equal((await unreadable.reconcile(1)).status, 'unavailable');
  assert.deepEqual(repo.notes.at(-1), { outcome: 'read_failed', error: 'Error', countsAsFailure: true });
  for (const powerState of ['off', 'booting', 'unknown'] as const) {
    const off = new PowerController({ repository: repo.value, getApplicablePrice: async () => null,
      readState: async () => ({ mode: 'low', powerState }), writeMode: noWrite, now: () => instant });
    assert.equal((await off.reconcile(1)).status, 'unavailable');
    assert.deepEqual(repo.notes.at(-1), { outcome: 'host_not_running', error: powerState, countsAsFailure: false });
  }
  assert.equal(repo.isClaimed(), false);
});

test('a hung write is bounded; its guard refuses after the controller gives up', async () => {
  const state = snapshot();
  const repo = repository(state);
  let lateGuard: (() => Promise<boolean>) | undefined;
  const controller = new PowerController({ repository: repo.value, getApplicablePrice: async () => null,
    readState: async () => on('low'), now: () => instant, sleep: fast, timings: { writeTimeoutMs: 5 },
    writeMode: (_c, _t, _r, _p, guard) => { lateGuard = guard; return new Promise(() => {}); },
  });
  assert.equal((await controller.reconcile(1)).status, 'failed');
  assert.equal(await lateGuard?.(), false, 'an abandoned write can never dispatch later');
  assert.equal(repo.requested.length, 0);
});

test('corrupt stored price policy restricts and never boosts', async () => {
  const state = snapshot();
  state.pricePolicy = { ...state.pricePolicy, enabled: true, contractRef: 'c', area: 'DK2',
    expensive: { enabled: true, threshold: '1.00', hysteresis: '0', capMode: 'dynamic' },
    cheap: { enabled: true, threshold: '2.00', hysteresis: '0' } }; // overlapping bands: invalid
  const repo = repository(state);
  const writes: string[] = [];
  const controller = (actual: HardwareMode) => new PowerController({ repository: repo.value, getApplicablePrice: async () => null,
    readState: async () => on(actual), now: () => instant, sleep: fast,
    writeMode: async (_c, target, _r, _p, guard) => { assert.equal(await guard?.(), true); writes.push(target); return { prior: actual, target, outcome: 'verified' }; },
  });
  const low = await controller('low').reconcile(1);
  assert.equal(low.status, 'hold');
  assert.equal(low.decision?.reason, 'policy_invalid');
  assert.equal(repo.notes.at(-1)?.outcome, 'policy_invalid');
  state.lastVerifiedMode = null;
  assert.equal((await controller('high').reconcile(1)).status, 'verified');
  assert.deepEqual(writes, ['dynamic'], 'only a restriction to the cap mode is written');
});

test('automatic price upshift dwell delays another increase but never delays a restriction', async () => {
  const state = snapshot();
  state.pricePolicy.enabled = true;
  state.pricePolicy.contractRef = 'contract';
  state.pricePolicy.area = 'DK2';
  state.pricePolicy.minAutomaticUpshiftMinutes = 5;
  state.lastAutomaticUpshiftAt = new Date(instant.getTime() - 60_000);
  const repo = repository(state);
  let writes = 0;
  const controller = new PowerController({ repository: repo.value, getApplicablePrice: async () => null,
    readState: async () => on('low'), now: () => instant, sleep: fast,
    writeMode: async () => { writes++; return { prior: 'low', target: 'high', outcome: 'verified' }; },
  });
  assert.equal((await controller.reconcile(1)).status, 'hold');
  assert.equal(writes, 0);
  state.lastAutomaticUpshiftAt = new Date(instant.getTime() - 6 * 60_000);
  assert.equal((await controller.reconcile(1)).status, 'verified');
  assert.equal(writes, 1);
  state.lastAutomaticUpshiftAt = instant;
  state.lastVerifiedMode = null;
  const restrict = new PowerController({ repository: repo.value, getApplicablePrice: async () => null,
    readState: async () => on('high'), now: () => instant, sleep: fast,
    writeMode: async (_config, target) => { assert.equal(target, 'low'); return { prior: 'high', target, outcome: 'verified' }; },
  });
  state.schedule.defaultMode = 'low';
  state.schedule.enabled = false;
  state.pricePolicy.priceOnlyDefault = 'low';
  assert.equal((await restrict.reconcile(1)).status, 'verified');
});

test('price expiry while waiting for dispatch cancels a queued cheap High', async () => {
  const state = snapshot();
  state.schedule.enabled = false;
  state.pricePolicy = { ...state.pricePolicy, enabled: true, contractRef: 'c', area: 'DK2', priceOnlyDefault: 'low',
    cheap: { enabled: true, threshold: '1.00', hysteresis: '0.10' } };
  const repo = repository(state);
  let clock = instant;
  const price = (): ApplicablePowerPrice => ({ dkk_per_kwh: '0.50', basis: 'variable_retail_including_vat', contract_ref: 'c', area: 'DK2',
    start_utc: '2026-10-12T16:00:00Z', end_utc: '2026-10-12T16:15:00Z', status: 'valid', contract_revision: '1', source_revision: 'a' });
  let writes = 0;
  const controller = new PowerController({ repository: repo.value, now: () => clock, sleep: fast,
    getApplicablePrice: async (at) => at.getTime() < Date.parse('2026-10-12T16:15:00Z') ? price() : null,
    readState: async () => on('low'),
    writeMode: async (_c, target, _r, _p, guard) => {
      clock = new Date('2026-10-12T16:15:00Z'); // the interval ends while waiting
      if (!await guard?.()) throw new IloError('policy_changed', 'changed');
      writes++; return { prior: 'low', target, outcome: 'verified' };
    },
  });
  assert.equal((await controller.reconcile(1)).status, 'stale');
  assert.equal(writes, 0);
  assert.equal(repo.requested.length, 0);
});

test('pause carries the price latch instead of erasing hysteresis state', async () => {
  const state = snapshot();
  state.paused = true;
  state.latch = { expensive: true, cheap: false, policyVersion: 1, priceRevision: '1/a' };
  const repo = repository(state);
  await new PowerController({ repository: repo.value, getApplicablePrice: async () => null,
    readState: async () => on('low'), writeMode: noWrite, now: () => instant }).reconcile(1);
  assert.deepEqual(state.latch, { expensive: true, cheap: false, policyVersion: 1, priceRevision: '1/a' });
});
