import { parseDkkPerKwh } from './powerPolicy.ts';

const KWH_SCALE = 1_000_000_000n;
function parseKwh(value: string): bigint {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,9})?$/.test(value)) throw new Error('Invalid kWh');
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * KWH_SCALE + BigInt(fraction.padEnd(9, '0') || '0');
}
function decimal(value: bigint, scale: bigint): string { return `${value / scale}.${String(value % scale).padStart(String(scale).length - 1, '0')}`; }
function round(n: bigint, d: bigint): bigint { return (n + d / 2n) / d; }

export interface HouseholdAttribution {
  labKwh: string;
  householdKwh: string | null;
  labShare: string | null;
  status: 'comparable' | 'partial' | 'dedicated_meter' | 'scope_mismatch' | 'household_unavailable';
  diagnostic: string | null;
}
// Both values must describe the same interval/import scope. Household import
// already contains server use, so these numbers are compared, never added.
export function compareHouseholdEnergy(labKwh: string, householdKwh: string | null, labCoveredSeconds: number, householdCoveredSeconds: number, expectedSeconds: number, meterScope: 'household' | 'dedicated_lab'): HouseholdAttribution {
  const lab = parseKwh(labKwh);
  const household = householdKwh == null ? null : parseKwh(householdKwh);
  if (!Number.isSafeInteger(expectedSeconds) || expectedSeconds <= 0 || !Number.isSafeInteger(labCoveredSeconds) || !Number.isSafeInteger(householdCoveredSeconds)
    || labCoveredSeconds < 0 || householdCoveredSeconds < 0 || labCoveredSeconds > expectedSeconds || householdCoveredSeconds > expectedSeconds) throw new Error('Invalid energy coverage');
  if (household == null) return { labKwh, householdKwh, labShare: null, status: 'household_unavailable', diagnostic: 'Household meter coverage unavailable' };
  if (meterScope === 'dedicated_lab') return { labKwh, householdKwh, labShare: null, status: 'dedicated_meter', diagnostic: 'Dedicated lab meter is an alternative total, not additive to servers' };
  if (labCoveredSeconds !== expectedSeconds || householdCoveredSeconds !== expectedSeconds) return { labKwh, householdKwh, labShare: null, status: 'partial', diagnostic: 'Coverage does not span the same full interval' };
  if (household === 0n || lab > household) return { labKwh, householdKwh, labShare: null, status: 'scope_mismatch', diagnostic: 'Server energy exceeds household import or import is zero; check scope, generation and coverage' };
  const shareMillionths = round(lab * 1_000_000n, household);
  return { labKwh, householdKwh, labShare: decimal(shareMillionths, 1_000_000n), status: 'comparable', diagnostic: null };
}

export type FixedFeePolicy = { mode: 'none' } | { mode: 'manual_share'; share: string } | { mode: 'energy_proportion' };
export function allocateFixedFee(fixedFeeOre: bigint, policy: FixedFeePolicy, comparison: HouseholdAttribution): { allocatedOre: bigint; status: 'known' | 'incomplete'; method: FixedFeePolicy['mode'] } {
  if (fixedFeeOre < 0n) throw new Error('Invalid fixed fee');
  if (policy.mode === 'none') return { allocatedOre: 0n, status: 'known', method: 'none' };
  const share = policy.mode === 'manual_share' ? policy.share : comparison.status === 'comparable' ? comparison.labShare : null;
  if (share == null) return { allocatedOre: 0n, status: 'incomplete', method: policy.mode };
  const millionths = parseDkkPerKwh(share);
  if (millionths < 0n || millionths > 1_000_000n) throw new Error('Invalid fixed-fee share');
  return { allocatedOre: round(fixedFeeOre * millionths, 1_000_000n), status: 'known', method: policy.mode };
}

