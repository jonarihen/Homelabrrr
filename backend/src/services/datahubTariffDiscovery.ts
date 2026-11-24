// Finds which DatahubPricelist charges apply to the selected meter from its
// stored ElOverblik `getcharges` snapshot, where a tariff's `owner` is the
// charge owner's GLN and `priceId` is the Datahub ChargeTypeCode.
//
// Only the identity of each charge is used. A snapshot says what the source
// reported when it was observed, so rates and their effective dates still come
// from DatahubPricelist.

export const ENERGINET_GLN = '5790000432752';

export type DiscoveredComponent = 'network' | 'system' | 'tax';
export interface DiscoveredSource { gln: string; code: string; name: string; zeroRated: boolean }
export interface DiscoveredTariffs {
  sources: Record<DiscoveredComponent, DiscoveredSource[]>;
  // More than one non-Energinet owner: which one is the grid company is unknown,
  // so `sources.network` stays empty rather than billing a retailer's charge as grid.
  networkOwners: string[];
}

function instant(value: unknown): number {
  const at = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(at)) throw new Error('INVALID_CHARGE_SNAPSHOT');
  return at;
}

export function discoverTariffSources(payload: unknown, at: Date): DiscoveredTariffs {
  const tariffs = (payload as { tariffs?: unknown } | null)?.tariffs;
  if (!Array.isArray(tariffs)) throw new Error('INVALID_CHARGE_SNAPSHOT');
  const sources: DiscoveredTariffs['sources'] = { network: [], system: [], tax: [] };
  const networkCandidates: DiscoveredSource[] = [];
  const seen = new Set<string>();
  for (const tariff of tariffs) {
    const gln = tariff?.owner; const code = tariff?.priceId;
    if (typeof gln !== 'string' || !/^\d{13}$/.test(gln) || typeof code !== 'string' || !code) throw new Error('INVALID_CHARGE_SNAPSHOT');
    if (instant(tariff.validFromDate) > at.getTime()) continue;
    if (tariff.validToDate && instant(tariff.validToDate) <= at.getTime()) continue;
    const key = `${gln}:${code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const name = typeof tariff.name === 'string' ? tariff.name : code;
    const prices = Array.isArray(tariff.prices) ? tariff.prices : [];
    const source = { gln, code, name, zeroRated: prices.length > 0 && prices.every((item: { price?: unknown }) => Number(item?.price) === 0) };
    if (gln !== ENERGINET_GLN) networkCandidates.push(source);
    else if (code.startsWith('EA-') || /elafgift/i.test(name)) sources.tax.push(source);
    else sources.system.push(source);
  }
  const networkOwners = [...new Set(networkCandidates.map((source) => source.gln))];
  if (networkOwners.length === 1) sources.network = networkCandidates;
  return { sources, networkOwners };
}
