import { Router } from 'express';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { hardwareConnections, hardwarePowerPolicies } from '../db/schema/index.ts';
import { getSetting, setSetting } from '../db/settings.ts';
import { requireAuth, requireAdmin, requireInteractiveSession, requireRecentReauthentication } from '../middleware/auth.ts';
import { resolvePowerDecision, validatePowerSchedule, validatePricePolicy, weekdayPreset, type ApplicablePowerPrice, type PowerPricePolicy, type WeeklyPowerSchedule, type WritablePowerMode } from '../services/powerPolicy.ts';
import { getApplicablePrice } from '../services/electricityPricing.ts';
import { logAudit, logAuditTx } from '../utils/audit.ts';
import { sanitizeError } from '../utils/sanitize.ts';
import { PowerController } from '../services/powerController.ts';
import { PowerControlStore } from '../services/powerControlStore.ts';

const router = Router();
router.use(requireAuth, requireAdmin, requireInteractiveSession);
const manualController = new PowerController({ repository: new PowerControlStore(), getApplicablePrice: async () => null });

function hardwareId(value: string): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid hardware ID');
  return id;
}

function defaultPricePolicy(): PowerPricePolicy {
  return {
    enabled: false, basis: 'variable_retail_including_vat', contractRef: '', area: '', priceOnlyDefault: 'low', minAutomaticUpshiftMinutes: 5,
    expensive: { enabled: false, threshold: '', hysteresis: '', capMode: 'dynamic' },
    cheap: { enabled: false, threshold: '', hysteresis: '' }, version: 1,
  };
}

function policyInput(body: any): { schedule: WeeklyPowerSchedule; pricePolicy: PowerPricePolicy; automationEnabled: boolean } {
  if (!body || typeof body !== 'object' || typeof body.automationEnabled !== 'boolean') throw new Error('Invalid power policy');
  const schedule = body.schedule as WeeklyPowerSchedule;
  const pricePolicy = body.pricePolicy as PowerPricePolicy;
  if (!schedule || !Array.isArray(schedule.windows) || !pricePolicy || !pricePolicy.expensive || !pricePolicy.cheap) throw new Error('Invalid power policy');
  validatePowerSchedule(schedule);
  validatePricePolicy(pricePolicy);
  if (body.automationEnabled && !schedule.enabled && !pricePolicy.enabled) throw new Error('Enable a schedule or price policy first');
  if (pricePolicy.enabled && !schedule.enabled && !pricePolicy.priceOnlyDefault) throw new Error('Price-only automation requires a default mode');
  return { schedule, pricePolicy, automationEnabled: body.automationEnabled };
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
    const at = req.query.at === undefined ? new Date() : new Date(String(req.query.at));
    if (!Number.isFinite(at.getTime())) return res.status(400).json({ error: 'Invalid preview time' });
    const [row] = await db.select({ connection: hardwareConnections, policy: hardwarePowerPolicies })
      .from(hardwareConnections).leftJoin(hardwarePowerPolicies, eq(hardwareConnections.id, hardwarePowerPolicies.hardware_id))
      .where(and(eq(hardwareConnections.id, id), eq(hardwareConnections.lifecycle_state, 'active'))).limit(1);
    if (!row?.policy) return res.status(404).json({ error: 'Saved power policy not found' });
    const capabilities = row.connection.capabilities as { runtimeMode?: string; supportedModes?: string[] } | null;
    const supportedModes = (capabilities?.runtimeMode === 'supported' ? capabilities.supportedModes ?? ['low', 'dynamic', 'high'] : [])
      .filter((mode): mode is WritablePowerMode => ['low', 'dynamic', 'high'].includes(mode));
    const applicable = row.policy.price_policy.enabled ? await getApplicablePrice(at, row.policy.price_policy) : null;
    const price = applicable?.status === 'valid' && applicable.dkk_per_kwh && applicable.start_utc && applicable.end_utc
      ? applicable as ApplicablePowerPrice : null;
    const manualActive = row.policy.manual_mode && (!row.policy.manual_expires_at || row.policy.manual_expires_at > at);
    const observed = row.policy.last_verified_mode;
    const actualMode = ['low', 'dynamic', 'high', 'os_control'].includes(observed || '')
      ? observed as 'low' | 'dynamic' | 'high' | 'os_control' : 'unknown';
    const decision = resolvePowerDecision({ now: at, actualMode, supportedModes,
      controlEnabled: row.connection.control_enabled && (row.policy.automation_enabled || Boolean(manualActive)),
      automationPaused: row.policy.paused || await getSetting('power_automation_paused') === 'true',
      driftHold: row.policy.drift_hold, schedule: row.policy.schedule, pricePolicy: row.policy.price_policy,
      price, previousLatch: row.policy.latch,
      manualOverride: manualActive ? { mode: row.policy.manual_mode as WritablePowerMode, expiresAt: row.policy.manual_expires_at } : null,
      manualAction: Boolean(manualActive),
    });
    res.json({ at, observedMode: actualMode, policyVersion: row.policy.version,
      baseMode: decision.baseMode, selectedMode: decision.target, reason: decision.reason,
      priceStatus: decision.priceStatus, priceDkkPerKwh: price?.dkk_per_kwh ?? null,
      priceValidUntil: decision.validUntil, futureBeyondPublishedPrice: row.policy.price_policy.enabled && at > new Date() && decision.priceStatus !== 'valid' });
  } catch (err) { res.status(500).json({ error: sanitizeError(err) }); }
});

