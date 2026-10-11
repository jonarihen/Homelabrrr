import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { eq, sql } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '../testUtils/pgTestDb.ts';
import { hardwareConnections, hardwarePowerOperations, hardwarePowerPolicies, pveHosts, settings } from '../db/schema/index.ts';
import { weekdayPreset, type ApplicablePowerPrice, type PowerPricePolicy } from './powerPolicy.ts';
import type { HardwareMode, RuntimeState } from './iloAdapter.ts';
import type { PowerControlStore as StoreType } from './powerControlStore.ts';
import type { PowerController as ControllerType } from './powerController.ts';

// DB-backed races for the single iLO writer. Hardware is always a fake; the
// clock is injected. Each scenario asserts the exact number of dispatched writes.

let fixture: TestDatabase;
let closeDb: () => Promise<void>;
let Store: typeof StoreType;
let Controller: typeof ControllerType;
let createWorker: typeof import('./powerControlWorker.ts').createPowerControlWorker;
let encryptSecret: (value: string) => string;
let hostId: number;
let clock = new Date('2026-10-12T16:00:00Z'); // Monday 18:00 Copenhagen: weekly High
const now = () => clock;
const notices: string[] = [];

before(async () => {
  fixture = await createTestDatabase();
  process.env.DATABASE_URL = fixture.url;
  process.env.SECRET_ENCRYPTION_KEY ||= '55'.repeat(32);
  ({ closeDb } = await import('../db/client.ts'));
  ({ PowerControlStore: Store } = await import('./powerControlStore.ts'));
  ({ PowerController: Controller } = await import('./powerController.ts'));
  ({ createPowerControlWorker: createWorker } = await import('./powerControlWorker.ts'));
  ({ encryptSecret } = await import('../utils/secrets.ts'));
  const [host] = await fixture.db.insert(pveHosts).values({ name: 'pve', host: 'pve.race.test', token_id: 'fixture', token_secret: 'fixture' }).returning();
  hostId = host.id;
});

after(async () => { await closeDb?.(); await fixture?.drop(); });

beforeEach(async () => {
  clock = new Date('2026-10-12T16:00:00Z');
  notices.length = 0;
  await fixture.db.delete(settings).where(eq(settings.key, 'power_automation_paused'));
});

const disabledPrice = (): PowerPricePolicy => ({
  enabled: false, basis: 'variable_retail_including_vat', contractRef: '', area: '', version: 1,
  expensive: { enabled: false, threshold: '', hysteresis: '', capMode: 'dynamic' },
  cheap: { enabled: false, threshold: '', hysteresis: '' },
});

let nodeCounter = 0;
async function hardware(options: { controlEnabled?: boolean; automationEnabled?: boolean; pricePolicy?: PowerPricePolicy; scheduleEnabled?: boolean;
  policy?: Partial<typeof hardwarePowerPolicies.$inferInsert> } = {}) {
  nodeCounter += 1;
  const [row] = await fixture.db.insert(hardwareConnections).values({
    pve_host_id: hostId, node_ref: `${hostId}~node${nodeCounter}`, target_host: `ilo${nodeCounter}.race.test`, username: 'fixture',
    secret: encryptSecret('fixture-only'), control_enabled: options.controlEnabled ?? true, system_uuid: `uuid-${nodeCounter}`,
    last_status: 'online', capabilities: { runtimeMode: 'supported', supportedModes: ['low', 'dynamic', 'high'] },
  }).returning();
  const schedule = weekdayPreset(); schedule.enabled = options.scheduleEnabled ?? true;
  await fixture.db.insert(hardwarePowerPolicies).values({
    hardware_id: row.id, schedule, price_policy: options.pricePolicy ?? disabledPrice(),
    automation_enabled: options.automationEnabled ?? true, ...options.policy,
  });
  return row.id;
}

function fakeHardware(initial: HardwareMode) {
  const state = { actual: initial, reads: 0, writes: [] as string[], onRead: null as null | (() => Promise<void>) };
  return {
    state,
    readState: async (): Promise<RuntimeState> => { state.reads += 1; await state.onRead?.(); return { mode: state.actual, powerState: 'on' }; },
    writeMode: async (_config: unknown, target: 'low' | 'dynamic' | 'high', _r?: unknown, _p?: unknown, guard?: () => Promise<boolean>) => {
      const { IloError } = await import('./iloAdapter.ts');
      if (guard && !await guard()) throw new IloError('policy_changed', 'Power policy changed before dispatch');
      state.writes.push(target); state.actual = target;
      return { prior: 'low' as HardwareMode, target, outcome: 'verified' as const };
    },
  };
}

