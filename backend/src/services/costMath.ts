import { parseDkkPerKwh } from './powerPolicy.ts';

export interface CostEnergyInterval {
  startUtc: Date;
  endUtc: Date;
  kwh: string; // nine decimal places are supported; represents measured/integrated energy in this interval
  coveredSeconds: number;
  expectedSeconds: number;
}

export interface CostPriceInterval {
  startUtc: Date;
  endUtc: Date;
  dkkPerKwh: string;
  status: 'valid' | 'incomplete' | 'forecast';
}

export interface CostResult {
  kwhPriced: string;
  costOre: bigint;
  energyCoveredSeconds: number;
  priceCoveredSeconds: number;
  complete: boolean;
  assumption: 'uniform_energy_within_interval';
}

const KWH_SCALE = 1_000_000_000n;
const RATE_SCALE = 1_000_000n;
const ORE_PER_DKK = 100n;

function parseKwh(value: string): bigint {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d{1,9})?$/.test(value)) {
    throw new Error('Invalid decimal kWh');
  }
  const [whole, decimal = ''] = value.split('.');
  return BigInt(whole) * KWH_SCALE + BigInt(decimal.padEnd(9, '0') || '0');
}

function formatKwh(value: bigint): string {
  return `${value / KWH_SCALE}.${String(value % KWH_SCALE).padStart(9, '0')}`;
}

function roundNearestAwayFromZero(numerator: bigint, denominator: bigint): bigint {
  if (numerator < 0n) return -roundNearestAwayFromZero(-numerator, denominator);
  return (numerator + denominator / 2n) / denominator;
}

// Price joins are on UTC instants; local days/months are chosen by the caller.
// Energy is apportioned uniformly within each source interval because a finer
// watt curve is unavailable after rollup. Missing prices stay incomplete.
export function calculateIntervalCost(
  energy: CostEnergyInterval[], prices: CostPriceInterval[],
): CostResult {
  let pricedKwhNano = 0n;
  let costUnits = 0n; // DKK at 15 decimal places, before final øre rounding
  let energyCoveredSeconds = 0;
  let priceCoveredSeconds = 0;
  let complete = true;
  const validPrices = prices.filter((price) => price.status === 'valid').sort((a, b) => a.startUtc.getTime() - b.startUtc.getTime());
  for (let index = 0; index < validPrices.length; index += 1) {
    const price = validPrices[index];
    const start = price.startUtc.getTime();
    const end = price.endUtc.getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error('Invalid price interval');
    parseDkkPerKwh(price.dkkPerKwh);
    if (index && start < validPrices[index - 1].endUtc.getTime()) throw new Error('Overlapping price intervals');
  }
  for (const interval of energy) {
    const start = interval.startUtc.getTime();
    const end = interval.endUtc.getTime();
    const duration = end - start;
    if (!Number.isFinite(start) || !Number.isFinite(end) || duration <= 0
      || !Number.isFinite(interval.coveredSeconds) || !Number.isFinite(interval.expectedSeconds)
      || interval.coveredSeconds < 0 || interval.expectedSeconds <= 0
      || interval.coveredSeconds > interval.expectedSeconds
      || interval.expectedSeconds * 1000 !== duration) throw new Error('Invalid energy interval');
    const kwhNano = parseKwh(interval.kwh);
    energyCoveredSeconds += interval.coveredSeconds;
    if (interval.coveredSeconds !== interval.expectedSeconds) complete = false;
    let matchedMs = 0;
    for (const price of validPrices) {
      const overlap = Math.max(0, Math.min(end, price.endUtc.getTime()) - Math.max(start, price.startUtc.getTime()));
      if (!overlap) continue;
      const before = matchedMs;
      matchedMs += overlap;
      // Cumulative allocation gives the final matched fragment the rounding
      // remainder, so fully priced intervals conserve their exact kWh value.
      const energyPart = kwhNano * BigInt(matchedMs) / BigInt(duration)
        - kwhNano * BigInt(before) / BigInt(duration);
      pricedKwhNano += energyPart;
      costUnits += energyPart * parseDkkPerKwh(price.dkkPerKwh);
    }
    priceCoveredSeconds += matchedMs / 1000;
    if (matchedMs !== duration) complete = false;
  }
  return {
    kwhPriced: formatKwh(pricedKwhNano),
    costOre: roundNearestAwayFromZero(costUnits * ORE_PER_DKK, KWH_SCALE * RATE_SCALE),
    energyCoveredSeconds,
    priceCoveredSeconds,
    complete,
    assumption: 'uniform_energy_within_interval',
  };
}

export interface FundingSplit {
  appliedOre: bigint;
  ownerRemainderOre: bigint;
  creditCarriedOre: bigint;
}

// The caller supplies only confirmed, known-net, live DKK credit. Payment
// ingestion owns that eligibility decision and the durable credit ledger.
export function allocateConfirmedCredit(labCostOre: bigint, availableCreditOre: bigint): FundingSplit {
  if (labCostOre < 0n || availableCreditOre < 0n) throw new Error('Cost and available credit must be nonnegative');
  const appliedOre = labCostOre < availableCreditOre ? labCostOre : availableCreditOre;
  return {
    appliedOre,
    ownerRemainderOre: labCostOre - appliedOre,
    creditCarriedOre: availableCreditOre - appliedOre,
  };
}
