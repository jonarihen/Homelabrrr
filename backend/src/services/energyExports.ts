import { csvLine, type CsvCell } from '../utils/csv.ts';
import type { adminBudgetRecords } from './energyDashboard.ts';

// CSV exports for the Energy & Budget page. Both go through utils/csv.ts, so
// text cells that a spreadsheet would evaluate as a formula are neutralized.

function cell(value: unknown): CsvCell {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

/** Flattens a member DTO to `field,value` rows: exactly the fields the API returned, nothing more. */
export function flattenDto(value: unknown, prefix = '', rows: Array<[string, CsvCell]> = []): Array<[string, CsvCell]> {
  if (rows.length > 5000) throw new Error('EXPORT_TOO_LARGE');
  if (Array.isArray(value)) {
    if (!value.length) rows.push([prefix, null]);
    value.forEach((item, index) => flattenDto(item, `${prefix}.${index}`, rows));
  } else if (value && typeof value === 'object' && !(value instanceof Date)) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (!entries.length) rows.push([prefix, null]);
    for (const [key, item] of entries) flattenDto(item, prefix ? `${prefix}.${key}` : key, rows);
  } else rows.push([prefix, cell(value)]);
  return rows;
}

export function memberSummaryCsv(summary: unknown): string {
  const lines = [csvLine(['field', 'value']), ...flattenDto(summary).map(([field, value]) => csvLine([field, value]))];
  return `${lines.join('\r\n')}\r\n`;
}

function dkk(ore: unknown): CsvCell {
  const text = typeof ore === 'number' && Number.isSafeInteger(ore) ? String(ore) : typeof ore === 'string' && /^-?\d+$/.test(ore) ? ore : null;
  if (text === null) return null;
  const negative = text.startsWith('-');
  const digits = (negative ? text.slice(1) : text).padStart(3, '0');
  return { numeric: `${negative ? '-' : ''}${digits.slice(0, -2).replace(/^0+(?=\d)/, '')}.${digits.slice(-2)}` };
}
function copenhagenMonthOf(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Copenhagen', year: 'numeric', month: '2-digit' }).format(date);
}

const ADMIN_COLUMNS = ['record_type', 'month', 'record_id', 'revision', 'previous_id', 'created_at', 'status', 'contract_id',
  'cost_statement_id', 'ledger_revision', 'lab_cost_dkk', 'variable_cost_dkk', 'allocated_fixed_fee_dkk', 'fixed_fee_status',
  'variable_cost_complete', 'lab_kwh', 'lab_covered_seconds', 'expected_seconds', 'partial_acknowledged',
  'opening_credit_dkk', 'received_net_dkk', 'applied_dkk', 'owner_remainder_dkk', 'owner_adjustment_dkk', 'closing_balance_dkk', 'unresolved_count'];

/**
 * Private admin export of the calculation and allocation records behind each
 * month. Selected calculation fields only, never the raw statement JSON
 * (which embeds household comparison/bill details). Allocations are live-only
 * by construction, so sandbox money never appears.
 */
export function adminBudgetCsv(records: Awaited<ReturnType<typeof adminBudgetRecords>>): string {
  const lines = [csvLine(ADMIN_COLUMNS)];
  for (const row of records.statements) {
    const calc = (row.calculation ?? {}) as Record<string, unknown>;
    lines.push(csvLine(['cost_statement', copenhagenMonthOf(row.period_start), row.id, row.revision, row.previous_id, row.created_at,
      row.finalized ? calc.partialAcknowledged === true ? 'finalized_partial' : 'finalized' : 'draft', row.contract_id, null, null,
      dkk(calc.calculatedLabCostOre), dkk(calc.variableCostOre), dkk(calc.allocatedFixedFeeOre), cell(calc.fixedFeeStatus),
      cell(calc.variableCostComplete), typeof calc.labKwh === 'string' && /^\d+(?:\.\d+)?$/.test(calc.labKwh) ? { numeric: calc.labKwh } : null,
      cell(calc.labCoveredSeconds), cell(calc.expectedSeconds), cell(calc.partialAcknowledged === true),
      null, null, null, null, null, null, null]));
  }
  for (const row of records.allocations) {
    lines.push(csvLine(['allocation', row.month, row.id, row.revision, row.previous_id, row.created_at, row.status, null,
      row.cost_statement_id, row.ledger_revision, dkk(row.cost_ore), null, null, null, null, null, null, null, null,
      dkk(row.opening_balance_ore), dkk(row.received_net_ore), dkk(row.applied_ore), dkk(row.owner_remainder_ore),
      dkk(row.owner_adjustment_ore), dkk(row.closing_balance_ore), row.unresolved_count]));
  }
  return `${lines.join('\r\n')}\r\n`;
}
