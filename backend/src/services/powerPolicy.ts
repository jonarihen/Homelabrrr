import { isValidTime, isValidTimezone, timeToMinutes, zonedParts } from '../utils/schedule.ts';

export type WritablePowerMode = 'low' | 'dynamic' | 'high';
export type ObservedPowerMode = WritablePowerMode | 'os_control' | 'unknown';
export type PriceBasis = 'variable_retail_including_vat' | 'spot_only_excluding_retail_additions';

export interface PowerWindow {
  days: number; // Sunday bit 0 through Saturday bit 6; the start day owns an overnight window.
  start: string;
  end: string;
  mode: WritablePowerMode;
}

export interface WeeklyPowerSchedule {
  enabled: boolean;
  timezone: string;
  defaultMode: WritablePowerMode;
  windows: PowerWindow[];
  version: number;
}

export interface PriceRule {
  enabled: boolean;
  threshold: string;
  hysteresis: string;
}

export interface PowerPricePolicy {
  enabled: boolean;
  basis: PriceBasis;
  contractRef: string;
  area: string;
  priceOnlyDefault?: WritablePowerMode;
  minAutomaticUpshiftMinutes?: number;
  expensive: PriceRule & { capMode: 'low' | 'dynamic' };
  cheap: PriceRule;
  version: number;
}

export interface ApplicablePowerPrice {
  dkk_per_kwh: string;
  basis: PriceBasis;
  contract_ref: string;
  area: string;
  start_utc: string;
  end_utc: string;
  status: 'valid' | 'incomplete' | 'forecast' | 'invalid';
  contract_revision: string;
  source_revision: string;
}

export interface PriceLatch {
  expensive: boolean;
  cheap: boolean;
  policyVersion: number;
  priceRevision: string;
}

export interface PowerDecisionInput {
  now: Date;
  controlEnabled: boolean;
  automationPaused: boolean;
  driftHold: boolean;
  actualMode: ObservedPowerMode;
  supportedModes: WritablePowerMode[];
  schedule: WeeklyPowerSchedule;
  pricePolicy: PowerPricePolicy;
  price: ApplicablePowerPrice | null;
  previousLatch?: PriceLatch | null;
  manualOverride?: { mode: WritablePowerMode; expiresAt: Date | null } | null;
  manualAction?: boolean;
}

export interface PowerDecision {
  target: WritablePowerMode | null;
  baseMode: WritablePowerMode | null;
  actualMode: ObservedPowerMode;
  reason: 'disabled' | 'paused' | 'drift_hold' | 'unsafe_actual_mode' | 'unsupported_mode'
    | 'no_automation' | 'manual' | 'schedule' | 'default' | 'price_high' | 'price_low'
    | 'price_unavailable_fallback';
  priceStatus: 'disabled' | 'valid' | 'unavailable';
  validUntil: Date | null;
  latch: PriceLatch;
}

const MODE_ORDER: Record<WritablePowerMode, number> = { low: 0, dynamic: 1, high: 2 };
const RATE_PATTERN = /^-?(?:0|[1-9]\d*)(?:[.,]\d{1,6})?$/;

// Signed millionths of DKK/kWh. This keeps comparisons exact without floating point thresholds.
export function parseDkkPerKwh(value: string): bigint {
  if (typeof value !== 'string' || !RATE_PATTERN.test(value.trim())) {
    throw new Error('Price must be a decimal DKK/kWh value with at most six fractional digits');
  }
  const normalized = value.trim().replace(',', '.');
  const negative = normalized.startsWith('-');
  const [whole, fraction = ''] = (negative ? normalized.slice(1) : normalized).split('.');
  const micros = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0') || '0');
  return negative ? -micros : micros;
}

export function weekdayPreset(): WeeklyPowerSchedule {
  return {
    enabled: false,
    timezone: 'Europe/Copenhagen',
    defaultMode: 'low',
    windows: [
      { days: 0b0111110, start: '16:00', end: '02:00', mode: 'high' },
      { days: 0b1000001, start: '12:00', end: '22:00', mode: 'high' },
    ],
    version: 1,
  };
}

