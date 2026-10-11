import { randomUUID } from 'node:crypto';
import {
  IloError, readRuntimeState, setRuntimeMode, type HardwareMode, type IloConfig, type RuntimeState,
} from './iloAdapter.ts';
import {
  resolvePowerDecision, scheduleBoundaryInstants, type ApplicablePowerPrice, type PowerDecision, type PowerPricePolicy,
  type PriceLatch, type WeeklyPowerSchedule, type WritablePowerMode,
} from './powerPolicy.ts';
import { controllerDecisionInput } from './powerDecisionContext.ts';

export interface ControlSnapshot {
  hardwareId: number;
  configVersion: number;
  policyVersion: number;
  controlEnabled: boolean;
  automationEnabled: boolean;
  paused: boolean;
  driftHold: boolean;
  driftHoldUntil?: Date | null;
  supportedModes: WritablePowerMode[];
  schedule: WeeklyPowerSchedule;
  pricePolicy: PowerPricePolicy;
  latch: PriceLatch | null;
  manualOverride: { mode: WritablePowerMode; expiresAt: Date | null } | null;
  lastVerifiedMode: HardwareMode | null;
  lastAutomaticUpshiftAt: Date | null;
  failureCount?: number;
  nextAttemptAt?: Date | null;
  pendingTarget?: WritablePowerMode | null;
  pendingOperationId?: number | null;
  ilo: IloConfig;
}

// Revisions and price provenance recorded with every operation row. The
// policy version is the server-owned row version, never a client value.
export interface OperationAudit {
  configVersion: number;
  policyVersion: number;
  scheduleVersion: number | null;
  pricePolicyVersion: number | null;
  price: { dkkPerKwh: string; startUtc: string; endUtc: string; source: Record<string, string> } | null;
  thresholds: Record<string, unknown> | null;
}

export interface ClaimOutcome {
  actor: 'manual' | 'automation';
  actorUserId?: number | null;
  outcome: 'verified' | 'already_set' | 'unknown' | 'failed' | 'stale' | 'unavailable';
  prior: HardwareMode | null;
  target: WritablePowerMode;
  decision: PowerDecision;
  audit?: OperationAudit;
  operationId?: number | null;
  errorCategory?: string;
}

export interface ObservationNote {
  outcome: 'read_failed' | 'host_not_running' | 'policy_invalid';
  error: string;
  // Read failures count toward backoff and the deduplicated failure notice.
  countsAsFailure: boolean;
}

export interface ControlRepository {
  load(hardwareId: number): Promise<ControlSnapshot | null>;
  // Clears a lease whose holder died; a possibly-dispatched write becomes an
  // unresolved pending target, recorded as an unknown outcome.
  releaseExpiredClaim?(hardwareId: number): Promise<void>;
  claim(snapshot: ControlSnapshot, token: string, expiresAt: Date): Promise<boolean>;
  renewClaim?(hardwareId: number, token: string, expiresAt: Date): Promise<boolean>;
  claimStillCurrent(snapshot: ControlSnapshot, token: string, manual?: boolean): Promise<boolean>;
  // Atomically renews the lease and writes the pre-dispatch "requested" row.
  // Returns null when the lease was lost: the caller must not dispatch.
  recordRequested?(hardwareId: number, token: string, outcome: ClaimOutcome, leaseUntil: Date): Promise<number | null>;
  finish(hardwareId: number, token: string, outcome: ClaimOutcome): Promise<void>;
  observe(hardwareId: number, version: number, decision: PowerDecision, actual: HardwareMode, note?: ObservationNote): Promise<void>;
  holdExternalDrift(hardwareId: number, version: number, actual: HardwareMode, holdUntil?: Date | null): Promise<void>;
  releaseDriftHold?(hardwareId: number, version: number, actual: HardwareMode): Promise<boolean>;
  resolvePending?(hardwareId: number, operationId: number | null, verified: boolean, actual: HardwareMode): Promise<void>;
  recordUnavailable?(hardwareId: number, note: ObservationNote): Promise<void>;
}

export interface ControllerTimings {
  leaseMs: number;
  readTimeoutMs: number;
  writeTimeoutMs: number;
  dispatchBudgetMs: number;
}

export interface ControllerDependencies {
  repository: ControlRepository;
  getApplicablePrice: (at: Date, policy: PowerPricePolicy) => Promise<ApplicablePowerPrice | null>;
  readState?: (config: IloConfig) => Promise<RuntimeState>;
  writeMode?: typeof setRuntimeMode;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  timings?: Partial<ControllerTimings>;
}

export interface ReconcileResult {
  status: 'not_configured' | 'disabled' | 'busy' | 'hold' | 'already_set' | 'stale' | 'verified' | 'unknown'
    | 'failed' | 'unavailable' | 'backoff';
  decision?: PowerDecision;
}

