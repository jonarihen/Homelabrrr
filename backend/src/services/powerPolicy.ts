import { isValidTime, isValidTimezone, timeToMinutes } from '../utils/schedule.ts';

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
  const local = localDateParts(now, schedule.timezone);
  const today = Date.UTC(local.year, local.month - 1, local.day);
  for (const day of [today - 86_400_000, today]) {
    const weekday = new Date(day).getUTCDay();
    for (const window of schedule.windows) {
      if (!(window.days & (1 << weekday))) continue;
      const start = localBoundary(day, window.start, schedule.timezone, 'earlier');
      const overnight = timeToMinutes(window.end) < timeToMinutes(window.start);
      const end = localBoundary(day + (overnight ? 86_400_000 : 0), window.end, schedule.timezone, 'later');
      if (start <= now.getTime() && now.getTime() < end) return window.mode;
    }
  }
  return schedule.defaultMode;
}

const dateFormatters = new Map<string, Intl.DateTimeFormat>();
function localDateParts(date: Date, timezone: string) {
  let formatter = dateFormatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    dateFormatters.set(timezone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, Number(part.value)]));
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour % 24, minute: parts.minute };
}

// Resolve wall-clock boundaries to instants. Spring gaps advance to the first
// valid local minute; autumn starts use the earlier occurrence and ends the
// later occurrence, so an active window cannot oscillate when clocks go back.
function localBoundary(localDayUtc: number, wallTime: string, timezone: string, occurrence: 'earlier' | 'later'): number {
  const minute = timeToMinutes(wallTime);
  const naive = localDayUtc + minute * 60_000;
  const day = new Date(localDayUtc);
  for (let advance = 0; advance <= 180; advance += 1) {
    const desired = naive + advance * 60_000;
    const matches = new Set<number>();
    const offsets = new Set<number>();
    for (let hours = -36; hours <= 36; hours += 6) {
      const probe = desired + hours * 3_600_000;
      const local = localDateParts(new Date(probe), timezone);
      offsets.add((Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute) - probe) / 60_000);
    }
    for (const offset of offsets) {
      const instant = desired - offset * 60_000;
      const p = localDateParts(new Date(instant), timezone);
      const wanted = new Date(desired);
      if (p.year === wanted.getUTCFullYear() && p.month === wanted.getUTCMonth() + 1
        && p.day === wanted.getUTCDate() && p.hour === wanted.getUTCHours() && p.minute === wanted.getUTCMinutes()) matches.add(instant);
    }
    if (matches.size) return occurrence === 'earlier' ? Math.min(...matches) : Math.max(...matches);
  }
  throw new Error(`Unable to resolve local power boundary for ${day.toISOString()}`);
}

export function scheduleBoundaryInstants(schedule: WeeklyPowerSchedule, from: Date, to: Date): Date[] {
  validatePowerSchedule(schedule);
  if (!schedule.enabled) return [];
  const local = localDateParts(from, schedule.timezone);
  const first = Date.UTC(local.year, local.month - 1, local.day) - 86_400_000;
  const days = Math.ceil((to.getTime() - from.getTime()) / 86_400_000) + 4;
  const boundaries = new Set<number>();
  for (let index = 0; index < days; index += 1) {
    const day = first + index * 86_400_000;
    for (const window of schedule.windows) {
      if (!(window.days & (1 << new Date(day).getUTCDay()))) continue;
      const start = localBoundary(day, window.start, schedule.timezone, 'earlier');
      const end = localBoundary(day + (timeToMinutes(window.end) < timeToMinutes(window.start) ? 86_400_000 : 0), window.end, schedule.timezone, 'later');
      if (start > from.getTime() && start < to.getTime()) boundaries.add(start);
      if (end > from.getTime() && end < to.getTime()) boundaries.add(end);
    }
  }
  return [...boundaries].sort((a, b) => a - b).map((value) => new Date(value));
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
