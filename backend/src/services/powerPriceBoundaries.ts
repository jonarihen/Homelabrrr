import { and, eq, gt, lt } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { electricityContracts, electricitySpotPrices, electricityTariffs } from '../db/schema/index.ts';
import type { PowerPricePolicy } from './powerPolicy.ts';

// Instants inside [at, previewEnd) where the applicable price for a policy can
// change: contract validity, tariff validity and published spot intervals (or
// UTC midnights for fixed contracts). Read-only; shared by the admin preview
// and the member dashboard preview so both segment time identically.
export async function pricePolicyBoundaries(pricePolicy: PowerPricePolicy, at: Date, previewEnd: Date): Promise<Date[]> {
  const boundaries: Date[] = [];
  if (!pricePolicy?.enabled || !/^\d+$/.test(pricePolicy.contractRef)) return boundaries;
  const [contract] = await db.select().from(electricityContracts)
    .where(eq(electricityContracts.id, Number(pricePolicy.contractRef))).limit(1);
  if (!contract || contract.area !== pricePolicy.area) return boundaries;
  boundaries.push(contract.valid_from);
  if (contract.valid_to) boundaries.push(contract.valid_to);
  const tariffs = await db.select({ start: electricityTariffs.valid_from, end: electricityTariffs.valid_to })
    .from(electricityTariffs).where(and(eq(electricityTariffs.contract_id, contract.id),
      lt(electricityTariffs.valid_from, previewEnd), gt(electricityTariffs.valid_to, at)));
  for (const tariff of tariffs) boundaries.push(tariff.start, tariff.end);
  if (contract.kind === 'spot') {
    const spots = await db.select({ start: electricitySpotPrices.start_utc, end: electricitySpotPrices.end_utc })
      .from(electricitySpotPrices).where(and(eq(electricitySpotPrices.area, contract.area),
        lt(electricitySpotPrices.start_utc, previewEnd), gt(electricitySpotPrices.end_utc, at)));
    for (const spot of spots) boundaries.push(spot.start, spot.end);
  } else {
    for (let time = at.getTime() - at.getTime() % 86_400_000 + 86_400_000; time < previewEnd.getTime(); time += 86_400_000) {
      boundaries.push(new Date(time));
    }
  }
  return boundaries;
}