// Lease strategy: a claim lasts leaseMs and is renewed before each slow phase
// (fresh hardware read, pre-dispatch "requested" row). Reads and the whole
// write call are bounded independently of the transport's socket timeouts, and
// the pre-dispatch phase must finish inside dispatchBudgetMs of the claim, so
// leaseMs > dispatchBudgetMs + writeTimeoutMs keeps one holder per node.
// Once the "requested" row commits and the PATCH leaves, the request cannot be
// recalled: disabling control only stops future actions.
export const DEFAULT_TIMINGS: ControllerTimings = {
  leaseMs: 240_000,
  readTimeoutMs: 45_000,
  writeTimeoutMs: 120_000,
  dispatchBudgetMs: 90_000,
};

const ORDER: Record<HardwareMode, number> = { low: 0, dynamic: 1, high: 2, os_control: -1, unknown: -1 };

function sameSelection(a: PowerDecision, b: PowerDecision): boolean {
  return a.target === b.target && a.reason === b.reason
    && a.validUntil?.getTime() === b.validUntil?.getTime()
    && a.latch.priceRevision === b.latch.priceRevision
    && a.latch.policyVersion === b.latch.policyVersion;
}

class DeadlineError extends Error {
  constructor(message: string) { super(message); this.name = 'DeadlineError'; }
}

