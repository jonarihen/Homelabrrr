import { randomUUID } from 'node:crypto';
import { readCurrentMode, setRuntimeMode, type HardwareMode, type IloConfig } from './iloAdapter.ts';
import {
  resolvePowerDecision, type ApplicablePowerPrice, type PowerDecision, type PowerPricePolicy,
  type PriceLatch, type WeeklyPowerSchedule, type WritablePowerMode,
} from './powerPolicy.ts';

export interface ControlSnapshot {
  hardwareId: number;
  configVersion: number;
  policyVersion: number;
  controlEnabled: boolean;
  automationEnabled: boolean;
  paused: boolean;
  driftHold: boolean;
  supportedModes: WritablePowerMode[];
  schedule: WeeklyPowerSchedule;
  pricePolicy: PowerPricePolicy;
  latch: PriceLatch | null;
  manualOverride: { mode: WritablePowerMode; expiresAt: Date | null } | null;
  lastVerifiedMode: HardwareMode | null;
  lastAutomaticUpshiftAt: Date | null;
  ilo: IloConfig;
}

export interface ClaimOutcome {
  actor: 'manual' | 'automation';
  outcome: 'verified' | 'already_set' | 'unknown' | 'failed' | 'stale';
  prior: HardwareMode | null;
  target: WritablePowerMode;
  decision: PowerDecision;
  errorCategory?: string;
}

export interface ControlRepository {
  load(hardwareId: number): Promise<ControlSnapshot | null>;
  claim(snapshot: ControlSnapshot, token: string, expiresAt: Date): Promise<boolean>;
  claimStillCurrent(snapshot: ControlSnapshot, token: string, manual?: boolean): Promise<boolean>;
  finish(hardwareId: number, token: string, outcome: ClaimOutcome): Promise<void>;
  observe(hardwareId: number, version: number, decision: PowerDecision, actual: HardwareMode): Promise<void>;
  holdExternalDrift(hardwareId: number, version: number, actual: HardwareMode): Promise<void>;
}

export interface ControllerDependencies {
  repository: ControlRepository;
  getApplicablePrice: (at: Date, policy: PowerPricePolicy) => Promise<ApplicablePowerPrice | null>;
  readMode?: typeof readCurrentMode;
  writeMode?: typeof setRuntimeMode;
  now?: () => Date;
}

export interface ReconcileResult {
  status: 'not_configured' | 'disabled' | 'busy' | 'hold' | 'already_set' | 'stale' | 'verified' | 'unknown' | 'failed';
  decision?: PowerDecision;
}

function sameSelection(a: PowerDecision, b: PowerDecision): boolean {
  return a.target === b.target && a.reason === b.reason
    && a.validUntil?.getTime() === b.validUntil?.getTime()
    && a.latch.priceRevision === b.latch.priceRevision
    && a.latch.policyVersion === b.latch.policyVersion;
}

// All automatic paths (weekly and price) pass through this one reconciler.
// The repository atomically leases each physical node across processes; the
// in-process set avoids redundant local reads. No timer lives in this module.
export class PowerController {
  private readonly active = new Set<number>();
  private readonly deps: Required<ControllerDependencies>;

  constructor(deps: ControllerDependencies) {
    this.deps = {
      ...deps,
      readMode: deps.readMode ?? readCurrentMode,
      writeMode: deps.writeMode ?? setRuntimeMode,
      now: deps.now ?? (() => new Date()),
    };
  }

  private async decision(snapshot: ControlSnapshot, actualMode: HardwareMode, manual = false): Promise<PowerDecision> {
    const now = this.deps.now();
    const price = snapshot.pricePolicy.enabled && !manual
      ? await this.deps.getApplicablePrice(now, snapshot.pricePolicy) : null;
    return resolvePowerDecision({
      now, controlEnabled: snapshot.controlEnabled && (snapshot.automationEnabled || manual),
      automationPaused: snapshot.paused, driftHold: snapshot.driftHold, manualAction: manual,
      actualMode, supportedModes: snapshot.supportedModes,
      schedule: snapshot.schedule, pricePolicy: snapshot.pricePolicy,
      price, previousLatch: snapshot.latch, manualOverride: snapshot.manualOverride,
    });
  }