function occupiedMinutes(window: PowerWindow): Set<number> {
  const start = timeToMinutes(window.start);
  const end = timeToMinutes(window.end);
  const duration = (end - start + 1440) % 1440;
  const minutes = new Set<number>();
  for (let day = 0; day < 7; day += 1) {
    if (!(window.days & (1 << day))) continue;
    for (let offset = 0; offset < duration; offset += 1) {
      minutes.add(((day * 1440 + start + offset) % 10080));
    }
  }
  return minutes;
}

export function validatePowerSchedule(schedule: WeeklyPowerSchedule): void {
  if (!isValidTimezone(schedule.timezone)) throw new Error('Invalid schedule timezone');
  if (!(schedule.defaultMode in MODE_ORDER)) throw new Error('Invalid default mode');
  const occupied = new Set<number>();
  for (const window of schedule.windows) {
    if (!Number.isInteger(window.days) || window.days < 1 || window.days > 127
      || !isValidTime(window.start) || !isValidTime(window.end) || window.start === window.end
      || !(window.mode in MODE_ORDER)) throw new Error('Invalid power window');
    for (const minute of occupiedMinutes(window)) {
      if (occupied.has(minute)) throw new Error('Overlapping power windows');
      occupied.add(minute);
    }
  }
}

export function scheduledModeAt(schedule: WeeklyPowerSchedule, now: Date): WritablePowerMode {
  validatePowerSchedule(schedule);
  const { weekday, minuteOfDay } = zonedParts(now, schedule.timezone);
  const minuteOfWeek = weekday * 1440 + minuteOfDay;
  for (const window of schedule.windows) {
    if (occupiedMinutes(window).has(minuteOfWeek)) return window.mode;
  }
  return schedule.defaultMode;
}

export function validatePricePolicy(policy: PowerPricePolicy): void {
  if (!['variable_retail_including_vat', 'spot_only_excluding_retail_additions'].includes(policy.basis)) {
    throw new Error('Invalid price basis');
  }
  if (policy.enabled && (!policy.contractRef || !policy.area)) throw new Error('Price contract and area required');
  if (policy.priceOnlyDefault && !(policy.priceOnlyDefault in MODE_ORDER)) throw new Error('Invalid price-only default');
  if (policy.minAutomaticUpshiftMinutes !== undefined
    && (!Number.isInteger(policy.minAutomaticUpshiftMinutes) || policy.minAutomaticUpshiftMinutes < 0
      || policy.minAutomaticUpshiftMinutes > 1440)) throw new Error('Invalid minimum automatic upshift interval');
  if (!['low', 'dynamic'].includes(policy.expensive.capMode)) throw new Error('Invalid expensive-price cap mode');
  const upper = policy.expensive.enabled ? parseDkkPerKwh(policy.expensive.threshold) : 0n;
  const lower = policy.cheap.enabled ? parseDkkPerKwh(policy.cheap.threshold) : 0n;
  const upperHysteresis = policy.expensive.enabled ? parseDkkPerKwh(policy.expensive.hysteresis) : 0n;
  const lowerHysteresis = policy.cheap.enabled ? parseDkkPerKwh(policy.cheap.hysteresis) : 0n;
  if (upperHysteresis < 0n || lowerHysteresis < 0n) throw new Error('Hysteresis cannot be negative');
  if (policy.expensive.enabled && policy.cheap.enabled && lower + lowerHysteresis >= upper - upperHysteresis) {
    throw new Error('Price-rule release bands overlap');
  }
}

