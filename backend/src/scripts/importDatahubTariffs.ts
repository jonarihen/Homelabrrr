// Imports published grid, system and tax tariffs from Energi Data Service
// (DatahubPricelist) into one electricity contract as concrete, contiguous
// local-hour intervals (Europe/Copenhagen, DST-aware). Dry run by default.
//
//   npm run import-datahub-tariffs -- --contract 1 \
//     --network 5790000705184:30TR_C_ET \
//     --system 5790000432752:40000+5790000432752:41000 \
//     --tax 5790000432752:EA-001 [--until 2028-01-01] [--apply]
//
//   npm run import-datahub-tariffs -- --contract 1 --auto [--until 2028-01-01] [--apply]
//
// --auto looks up network, system and tax charges from the selected meter's
// latest ElOverblik charge snapshot. An explicit component flag overrides it.
//
// Rates are stored excluding VAT (vat_included = false); the contract's VAT
// fraction is applied once by the price resolver. Fixed subscriptions (D01
// charges) are not imported: they stay in the contract's monthly fee.
import { and, desc, eq, gt, lt, sql } from 'drizzle-orm';
import { db, pool } from '../db/client.ts';
import { electricityContracts, electricityTariffs, eloverblikChargeObservations, eloverblikChargeSnapshots, eloverblikConnections } from '../db/schema/index.ts';
import { logSystemAudit } from '../utils/audit.ts';
import { assertContiguous, datahubPeriods, formatMicros, hourlyRates, mergeHourlyRates, sumHourlyRates, type DatahubChargeRecord } from '../services/datahubTariffs.ts';
import { discoverTariffSources, type DiscoveredComponent, type DiscoveredTariffs } from '../services/datahubTariffDiscovery.ts';

const SOURCE = 'https://api.energidataservice.dk/dataset/DatahubPricelist';
const COMPONENTS = ['network', 'system', 'tax', 'retailer'] as const;
const HOUR_MS = 3_600_000;

function args() {
  const out: Record<string, string | true> = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) throw new Error(`Unexpected argument ${argv[i]}`);
    const key = argv[i].slice(2);
    if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[key] = argv[++i]; else out[key] = true;
  }
  return out;
}
function sources(spec: string) {
  return spec.split('+').map((part) => {
    const [gln, code] = part.split(':');
    if (!/^\d{13}$/.test(gln || '') || !code) throw new Error(`Invalid source ${part}; expected <13-digit GLN>:<ChargeTypeCode>`);
    return { gln, code };
  });
}
async function fetchCharges(gln: string, code: string): Promise<DatahubChargeRecord[]> {
  const url = `${SOURCE}?filter=${encodeURIComponent(JSON.stringify({ GLN_Number: [gln], ChargeTypeCode: [code] }))}&limit=10000`;
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (response.status === 429) {
      const wait = Number(/(\d+) seconds/.exec(await response.text())?.[1] || 60);
      process.stdout.write(`rate limited, waiting ${wait}s\n`);
      await new Promise((resolve) => setTimeout(resolve, (wait + 1) * 1000));
      continue;
    }
    if (!response.ok) throw new Error(`Datahub request failed (${response.status}) for ${gln}:${code}`);
    const body = await response.json() as { records?: DatahubChargeRecord[] };
    if (!Array.isArray(body.records)) throw new Error('Invalid Datahub response');
    return body.records.filter((row) => row.GLN_Number === gln);
  }
  throw new Error('Datahub kept rate limiting');
}

async function latestChargeSnapshot(): Promise<{ payload: unknown; lastObservedAt: Date }> {
  const [connection] = await db.select({ meterId: eloverblikConnections.selected_meter_id }).from(eloverblikConnections).limit(1);
  if (!connection?.meterId) throw new Error('--auto needs a selected ElOverblik meter');
  const [latest] = await db.select({ payload: eloverblikChargeSnapshots.source_payload, lastObservedAt: eloverblikChargeObservations.last_observed_at })
    .from(eloverblikChargeObservations).innerJoin(eloverblikChargeSnapshots, eq(eloverblikChargeObservations.snapshot_id, eloverblikChargeSnapshots.id))
    .where(eq(eloverblikChargeObservations.meter_id, connection.meterId))
    .orderBy(desc(eloverblikChargeObservations.first_observed_at), desc(eloverblikChargeObservations.id)).limit(1);
  if (!latest) throw new Error('--auto needs a stored ElOverblik charge snapshot; run a meter sync first');
  return latest;
}
function autoSources(found: DiscoveredTariffs, component: string) {
  if (component === 'retailer') return [];
  if (component === 'network' && found.networkOwners.length > 1) throw new Error(`--auto found several non-Energinet charge owners (${found.networkOwners.join(', ')}); pass --network GLN:CODE`);
  const sources = found.sources[component as DiscoveredComponent];
  if (!sources.length) throw new Error(`--auto found no ${component} tariff in the charge snapshot; pass --${component} GLN:CODE`);
  return sources;
}

