import { Router } from 'express';
import { and, desc, eq, isNull, sql, lt, gt } from 'drizzle-orm';
import { db } from '../db/client.ts';
import {
  hardwareConnections, hardwarePowerOperations, hardwarePowerPolicies, electricityContracts, electricitySpotPrices, electricityTariffs,
} from '../db/schema/index.ts';
import { getSetting, setSetting } from '../db/settings.ts';
import { requireAuth, requireAdmin, requireInteractiveSession, requireRecentReauthentication } from '../middleware/auth.ts';
import {
  isWritablePowerMode, normalizeDkkPerKwh, resolvePowerDecision, validatePowerSchedule, validatePricePolicy, weekdayPreset,
  type ApplicablePowerPrice, type PowerPricePolicy, type PriceBasis, type WeeklyPowerSchedule, type WritablePowerMode,
} from '../services/powerPolicy.ts';
import { getApplicablePrice as defaultGetApplicablePrice } from '../services/electricityPricing.ts';
import { logAudit, logAuditTx } from '../utils/audit.ts';
import { sanitizeError } from '../utils/sanitize.ts';
import { PowerController } from '../services/powerController.ts';
import { PowerControlStore } from '../services/powerControlStore.ts';
import { buildPowerPreview } from '../services/powerPreview.ts';
import { resolveManualExpiry } from '../services/manualPowerOverride.ts';
import { controllerDecisionInput, observedMode, storedManualOverride, supportedModesFrom, type DecisionState } from '../services/powerDecisionContext.ts';
import { IloError, readRuntimeState, type RuntimeState } from '../services/iloAdapter.ts';
import { decryptSecret } from '../utils/secrets.ts';

function hardwareId(value: string): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid hardware ID');
  return id;
}

const INPUT_ERROR = /^(Invalid|Enable|Price|Overlapping|Hysteresis|Unsupported|No next|Choose|Policy version)/;
function inputError(err: unknown): string | null {
  return err instanceof Error && INPUT_ERROR.test(err.message) ? err.message : null;
}

// No pre-selected price-only default: price-only automation needs an explicit
// administrator choice, never a guess.
function defaultPricePolicy(): PowerPricePolicy {
  return {
    enabled: false, basis: 'variable_retail_including_vat', contractRef: '', area: '', minAutomaticUpshiftMinutes: 5,
    expensive: { enabled: false, threshold: '', hysteresis: '', capMode: 'dynamic' },
    cheap: { enabled: false, threshold: '', hysteresis: '' }, version: 1,
  };
}

function strictBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`Invalid ${label}: expected true or false`);
  return value;
}

function rate(value: unknown, enabled: boolean, label: string): string {
  if (value === undefined || value === null || value === '') {
    if (enabled) throw new Error(`Invalid ${label}: a DKK/kWh value is required`);
    return '';
  }
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error(`Invalid ${label}`);
  try { return normalizeDkkPerKwh(String(value)); }
  catch { throw new Error(`Invalid ${label}: use a decimal kr./kWh value such as 1,25`); }
}

function mode(value: unknown, label: string): WritablePowerMode {
  if (!isWritablePowerMode(value)) throw new Error(`Invalid ${label}`);
  return value;
}