  private withinUpshiftDwell(snapshot: ControlSnapshot, actual: HardwareMode, target: WritablePowerMode, manual: boolean): boolean {
    if (manual || !snapshot.pricePolicy.enabled || !snapshot.lastAutomaticUpshiftAt) return false;
    const order = { low: 0, dynamic: 1, high: 2, os_control: -1, unknown: -1 };
    if (order[target] <= order[actual]) return false;
    const minutes = snapshot.pricePolicy.minAutomaticUpshiftMinutes ?? 5;
    return this.deps.now().getTime() < snapshot.lastAutomaticUpshiftAt.getTime() + minutes * 60_000;
  }

  async reconcile(hardwareId: number, { manual = false }: { manual?: boolean } = {}): Promise<ReconcileResult> {
    if (this.active.has(hardwareId)) return { status: 'busy' };
    this.active.add(hardwareId);
    try {
      const initial = await this.deps.repository.load(hardwareId);
      if (!initial) return { status: 'not_configured' };
      if (!initial.controlEnabled || (!manual && !initial.automationEnabled)) return { status: 'disabled' };
      const actual = await this.deps.readMode(initial.ilo);
      if (!manual && initial.lastVerifiedMode && initial.lastVerifiedMode !== actual && !initial.driftHold) {
        await this.deps.repository.holdExternalDrift(hardwareId, initial.policyVersion, actual);
        return { status: 'hold' };
      }
      const selected = await this.decision(initial, actual, manual);
      if (!selected.target) {
        await this.deps.repository.observe(hardwareId, initial.policyVersion, selected, actual);
        return { status: 'hold', decision: selected };
      }
      if (selected.target === actual) {
        await this.deps.repository.observe(hardwareId, initial.policyVersion, selected, actual);
        return { status: 'already_set', decision: selected };
      }
      if (this.withinUpshiftDwell(initial, actual, selected.target, manual)) return { status: 'hold', decision: selected };
      const token = randomUUID();
      // iLO's bounded GET/PATCH/readback sequence is at most ~15 seconds; the
      // 60-second lease leaves room for DB and network jitter. Expired claims
      // are reconciled by a fresh hardware read, never blindly replayed.
      const claimed = await this.deps.repository.claim(initial, token, new Date(this.deps.now().getTime() + 60_000));
      if (!claimed) return { status: 'busy', decision: selected };
      let outcome: ClaimOutcome = { actor: manual ? 'manual' : 'automation', outcome: 'stale', prior: actual, target: selected.target, decision: selected };
      try {
        const fresh = await this.deps.repository.load(hardwareId);
        if (!fresh || fresh.configVersion !== initial.configVersion || fresh.policyVersion !== initial.policyVersion
          || !await this.deps.repository.claimStillCurrent(initial, token, manual)) return { status: 'stale', decision: selected };
        const current = await this.deps.readMode(fresh.ilo);
        const renewed = await this.decision(fresh, current, manual);
        if (!sameSelection(selected, renewed) || !renewed.target) return { status: 'stale', decision: renewed };
        if (current === renewed.target) {
          outcome = { actor: manual ? 'manual' : 'automation', outcome: 'already_set', prior: current, target: renewed.target, decision: renewed };
          return { status: 'already_set', decision: renewed };
        }
        if (this.withinUpshiftDwell(fresh, current, renewed.target, manual)) return { status: 'hold', decision: renewed };
        const guard = async () => {
          if (!await this.deps.repository.claimStillCurrent(initial, token, manual)) return false;
          const latest = await this.deps.repository.load(hardwareId);
          if (!latest || latest.configVersion !== initial.configVersion || latest.policyVersion !== initial.policyVersion) return false;
          const atDispatch = await this.decision(latest, current, manual);
          return sameSelection(renewed, atDispatch) && atDispatch.target === renewed.target
            && !this.withinUpshiftDwell(latest, current, renewed.target, manual);
        };
        const result = await this.deps.writeMode(fresh.ilo, renewed.target, undefined, undefined, guard);
        outcome = { actor: manual ? 'manual' : 'automation', outcome: result.outcome, prior: result.prior, target: renewed.target, decision: renewed };
        return { status: result.outcome, decision: renewed };
      } catch (err) {
        outcome = { ...outcome, outcome: 'failed', errorCategory: err instanceof Error ? err.name : 'unknown' };
        return { status: 'failed', decision: selected };
      } finally {
        await this.deps.repository.finish(hardwareId, token, outcome);
      }
    } finally {
      this.active.delete(hardwareId);
    }
  }
}
