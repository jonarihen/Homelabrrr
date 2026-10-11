// CSV serialization for private admin exports. Text cells that a spreadsheet
// would interpret as a formula (leading =, +, -, @, tab or CR) are prefixed
// with an apostrophe; numeric cells we generate ourselves are passed as
// `{ numeric: string }` so a negative amount stays a number.
export type CsvCell = string | number | null | undefined | Date | { numeric: string };

export function csvCell(value: CsvCell): string {
  if (value === null || value === undefined) return '';
  let text: string;
  if (value instanceof Date) text = value.toISOString();
  else if (typeof value === 'number') text = Number.isFinite(value) ? String(value) : '';
  else if (typeof value === 'object') {
    if (!/^-?\d+(?:\.\d+)?$/.test(value.numeric)) throw new Error('Invalid numeric CSV cell');
    text = value.numeric;
  } else {
    text = value;
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  }
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function csvLine(cells: CsvCell[]): string {
  return cells.map(csvCell).join(',');
}