router.get('/:id', async (req, res) => {
  try {
    const id = hardwareId(req.params.id);
    const [row] = await db.select({ connection: hardwareConnections, policy: hardwarePowerPolicies })
      .from(hardwareConnections).leftJoin(hardwarePowerPolicies, eq(hardwareConnections.id, hardwarePowerPolicies.hardware_id))
      .where(and(eq(hardwareConnections.id, id), eq(hardwareConnections.lifecycle_state, 'active'))).limit(1);
    if (!row) return res.status(404).json({ error: 'Hardware connection not found' });
    res.json({
      hardwareId: id, controlEnabled: row.connection.control_enabled,
      capability: (row.connection.capabilities as any)?.runtimeMode ?? 'unsupported',
      globalPaused: await getSetting('power_automation_paused') === 'true',
      policy: row.policy ? {
        automationEnabled: row.policy.automation_enabled, paused: row.policy.paused, driftHold: row.policy.drift_hold,
        schedule: row.policy.schedule, pricePolicy: row.policy.price_policy,
        version: row.policy.version, lastVerifiedMode: row.policy.last_verified_mode,
        lastOutcome: row.policy.last_outcome, manualMode: row.policy.manual_mode,
        manualExpiresAt: row.policy.manual_expires_at,
      } : { automationEnabled: false, paused: false, driftHold: false,
        schedule: weekdayPreset(), pricePolicy: defaultPricePolicy(), version: 0,
        lastVerifiedMode: null, lastOutcome: null, manualMode: null, manualExpiresAt: null },
    });
  } catch (err) {
    res.status(err instanceof Error && err.message === 'Invalid hardware ID' ? 400 : 500)
      .json({ error: err instanceof Error && err.message === 'Invalid hardware ID' ? err.message : sanitizeError(err) });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const id = hardwareId(req.params.id);
    const version = Number(req.body?.version);
    if (!Number.isSafeInteger(version) || version < 0) return res.status(400).json({ error: 'Policy version required' });
    const input = policyInput(req.body);
    const result = await db.transaction(async (tx) => {
      const [connection] = await tx.select({ id: hardwareConnections.id }).from(hardwareConnections)
        .where(and(eq(hardwareConnections.id, id), eq(hardwareConnections.lifecycle_state, 'active'))).limit(1);
      if (!connection) return 'missing';
      if (version === 0) {
        const rows = await tx.insert(hardwarePowerPolicies).values({
          hardware_id: id, schedule: input.schedule, price_policy: input.pricePolicy,
          automation_enabled: input.automationEnabled,
        }).onConflictDoNothing().returning({ hardware_id: hardwarePowerPolicies.hardware_id });
        if (!rows.length) return 'conflict';
      } else {
        const rows = await tx.update(hardwarePowerPolicies).set({
          schedule: input.schedule, price_policy: input.pricePolicy,
          automation_enabled: input.automationEnabled, latch: null, version: version + 1, updated_at: new Date(),
        }).where(and(eq(hardwarePowerPolicies.hardware_id, id), eq(hardwarePowerPolicies.version, version), isNull(hardwarePowerPolicies.claim_token)))
          .returning({ hardware_id: hardwarePowerPolicies.hardware_id });
        if (!rows.length) return 'conflict';
      }
      await logAuditTx(tx, req, [{ action: 'hardware_power_policy_saved', target: String(id), detail: `version=${version + 1}` }]);
      return 'saved';
    });
    if (result === 'missing') return res.status(404).json({ error: 'Hardware connection not found' });
    if (result === 'conflict') return res.status(409).json({ error: 'Policy changed or an action is in flight' });
    res.json({ ok: true, version: version + 1 });
  } catch (err) {
    if (err instanceof Error && (err.message.startsWith('Invalid') || err.message.startsWith('Enable') || err.message.startsWith('Price-'))) return res.status(400).json({ error: err.message });
    res.status(500).json({ error: sanitizeError(err) });
  }
});