function validPrice(input: PowerDecisionInput): boolean {
  const { price, pricePolicy, now } = input;
  if (!price || price.status !== 'valid' || price.basis !== pricePolicy.basis
    || price.contract_ref !== pricePolicy.contractRef || price.area !== pricePolicy.area
    || !price.contract_revision || !price.source_revision) return false;
  const start = Date.parse(price.start_utc);
  const end = Date.parse(price.end_utc);
  if (!(Number.isFinite(start) && Number.isFinite(end) && start <= now.getTime() && now.getTime() < end)) return false;
  try {
    parseDkkPerKwh(price.dkk_per_kwh);
    return true;
  } catch {
    return false;
  }
}

export function resolvePowerDecision(input: PowerDecisionInput): PowerDecision {
  validatePowerSchedule(input.schedule);
  validatePricePolicy(input.pricePolicy);
  const policy = input.pricePolicy;
  const priceRevision = input.price ? `${input.price.contract_revision}/${input.price.source_revision}` : '';
  const latch: PriceLatch = { expensive: false, cheap: false, policyVersion: policy.version, priceRevision };
  const baseMode = input.schedule.enabled ? scheduledModeAt(input.schedule, input.now)
    : policy.enabled ? policy.priceOnlyDefault ?? null : null;
  const result = (reason: PowerDecision['reason'], target: WritablePowerMode | null,
    priceStatus: PowerDecision['priceStatus'] = 'disabled', validUntil: Date | null = null): PowerDecision => ({
    target, baseMode, actualMode: input.actualMode, reason, priceStatus, validUntil, latch,
  });

  if (!input.controlEnabled) return result('disabled', null);
  if (input.actualMode === 'os_control' || input.actualMode === 'unknown') return result('unsafe_actual_mode', null);

  const override = input.manualOverride;
  if (input.manualAction && override && (!override.expiresAt || override.expiresAt.getTime() > input.now.getTime())) {
    return input.supportedModes.includes(override.mode) ? result('manual', override.mode)
      : result('unsupported_mode', null);
  }
  if (input.automationPaused) return result('paused', null);
  if (input.driftHold) return result('drift_hold', null);
  if (override && (!override.expiresAt || override.expiresAt.getTime() > input.now.getTime())) {
    return input.supportedModes.includes(override.mode) ? result('manual', override.mode)
      : result('unsupported_mode', null);
  }
  if (!baseMode) return result('no_automation', null);

  let target = baseMode;
  let reason: PowerDecision['reason'] = input.schedule.enabled ? 'schedule' : 'default';
  let priceStatus: PowerDecision['priceStatus'] = 'disabled';
  let validUntil: Date | null = null;
  if (policy.enabled && (policy.expensive.enabled || policy.cheap.enabled)) {
    priceStatus = 'unavailable';
    reason = 'price_unavailable_fallback';
    if (validPrice(input)) {
      const price = input.price!;
      const current = parseDkkPerKwh(price.dkk_per_kwh);
      const upper = policy.expensive.enabled ? parseDkkPerKwh(policy.expensive.threshold) : 0n;
      const lower = policy.cheap.enabled ? parseDkkPerKwh(policy.cheap.threshold) : 0n;
      const old = input.previousLatch;
      const samePolicy = old?.policyVersion === policy.version;
      latch.expensive = policy.expensive.enabled && (current > upper
        || (samePolicy && old!.expensive && current > upper - parseDkkPerKwh(policy.expensive.hysteresis)));
      latch.cheap = policy.cheap.enabled && (current < lower
        || (samePolicy && old!.cheap && current < lower + parseDkkPerKwh(policy.cheap.hysteresis)));
      priceStatus = 'valid';
      validUntil = new Date(price.end_utc);
      reason = input.schedule.enabled ? 'schedule' : 'default';
      if (latch.expensive) {
        if (MODE_ORDER[target] > MODE_ORDER[policy.expensive.capMode]) target = policy.expensive.capMode;
        reason = 'price_high';
      } else if (latch.cheap) {
        target = 'high';
        reason = 'price_low';
      }
    }
  }
  return input.supportedModes.includes(target) ? result(reason, target, priceStatus, validUntil)
    : result('unsupported_mode', null, priceStatus, validUntil);
}
