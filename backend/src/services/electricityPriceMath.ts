import { parseDkkPerKwh, type PriceBasis } from './powerPolicy.ts';

export interface ContractPriceInput {
  ref: string;
  kind: 'spot' | 'fixed_all_in';
  area: 'DK1' | 'DK2';
  validFrom: Date;
  validTo: Date | null;
  fixedRate: string | null;
  marginRate: string | null;
  vatRate: string | null;
  requiredComponents: string[] | null;
  revision: number;
}
export interface TariffPriceInput { component: string; validFrom: Date; validTo: Date; rate: string; vatIncluded: boolean; provenance: string; revision: number }
export interface SpotPriceInput { area: string; startUtc: Date; endUtc: Date; rate: string; revision: string; fetchedAt: Date }
export interface ApplicablePrice {
  status: 'valid' | 'incomplete';
  reason: string | null;
  dkk_per_kwh: string | null;
  currency: 'DKK';
  start_utc: string | null;
  end_utc: string | null;
  area: string;
  contract_ref: string;
  basis: PriceBasis;
  components: Array<{ component: string; dkk_per_kwh: string; provenance: string; vat_included: boolean }>;
  contract_revision: string;
  source_revision: string;
  fetched_at: string | null;
  known_horizon: string | null;
}

function format(micros: bigint): string {
  return `${micros < 0n ? '-' : ''}${(micros < 0n ? -micros : micros) / 1_000_000n}.${String((micros < 0n ? -micros : micros) % 1_000_000n).padStart(6, '0')}`;
}
function validDate(date: Date): boolean { return date instanceof Date && Number.isFinite(date.getTime()); }
function incomplete(contract: ContractPriceInput, basis: PriceBasis, reason: string): ApplicablePrice {
  return { status: 'incomplete', reason, dkk_per_kwh: null, currency: 'DKK', start_utc: null, end_utc: null,
    area: contract.area, contract_ref: contract.ref, basis, components: [], contract_revision: String(contract.revision), source_revision: '', fetched_at: null, known_horizon: null };
}
function minDate(...dates: Date[]): Date { return new Date(Math.min(...dates.map((d) => d.getTime()))); }
function maxDate(...dates: Date[]): Date { return new Date(Math.max(...dates.map((d) => d.getTime()))); }
function vatMicros(value: bigint, vatRate: string): bigint {
  const rate = parseDkkPerKwh(vatRate);
  if (rate < 0n || rate > 1_000_000n) throw new Error('Invalid VAT fraction');
  const amount = value * (1_000_000n + rate);
  return amount < 0n ? -((-amount + 500_000n) / 1_000_000n) : (amount + 500_000n) / 1_000_000n;
}

