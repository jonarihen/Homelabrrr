export interface WattSample {
  hardwareId: number;
  observedAt: Date;
  watts: number;
  deviceEpoch?: string | null;
}

export interface EnergyInterval {
  hardwareId: number;
  startUtc: Date;
  endUtc: Date;
  kwh: string;
  coveredSeconds: number;
  expectedSeconds: number;
  quality: 'integrated_partial' | 'integrated_complete';
  methodVersion: 'trapezoid_v1';
}

const BUCKET_MS = 15 * 60 * 1000;
const KWH_SCALE = 1_000_000_000n;

function assertSample(sample: WattSample): void {
  if (!Number.isSafeInteger(sample.hardwareId) || sample.hardwareId < 1
    || !(sample.observedAt instanceof Date) || !Number.isFinite(sample.observedAt.getTime())
    || !Number.isFinite(sample.watts) || sample.watts < 0 || sample.watts > 100_000) {
    throw new Error('Invalid hardware power sample');
  }
}

// kWh is stored to nine decimal places. Rounding happens once per bucket, after all
// segment integrals have been accumulated. Caller must retain sample provenance.
function formatKwh(wattMilliseconds: number): string {
  const units = BigInt(Math.round(wattMilliseconds * Number(KWH_SCALE) / 3_600_000_000));
  const whole = units / KWH_SCALE;
  const fraction = String(units % KWH_SCALE).padStart(9, '0');
  return `${whole}.${fraction}`;
}

// Samples are instantaneous input watts. We interpolate linearly only between
// consecutive valid readings; a gap over maxGapMs and an epoch change have no
// coverage. Re-running with the same samples yields identical bucket values.
export function integrateWattSamples(
  samples: WattSample[],
  options: { intervalMs?: number; maxGapMs?: number } = {},
): EnergyInterval[] {
  const intervalMs = options.intervalMs ?? 60_000;
  const maxGapMs = options.maxGapMs ?? intervalMs * 3;
  if (!Number.isInteger(intervalMs) || intervalMs < 1_000
    || !Number.isInteger(maxGapMs) || maxGapMs < intervalMs) {
    throw new Error('Invalid sampling interval or gap limit');
  }
  for (const sample of samples) assertSample(sample);
  const ordered = [...samples].sort((a, b) => a.hardwareId - b.hardwareId
    || a.observedAt.getTime() - b.observedAt.getTime());
  const buckets = new Map<string, { hardwareId: number; start: number; wattMs: number; coveredMs: number }>();
  for (let i = 1; i < ordered.length; i += 1) {
    const previous = ordered[i - 1];
    const current = ordered[i];
    if (previous.hardwareId !== current.hardwareId) continue;
    if (previous.deviceEpoch !== current.deviceEpoch) continue;
    const startMs = previous.observedAt.getTime();
    const endMs = current.observedAt.getTime();
    const gap = endMs - startMs;
    if (gap <= 0 || gap > maxGapMs) continue;
    let cursor = startMs;
    while (cursor < endMs) {
      const bucketStart = Math.floor(cursor / BUCKET_MS) * BUCKET_MS;
      const segmentEnd = Math.min(endMs, bucketStart + BUCKET_MS);
      const beginningWatts = previous.watts + (current.watts - previous.watts) * ((cursor - startMs) / gap);
      const endingWatts = previous.watts + (current.watts - previous.watts) * ((segmentEnd - startMs) / gap);
      const key = `${previous.hardwareId}:${bucketStart}`;
      const bucket = buckets.get(key) ?? { hardwareId: previous.hardwareId, start: bucketStart, wattMs: 0, coveredMs: 0 };
      bucket.wattMs += (beginningWatts + endingWatts) / 2 * (segmentEnd - cursor);
      bucket.coveredMs += segmentEnd - cursor;
      buckets.set(key, bucket);
      cursor = segmentEnd;
    }
  }
  return [...buckets.values()].sort((a, b) => a.hardwareId - b.hardwareId || a.start - b.start).map((bucket) => ({
    hardwareId: bucket.hardwareId,
    startUtc: new Date(bucket.start),
    endUtc: new Date(bucket.start + BUCKET_MS),
    kwh: formatKwh(bucket.wattMs),
    coveredSeconds: bucket.coveredMs / 1000,
    expectedSeconds: BUCKET_MS / 1000,
    quality: bucket.coveredMs === BUCKET_MS ? 'integrated_complete' : 'integrated_partial',
    methodVersion: 'trapezoid_v1',
  }));
}