export interface DailyEvidence { localDate: string; kwh: string; coveredSeconds: number; expectedSeconds: number }
export interface ForecastInput {
  now: Date;
  month: string; // YYYY-MM in Europe/Copenhagen
  actualCostOre: bigint;
  dailyEvidence: DailyEvidence[];
  scenarioDkkPerKwh: string | null;
  knownFuturePrices?: Array<{ startUtc: Date; endUtc: Date; dkkPerKwh: string; status: 'valid' }>;
}
export interface MonthlyForecast {
  status: 'insufficient_data' | 'missing_price_scenario' | 'fixed_fee_incomplete' | 'scenario';
  actualCostOre: bigint;
  forecastTotalOre: bigint | null;
  futureCostOre: bigint | null;
  baselineDays: number;
  baselineCoverage: number;
  method: 'weekday_weekend_28d_v1';
  priceBasis: 'scenario' | 'published_and_scenario' | 'published' | 'unknown';
  knownPriceSeconds: number;
}
// Fixed monthly charges are allocated once to the whole month. They must not
// be prorated through the elapsed-day estimate or silently omitted from it.
export function includeMonthlyFixedFee(forecast: MonthlyForecast, allocatedOre: bigint, feeStatus: 'known' | 'incomplete'): MonthlyForecast {
  if (allocatedOre < 0n) throw new Error('Invalid fixed fee');
  if (feeStatus === 'incomplete' && forecast.forecastTotalOre !== null) return { ...forecast, status: 'fixed_fee_incomplete', forecastTotalOre: null };
  return { ...forecast, forecastTotalOre: forecast.forecastTotalOre === null ? null : forecast.forecastTotalOre + allocatedOre };
}
function calendarDate(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Copenhagen', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const item = (name: string) => parts.find((p) => p.type === name)?.value;
  return `${item('year')}-${item('month')}-${item('day')}`;
}
function weekday(localDate: string): number { return new Date(`${localDate}T12:00:00Z`).getUTCDay(); }
function monthDates(month: string): string[] {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('Invalid forecast month');
  const [year, number] = month.split('-').map(Number);
  const count = new Date(Date.UTC(year, number, 0)).getUTCDate();
  return Array.from({ length: count }, (_, index) => `${month}-${String(index + 1).padStart(2, '0')}`);
}
export function startOfLocalDateUtc(localDate: string): Date {
  const guess = Date.parse(`${localDate}T00:00:00Z`);
  let low = guess - 36 * 3600_000;
  let high = guess + 36 * 3600_000;
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (calendarDate(new Date(mid)) < localDate) low = mid;
    else high = mid;
  }
  return new Date(high);
}
export function forecastMonthlyCost(input: ForecastInput): MonthlyForecast {
  if (!Number.isFinite(input.now.getTime()) || input.actualCostOre < 0n) throw new Error('Invalid forecast input');
  const today = calendarDate(input.now);
  const dates = monthDates(input.month);
  const recent = input.dailyEvidence.filter((day) => day.localDate < today && day.localDate >= calendarDate(new Date(input.now.getTime() - 28 * 86400_000)))
    .filter((day) => day.expectedSeconds > 0 && day.coveredSeconds / day.expectedSeconds >= 0.8);
  const base = { actualCostOre: input.actualCostOre, baselineDays: recent.length, baselineCoverage: recent.length ? recent.reduce((sum, day) => sum + day.coveredSeconds / day.expectedSeconds, 0) / recent.length : 0,
    method: 'weekday_weekend_28d_v1' as const };
  const weekdays = recent.filter((day) => ![0, 6].includes(weekday(day.localDate)));
  const weekends = recent.filter((day) => [0, 6].includes(weekday(day.localDate)));
  if (recent.length < 14 || weekdays.length < 8 || weekends.length < 4) return { ...base, status: 'insufficient_data', forecastTotalOre: null, futureCostOre: null, priceBasis: 'unknown', knownPriceSeconds: 0 };
  const mean = (days: DailyEvidence[]) => round(days.reduce((sum, day) => sum + parseKwh(day.kwh) * BigInt(day.expectedSeconds) / BigInt(day.coveredSeconds), 0n), BigInt(days.length));
  const weekdayKwh = mean(weekdays);
  const weekendKwh = mean(weekends);
  const published = [...(input.knownFuturePrices || [])].sort((a, b) => a.startUtc.getTime() - b.startUtc.getTime());
  for (let i = 0; i < published.length; i++) {
    const price = published[i];
    if (price.status !== 'valid' || !Number.isFinite(price.startUtc.getTime()) || !Number.isFinite(price.endUtc.getTime()) || price.endUtc <= price.startUtc || (i && price.startUtc < published[i - 1].endUtc)) throw new Error('Invalid known future price intervals');
    parseDkkPerKwh(price.dkkPerKwh);
  }
  let futureKwh = 0n; let knownKwh = 0n; let knownCostUnits = 0n; let knownPriceSeconds = 0;
  for (const date of dates.filter((item) => item >= today)) {
    const dayStart = startOfLocalDateUtc(date).getTime();
    const [year, month, day] = date.split('-').map(Number);
    const nextDate = new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
    const nextStart = startOfLocalDateUtc(nextDate).getTime();
    const from = Math.max(dayStart, input.now.getTime());
    if (from >= nextStart) continue;
    const baseline = [0, 6].includes(weekday(date)) ? weekendKwh : weekdayKwh;
    futureKwh += baseline * BigInt(nextStart - from) / BigInt(nextStart - dayStart);
    for (const price of published) {
      const overlap = Math.max(0, Math.min(nextStart, price.endUtc.getTime()) - Math.max(from, price.startUtc.getTime()));
      if (!overlap) continue;
      const part = baseline * BigInt(overlap) / BigInt(nextStart - dayStart);
      knownKwh += part; knownCostUnits += part * parseDkkPerKwh(price.dkkPerKwh); knownPriceSeconds += overlap / 1000;
    }
  }
  const remainingKwh = futureKwh - knownKwh;
  if (remainingKwh > 0n && input.scenarioDkkPerKwh == null) return { ...base, status: 'missing_price_scenario', forecastTotalOre: null, futureCostOre: null, priceBasis: 'unknown', knownPriceSeconds };
  const scenario = input.scenarioDkkPerKwh == null ? 0n : parseDkkPerKwh(input.scenarioDkkPerKwh);
  const futureCostOre = round((knownCostUnits + remainingKwh * scenario) * 100n, KWH_SCALE * 1_000_000n);
  return { ...base, status: 'scenario', forecastTotalOre: input.actualCostOre + futureCostOre, futureCostOre, priceBasis: knownPriceSeconds ? remainingKwh > 0n ? 'published_and_scenario' : 'published' : 'scenario', knownPriceSeconds };
}