// Build stored objects from an allowlist; unknown properties and client-sent
// versions are dropped. Danish decimals are normalized before storage.
export function normalizePolicyBody(body: any): { schedule: WeeklyPowerSchedule; pricePolicy: PowerPricePolicy; automationEnabled: boolean } {
  if (!body || typeof body !== 'object') throw new Error('Invalid power policy');
  const automationEnabled = strictBoolean(body.automationEnabled, 'automation switch');
  const rawSchedule = body.schedule;
  const rawPrice = body.pricePolicy;
  if (!rawSchedule || typeof rawSchedule !== 'object' || !Array.isArray(rawSchedule.windows)
    || !rawPrice || typeof rawPrice !== 'object' || !rawPrice.expensive || typeof rawPrice.expensive !== 'object'
    || !rawPrice.cheap || typeof rawPrice.cheap !== 'object') throw new Error('Invalid power policy');
  const schedule: WeeklyPowerSchedule = {
    enabled: strictBoolean(rawSchedule.enabled, 'schedule switch'),
    timezone: typeof rawSchedule.timezone === 'string' ? rawSchedule.timezone.trim() : '',
    defaultMode: mode(rawSchedule.defaultMode, 'default mode'),
    windows: rawSchedule.windows.slice(0, 51).map((window: any) => ({
      days: window?.days, start: window?.start, end: window?.end, mode: mode(window?.mode, 'window mode'),
    })),
    version: 0,
  };
  validatePowerSchedule(schedule);
  const expensiveEnabled = strictBoolean(rawPrice.expensive.enabled, 'expensive-price switch');
  const cheapEnabled = strictBoolean(rawPrice.cheap.enabled, 'cheap-price switch');
  const minutes = rawPrice.minAutomaticUpshiftMinutes === undefined ? 5 : rawPrice.minAutomaticUpshiftMinutes;
  const pricePolicy: PowerPricePolicy = {
    enabled: strictBoolean(rawPrice.enabled, 'price-policy switch'),
    basis: rawPrice.basis as PriceBasis,
    contractRef: typeof rawPrice.contractRef === 'string' ? rawPrice.contractRef.trim() : '',
    area: typeof rawPrice.area === 'string' ? rawPrice.area.trim() : '',
    minAutomaticUpshiftMinutes: minutes,
    expensive: {
      enabled: expensiveEnabled,
      threshold: rate(rawPrice.expensive.threshold, expensiveEnabled, 'upper price'),
      hysteresis: rate(rawPrice.expensive.hysteresis ?? '0', expensiveEnabled, 'upper hysteresis'),
      capMode: rawPrice.expensive.capMode,
    },
    cheap: {
      enabled: cheapEnabled,
      threshold: rate(rawPrice.cheap.threshold, cheapEnabled, 'lower price'),
      hysteresis: rate(rawPrice.cheap.hysteresis ?? '0', cheapEnabled, 'lower hysteresis'),
    },
    version: 0,
  };
  if (rawPrice.priceOnlyDefault !== undefined && rawPrice.priceOnlyDefault !== null && rawPrice.priceOnlyDefault !== '') {
    pricePolicy.priceOnlyDefault = mode(rawPrice.priceOnlyDefault, 'price-only default');
  }
  validatePricePolicy(pricePolicy);
  if (automationEnabled && !schedule.enabled && !pricePolicy.enabled) throw new Error('Enable a schedule or price policy first');
  if (pricePolicy.enabled && !schedule.enabled && !pricePolicy.priceOnlyDefault) throw new Error('Choose a price-only default mode');
  return { schedule, pricePolicy, automationEnabled };
}

// Reject a saved policy that names a mode the discovered hardware cannot set.
export function assertModesSupported(input: { schedule: WeeklyPowerSchedule; pricePolicy: PowerPricePolicy }, capabilities: unknown) {
  const value = capabilities as { runtimeMode?: string; supportedModes?: unknown } | null;
  if (value?.runtimeMode !== 'supported' || !Array.isArray(value.supportedModes)) return;
  const supported = new Set(supportedModesFrom(capabilities));
  const used = new Set<WritablePowerMode>([input.schedule.defaultMode, ...input.schedule.windows.map((window) => window.mode)]);
  if (input.pricePolicy.expensive.enabled) used.add(input.pricePolicy.expensive.capMode);
  if (input.pricePolicy.cheap.enabled) used.add('high');
  if (input.pricePolicy.priceOnlyDefault) used.add(input.pricePolicy.priceOnlyDefault);
  for (const item of used) if (!supported.has(item)) throw new Error(`Unsupported mode for this hardware: ${item}`);
}

function sameContent<T extends { version: number }>(a: T | null | undefined, b: T): boolean {
  if (!a) return false;
  const strip = (value: T) => JSON.stringify({ ...value, version: 0 });
  return strip(a) === strip(b);
}

export interface PowerControlRouterDeps {
  store?: PowerControlStore;
  controller?: PowerController;
  readState?: (config: Parameters<typeof readRuntimeState>[0]) => Promise<RuntimeState>;
  getApplicablePrice?: typeof defaultGetApplicablePrice;
  now?: () => Date;
}