function controller(fake: ReturnType<typeof fakeHardware>, price: () => ApplicablePowerPrice | null = () => null) {
  const store = new Store({ now, notify: async (event) => { notices.push(event); } });
  return { store, controller: new Controller({ repository: store, getApplicablePrice: async () => price(), now,
    readState: fake.readState, writeMode: fake.writeMode as any, sleep: async () => {} }) };
}

async function policy(id: number) {
  const [row] = await fixture.db.select().from(hardwarePowerPolicies).where(eq(hardwarePowerPolicies.hardware_id, id)).limit(1);
  return row;
}
async function operations(id: number) {
  return fixture.db.select().from(hardwarePowerOperations).where(eq(hardwarePowerOperations.hardware_id, id)).orderBy(hardwarePowerOperations.id);
}

test('concurrent workers on separate processes produce exactly one serialized write', async () => {
  const id = await hardware();
  const fake = fakeHardware('low');
  const a = controller(fake).controller;
  const b = controller(fake).controller;
  const results = await Promise.all([a.reconcile(id), b.reconcile(id), a.reconcile(id)]);
  assert.equal(fake.state.writes.length, 1);
  assert.equal(results.filter((r) => r.status === 'verified').length, 1);
  const ops = await operations(id);
  assert.equal(ops.length, 1);
  assert.equal(ops[0].outcome, 'verified');
  assert.equal(ops[0].reason, 'schedule');
  assert.equal((await policy(id)).claim_token, null);
});

test('edit between snapshot read and claim prevents the stale write', async () => {
  const id = await hardware();
  const fake = fakeHardware('low');
  let first = true;
  fake.state.onRead = async () => {
    if (!first) return; first = false;
    await fixture.db.update(hardwarePowerPolicies).set({ automation_enabled: false, version: sql`${hardwarePowerPolicies.version} + 1` })
      .where(eq(hardwarePowerPolicies.hardware_id, id));
  };
  const result = await controller(fake).controller.reconcile(id);
  assert.equal(result.status, 'busy');
  assert.equal(fake.state.writes.length, 0);
});

test('an edit cannot complete while a claim is held, and disable/delete/pause after claim abort dispatch', async () => {
  for (const scenario of ['edit', 'disable', 'decommission', 'global_pause'] as const) {
    const id = await hardware();
    const fake = fakeHardware('low');
    let reads = 0;
    fake.state.onRead = async () => {
      reads += 1;
      if (reads !== 2) return; // the second read happens after the claim
      if (scenario === 'edit') {
        const rows = await fixture.db.update(hardwarePowerPolicies).set({ version: sql`${hardwarePowerPolicies.version} + 1` })
          .where(sql`${hardwarePowerPolicies.hardware_id} = ${id} AND ${hardwarePowerPolicies.claim_token} IS NULL`).returning();
        assert.equal(rows.length, 0, 'route edits are claim-guarded');
        // An out-of-band edit that ignores the guard still invalidates the claim.
        await fixture.db.update(hardwarePowerPolicies).set({ version: sql`${hardwarePowerPolicies.version} + 1` }).where(eq(hardwarePowerPolicies.hardware_id, id));
      } else if (scenario === 'disable') {
        await fixture.db.update(hardwareConnections).set({ control_enabled: false, config_version: sql`${hardwareConnections.config_version} + 1` }).where(eq(hardwareConnections.id, id));
      } else if (scenario === 'decommission') {
        await fixture.db.update(hardwareConnections).set({ lifecycle_state: 'decommissioned', control_enabled: false }).where(eq(hardwareConnections.id, id));
      } else {
        await fixture.db.insert(settings).values({ key: 'power_automation_paused', value: 'true' })
          .onConflictDoUpdate({ target: settings.key, set: { value: 'true' } });
      }
    };
    const result = await controller(fake).controller.reconcile(id);
    assert.equal(result.status, 'stale', scenario);
    assert.equal(fake.state.writes.length, 0, scenario);
    assert.equal((await policy(id)).claim_token, null, `${scenario}: claim released`);
    await fixture.db.delete(settings).where(eq(settings.key, 'power_automation_paused'));
  }
});

