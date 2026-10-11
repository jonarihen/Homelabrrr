import { and, desc, eq, gt, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { hardwareConnections, hardwarePowerOperations, hardwarePowerPolicies } from '../db/schema/index.ts';
import { decryptSecret } from '../utils/secrets.ts';
import { getSetting } from '../db/settings.ts';
import { log } from '../utils/logger.ts';
import { notify as sendNotification, type NotifyPayload } from '../utils/notify.ts';
import type { HardwareMode } from './iloAdapter.ts';
import { isWritablePowerMode, type PowerDecision } from './powerPolicy.ts';
import { storedManualOverride, supportedModesFrom } from './powerDecisionContext.ts';
import type { ClaimOutcome, ControlRepository, ControlSnapshot, ObservationNote } from './powerController.ts';

// After this many consecutive failed/unknown/unreadable attempts one
// notification is sent; the next one only follows a verified recovery.
export const FAILURE_NOTIFY_THRESHOLD = 3;

// 1, 2, 4 … minutes, capped at one hour, so an unreachable or refusing iLO is
// not re-read or re-PATCHed every tick.
export function failureBackoffMs(failureCount: number): number {
  return Math.min(60, 2 ** Math.max(0, failureCount - 1)) * 60_000;
}

const READ_PROBLEMS = ['read_failed', 'host_not_running', 'policy_invalid'];

type Notifier = (eventType: string, payload: NotifyPayload) => Promise<void>;

export interface PowerControlStoreOptions {
  now?: () => Date;
  notify?: Notifier;
}

export class PowerControlStore implements ControlRepository {
  private readonly now: () => Date;
  private readonly notifier: Notifier;

  constructor(options: PowerControlStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.notifier = options.notify ?? sendNotification;
  }

  private notify(eventType: string, hardwareId: number, detail: string) {
    // Best effort and deduplicated by failure_notified_at; never blocks control.
    this.notifier(eventType, { domain: `Hardware connection #${hardwareId}`, detail })
      .catch((err) => log('warn', 'power_control_notify_failed', { hardwareId, error: err }));
  }

  async load(hardwareId: number): Promise<ControlSnapshot | null> {
    const [joined] = await db.select({ connection: hardwareConnections, policy: hardwarePowerPolicies })
      .from(hardwareConnections)
      .innerJoin(hardwarePowerPolicies, eq(hardwareConnections.id, hardwarePowerPolicies.hardware_id))
      .where(and(eq(hardwareConnections.id, hardwareId), eq(hardwareConnections.lifecycle_state, 'active')))
      .limit(1);
    if (!joined) return null;
    const { connection, policy } = joined;
    const [lastUpshift] = await db.select({ occurred_at: hardwarePowerOperations.occurred_at })
      .from(hardwarePowerOperations)
      .where(and(eq(hardwarePowerOperations.hardware_id, hardwareId), eq(hardwarePowerOperations.actor, 'automation'),
        eq(hardwarePowerOperations.outcome, 'verified'),
        sql`CASE ${hardwarePowerOperations.target_mode} WHEN 'high' THEN 2 WHEN 'dynamic' THEN 1 ELSE 0 END
          > CASE ${hardwarePowerOperations.prior_mode} WHEN 'high' THEN 2 WHEN 'dynamic' THEN 1 ELSE 0 END`))
      .orderBy(desc(hardwarePowerOperations.occurred_at)).limit(1);
    return {
      hardwareId,
      configVersion: connection.config_version,
      policyVersion: policy.version,
      controlEnabled: connection.control_enabled,
      automationEnabled: policy.automation_enabled,
      paused: policy.paused || await getSetting('power_automation_paused') === 'true',
      driftHold: policy.drift_hold,
      driftHoldUntil: policy.drift_hold_until,
      supportedModes: supportedModesFrom(connection.capabilities),
      schedule: policy.schedule,
      pricePolicy: policy.price_policy,
      latch: policy.latch,
      manualOverride: storedManualOverride(policy.manual_mode, policy.manual_expires_at),
      lastVerifiedMode: (policy.last_verified_mode as HardwareMode | null) ?? null,
      lastAutomaticUpshiftAt: lastUpshift?.occurred_at ?? null,
      failureCount: policy.failure_count,
      nextAttemptAt: policy.next_attempt_at,
      pendingTarget: isWritablePowerMode(policy.pending_target) ? policy.pending_target : null,
      pendingOperationId: policy.pending_operation_id,
      ilo: {
        host: connection.target_host, port: connection.target_port, username: connection.username,
        password: decryptSecret(connection.secret), verifyTls: connection.verify_tls,
        caCertificate: connection.ca_certificate, tlsFingerprint: connection.tls_fingerprint,
      },
    };
  }

  // A lease whose holder crashed (or a restored backup taken mid-operation)
  // must not block edits forever. If its "requested" row exists, the PATCH
  // may have left: that row becomes unknown and the target pending, verified
  // read-only on the next tick. Without one nothing was dispatched.
  async releaseExpiredClaim(hardwareId: number): Promise<void> {
    const now = this.now();
    await db.transaction(async (tx) => {
      const [row] = await tx.select({ claim_token: hardwarePowerPolicies.claim_token, version: hardwarePowerPolicies.version })
        .from(hardwarePowerPolicies)
        .where(and(eq(hardwarePowerPolicies.hardware_id, hardwareId), isNotNull(hardwarePowerPolicies.claim_token),
          lt(hardwarePowerPolicies.claim_expires_at, now)))
        .for('update').limit(1);
      if (!row?.claim_token) return;
      const [requested] = await tx.update(hardwarePowerOperations)
        .set({ outcome: 'unknown', error_category: 'abandoned_claim', completed_at: now })
        .where(and(eq(hardwarePowerOperations.hardware_id, hardwareId), eq(hardwarePowerOperations.claim_token, row.claim_token),
          eq(hardwarePowerOperations.outcome, 'requested')))
        .returning({ id: hardwarePowerOperations.id, target_mode: hardwarePowerOperations.target_mode });
      if (!requested) {
        await tx.insert(hardwarePowerOperations).values({
          hardware_id: hardwareId, actor: 'automation', reason: 'abandoned_claim', outcome: 'unknown',
          policy_version: row.version, claim_token: row.claim_token,
          error_category: 'abandoned_claim_before_dispatch', completed_at: now, occurred_at: now,
        });
      }
      await tx.update(hardwarePowerPolicies).set({
        claim_token: null, claim_expires_at: null, last_outcome: 'unknown', last_outcome_at: now,
        last_error: requested ? 'abandoned_claim' : 'abandoned_claim_before_dispatch',
        ...(requested && isWritablePowerMode(requested.target_mode)
          ? { pending_target: requested.target_mode, pending_operation_id: requested.id, next_attempt_at: null } : {}),
        updated_at: now,
      }).where(and(eq(hardwarePowerPolicies.hardware_id, hardwareId), eq(hardwarePowerPolicies.claim_token, row.claim_token)));
    });
  }

  async releaseExpiredClaims(): Promise<number> {
    const rows = await db.select({ id: hardwarePowerPolicies.hardware_id }).from(hardwarePowerPolicies)
      .where(and(isNotNull(hardwarePowerPolicies.claim_token), lt(hardwarePowerPolicies.claim_expires_at, this.now())));
    for (const row of rows) await this.releaseExpiredClaim(row.id);
    return rows.length;
  }

  async claim(snapshot: ControlSnapshot, token: string, expiresAt: Date): Promise<boolean> {
    const rows = await db.update(hardwarePowerPolicies)
      .set({ claim_token: token, claim_expires_at: expiresAt })
      .where(and(eq(hardwarePowerPolicies.hardware_id, snapshot.hardwareId),
        eq(hardwarePowerPolicies.version, snapshot.policyVersion),
        isNull(hardwarePowerPolicies.claim_token),
        sql`EXISTS (SELECT 1 FROM hardware_connections h WHERE h.id = ${snapshot.hardwareId}
          AND h.config_version = ${snapshot.configVersion} AND h.lifecycle_state = 'active'
          AND h.control_enabled = true)`))
      .returning({ hardware_id: hardwarePowerPolicies.hardware_id });
    return rows.length === 1;
  }

  async renewClaim(hardwareId: number, token: string, expiresAt: Date): Promise<boolean> {
    const rows = await db.update(hardwarePowerPolicies).set({ claim_expires_at: expiresAt })
      .where(and(eq(hardwarePowerPolicies.hardware_id, hardwareId), eq(hardwarePowerPolicies.claim_token, token),
        gt(hardwarePowerPolicies.claim_expires_at, this.now())))
      .returning({ hardware_id: hardwarePowerPolicies.hardware_id });
    return rows.length === 1;
  }

  async claimStillCurrent(snapshot: ControlSnapshot, token: string, manual = false): Promise<boolean> {
    if (!manual && await getSetting('power_automation_paused') === 'true') return false;
    const [row] = await db.select({
      claim_token: hardwarePowerPolicies.claim_token,
      claim_expires_at: hardwarePowerPolicies.claim_expires_at,
      version: hardwarePowerPolicies.version,
      automation_enabled: hardwarePowerPolicies.automation_enabled,
      config_version: hardwareConnections.config_version,
      control_enabled: hardwareConnections.control_enabled,
      lifecycle_state: hardwareConnections.lifecycle_state,
    }).from(hardwarePowerPolicies)
      .innerJoin(hardwareConnections, eq(hardwareConnections.id, hardwarePowerPolicies.hardware_id))
      .where(eq(hardwarePowerPolicies.hardware_id, snapshot.hardwareId)).limit(1);
    return Boolean(row && row.claim_token === token && row.claim_expires_at
      && row.claim_expires_at.getTime() > this.now().getTime()
      && row.version === snapshot.policyVersion && row.config_version === snapshot.configVersion
      && (manual || row.automation_enabled) && row.control_enabled && row.lifecycle_state === 'active');
  }

  private operationValues(hardwareId: number, token: string, outcome: ClaimOutcome) {
    const audit = outcome.audit;
    return {
      hardware_id: hardwareId, actor: outcome.actor, actor_user_id: outcome.actorUserId ?? null,
      prior_mode: outcome.prior, target_mode: outcome.target, reason: outcome.decision.reason,
      policy_version: audit?.policyVersion ?? outcome.decision.latch.policyVersion,
      price_revision: outcome.decision.priceStatus === 'valid' ? outcome.decision.latch.priceRevision || null : null,
      config_version: audit?.configVersion ?? null,
      schedule_version: audit?.scheduleVersion ?? null,
      price_policy_version: audit?.pricePolicyVersion ?? null,
      price_dkk_per_kwh: audit?.price?.dkkPerKwh ?? null,
      price_start_utc: audit?.price ? new Date(audit.price.startUtc) : null,
      price_end_utc: audit?.price ? new Date(audit.price.endUtc) : null,
      price_source: audit?.price?.source ?? null,
      thresholds: audit?.thresholds ?? null,
      claim_token: token,
    };
  }

  // The "requested" row commits, with a renewed lease, before the PATCH is
  // sent. It is the documented point after which a request cannot be recalled.
  async recordRequested(hardwareId: number, token: string, outcome: ClaimOutcome, leaseUntil: Date): Promise<number | null> {
    const now = this.now();
    return db.transaction(async (tx) => {
      const [held] = await tx.update(hardwarePowerPolicies).set({ claim_expires_at: leaseUntil })
        .where(and(eq(hardwarePowerPolicies.hardware_id, hardwareId), eq(hardwarePowerPolicies.claim_token, token),
          gt(hardwarePowerPolicies.claim_expires_at, now)))
        .returning({ hardware_id: hardwarePowerPolicies.hardware_id });
      if (!held) return null;
      const [row] = await tx.insert(hardwarePowerOperations)
        .values({ ...this.operationValues(hardwareId, token, outcome), outcome: 'requested', occurred_at: now })
        .returning({ id: hardwarePowerOperations.id });
      return row.id;
    });
  }

  // Always records the operation, even when the lease was lost meanwhile;
  // policy state changes only while this token still holds the lease.
  async finish(hardwareId: number, token: string, outcome: ClaimOutcome): Promise<void> {
    const now = this.now();
    const events = await db.transaction(async (tx) => {
      const [current] = await tx.select({
        claim_token: hardwarePowerPolicies.claim_token, failure_count: hardwarePowerPolicies.failure_count,
        failure_notified_at: hardwarePowerPolicies.failure_notified_at,
      }).from(hardwarePowerPolicies).where(eq(hardwarePowerPolicies.hardware_id, hardwareId)).for('update').limit(1);
      const holds = current?.claim_token === token;
      const errorCategory = [outcome.errorCategory, holds ? null : 'lease_lost'].filter(Boolean).join(';') || null;
      let operationId = outcome.operationId ?? null;
      if (operationId) {
        await tx.update(hardwarePowerOperations).set({
          outcome: outcome.outcome, prior_mode: outcome.prior, error_category: errorCategory, completed_at: now,
        }).where(and(eq(hardwarePowerOperations.id, operationId), eq(hardwarePowerOperations.hardware_id, hardwareId),
          eq(hardwarePowerOperations.claim_token, token)));
      } else {
        const [inserted] = await tx.insert(hardwarePowerOperations).values({
          ...this.operationValues(hardwareId, token, outcome), outcome: outcome.outcome,
          error_category: errorCategory, completed_at: now, occurred_at: now,
        }).returning({ id: hardwarePowerOperations.id });
        operationId = inserted.id;
      }
      if (!holds || !current) return [] as Array<[string, string]>;
      const set: Record<string, unknown> = {
        claim_token: null, claim_expires_at: null, last_outcome: outcome.outcome, last_outcome_at: now,
        latch: outcome.decision.latch, updated_at: now,
      };
      const notices: Array<[string, string]> = [];
      if (outcome.outcome === 'verified' || outcome.outcome === 'already_set') {
        Object.assign(set, { last_verified_mode: outcome.target, failure_count: 0, next_attempt_at: null,
          pending_target: null, pending_operation_id: null, last_error: null, failure_notified_at: null });
        if (current.failure_notified_at) notices.push(['hardware.power_control_recovered', `Mode ${outcome.target} verified`]);
      } else if (outcome.outcome === 'unknown' || outcome.outcome === 'failed') {
        const failures = current.failure_count + 1;
        Object.assign(set, { failure_count: failures, next_attempt_at: new Date(now.getTime() + failureBackoffMs(failures)),
          last_error: errorCategory ?? (outcome.outcome === 'unknown' ? 'unverified' : 'failed') });
        if (outcome.outcome === 'unknown') Object.assign(set, { pending_target: outcome.target, pending_operation_id: operationId });
        if (failures >= FAILURE_NOTIFY_THRESHOLD && !current.failure_notified_at) {
          set.failure_notified_at = now;
          notices.push(['hardware.power_control_failing', `${failures} consecutive mode attempts ended ${outcome.outcome}${errorCategory ? ` (${errorCategory})` : ''}`]);
        }
      } else if (outcome.outcome === 'unavailable') {
        set.last_error = errorCategory;
      }
      await tx.update(hardwarePowerPolicies).set(set)
        .where(and(eq(hardwarePowerPolicies.hardware_id, hardwareId), eq(hardwarePowerPolicies.claim_token, token)));
      return notices;
    });
    for (const [event, detail] of events) this.notify(event, hardwareId, detail);
  }

  async observe(hardwareId: number, version: number, decision: PowerDecision, actual: HardwareMode, note?: ObservationNote): Promise<void> {
    const now = this.now();
    const set: Record<string, unknown> = { latch: decision.latch, updated_at: now };
    if (decision.target === actual) Object.assign(set, { last_verified_mode: actual, failure_count: 0, next_attempt_at: null });
    if (note) Object.assign(set, { last_outcome: note.outcome, last_error: note.error, last_outcome_at: now });
    else {
      // A successful read clears an earlier read/policy problem indicator.
      Object.assign(set, {
        last_error: sql`CASE WHEN ${hardwarePowerPolicies.last_outcome} IN ('read_failed', 'host_not_running', 'policy_invalid') THEN NULL ELSE ${hardwarePowerPolicies.last_error} END`,
        last_outcome: sql`CASE WHEN ${hardwarePowerPolicies.last_outcome} IN ('read_failed', 'host_not_running', 'policy_invalid') THEN 'reachable' ELSE ${hardwarePowerPolicies.last_outcome} END`,
      });
    }
    await db.update(hardwarePowerPolicies).set(set)
      .where(and(eq(hardwarePowerPolicies.hardware_id, hardwareId), eq(hardwarePowerPolicies.version, version), isNull(hardwarePowerPolicies.claim_token)));
  }

  async recordUnavailable(hardwareId: number, note: ObservationNote): Promise<void> {
    if (!READ_PROBLEMS.includes(note.outcome)) return;
    const now = this.now();
    const events = await db.transaction(async (tx) => {
      const [current] = await tx.select({ failure_count: hardwarePowerPolicies.failure_count, failure_notified_at: hardwarePowerPolicies.failure_notified_at })
        .from(hardwarePowerPolicies)
        .where(and(eq(hardwarePowerPolicies.hardware_id, hardwareId), isNull(hardwarePowerPolicies.claim_token)))
        .for('update').limit(1);
      if (!current) return [] as Array<[string, string]>;
      const set: Record<string, unknown> = { last_outcome: note.outcome, last_error: note.error, last_outcome_at: now, updated_at: now };
      const notices: Array<[string, string]> = [];
      if (note.countsAsFailure) {
        const failures = current.failure_count + 1;
        Object.assign(set, { failure_count: failures, next_attempt_at: new Date(now.getTime() + failureBackoffMs(failures)) });
        if (failures >= FAILURE_NOTIFY_THRESHOLD && !current.failure_notified_at) {
          set.failure_notified_at = now;
          notices.push(['hardware.power_control_failing', `${failures} consecutive iLO reads failed (${note.error})`]);
        }
      }
      await tx.update(hardwarePowerPolicies).set(set)
        .where(and(eq(hardwarePowerPolicies.hardware_id, hardwareId), isNull(hardwarePowerPolicies.claim_token)));
      return notices;
    });
    for (const [event, detail] of events) this.notify(event, hardwareId, detail);
  }

  async resolvePending(hardwareId: number, operationId: number | null, verified: boolean, actual: HardwareMode): Promise<void> {
    const now = this.now();
    const notices = await db.transaction(async (tx) => {
      const [current] = await tx.select({ failure_notified_at: hardwarePowerPolicies.failure_notified_at })
        .from(hardwarePowerPolicies)
        .where(and(eq(hardwarePowerPolicies.hardware_id, hardwareId), isNull(hardwarePowerPolicies.claim_token), isNotNull(hardwarePowerPolicies.pending_target)))
        .for('update').limit(1);
      if (!current) return [] as string[];
      if (operationId) {
        await tx.update(hardwarePowerOperations).set({
          outcome: verified ? 'verified' : 'not_applied', error_category: verified ? 'verified_on_later_read' : 'not_applied_on_later_read', completed_at: now,
        }).where(and(eq(hardwarePowerOperations.id, operationId), eq(hardwarePowerOperations.hardware_id, hardwareId),
          eq(hardwarePowerOperations.outcome, 'unknown')));
      }
      await tx.update(hardwarePowerPolicies).set({
        pending_target: null, pending_operation_id: null, last_outcome_at: now, updated_at: now,
        ...(verified ? { last_verified_mode: actual, last_outcome: 'verified', failure_count: 0, next_attempt_at: null, last_error: null, failure_notified_at: null }
          : { last_outcome: 'not_applied' }),
      }).where(and(eq(hardwarePowerPolicies.hardware_id, hardwareId), isNull(hardwarePowerPolicies.claim_token)));
      return verified && current.failure_notified_at ? [`Mode ${actual} verified on a later read`] : [];
    });
    for (const detail of notices) this.notify('hardware.power_control_recovered', hardwareId, detail);
  }

  async holdExternalDrift(hardwareId: number, version: number, actual: HardwareMode, holdUntil: Date | null = null): Promise<void> {
    await db.update(hardwarePowerPolicies).set({
      drift_hold: true, drift_hold_until: holdUntil, last_outcome: `external_drift:${actual}`, last_outcome_at: this.now(),
      version: version + 1, updated_at: this.now(),
    }).where(and(eq(hardwarePowerPolicies.hardware_id, hardwareId), eq(hardwarePowerPolicies.version, version), isNull(hardwarePowerPolicies.claim_token)));
  }

  async releaseDriftHold(hardwareId: number, version: number, actual: HardwareMode): Promise<boolean> {
    const rows = await db.update(hardwarePowerPolicies).set({
      drift_hold: false, drift_hold_until: null, last_verified_mode: actual, last_outcome: 'drift_hold_released',
      last_outcome_at: this.now(), version: version + 1, updated_at: this.now(),
    }).where(and(eq(hardwarePowerPolicies.hardware_id, hardwareId), eq(hardwarePowerPolicies.version, version),
      eq(hardwarePowerPolicies.drift_hold, true), isNull(hardwarePowerPolicies.claim_token)))
      .returning({ hardware_id: hardwarePowerPolicies.hardware_id });
    return rows.length === 1;
  }

  async automatedHardwareIds(): Promise<number[]> {
    const rows = await db.select({ id: hardwareConnections.id }).from(hardwareConnections)
      .innerJoin(hardwarePowerPolicies, eq(hardwareConnections.id, hardwarePowerPolicies.hardware_id))
      .where(and(eq(hardwareConnections.lifecycle_state, 'active'), eq(hardwareConnections.control_enabled, true), eq(hardwarePowerPolicies.automation_enabled, true)));
    return rows.map((row) => row.id);
  }
}