const opts = args();
const contractId = Number(opts.contract);
if (!Number.isSafeInteger(contractId) || contractId < 1) throw new Error('Usage: --contract <id> (--auto | --network GLN:CODE [--system GLN:CODE+GLN:CODE] [--tax GLN:CODE]) [--until YYYY-MM-DD] [--apply]');
const until = typeof opts.until === 'string' ? new Date(`${opts.until}T00:00:00Z`) : null;
try {
  const [contract] = await db.select().from(electricityContracts).where(eq(electricityContracts.id, contractId)).limit(1);
  if (!contract) throw new Error('Contract not found');
  const windowStart = new Date(Math.ceil(contract.valid_from.getTime() / HOUR_MS) * HOUR_MS);
  let discovered: DiscoveredTariffs | null = null;
  if (opts.auto === true) {
    const snapshot = await latestChargeSnapshot();
    discovered = discoverTariffSources(snapshot.payload, new Date());
    process.stdout.write(`Charge snapshot last observed ${snapshot.lastObservedAt.toISOString()}\n`);
  }
  const plans: Array<{ component: string; intervals: ReturnType<typeof mergeHourlyRates>; provenance: string }> = [];
  for (const component of COMPONENTS) {
    const spec = opts[component];
    const wanted = typeof spec === 'string' ? sources(spec).map((source) => ({ ...source, zeroRated: false })) : discovered ? autoSources(discovered, component) : [];
    if (!wanted.length) continue;
    const maps: Map<number, bigint>[] = [];
    const notes: string[] = [];
    for (const { gln, code, zeroRated } of wanted) {
      process.stdout.write(`${component}: ${gln}:${code}\n`);
      const periods = datahubPeriods(await fetchCharges(gln, code), code);
      if (!periods.length && zeroRated) { process.stdout.write(`  skipped: ${code} is zero-rated and not published\n`); continue; }
      if (!periods.length) throw new Error(`No ${code} charges published for ${gln}`);
      const lastEnd = periods[periods.length - 1].endUtc ?? until;
      if (!lastEnd) throw new Error(`${gln}:${code} is open-ended; pass --until`);
      const windowEnd = new Date(Math.min(lastEnd.getTime(), until?.getTime() ?? Infinity, contract.valid_to?.getTime() ?? Infinity));
      maps.push(hourlyRates(periods, windowStart, windowEnd));
      notes.push(`${periods[0].source.split(' from ')[0]}`);
    }
    if (!maps.length) throw new Error(`No published ${component} charges`);
    const intervals = mergeHourlyRates(maps.length > 1 ? sumHourlyRates(...maps) : maps[0]);
    if (!intervals.length) throw new Error(`No ${component} coverage after the contract start`);
    if (intervals[0].startUtc.getTime() !== windowStart.getTime()) throw new Error(`${component} coverage starts ${intervals[0].startUtc.toISOString()}, after the contract start ${windowStart.toISOString()}`);
    assertContiguous(intervals);
    plans.push({ component, intervals, provenance: `Energi Data Service DatahubPricelist: ${notes.join(' + ')}; local-hour schedule ${'Europe/Copenhagen'}; excl. VAT` });
  }
  if (!plans.length) throw new Error('Nothing to import: pass --auto or at least one of --network, --system, --tax, --retailer');
  for (const plan of plans) {
    const rates = [...new Set(plan.intervals.map((item) => formatMicros(item.micros)))];
    process.stdout.write(`${plan.component}: ${plan.intervals.length} intervals ${plan.intervals[0].startUtc.toISOString()} → ${plan.intervals[plan.intervals.length - 1].endUtc.toISOString()}; ${rates.length} distinct rates (${rates.slice(0, 12).join(', ')}${rates.length > 12 ? ', …' : ''})\n`);
  }
  if (opts.apply !== true) { process.stdout.write('Dry run: nothing written. Re-run with --apply to store.\n'); }
  else {
    const inserted = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(237002)`);
      let count = 0;
      for (const plan of plans) {
        const first = plan.intervals[0].startUtc; const last = plan.intervals[plan.intervals.length - 1].endUtc;
        const existing = await tx.select({ id: electricityTariffs.id }).from(electricityTariffs).where(and(eq(electricityTariffs.contract_id, contractId), eq(electricityTariffs.component, plan.component), lt(electricityTariffs.valid_from, last), gt(electricityTariffs.valid_to, first))).limit(1);
        if (existing.length) throw new Error(`OVERLAPPING_TARIFF: contract ${contractId} already has ${plan.component} tariffs in ${first.toISOString()} → ${last.toISOString()}`);
        for (let i = 0; i < plan.intervals.length; i += 500) {
          await tx.insert(electricityTariffs).values(plan.intervals.slice(i, i + 500).map((item) => ({ contract_id: contractId, component: plan.component,
            valid_from: item.startUtc, valid_to: item.endUtc, dkk_per_kwh: formatMicros(item.micros), vat_included: false, provenance: plan.provenance })));
        }
        count += plan.intervals.length;
      }
      return count;
    });
    for (const plan of plans) await logSystemAudit('electricity_tariffs_imported', String(contractId), `component=${plan.component}; intervals=${plan.intervals.length}; ${plan.intervals[0].startUtc.toISOString()}..${plan.intervals[plan.intervals.length - 1].endUtc.toISOString()}`, 'datahub-tariff-import');
    process.stdout.write(`Stored ${inserted} tariff intervals on contract ${contractId}.\n`);
  }
} finally {
  await pool.end();
}