test('price interval expiry while waiting for dispatch prevents a queued cheap High', async () => {
  const pricePolicy: PowerPricePolicy = { ...disabledPrice(), enabled: true, contractRef: '7', area: 'DK2', priceOnlyDefault: 'low',
    cheap: { enabled: true, threshold: '1', hysteresis: '0.1' } };
  const id = await hardware({ pricePolicy, scheduleEnabled: false });
  const fake = fakeHardware('low');
  const price = (): ApplicablePowerPrice | null => clock < new Date('2026-10-12T16:15:00Z') ? {
    dkk_per_kwh: '-0.25', basis: 'variable_retail_including_vat', contract_ref: '7', area: 'DK2',
    start_utc: '2026-10-12T16:00:00Z', end_utc: '2026-10-12T16:15:00Z', status: 'valid', contract_revision: 'c1', source_revision: 's1',
  } : null;
  let reads = 0;
  fake.state.onRead = async () => { reads += 1; if (reads === 2) clock = new Date('2026-10-12T16:15:00Z'); };
  const result = await controller(fake, price).controller.reconcile(id);
  assert.equal(result.status, 'stale');
  assert.equal(fake.state.writes.length, 0);
  // With a valid negative price the boost dispatches and records provenance.
  clock = new Date('2026-10-12T16:01:00Z');
  fake.state.onRead = null;
  assert.equal((await controller(fake, price).controller.reconcile(id)).status, 'verified');
  const [op] = (await operations(id)).filter((row) => row.outcome === 'verified');
  assert.equal(op.reason, 'price_low');
  assert.equal(op.price_dkk_per_kwh, '-0.25');
  assert.equal(op.price_end_utc?.toISOString(), '2026-10-12T16:15:00.000Z');
  assert.deepEqual(op.price_source, { basis: 'variable_retail_including_vat', area: 'DK2', contractRef: '7', contractRevision: 'c1', sourceRevision: 's1' });
  assert.equal((op.thresholds as any).cheap.threshold, '1');
  assert.equal(op.price_revision, 'c1/s1');
});

test('crash after the requested row: expired claim is released as unknown and verified read-only', async () => {
  const id = await hardware({ policy: { last_verified_mode: 'low' } });
  const [requested] = await fixture.db.insert(hardwarePowerOperations).values({
    hardware_id: id, actor: 'automation', prior_mode: 'low', target_mode: 'high', reason: 'schedule',
    outcome: 'requested', policy_version: 1, claim_token: 'dead-worker',
  }).returning();
  await fixture.db.update(hardwarePowerPolicies).set({ claim_token: 'dead-worker', claim_expires_at: new Date(clock.getTime() - 1000) })
    .where(eq(hardwarePowerPolicies.hardware_id, id));
  const fake = fakeHardware('high'); // the PATCH applied before the crash
  const { controller: c } = controller(fake);
  assert.equal((await c.reconcile(id)).status, 'already_set');
  assert.equal(fake.state.writes.length, 0, 'nothing is replayed');
  const row = await policy(id);
  assert.equal(row.claim_token, null);
  assert.equal(row.drift_hold, false, 'our own late apply is not external drift');
  assert.equal(row.last_verified_mode, 'high');
  const [op] = (await operations(id)).filter((item) => item.id === requested.id);
  assert.equal(op.outcome, 'verified');
  assert.equal(op.error_category, 'verified_on_later_read');
});

test('crash before dispatch records an unknown abandoned claim and unblocks edits', async () => {
  const id = await hardware({ automationEnabled: false });
  await fixture.db.update(hardwarePowerPolicies).set({ claim_token: 'dead-before-dispatch', claim_expires_at: new Date(clock.getTime() - 1000) })
    .where(eq(hardwarePowerPolicies.hardware_id, id));
  const store = new Store({ now });
  assert.equal(await store.releaseExpiredClaims(), 1);
  const row = await policy(id);
  assert.equal(row.claim_token, null);
  assert.equal(row.pending_target, null);
  const [op] = await operations(id);
  assert.equal(op.outcome, 'unknown');
  assert.equal(op.error_category, 'abandoned_claim_before_dispatch');
  const edited = await fixture.db.update(hardwarePowerPolicies).set({ version: 2 })
    .where(sql`${hardwarePowerPolicies.hardware_id} = ${id} AND ${hardwarePowerPolicies.claim_token} IS NULL`).returning();
  assert.equal(edited.length, 1);
});

test('finish records the operation even after the lease was lost', async () => {
  const id = await hardware();
  const fake = fakeHardware('low');
  const original = fake.writeMode;
  fake.writeMode = async (...args) => {
    const result = await original(...args);
    // Another worker reclaims after our lease expired mid-write.
    await fixture.db.update(hardwarePowerPolicies).set({ claim_token: 'other-worker' }).where(eq(hardwarePowerPolicies.hardware_id, id));
    return result;
  };
  await controller(fake).controller.reconcile(id);
  const ops = await operations(id);
  assert.equal(ops.length, 1);
  assert.equal(ops[0].outcome, 'verified');
  assert.match(ops[0].error_category ?? '', /lease_lost/);
  assert.equal((await policy(id)).claim_token, 'other-worker', 'the new holder keeps its lease');
});

