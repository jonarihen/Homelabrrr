import test from 'node:test';
import assert from 'node:assert/strict';
import { csvCell, csvLine } from './csv.ts';

test('CSV export neutralizes spreadsheet formulas and quotes separators', () => {
  for (const value of ['=HYPERLINK("x")', '+1+1', '-2+3', '@SUM(A1)', '\tcmd', '\rcmd'])
    assert.ok(csvCell(value).replace(/^"/, '').startsWith("'"), value);
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell({ numeric: '-4.00' }), '-4.00');
  assert.throws(() => csvCell({ numeric: '=1' }));
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(new Date('2026-10-08T00:00:00Z')), '2026-10-08T00:00:00.000Z');
  assert.equal(csvLine(['x', 1, { numeric: '1.50' }]), 'x,1,1.50');
});
