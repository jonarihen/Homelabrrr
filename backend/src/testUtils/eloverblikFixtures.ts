// Sanitized fake ElOverblik Customer API envelopes for tests. Shapes follow the
// official Customer API Swagger as verified on 2026-10-08 (see
// docs/eloverblik.md). Values, IDs and tokens are synthetic; tests never call
// the real service.
import { startOfLocalDateUtc } from '../services/energyAccounting.ts';

export const FIXTURE_METER = '571313180000000001';
export const OTHER_FIXTURE_METER = '571313180000000002';

// A syntactically valid, unsigned JWT with only an exp claim.
export function fixtureAccessToken(expSeconds: number, tag = 'a'): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ exp: expSeconds, tag })}.`;
}

export function meterListEnvelope(meters: Array<{ id: string | number; hasRelation?: boolean }>) {
  return { result: meters.map((meter) => ({ meteringPointId: meter.id, typeOfMP: 'E17', hasRelation: meter.hasRelation ?? true,
    streetName: 'Synthetic Street', postcode: '0000', cityName: 'Fixture' })) };
}

function localDays(from: string, to: string): string[] {
  const days: string[] = [];
  for (let day = new Date(`${from}T00:00:00Z`); day < new Date(`${to}T00:00:00Z`); day = new Date(day.getTime() + 86_400_000)) days.push(day.toISOString().slice(0, 10));
  return days;
}

// One PT1H period per Danish calendar day in [from, to), 23/24/25 points on
// DST days. Days before `dataFrom` are absent (not yet metered). `quantity`
// picks the value for each point.
export function timeSeriesEnvelope(meterId: string, from: string, to: string, { dataFrom = from, quantity = () => '0.250' as unknown }:
  { dataFrom?: string; quantity?: (day: string, position: number) => unknown } = {}) {
  const periods = localDays(from, to).filter((day) => day >= dataFrom).map((day) => {
    const start = startOfLocalDateUtc(day);
    const next = new Date(`${day}T00:00:00Z`); next.setUTCDate(next.getUTCDate() + 1);
    const end = startOfLocalDateUtc(next.toISOString().slice(0, 10));
    const hours = (end.getTime() - start.getTime()) / 3_600_000;
    return { resolution: 'PT1H', timeInterval: { start: start.toISOString(), end: end.toISOString() },
      Point: Array.from({ length: hours }, (_, index) => ({ position: String(index + 1), 'out_Quantity.quantity': quantity(day, index + 1), 'out_Quantity.quality': 'A04' })) };
  });
  return { result: [{ id: meterId, success: true, errorCode: 10000, errorText: 'NoError', stackTrace: null,
    MyEnergyData_MarketDocument: { mRID: 'fixture-document', createdDateTime: '2026-10-08T00:00:00Z',
      TimeSeries: [{ mRID: meterId, businessType: 'A04', curveType: 'A01', 'measurement_Unit.name': 'KWH', Period: periods }] } }] };
}

export function chargesEnvelope(meterId: string, tariffPrice: string) {
  return { result: [{ id: meterId, success: true, errorCode: 10000, errorText: 'NoError',
    result: { fees: [], subscriptions: [{ name: 'Synthetic subscription', price: 20, quantity: 1 }],
      tariffs: [{ name: 'Synthetic network tariff', periodType: 'P1H', prices: [{ position: '1', price: tariffPrice }] }] } }] };
}