function withDeadline<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  work.catch(() => {}); // a late rejection after the deadline must not crash the process
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new DeadlineError(`${label} exceeded ${ms} ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

export function errorCategory(err: unknown): string {
  if (err instanceof IloError) return err.code;
  if (err instanceof DeadlineError) return 'timeout';
  return err instanceof Error && /^[A-Za-z]{1,40}$/.test(err.name) ? err.name : 'unknown';
}

export function operationAudit(snapshot: ControlSnapshot, decision: PowerDecision, price: ApplicablePowerPrice | null): OperationAudit {
  const policy = snapshot.pricePolicy;
  const priced = decision.priceStatus === 'valid' && price;
  return {
    configVersion: snapshot.configVersion,
    policyVersion: snapshot.policyVersion,
    scheduleVersion: Number.isInteger(snapshot.schedule?.version) ? snapshot.schedule.version : null,
    pricePolicyVersion: Number.isInteger(policy?.version) ? policy.version : null,
    price: priced ? {
      dkkPerKwh: price.dkk_per_kwh, startUtc: price.start_utc, endUtc: price.end_utc,
      source: {
        basis: price.basis, area: price.area, contractRef: price.contract_ref,
        contractRevision: price.contract_revision, sourceRevision: price.source_revision,
      },
    } : null,
    thresholds: policy?.enabled ? {
      expensive: policy.expensive ? { enabled: policy.expensive.enabled, threshold: policy.expensive.threshold,
        hysteresis: policy.expensive.hysteresis, capMode: policy.expensive.capMode } : null,
      cheap: policy.cheap ? { enabled: policy.cheap.enabled, threshold: policy.cheap.threshold, hysteresis: policy.cheap.hysteresis } : null,
      minAutomaticUpshiftMinutes: policy.minAutomaticUpshiftMinutes ?? 5,
    } : null,
  };
}

// All automatic paths (weekly and price) and explicit manual commands pass
// through this one reconciler, and it is the only caller of setRuntimeMode.
// The repository atomically leases each physical node across processes; the
// in-process set avoids redundant local reads. No timer lives in this module.
export class PowerController {
  private readonly active = new Set<number>();
  private readonly deps: Required<Omit<ControllerDependencies, 'timings'>>;
  private readonly timings: ControllerTimings;

  constructor(deps: ControllerDependencies) {
    this.deps = {
      repository: deps.repository,
      getApplicablePrice: deps.getApplicablePrice,
      readState: deps.readState ?? ((config) => readRuntimeState(config)),
      writeMode: deps.writeMode ?? setRuntimeMode,
      now: deps.now ?? (() => new Date()),
      sleep: deps.sleep ?? ((ms) => new Promise<void>((resolve) => { setTimeout(resolve, ms).unref?.(); })),
    };
    this.timings = { ...DEFAULT_TIMINGS, ...deps.timings };
  }

  private async decision(snapshot: ControlSnapshot, actualMode: HardwareMode, manual = false)
    : Promise<{ decision: PowerDecision; price: ApplicablePowerPrice | null }> {
    const now = this.deps.now();
    let price: ApplicablePowerPrice | null = null;
    if (snapshot.pricePolicy?.enabled && !manual) {
      // A price-service failure is an unavailable price: the weekly schedule
      // or explicit default continues; it never invents a price.
      try { price = await this.deps.getApplicablePrice(now, snapshot.pricePolicy); } catch { price = null; }
    }
    return { decision: resolvePowerDecision(controllerDecisionInput(snapshot, { now, actualMode, price, manual })), price };
  }

  private withinUpshiftDwell(snapshot: ControlSnapshot, actual: HardwareMode, target: WritablePowerMode, manual: boolean): boolean {
    if (manual || !snapshot.pricePolicy?.enabled || !snapshot.lastAutomaticUpshiftAt) return false;
    if (ORDER[target] <= ORDER[actual]) return false;
    const minutes = snapshot.pricePolicy.minAutomaticUpshiftMinutes ?? 5;
    return this.deps.now().getTime() < snapshot.lastAutomaticUpshiftAt.getTime() + minutes * 60_000;
  }

  private read(config: IloConfig): Promise<RuntimeState> {
    return withDeadline(this.deps.readState(config), this.timings.readTimeoutMs, 'iLO read');
  }

  private driftHoldUntil(snapshot: ControlSnapshot, actual: HardwareMode): Date | null {
    // OS Control/unknown drift and price-only control wait for explicit Resume.
    if (actual === 'os_control' || actual === 'unknown' || !snapshot.schedule?.enabled) return null;
    try {
      const now = this.deps.now();
      return scheduleBoundaryInstants(snapshot.schedule, now, new Date(now.getTime() + 8 * 86_400_000))[0] ?? null;
    } catch { return null; }
  }

  private inBackoff(snapshot: ControlSnapshot, manual: boolean): boolean {
    return !manual && Boolean(snapshot.nextAttemptAt) && this.deps.now().getTime() < snapshot.nextAttemptAt!.getTime();
  }

  async reconcile(hardwareId: number, { manual = false, actorUserId = null }: { manual?: boolean; actorUserId?: number | null } = {})
    : Promise<ReconcileResult> {
    if (this.active.has(hardwareId)) return { status: 'busy' };
    this.active.add(hardwareId);
    try {
      const repo = this.deps.repository;
      await repo.releaseExpiredClaim?.(hardwareId);
      let initial = await repo.load(hardwareId);
      if (!initial) return { status: 'not_configured' };
      if (!initial.controlEnabled || (!manual && !initial.automationEnabled)) return { status: 'disabled' };
      // Failed/unknown/unreadable attempts back off; explicit manual commands do not.
      if (this.inBackoff(initial, manual)) return { status: 'backoff' };

      let state: RuntimeState;
      try { state = await this.read(initial.ilo); }
      catch (err) {
        await repo.recordUnavailable?.(hardwareId, { outcome: 'read_failed', error: errorCategory(err), countsAsFailure: true });
        return { status: 'unavailable' };
      }
      if (state.powerState !== 'on') {
        // Never act on (or power on) a host that is off, booting or unknown.
        await repo.recordUnavailable?.(hardwareId, { outcome: 'host_not_running', error: state.powerState, countsAsFailure: false });
        return { status: 'unavailable' };
      }
      const actual = state.mode;

      // An unresolved earlier write is verified read-only first; a late apply
      // of our own request is not external drift.
      if (initial.pendingTarget) {
        const applied = actual === initial.pendingTarget;
        await repo.resolvePending?.(hardwareId, initial.pendingOperationId ?? null, applied, actual);
        initial = { ...initial, pendingTarget: null, pendingOperationId: null,
          lastVerifiedMode: applied ? actual : initial.lastVerifiedMode };
      }

      if (!manual && initial.lastVerifiedMode && initial.lastVerifiedMode !== actual && !initial.driftHold) {
        await repo.holdExternalDrift(hardwareId, initial.policyVersion, actual, this.driftHoldUntil(initial, actual));
        return { status: 'hold' };
      }
      if (!manual && initial.driftHold && initial.driftHoldUntil && repo.releaseDriftHold
        && this.deps.now().getTime() >= initial.driftHoldUntil.getTime() && ORDER[actual] >= 0) {
        // Weekly-boundary auto-release adopts the freshly read mode as verified.
        if (await repo.releaseDriftHold(hardwareId, initial.policyVersion, actual)) {
          const reloaded = await repo.load(hardwareId);
          if (!reloaded) return { status: 'not_configured' };
          initial = reloaded;
        }
      }

      const { decision: selected } = await this.decision(initial, actual, manual);
      const note: ObservationNote | undefined = selected.policyError
        ? { outcome: 'policy_invalid', error: selected.policyError, countsAsFailure: false } : undefined;
      if (!selected.target || selected.target === actual) {
        await repo.observe(hardwareId, initial.policyVersion, selected, actual, note);
        return { status: selected.target ? 'already_set' : 'hold', decision: selected };
      }
      if (note) await repo.observe(hardwareId, initial.policyVersion, selected, actual, note);
      if (this.withinUpshiftDwell(initial, actual, selected.target, manual)) return { status: 'hold', decision: selected };

      return await this.dispatch(hardwareId, initial, selected, actual, manual, actorUserId);
    } finally {
      this.active.delete(hardwareId);
    }
  }

  private async dispatch(hardwareId: number, initial: ControlSnapshot, selected: PowerDecision, actual: HardwareMode,
    manual: boolean, actorUserId: number | null): Promise<ReconcileResult> {
    const repo = this.deps.repository;
    const token = randomUUID();
    const claimedAt = this.deps.now().getTime();
    const leaseUntil = () => new Date(this.deps.now().getTime() + this.timings.leaseMs);
    if (!await repo.claim(initial, token, leaseUntil())) return { status: 'busy', decision: selected };
    const actor = manual ? 'manual' as const : 'automation' as const;
    let outcome: ClaimOutcome = { actor, actorUserId, outcome: 'stale', prior: actual, target: selected.target!, decision: selected,
      audit: operationAudit(initial, selected, null) };
    let dispatched = false;
    let abandoned = false;
    try {
      const fresh = await repo.load(hardwareId);
      if (!fresh || fresh.configVersion !== initial.configVersion || fresh.policyVersion !== initial.policyVersion
        || !await repo.claimStillCurrent(initial, token, manual)) return { status: 'stale', decision: selected };
      if (repo.renewClaim && !await repo.renewClaim(hardwareId, token, leaseUntil())) return { status: 'stale', decision: selected };
      const state = await this.read(fresh.ilo);
      if (state.powerState !== 'on') {
        outcome = { ...outcome, outcome: 'unavailable', prior: state.mode, errorCategory: 'host_not_running' };
        return { status: 'unavailable', decision: selected };
      }
      const current = state.mode;
      const { decision: renewed, price } = await this.decision(fresh, current, manual);
      if (!sameSelection(selected, renewed) || !renewed.target) return { status: 'stale', decision: renewed };
      outcome = { ...outcome, prior: current, target: renewed.target, decision: renewed, audit: operationAudit(fresh, renewed, price) };
      if (current === renewed.target) {
        outcome = { ...outcome, outcome: 'already_set' };
        return { status: 'already_set', decision: renewed };
      }
      const target = renewed.target;
      if (this.withinUpshiftDwell(fresh, current, target, manual)) return { status: 'hold', decision: renewed };
      // Revalidated after the slow adapter read and immediately before the
      // PATCH: lease, versions, global pause, clock and price validity.
      const guard = async () => {
        if (abandoned || this.deps.now().getTime() - claimedAt > this.timings.dispatchBudgetMs) return false;
        if (!await repo.claimStillCurrent(initial, token, manual)) return false;
        const latest = await repo.load(hardwareId);
        if (!latest || latest.configVersion !== initial.configVersion || latest.policyVersion !== initial.policyVersion) return false;
        const { decision: atDispatch } = await this.decision(latest, current, manual);
        if (!sameSelection(renewed, atDispatch) || atDispatch.target !== target
          || this.withinUpshiftDwell(latest, current, target, manual) || abandoned) return false;
        if (repo.recordRequested) {
          const operationId = await repo.recordRequested(hardwareId, token, outcome, leaseUntil());
          if (operationId === null || abandoned) return false;
          outcome = { ...outcome, operationId };
        }
        dispatched = true;
        return true;
      };
      let result: Awaited<ReturnType<typeof setRuntimeMode>>;
      try {
        result = await withDeadline(
          this.deps.writeMode(fresh.ilo, target, undefined, undefined, guard, { sleep: this.deps.sleep }),
          this.timings.writeTimeoutMs, 'iLO write');
      } catch (err) {
        abandoned = true;
        if (err instanceof IloError && err.code === 'policy_changed') return { status: 'stale', decision: renewed };
        if (err instanceof IloError && err.code === 'host_not_running') {
          outcome = { ...outcome, outcome: 'unavailable', errorCategory: 'host_not_running' };
          return { status: 'unavailable', decision: renewed };
        }
        throw err;
      }
      outcome = { ...outcome, outcome: result.outcome, prior: result.prior };
      return { status: result.outcome, decision: renewed };
    } catch (err) {
      abandoned = true;
      // A failure after dispatch (including a deadline) may still have applied:
      // keep it unresolved so the next tick verifies it read-only.
      // A definitive refusal (auth, ETag conflict, redirect) did not apply.
      const refused = err instanceof IloError && ['authentication_failed', 'conflict', 'invalid_target'].includes(err.code);
      const status = dispatched && !refused ? 'unknown' as const : 'failed' as const;
      outcome = { ...outcome, outcome: status, errorCategory: errorCategory(err) };
      return { status, decision: outcome.decision };
    } finally {
      abandoned = true;
      await repo.finish(hardwareId, token, outcome);
    }
  }
}