// Pure resolver: no provider fetch, meter access or hardware side effects.
// Unknown terms fail closed; published spot is never a retail-price substitute.
export function resolveApplicablePrice(at: Date, contract: ContractPriceInput, tariffs: TariffPriceInput[], spot: SpotPriceInput | null, basis: PriceBasis): ApplicablePrice {
  if (!validDate(at) || !validDate(contract.validFrom) || (contract.validTo && !validDate(contract.validTo))) throw new Error('Invalid price evaluation date');
  if (at < contract.validFrom || (contract.validTo && at >= contract.validTo)) return incomplete(contract, basis, 'CONTRACT_OUTSIDE_VALIDITY');
  if (basis !== 'variable_retail_including_vat' && basis !== 'spot_only_excluding_retail_additions') throw new Error('Invalid pricing basis');
  if (contract.kind === 'fixed_all_in') {
    if (basis === 'spot_only_excluding_retail_additions') return incomplete(contract, basis, 'SPOT_BASIS_NOT_APPLICABLE');
    if (contract.fixedRate == null) return incomplete(contract, basis, 'FIXED_RATE_MISSING');
    const micros = parseDkkPerKwh(contract.fixedRate);
    const end = contract.validTo?.toISOString() || new Date(at.getTime() + 24 * 3600_000).toISOString();
    return { status: 'valid', reason: null, dkk_per_kwh: format(micros), currency: 'DKK', start_utc: contract.validFrom.toISOString(), end_utc: end,
      area: contract.area, contract_ref: contract.ref, basis, components: [{ component: 'fixed_all_in', dkk_per_kwh: format(micros), provenance: 'contract', vat_included: true }],
      contract_revision: String(contract.revision), source_revision: `fixed:${contract.revision}`, fetched_at: null, known_horizon: end };
  }
  if (contract.kind !== 'spot') return incomplete(contract, basis, 'CONTRACT_KIND_UNKNOWN');
  if (!spot || spot.area !== contract.area || !validDate(spot.startUtc) || !validDate(spot.endUtc) || at < spot.startUtc || at >= spot.endUtc) return incomplete(contract, basis, 'CURRENT_SPOT_UNAVAILABLE');
  const base = parseDkkPerKwh(spot.rate);
  const components: ApplicablePrice['components'] = [{ component: 'day_ahead_spot', dkk_per_kwh: format(base), provenance: 'Energi Data Service DayAheadPrices', vat_included: false }];
  const begin = maxDate(contract.validFrom, spot.startUtc);
  let end = contract.validTo ? minDate(contract.validTo, spot.endUtc) : spot.endUtc;
  if (basis === 'spot_only_excluding_retail_additions') return { status: 'valid', reason: null, dkk_per_kwh: format(base), currency: 'DKK', start_utc: begin.toISOString(), end_utc: end.toISOString(),
    area: contract.area, contract_ref: contract.ref, basis, components, contract_revision: String(contract.revision), source_revision: spot.revision, fetched_at: spot.fetchedAt.toISOString(), known_horizon: spot.endUtc.toISOString() };
  if (contract.marginRate == null || contract.vatRate == null || !Array.isArray(contract.requiredComponents)) return incomplete(contract, basis, 'RETAIL_TERMS_INCOMPLETE');
  let taxable = base + parseDkkPerKwh(contract.marginRate);
  let vatIncluded = 0n;
  components.push({ component: 'retailer_margin', dkk_per_kwh: format(parseDkkPerKwh(contract.marginRate)), provenance: 'contract', vat_included: false });
  const selected = new Set<string>();
  for (const component of contract.requiredComponents) {
    if (!/^(network|system|tax|retailer)$/.test(component) || selected.has(component)) return incomplete(contract, basis, 'TARIFF_COMPONENTS_INVALID');
    selected.add(component);
    const applicable = tariffs.filter((item) => item.component === component && item.validFrom <= at && at < item.validTo);
    if (applicable.length !== 1) return incomplete(contract, basis, `TARIFF_${component.toUpperCase()}_${applicable.length ? 'OVERLAP' : 'MISSING'}`);
    const item = applicable[0];
    const micros = parseDkkPerKwh(item.rate);
    if (item.vatIncluded) vatIncluded += micros;
    else taxable += micros;
    components.push({ component, dkk_per_kwh: format(micros), provenance: item.provenance, vat_included: item.vatIncluded });
    if (item.validFrom > begin) begin.setTime(item.validFrom.getTime());
    end = minDate(end, item.validTo);
  }
  const total = vatMicros(taxable, contract.vatRate) + vatIncluded;
  components.push({ component: 'vat', dkk_per_kwh: format(vatMicros(taxable, contract.vatRate) - taxable), provenance: `contract VAT fraction ${contract.vatRate}`, vat_included: true });
  return { status: 'valid', reason: null, dkk_per_kwh: format(total), currency: 'DKK', start_utc: begin.toISOString(), end_utc: end.toISOString(),
    area: contract.area, contract_ref: contract.ref, basis, components, contract_revision: String(contract.revision),
    source_revision: `${spot.revision}:${tariffs.filter((item) => selected.has(item.component) && item.validFrom <= at && at < item.validTo).map((item) => item.revision).join('.')}`,
    fetched_at: spot.fetchedAt.toISOString(), known_horizon: spot.endUtc.toISOString() };
}
