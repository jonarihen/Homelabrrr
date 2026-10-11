import {
  resolvePowerDecision, scheduleBoundaryInstants, type ApplicablePowerPrice,
  type PowerDecisionInput, type PowerDecision, type PriceLatch,
} from './powerPolicy.ts';

export interface PowerPreviewSegment {
  startUtc: string;
  endUtc: string;
  baseMode: PowerDecision['baseMode'];
  selectedMode: PowerDecision['target'];
  reason: PowerDecision['reason'];
  priceStatus: PowerDecision['priceStatus'];
  priceDkkPerKwh: string | null;
  priceValidUntil: string | null;
  futurePriceUnknown: boolean;
}

export interface PowerPreview {
  startUtc: string;
  endUtc: string;
  nextScheduleTransition: string | null;
  nextKnownTransition: string | null;
  segments: PowerPreviewSegment[];
}

// The worker and preview call the same resolver. Provider reads are supplied by
// the caller; this function has no side effects and never writes to hardware.
export async function buildPowerPreview(
  input: Omit<PowerDecisionInput, 'now' | 'price' | 'previousLatch'> & { now: Date; previousLatch?: PriceLatch | null },
  sourceBoundaries: Date[],
  priceAt: (at: Date) => Promise<ApplicablePowerPrice | null>,
  days = 7,
  knownAt = input.now,
): Promise<PowerPreview> {
  if (!Number.isInteger(days) || days < 1 || days > 7 || !Number.isFinite(input.now.getTime())) throw new Error('Invalid preview period');
  const end = new Date(input.now.getTime() + days * 86_400_000);
  const startMs = input.now.getTime();
  const endMs = end.getTime();
  const boundaries = [...new Set([
    startMs, endMs,
    ...scheduleBoundaryInstants(input.schedule, input.now, end).map((value) => value.getTime()),
    ...sourceBoundaries.map((value) => value.getTime()).filter((value) => Number.isFinite(value) && value > startMs && value < endMs),
    ...(input.manualOverride?.expiresAt ? [input.manualOverride.expiresAt.getTime()] : []),
  ])].filter((value) => value >= startMs && value <= endMs).sort((a, b) => a - b);
  const segments: PowerPreviewSegment[] = [];
  let latch = input.previousLatch ?? null;
  let cachedPrice: ApplicablePowerPrice | null = null;
  let nextScheduleTransition: string | null = null;
  let nextKnownTransition: string | null = null;
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const at = new Date(boundaries[index]);
    if (!cachedPrice || Date.parse(cachedPrice.end_utc) <= at.getTime()) cachedPrice = await priceAt(at);
    const decision = resolvePowerDecision({ ...input, now: at, price: cachedPrice, previousLatch: latch });
    latch = decision.latch;
    const futurePriceUnknown = input.pricePolicy.enabled && (input.pricePolicy.cheap.enabled || input.pricePolicy.expensive.enabled)
      && (index > 0 || at.getTime() > knownAt.getTime()) && decision.priceStatus !== 'valid'
      && ['schedule', 'default', 'price_unavailable_fallback'].includes(decision.reason);
    const segment: PowerPreviewSegment = {
      startUtc: at.toISOString(), endUtc: new Date(boundaries[index + 1]).toISOString(),
      baseMode: decision.baseMode, selectedMode: futurePriceUnknown ? null : decision.target,
      reason: decision.reason, priceStatus: decision.priceStatus,
      priceDkkPerKwh: decision.priceStatus === 'valid' ? cachedPrice?.dkk_per_kwh ?? null : null,
      priceValidUntil: decision.validUntil?.toISOString() ?? null, futurePriceUnknown,
    };
    const prior = segments.at(-1);
    if (prior && !nextScheduleTransition && prior.baseMode !== segment.baseMode) nextScheduleTransition = segment.startUtc;
    if (prior && !nextKnownTransition && !prior.futurePriceUnknown && !segment.futurePriceUnknown
      && prior.selectedMode !== segment.selectedMode) nextKnownTransition = segment.startUtc;
    if (prior && prior.baseMode === segment.baseMode && prior.selectedMode === segment.selectedMode
      && prior.reason === segment.reason && prior.priceStatus === segment.priceStatus
      && prior.priceDkkPerKwh === segment.priceDkkPerKwh && prior.futurePriceUnknown === segment.futurePriceUnknown) {
      prior.endUtc = segment.endUtc;
    } else segments.push(segment);
  }
  return { startUtc: input.now.toISOString(), endUtc: end.toISOString(), nextScheduleTransition, nextKnownTransition, segments };
}