test('repeated failures back off and notify once; recovery notifies once', async () => {
  const id = await hardware();
  const fake = fakeHardware('low');
  fake.readState = async () => { throw new Error('unreachable'); };
  const { controller: c } = controller(fake);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await c.reconcile(id);
    clock = new Date(clock.getTime() + 61 * 60_000); // past any backoff
  }
  const row = await policy(id);
  assert.equal(row.failure_count, 6);
  assert.equal(row.last_outcome, 'read_failed');
  assert.deepEqual(notices, ['hardware.power_control_failing']);
  // Inside the backoff window no read happens at all.
  let reads = 0;
  fake.readState = async () => { reads += 1; return { mode: 'low', powerState: 'on' }; };
  const backoff = new Controller({ repository: new Store({ now }), getApplicablePrice: async () => null, now, readState: fake.readState, writeMode: fake.writeMode as any });
  clock = new Date(row.next_attempt_at!.getTime() - 1000);
  assert.equal((await backoff.reconcile(id)).status, 'backoff');
  assert.equal(reads, 0);
  clock = new Date(row.next_attempt_at!.getTime() + 1000);
  const recovered = controller(fake).controller;
  assert.equal((await recovered.reconcile(id)).status, 'verified');
  assert.deepEqual(notices, ['hardware.power_control_failing', 'hardware.power_control_recovered']);
  assert.equal((await policy(id)).failure_count, 0);
});

test('worker restart reconciles only explicitly enabled control and never enables anything', async () => {
  await fixture.db.update(hardwareConnections).set({ control_enabled: false });
  const enabled = await hardware();
  const disabled = await hardware({ controlEnabled: false });
  const draft = await hardware({ automationEnabled: false });
  const fake = fakeHardware('low');
  const read: number[] = [];
  const sweep = createWorker(async () => null, new Store({ now }), {
    now, sleep: async () => {},
    readState: async (config) => { read.push(Number(/ilo(\d+)/.exec(config.host)?.[1])); return fake.readState(); },
    writeMode: fake.writeMode as any,
  });
  await sweep();
  assert.equal(fake.state.writes.length, 1);
  const [enabledRow] = await fixture.db.select().from(hardwareConnections).where(eq(hardwareConnections.id, enabled));
  const [disabledRow] = await fixture.db.select().from(hardwareConnections).where(eq(hardwareConnections.id, disabled));
  assert.equal(enabledRow.control_enabled, true);
  assert.equal(disabledRow.control_enabled, false);
  assert.equal(new Set(read).size, 1, 'disabled and draft-only nodes are never read for control');
  assert.equal((await policy(draft)).automation_enabled, false);
  // A second sweep (e.g. after restart) does not replay the transition.
  await createWorker(async () => null, new Store({ now }), { now, readState: fake.readState, writeMode: fake.writeMode as any })();
  assert.equal(fake.state.writes.length, 1);
});

test('policy rows restored from a backup taken mid-operation cannot duplicate a hardware action', async () => {
  await fixture.db.update(hardwareConnections).set({ control_enabled: false });
  const id = await hardware({ policy: { last_verified_mode: 'low', latch: null } });
  // State as captured by the backup: lease held, requested row written.
  await fixture.db.insert(hardwarePowerOperations).values({ hardware_id: id, actor: 'automation', prior_mode: 'low', target_mode: 'high',
    reason: 'schedule', outcome: 'requested', policy_version: 1, claim_token: 'backup-era' });
  await fixture.db.update(hardwarePowerPolicies).set({ claim_token: 'backup-era', claim_expires_at: new Date('2026-10-01T00:00:00Z') })
    .where(eq(hardwarePowerPolicies.hardware_id, id));
  // The restored host never received that PATCH: read shows Low.
  const fake = fakeHardware('low');
  const sweep = createWorker(async () => null, new Store({ now }), { now, readState: fake.readState, writeMode: fake.writeMode as any, sleep: async () => {} });
  await sweep();
  const ops = await operations(id);
  assert.equal(ops[0].outcome, 'not_applied', 'the restored request is resolved, not replayed blindly');
  // Exactly one fresh, current-state write follows; never two.
  assert.equal(fake.state.writes.length, 1);
  await sweep();
  assert.equal(fake.state.writes.length, 1);
});