router.post('/:id/enable', requireRecentReauthentication, async (req, res) => {
  try {
    if (req.body?.acknowledgeLiveControl !== true) return res.status(400).json({ error: 'Explicit live-control acknowledgement required' });
    const id = hardwareId(req.params.id);
    const [policy] = await db.select({ hardware_id: hardwarePowerPolicies.hardware_id, claim_token: hardwarePowerPolicies.claim_token })
      .from(hardwarePowerPolicies).where(eq(hardwarePowerPolicies.hardware_id, id)).limit(1);
    if (!policy) return res.status(409).json({ error: 'Save a power policy first' });
    if (policy.claim_token) return res.status(409).json({ error: 'Power action in flight' });
    const [enabled] = await db.update(hardwareConnections)
      .set({ control_enabled: true, config_version: sql`${hardwareConnections.config_version} + 1`, updated_at: new Date() })
      .where(and(eq(hardwareConnections.id, id), eq(hardwareConnections.lifecycle_state, 'active'),
        eq(hardwareConnections.last_status, 'online'), sql`${hardwareConnections.system_uuid} IS NOT NULL`,
        sql`${hardwareConnections.capabilities}->>'runtimeMode' = 'supported'`))
      .returning({ id: hardwareConnections.id });
    if (!enabled) return res.status(409).json({ error: 'Hardware needs a successful capability test before control can be enabled' });
    await logAudit(req, 'hardware_power_control_enabled', String(id));
    res.json({ controlEnabled: true });
  } catch (err) { res.status(500).json({ error: sanitizeError(err) }); }
});

router.post('/:id/disable', async (req, res) => {
  try {
    const id = hardwareId(req.params.id);
    const [disabled] = await db.update(hardwareConnections)
      .set({ control_enabled: false, config_version: sql`${hardwareConnections.config_version} + 1`, updated_at: new Date() })
      .where(and(eq(hardwareConnections.id, id), eq(hardwareConnections.lifecycle_state, 'active')))
      .returning({ id: hardwareConnections.id });
    if (!disabled) return res.status(404).json({ error: 'Hardware connection not found' });
    await logAudit(req, 'hardware_power_control_disabled', String(id));
    res.json({ controlEnabled: false });
  } catch (err) { res.status(500).json({ error: sanitizeError(err) }); }
});

router.post('/:id/pause', async (req, res) => {
  try {
    const id = hardwareId(req.params.id);
    if (typeof req.body?.paused !== 'boolean' || !Number.isSafeInteger(req.body?.version)) return res.status(400).json({ error: 'Paused and policy version required' });
    const [row] = await db.update(hardwarePowerPolicies).set({
      paused: req.body.paused, version: req.body.version + 1, updated_at: new Date(),
    }).where(and(eq(hardwarePowerPolicies.hardware_id, id), eq(hardwarePowerPolicies.version, req.body.version), isNull(hardwarePowerPolicies.claim_token)))
      .returning({ hardware_id: hardwarePowerPolicies.hardware_id });
    if (!row) return res.status(409).json({ error: 'Policy changed or a hardware action is in flight' });
    await logAudit(req, req.body.paused ? 'hardware_power_paused' : 'hardware_power_resumed', String(id));
    res.json({ paused: req.body.paused, version: req.body.version + 1 });
  } catch (err) { res.status(500).json({ error: sanitizeError(err) }); }
});

