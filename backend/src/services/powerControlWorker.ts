import { PowerController } from './powerController.ts';
import { PowerControlStore } from './powerControlStore.ts';
import { startBackgroundWork } from './backgroundWork.ts';
import { log } from '../utils/logger.ts';
import type { ApplicablePowerPrice, PowerPricePolicy } from './powerPolicy.ts';

const TICK_MS = 60_000;
let timer: ReturnType<typeof setInterval> | null = null;
let initialTimer: ReturnType<typeof setTimeout> | null = null;
let sweeping = false;

export function createPowerControlWorker(
  getApplicablePrice: (at: Date, policy: PowerPricePolicy) => Promise<ApplicablePowerPrice | null>,
  store = new PowerControlStore(),
) {
  const controller = new PowerController({ repository: store, getApplicablePrice });
  return async () => {
    if (sweeping) return;
    sweeping = true;
    try {
      const ids = await store.automatedHardwareIds();
      for (let offset = 0; offset < ids.length; offset += 2) {
        await Promise.allSettled(ids.slice(offset, offset + 2).map((id) => startBackgroundWork(
          () => controller.reconcile(id), { kind: 'power-control', hardwareId: id },
        )));
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