export function createPowerControlRouter(deps: PowerControlRouterDeps = {}) {
  const router = Router();
  router.use(requireAuth, requireAdmin, requireInteractiveSession);
  const now = deps.now ?? (() => new Date());
  const store = deps.store ?? new PowerControlStore({ now });
  const manualController = deps.controller
    ?? new PowerController({ repository: store, getApplicablePrice: async () => null, now });
  const readState = deps.readState ?? ((config) => readRuntimeState(config));
  const getApplicablePrice = deps.getApplicablePrice ?? defaultGetApplicablePrice;

  const validPriceAt = async (when: Date, policy: PowerPricePolicy): Promise<ApplicablePowerPrice | null> => {
    if (!policy?.enabled) return null;
    try {
      const value = await getApplicablePrice(when, policy);
      return value?.status === 'valid' && value.dkk_per_kwh && value.start_utc && value.end_utc ? value as ApplicablePowerPrice : null;
    } catch { return null; }
  };

  async function sourceBoundaries(pricePolicy: PowerPricePolicy, at: Date, previewEnd: Date): Promise<Date[]> {
    const boundaries: Date[] = [];
    if (!pricePolicy?.enabled || !/^\d+$/.test(pricePolicy.contractRef)) return boundaries;
    const [contract] = await db.select().from(electricityContracts)
      .where(eq(electricityContracts.id, Number(pricePolicy.contractRef))).limit(1);
    if (!contract || contract.area !== pricePolicy.area) return boundaries;
    boundaries.push(contract.valid_from);
    if (contract.valid_to) boundaries.push(contract.valid_to);
    const tariffs = await db.select({ start: electricityTariffs.valid_from, end: electricityTariffs.valid_to })
      .from(electricityTariffs).where(and(eq(electricityTariffs.contract_id, contract.id),
        lt(electricityTariffs.valid_from, previewEnd), gt(electricityTariffs.valid_to, at)));
    for (const tariff of tariffs) boundaries.push(tariff.start, tariff.end);
    if (contract.kind === 'spot') {
      const spots = await db.select({ start: electricitySpotPrices.start_utc, end: electricitySpotPrices.end_utc })
        .from(electricitySpotPrices).where(and(eq(electricitySpotPrices.area, contract.area),
          lt(electricitySpotPrices.start_utc, previewEnd), gt(electricitySpotPrices.end_utc, at)));
      for (const spot of spots) boundaries.push(spot.start, spot.end);
    } else {
      for (let time = at.getTime() - at.getTime() % 86_400_000 + 86_400_000; time < previewEnd.getTime(); time += 86_400_000) {
        boundaries.push(new Date(time));
      }
    }
    return boundaries;
  }

  // Preview uses exactly the worker's resolver input (automatic, not manual).
  // `ifEnabled` shows what the policy would select if control and automation
  // were enabled, so a disabled draft is still explainable.
  async function previewFor(state: DecisionState, lastVerifiedMode: unknown, at: Date) {
    const actualMode = observedMode(lastVerifiedMode);
    const price = await validPriceAt(at, state.pricePolicy);
    const decision = resolvePowerDecision(controllerDecisionInput(state, { now: at, actualMode, price }));
    const enabledState = { ...state, controlEnabled: true, automationEnabled: true };
    const ifEnabled = resolvePowerDecision(controllerDecisionInput(enabledState, { now: at, actualMode, price }));
    const previewEnd = new Date(at.getTime() + 7 * 86_400_000);
    const boundaries = await sourceBoundaries(state.pricePolicy, at, previewEnd);
    const knownAt = now();
    const timeline = (scenario: DecisionState) => buildPowerPreview(
      controllerDecisionInput(scenario, { now: at, actualMode, price: null }),
      boundaries, (when) => validPriceAt(when, state.pricePolicy), 7, knownAt);
    const sevenDayPreview = await timeline(state);
    const ifEnabledPreview = state.controlEnabled && state.automationEnabled ? null : await timeline(enabledState);
    return {
      at, observedMode: actualMode,
      baseMode: decision.baseMode, selectedMode: sevenDayPreview.segments[0]?.futurePriceUnknown ? null : decision.target,
      reason: decision.reason, policyError: decision.policyError ?? null,
      priceStatus: decision.priceStatus, priceDkkPerKwh: decision.priceStatus === 'valid' ? price?.dkk_per_kwh ?? null : null,
      priceValidUntil: decision.validUntil,
      futureBeyondPublishedPrice: Boolean(state.pricePolicy?.enabled) && at > knownAt && decision.priceStatus !== 'valid',
      ifEnabled: { selectedMode: ifEnabled.target, reason: ifEnabled.reason, baseMode: ifEnabled.baseMode },
      sevenDayPreview, ifEnabledPreview,
      nextKnownTransition: sevenDayPreview.nextKnownTransition, nextScheduleTransition: sevenDayPreview.nextScheduleTransition,
    };
  }

  async function loadRow(id: number) {
    const [row] = await db.select({ connection: hardwareConnections, policy: hardwarePowerPolicies })
      .from(hardwareConnections).leftJoin(hardwarePowerPolicies, eq(hardwareConnections.id, hardwarePowerPolicies.hardware_id))
      .where(and(eq(hardwareConnections.id, id), eq(hardwareConnections.lifecycle_state, 'active'))).limit(1);
    return row;
  }

  function previewAt(value: unknown): Date | null {
    const at = value === undefined ? now() : new Date(String(value));
    return Number.isFinite(at.getTime()) ? at : null;
  }

  router.get('/global', async (_req, res) => {
    try { res.json({ paused: await getSetting('power_automation_paused') === 'true' }); }
    catch (err) { res.status(500).json({ error: sanitizeError(err) }); }
  });

  router.post('/global/pause', requireRecentReauthentication, async (req, res) => {
    try {
      if (typeof req.body?.paused !== 'boolean') return res.status(400).json({ error: 'Paused must be a boolean' });
      await setSetting('power_automation_paused', req.body.paused ? 'true' : 'false');
      await logAudit(req, req.body.paused ? 'power_automation_paused' : 'power_automation_resumed');
      res.json({ paused: req.body.paused });
    } catch (err) { res.status(500).json({ error: sanitizeError(err) }); }
  });

  router.get('/:id/preview', async (req, res) => {
    try {
      const id = hardwareId(req.params.id);
      const at = previewAt(req.query.at);
      if (!at) return res.status(400).json({ error: 'Invalid preview time' });
      const row = await loadRow(id);
      if (!row?.policy) return res.status(404).json({ error: 'Saved power policy not found' });
      const state: DecisionState = {
        controlEnabled: row.connection.control_enabled, automationEnabled: row.policy.automation_enabled,
        paused: row.policy.paused || await getSetting('power_automation_paused') === 'true',
        driftHold: row.policy.drift_hold, supportedModes: supportedModesFrom(row.connection.capabilities),
        schedule: row.policy.schedule, pricePolicy: row.policy.price_policy, latch: row.policy.latch,
        manualOverride: storedManualOverride(row.policy.manual_mode, row.policy.manual_expires_at),
      };
      res.json({ ...await previewFor(state, row.policy.last_verified_mode, at), policyVersion: row.policy.version, draft: false });
    } catch (err) {
      const message = inputError(err);
      res.status(message ? 400 : 500).json({ error: message ?? sanitizeError(err) });
    }
  });

  // Draft preview: validates and evaluates an unsaved policy. Read-only; it
  // never stores, enables or contacts hardware.
  router.post('/:id/preview', async (req, res) => {
    try {
      const id = hardwareId(req.params.id);
      const at = previewAt(req.body?.at);
      if (!at) return res.status(400).json({ error: 'Invalid preview time' });
      const row = await loadRow(id);
      if (!row) return res.status(404).json({ error: 'Hardware connection not found' });
      const input = normalizePolicyBody(req.body);
      assertModesSupported(input, row.connection.capabilities);
      const samePrice = row.policy && sameContent(row.policy.price_policy, input.pricePolicy);
      input.pricePolicy.version = samePrice ? row.policy!.price_policy.version : (row.policy?.price_policy.version ?? 0) + 1;
      const state: DecisionState = {
        controlEnabled: row.connection.control_enabled, automationEnabled: input.automationEnabled,
        paused: Boolean(row.policy?.paused) || await getSetting('power_automation_paused') === 'true',
        driftHold: Boolean(row.policy?.drift_hold), supportedModes: supportedModesFrom(row.connection.capabilities),
        schedule: input.schedule, pricePolicy: input.pricePolicy, latch: samePrice ? row.policy?.latch ?? null : null,
        manualOverride: storedManualOverride(row.policy?.manual_mode, row.policy?.manual_expires_at),
      };
      res.json({ ...await previewFor(state, row.policy?.last_verified_mode, at), policyVersion: row.policy?.version ?? 0, draft: true });
    } catch (err) {
      const message = inputError(err);
      res.status(message ? 400 : 500).json({ error: message ?? sanitizeError(err) });
    }
  });

  router.get('/:id/operations', async (req, res) => {
    try {
      const id = hardwareId(req.params.id);
      const rows = await db.select({
        id: hardwarePowerOperations.id, actor: hardwarePowerOperations.actor, actor_user_id: hardwarePowerOperations.actor_user_id,
        prior_mode: hardwarePowerOperations.prior_mode, target_mode: hardwarePowerOperations.target_mode,
        reason: hardwarePowerOperations.reason, outcome: hardwarePowerOperations.outcome,
        error_category: hardwarePowerOperations.error_category, policy_version: hardwarePowerOperations.policy_version,
        config_version: hardwarePowerOperations.config_version, schedule_version: hardwarePowerOperations.schedule_version,
        price_policy_version: hardwarePowerOperations.price_policy_version, price_dkk_per_kwh: hardwarePowerOperations.price_dkk_per_kwh,
        price_start_utc: hardwarePowerOperations.price_start_utc, price_end_utc: hardwarePowerOperations.price_end_utc,
        price_source: hardwarePowerOperations.price_source, thresholds: hardwarePowerOperations.thresholds,
        occurred_at: hardwarePowerOperations.occurred_at, completed_at: hardwarePowerOperations.completed_at,
      }).from(hardwarePowerOperations).where(eq(hardwarePowerOperations.hardware_id, id))
        .orderBy(desc(hardwarePowerOperations.occurred_at), desc(hardwarePowerOperations.id)).limit(50);
      res.json({ operations: rows });
    } catch (err) {
      const message = inputError(err);
      res.status(message ? 400 : 500).json({ error: message ?? sanitizeError(err) });
    }
  });

  router.get('/:id', async (req, res) => {
    try {
      const id = hardwareId(req.params.id);
      await store.releaseExpiredClaim(id);
      const row = await loadRow(id);
      if (!row) return res.status(404).json({ error: 'Hardware connection not found' });
      res.json({
        hardwareId: id, controlEnabled: row.connection.control_enabled,
        capability: (row.connection.capabilities as any)?.runtimeMode ?? 'unsupported',
        supportedModes: supportedModesFrom(row.connection.capabilities),
        globalPaused: await getSetting('power_automation_paused') === 'true',
        policy: row.policy ? {
          automationEnabled: row.policy.automation_enabled, paused: row.policy.paused, driftHold: row.policy.drift_hold,
          driftHoldUntil: row.policy.drift_hold_until,
          schedule: row.policy.schedule, pricePolicy: row.policy.price_policy,
          version: row.policy.version, lastVerifiedMode: row.policy.last_verified_mode,
          lastOutcome: row.policy.last_outcome, lastOutcomeAt: row.policy.last_outcome_at, lastError: row.policy.last_error,
          failureCount: row.policy.failure_count, nextAttemptAt: row.policy.next_attempt_at,
          pendingTarget: row.policy.pending_target, actionInFlight: Boolean(row.policy.claim_token),
          manualMode: row.policy.manual_mode, manualExpiresAt: row.policy.manual_expires_at,
        } : { automationEnabled: false, paused: false, driftHold: false, driftHoldUntil: null,
          schedule: weekdayPreset(), pricePolicy: defaultPricePolicy(), version: 0,
          lastVerifiedMode: null, lastOutcome: null, lastOutcomeAt: null, lastError: null, failureCount: 0,
          nextAttemptAt: null, pendingTarget: null, actionInFlight: false, manualMode: null, manualExpiresAt: null },
      });
    } catch (err) {
      const message = inputError(err);
      res.status(message ? 400 : 500).json({ error: message ?? sanitizeError(err) });
    }
  });

  router.put('/:id', async (req, res) => {
    try {
      const id = hardwareId(req.params.id);
      const version = Number(req.body?.version);
      if (!Number.isSafeInteger(version) || version < 0) return res.status(400).json({ error: 'Policy version required' });
      const input = normalizePolicyBody(req.body);
      await store.releaseExpiredClaim(id);
      const result = await db.transaction(async (tx) => {
        const [connection] = await tx.select({ id: hardwareConnections.id, capabilities: hardwareConnections.capabilities }).from(hardwareConnections)
          .where(and(eq(hardwareConnections.id, id), eq(hardwareConnections.lifecycle_state, 'active'))).limit(1);
        if (!connection) return { status: 'missing' as const };
        assertModesSupported(input, connection.capabilities);
        const [existing] = await tx.select({ schedule: hardwarePowerPolicies.schedule, price_policy: hardwarePowerPolicies.price_policy })
          .from(hardwarePowerPolicies).where(eq(hardwarePowerPolicies.hardware_id, id)).limit(1);
        // Server-owned revisions: bump only when that part's content changed,
        // and reset the price latch only when the price policy changed.
        const sameSchedule = sameContent(existing?.schedule, input.schedule);
        const samePrice = sameContent(existing?.price_policy, input.pricePolicy);
        input.schedule.version = sameSchedule ? existing!.schedule.version : (existing?.schedule?.version ?? 0) + 1;
        input.pricePolicy.version = samePrice ? existing!.price_policy.version : (existing?.price_policy?.version ?? 0) + 1;
        if (version === 0) {
          const rows = await tx.insert(hardwarePowerPolicies).values({
            hardware_id: id, schedule: input.schedule, price_policy: input.pricePolicy,
            automation_enabled: input.automationEnabled,
          }).onConflictDoNothing().returning({ hardware_id: hardwarePowerPolicies.hardware_id });
          if (!rows.length) return { status: 'conflict' as const };
        } else {
          const rows = await tx.update(hardwarePowerPolicies).set({
            schedule: input.schedule, price_policy: input.pricePolicy,
            automation_enabled: input.automationEnabled, ...(samePrice ? {} : { latch: null }),
            version: version + 1, updated_at: new Date(),
          }).where(and(eq(hardwarePowerPolicies.hardware_id, id), eq(hardwarePowerPolicies.version, version), isNull(hardwarePowerPolicies.claim_token)))
            .returning({ hardware_id: hardwarePowerPolicies.hardware_id });
          if (!rows.length) return { status: 'conflict' as const };
        }
        await logAuditTx(tx, req, [{ action: 'hardware_power_policy_saved', target: String(id),
          detail: `version=${version + 1}; schedule_version=${input.schedule.version}; price_policy_version=${input.pricePolicy.version}; automation=${input.automationEnabled}` }]);
        return { status: 'saved' as const };
      });
      if (result.status === 'missing') return res.status(404).json({ error: 'Hardware connection not found' });
      if (result.status === 'conflict') return res.status(409).json({ error: 'Policy changed or an action is in flight' });
      res.json({ ok: true, version: version + 1, scheduleVersion: input.schedule.version, pricePolicyVersion: input.pricePolicy.version });
    } catch (err) {
      const message = inputError(err);
      res.status(message ? 400 : 500).json({ error: message ?? sanitizeError(err) });
    }
  });

  router.post('/:id/enable', requireRecentReauthentication, async (req, res) => {
    try {
      if (req.body?.acknowledgeLiveControl !== true) return res.status(400).json({ error: 'Explicit live-control acknowledgement required' });
      const id = hardwareId(req.params.id);
      await store.releaseExpiredClaim(id);
      const [policy] = await db.select({ hardware_id: hardwarePowerPolicies.hardware_id, claim_token: hardwarePowerPolicies.claim_token })
        .from(hardwarePowerPolicies).where(eq(hardwarePowerPolicies.hardware_id, id)).limit(1);
      if (!policy) return res.status(409).json({ error: 'Save a power policy first' });
      if (policy.claim_token) return res.status(409).json({ error: 'Power action in flight' });
      const [enabled] = await db.update(hardwareConnections)
        .set({ control_enabled: true, config_version: sql`${hardwareConnections.config_version} + 1`, updated_at: new Date() })
        .where(and(eq(hardwareConnections.id, id), eq(hardwareConnections.lifecycle_state, 'active'),
          eq(hardwareConnections.last_status, 'online'), sql`${hardwareConnections.system_uuid} IS NOT NULL`,
          sql`${hardwareConnections.capabilities}->>'runtimeMode' = 'supported'`))
        .returning({ id: hardwareConnections.id, config_version: hardwareConnections.config_version });
      if (!enabled) return res.status(409).json({ error: 'Hardware needs a successful capability test before control can be enabled' });
      await logAudit(req, 'hardware_power_control_enabled', String(id), `config_version=${enabled.config_version}`);
      res.json({ controlEnabled: true });
    } catch (err) { res.status(500).json({ error: sanitizeError(err) }); }
  });

  router.post('/:id/disable', async (req, res) => {
    try {
      const id = hardwareId(req.params.id);
      const [disabled] = await db.update(hardwareConnections)
        .set({ control_enabled: false, config_version: sql`${hardwareConnections.config_version} + 1`, updated_at: new Date() })
        .where(and(eq(hardwareConnections.id, id), eq(hardwareConnections.lifecycle_state, 'active')))
        .returning({ id: hardwareConnections.id, config_version: hardwareConnections.config_version });
      if (!disabled) return res.status(404).json({ error: 'Hardware connection not found' });
      await logAudit(req, 'hardware_power_control_disabled', String(id), `config_version=${disabled.config_version}`);
      res.json({ controlEnabled: false });
    } catch (err) { res.status(500).json({ error: sanitizeError(err) }); }
  });

  router.post('/:id/pause', async (req, res) => {
    try {
      const id = hardwareId(req.params.id);
      if (typeof req.body?.paused !== 'boolean' || !Number.isSafeInteger(req.body?.version)) return res.status(400).json({ error: 'Paused and policy version required' });
      await store.releaseExpiredClaim(id);
      const [row] = await db.update(hardwarePowerPolicies).set({
        paused: req.body.paused, version: req.body.version + 1, updated_at: new Date(),
      }).where(and(eq(hardwarePowerPolicies.hardware_id, id), eq(hardwarePowerPolicies.version, req.body.version), isNull(hardwarePowerPolicies.claim_token)))
        .returning({ hardware_id: hardwarePowerPolicies.hardware_id });
      if (!row) return res.status(409).json({ error: 'Policy changed or a hardware action is in flight' });
      await logAudit(req, req.body.paused ? 'hardware_power_paused' : 'hardware_power_resumed', String(id), `version=${req.body.version + 1}`);
      res.json({ paused: req.body.paused, version: req.body.version + 1 });
    } catch (err) { res.status(500).json({ error: sanitizeError(err) }); }
  });

  // Resume after external drift adopts a FRESH read of the actual mode as the
  // verified baseline (otherwise the next tick re-detects the same drift).
  // OS Control/unknown/off hosts cannot be resumed until the operator fixes them.
  router.post('/:id/resume-drift', async (req, res) => {
    try {
      const id = hardwareId(req.params.id);
      const version = Number(req.body?.version);
      if (!Number.isSafeInteger(version) || version < 1) return res.status(400).json({ error: 'Policy version required' });
      await store.releaseExpiredClaim(id);
      const row = await loadRow(id);
      if (!row?.policy) return res.status(404).json({ error: 'Saved power policy not found' });
      if (row.policy.version !== version || row.policy.claim_token) return res.status(409).json({ error: 'Policy changed or a hardware action is in flight' });
      let state: RuntimeState;
      try {
        state = await readState({ host: row.connection.target_host, port: row.connection.target_port, username: row.connection.username,
          password: decryptSecret(row.connection.secret), verifyTls: row.connection.verify_tls, caCertificate: row.connection.ca_certificate });
      } catch (err) {
        return res.status(503).json({ error: 'Could not read the current iLO mode; the hold stays in place',
          code: err instanceof IloError ? err.code : 'unavailable' });
      }
      if (state.powerState !== 'on') return res.status(409).json({ error: 'Host is not powered on and running; the hold stays in place' });
      if (state.mode === 'os_control' || state.mode === 'unknown') {
        return res.status(409).json({ error: 'iLO reports OS Control or an unknown mode. Resolve it on the server before resuming.' });
      }
      const [updated] = await db.update(hardwarePowerPolicies).set({
        drift_hold: false, drift_hold_until: null, last_verified_mode: state.mode, last_outcome: 'drift_resumed',
        last_outcome_at: new Date(), version: version + 1, updated_at: new Date(),
      }).where(and(eq(hardwarePowerPolicies.hardware_id, id), eq(hardwarePowerPolicies.version, version), isNull(hardwarePowerPolicies.claim_token)))
        .returning({ hardware_id: hardwarePowerPolicies.hardware_id });
      if (!updated) return res.status(409).json({ error: 'Policy changed or a hardware action is in flight' });
      await logAudit(req, 'hardware_power_drift_resumed', String(id), `version=${version + 1}; adopted_mode=${state.mode}`);
      res.json({ driftHold: false, version: version + 1, adoptedMode: state.mode });
    } catch (err) { res.status(500).json({ error: sanitizeError(err) }); }
  });

  router.post('/:id/manual', requireRecentReauthentication, async (req, res) => {
    try {
      const id = hardwareId(req.params.id);
      const version = Number(req.body?.version);
      const mode = req.body?.mode;
      if (!Number.isSafeInteger(version) || version < 1 || !isWritablePowerMode(mode)) {
        return res.status(400).json({ error: 'Valid mode, policy version and duration required' });
      }
      await store.releaseExpiredClaim(id);
      const [connection] = await db.select({ control_enabled: hardwareConnections.control_enabled, capabilities: hardwareConnections.capabilities })
        .from(hardwareConnections).where(and(eq(hardwareConnections.id, id), eq(hardwareConnections.lifecycle_state, 'active'))).limit(1);
      if (!connection?.control_enabled) return res.status(409).json({ error: 'Live iLO control must be enabled first' });
      if (!supportedModesFrom(connection.capabilities).includes(mode)) return res.status(400).json({ error: `Unsupported mode for this hardware: ${mode}` });
      const [policy] = await db.select({ schedule: hardwarePowerPolicies.schedule })
        .from(hardwarePowerPolicies).where(and(eq(hardwarePowerPolicies.hardware_id, id), eq(hardwarePowerPolicies.version, version))).limit(1);
      if (!policy) return res.status(409).json({ error: 'Policy changed' });
      const expiresAt = resolveManualExpiry(req.body, policy.schedule, now());
      const [row] = await db.update(hardwarePowerPolicies).set({
        manual_mode: mode, manual_expires_at: expiresAt, version: version + 1, updated_at: new Date(),
      }).where(and(eq(hardwarePowerPolicies.hardware_id, id), eq(hardwarePowerPolicies.version, version), isNull(hardwarePowerPolicies.claim_token)))
        .returning({ hardware_id: hardwarePowerPolicies.hardware_id });
      if (!row) return res.status(409).json({ error: 'Policy changed or a hardware action is in flight' });
      await logAudit(req, 'hardware_power_manual_requested', String(id), `mode=${mode}; expires=${expiresAt?.toISOString() || 'until_cleared'}; version=${version + 1}`);
      const result = await manualController.reconcile(id, { manual: true, actorUserId: Number.isSafeInteger(req.session?.userId) ? req.session.userId : null });
      res.json({ mode, expiresAt, result, version: version + 1 });
    } catch (err) {
      if (err instanceof Error && (err.message.startsWith('Invalid manual override') || err.message.startsWith('Enable a weekly schedule')
        || err.message.startsWith('No next weekly schedule'))) return res.status(400).json({ error: err.message });
      res.status(500).json({ error: sanitizeError(err) });
    }
  });

  router.delete('/:id/manual', async (req, res) => {
    try {
      const id = hardwareId(req.params.id);
      const version = Number(req.body?.version);
      if (!Number.isSafeInteger(version) || version < 1) return res.status(400).json({ error: 'Policy version required' });
      await store.releaseExpiredClaim(id);
      const [row] = await db.update(hardwarePowerPolicies).set({
        manual_mode: null, manual_expires_at: null, version: version + 1, updated_at: new Date(),
      }).where(and(eq(hardwarePowerPolicies.hardware_id, id), eq(hardwarePowerPolicies.version, version), isNull(hardwarePowerPolicies.claim_token)))
        .returning({ hardware_id: hardwarePowerPolicies.hardware_id });
      if (!row) return res.status(409).json({ error: 'Policy changed or a hardware action is in flight' });
      await logAudit(req, 'hardware_power_manual_cleared', String(id), `version=${version + 1}`);
      res.json({ ok: true, version: version + 1 });
    } catch (err) { res.status(500).json({ error: sanitizeError(err) }); }
  });

  return router;
}

export default createPowerControlRouter();
