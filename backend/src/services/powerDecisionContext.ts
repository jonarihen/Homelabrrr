import type {
  ApplicablePowerPrice, ObservedPowerMode, PowerDecisionInput, PowerPricePolicy, PriceLatch,
  WeeklyPowerSchedule, WritablePowerMode,
} from './powerPolicy.ts';

// One mapping from stored control state to resolver input. The worker,
// manual commands, the admin preview and the dashboard all use it, so a
// preview cannot claim a mode the worker would not select.

export interface DecisionState {
  controlEnabled: boolean;
  automationEnabled: boolean;
  paused: boolean;
  driftHold: boolean;
  supportedModes: WritablePowerMode[];
  schedule: WeeklyPowerSchedule;
  pricePolicy: PowerPricePolicy;
  latch: PriceLatch | null;
  manualOverride: { mode: WritablePowerMode; expiresAt: Date | null } | null;
}

export function controllerDecisionInput(state: DecisionState, options: {
  now: Date; actualMode: ObservedPowerMode; price: ApplicablePowerPrice | null; manual?: boolean;
}): PowerDecisionInput {
  const manual = options.manual === true;
  return {
    now: options.now,
    // Automatic work needs automation enabled; an explicit manual command needs
    // only enabled physical control.
    controlEnabled: state.controlEnabled && (state.automationEnabled || manual),
    automationPaused: state.paused,
    driftHold: state.driftHold,
    manualAction: manual,
    actualMode: options.actualMode,
    supportedModes: state.supportedModes,
    schedule: state.schedule,
    pricePolicy: state.pricePolicy,
    price: options.price,
    previousLatch: state.latch,
    manualOverride: state.manualOverride,
  };
}

const WRITABLE = new Set<string>(['low', 'dynamic', 'high']);

export function supportedModesFrom(capabilities: unknown): WritablePowerMode[] {
  const value = capabilities as { runtimeMode?: string; supportedModes?: unknown } | null;
  if (value?.runtimeMode !== 'supported') return [];
  const modes = Array.isArray(value.supportedModes) ? value.supportedModes : ['low', 'dynamic', 'high'];
  return modes.filter((mode): mode is WritablePowerMode => typeof mode === 'string' && WRITABLE.has(mode));
}

export function storedManualOverride(mode: unknown, expiresAt: Date | string | null | undefined)
  : { mode: WritablePowerMode; expiresAt: Date | null } | null {
  if (typeof mode !== 'string' || !WRITABLE.has(mode)) return null;
  return { mode: mode as WritablePowerMode, expiresAt: expiresAt ? new Date(expiresAt) : null };
}

export function observedMode(value: unknown): ObservedPowerMode {
  return value === 'low' || value === 'dynamic' || value === 'high' || value === 'os_control' ? value : 'unknown';
}
