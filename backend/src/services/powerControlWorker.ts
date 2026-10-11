import { PowerController, type ControllerDependencies, type ReconcileResult } from './powerController.ts';
import { PowerControlStore } from './powerControlStore.ts';
import { startBackgroundWork } from './backgroundWork.ts';
import { log } from '../utils/logger.ts';
import type { ApplicablePowerPrice, PowerPricePolicy } from './powerPolicy.ts';

const TICK_MS = 60_000;
let timer: ReturnType<typeof setInterval> | null = null;
let initialTimer: ReturnType<typeof setTimeout> | null = null;

export type WorkerOptions = Omit<ControllerDependencies, 'repository' | 'getApplicablePrice'>;

// One sweep: clear abandoned leases (including on nodes whose control has
// since been disabled, so edits are never blocked), then reconcile only nodes
// whose control and automation are explicitly enabled. A restart therefore
// resumes current-state reconciliation and never enables anything.
export function createPowerControlWorker(
  getApplicablePrice: (at: Date, policy: PowerPricePolicy) => Promise<ApplicablePowerPrice | null>,
  store = new PowerControlStore(),
  options: WorkerOptions = {},
) {
  const controller = new PowerController({ ...options, repository: store, getApplicablePrice });
  let sweeping = false;
  return async () => {
    if (sweeping) return;
    sweeping = true;
    try {
      await store.releaseExpiredClaims();
      const ids = await store.automatedHardwareIds();
      for (let offset = 0; offset < ids.length; offset += 2) {
        const batch = ids.slice(offset, offset + 2);
        // One host's failure never blocks the others; rejections are logged
        // rather than silently swallowed by allSettled.
        const results = await Promise.allSettled(batch.map((id) => startBackgroundWork(
          () => controller.reconcile(id), { kind: 'power-control', hardwareId: id },
        ) as Promise<ReconcileResult>));
        results.forEach((result, index) => {
          const hardwareId = batch[index];
          if (result.status === 'rejected') log('warn', 'power_control_reconcile_rejected', { hardwareId, error: result.reason });
          else if (['failed', 'unknown', 'unavailable'].includes(result.value.status)) {
            log('info', 'power_control_reconcile_outcome', { hardwareId, status: result.value.status });
          }
        });
      }
    } finally { sweeping = false; }
  };
}

// Startup and shutdown are explicit; importing this module never starts a job.
// A missing/invalid price suppresses only price rules, so a configured weekly
// schedule keeps working during a price-source outage.
export function startPowerControlWorker(
  getApplicablePrice: (at: Date, policy: PowerPricePolicy) => Promise<ApplicablePowerPrice | null>,
) {
  if (timer) return;
  const sweep = createPowerControlWorker(getApplicablePrice);
  const run = () => { void sweep().catch((err) => log('warn', 'power_control_sweep_failed', { error: err })); };
  initialTimer = setTimeout(run, 15_000);
  timer = setInterval(run, TICK_MS);
  initialTimer.unref(); timer.unref();
}

export function stopPowerControlWorker() {
  if (initialTimer) clearTimeout(initialTimer);
  if (timer) clearInterval(timer);
  initialTimer = null; timer = null;
}