router.post('/:id/resume-drift', async (req, res) => {
  try {
    const id = hardwareId(req.params.id);
    const version = Number(req.body?.version);
    if (!Number.isSafeInteger(version) || version < 1) return res.status(400).json({ error: 'Policy version required' });
    const [row] = await db.update(hardwarePowerPolicies).set({
      drift_hold: false, version: version + 1, updated_at: new Date(),
    }).where(and(eq(hardwarePowerPolicies.hardware_id, id), eq(hardwarePowerPolicies.version, version), isNull(hardwarePowerPolicies.claim_token)))
      .returning({ hardware_id: hardwarePowerPolicies.hardware_id });
    if (!row) return res.status(409).json({ error: 'Policy changed or a hardware action is in flight' });
    await logAudit(req, 'hardware_power_drift_resumed', String(id));
    res.json({ driftHold: false, version: version + 1 });
  } catch (err) { res.status(500).json({ error: sanitizeError(err) }); }
});

router.post('/:id/manual', requireRecentReauthentication, async (req, res) => {
  try {
    const id = hardwareId(req.params.id);
    const version = Number(req.body?.version);
    const mode = req.body?.mode;
    const untilCleared = req.body?.untilCleared === true;
    const minutes = req.body?.durationMinutes == null ? 180 : Number(req.body.durationMinutes);
    if (!Number.isSafeInteger(version) || version < 1 || !['low', 'dynamic', 'high'].includes(mode)
      || (!untilCleared && (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440))) {
      return res.status(400).json({ error: 'Valid mode, policy version and duration required' });
    }
    const [connection] = await db.select({ control_enabled: hardwareConnections.control_enabled })
      .from(hardwareConnections).where(and(eq(hardwareConnections.id, id), eq(hardwareConnections.lifecycle_state, 'active'))).limit(1);
    if (!connection?.control_enabled) return res.status(409).json({ error: 'Live iLO control must be enabled first' });
    const expiresAt = untilCleared ? null : new Date(Date.now() + minutes * 60_000);
    const [row] = await db.update(hardwarePowerPolicies).set({
      manual_mode: mode, manual_expires_at: expiresAt, version: version + 1, updated_at: new Date(),
    }).where(and(eq(hardwarePowerPolicies.hardware_id, id), eq(hardwarePowerPolicies.version, version), isNull(hardwarePowerPolicies.claim_token)))
      .returning({ hardware_id: hardwarePowerPolicies.hardware_id });
    if (!row) return res.status(409).json({ error: 'Policy changed or a hardware action is in flight' });
    await logAudit(req, 'hardware_power_manual_requested', String(id), `mode=${mode}; expires=${expiresAt?.toISOString() || 'until_cleared'}`);
    const result = await manualController.reconcile(id, { manual: true });
    res.json({ mode, expiresAt, result });
  } catch (err) { res.status(500).json({ error: sanitizeError(err) }); }
});

router.delete('/:id/manual', async (req, res) => {
  try {
    const id = hardwareId(req.params.id);
    const version = Number(req.body?.version);
    if (!Number.isSafeInteger(version) || version < 1) return res.status(400).json({ error: 'Policy version required' });
    const [row] = await db.update(hardwarePowerPolicies).set({
      manual_mode: null, manual_expires_at: null, version: version + 1, updated_at: new Date(),
    }).where(and(eq(hardwarePowerPolicies.hardware_id, id), eq(hardwarePowerPolicies.version, version), isNull(hardwarePowerPolicies.claim_token)))
      .returning({ hardware_id: hardwarePowerPolicies.hardware_id });
    if (!row) return res.status(409).json({ error: 'Policy changed or a hardware action is in flight' });
    await logAudit(req, 'hardware_power_manual_cleared', String(id));
    res.json({ ok: true, version: version + 1 });
  } catch (err) { res.status(500).json({ error: sanitizeError(err) }); }
});

export default router;
