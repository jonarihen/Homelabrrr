import test from 'node:test';
import assert from 'node:assert/strict';
import { computeTileLayout } from './tileSessions.js';

const vms = (n) => Array.from({ length: n }, (_, i) => ({ id: `s${i + 1}`, type: 'vnc' }));

function assertNoOverlap(layout) {
  for (let i = 0; i < layout.length; i += 1) {
    for (let j = i + 1; j < layout.length; j += 1) {
      const a = layout[i];
      const b = layout[j];
      const overlaps = a.x < b.x + b.width && a.x + a.width > b.x
        && a.y < b.y + b.height && a.y + a.height > b.y;
      assert.equal(overlaps, false, `tile ${a.id} overlaps tile ${b.id}`);
    }
  }
}

test('tiled windows are never smaller than the resizable minimum', () => {
  for (const mode of ['grid', 'horizontal', 'vertical']) {
    const layout = computeTileLayout(vms(2), mode, { width: 400, height: 300 });
    for (const tile of layout) {
      assert.ok(tile.width >= 320, `${mode}: width ${tile.width} is below the 320px minimum`);
      assert.ok(tile.height >= 240, `${mode}: height ${tile.height} is below the 240px minimum`);
    }
  }
});

test('tiles honouring the minimum size never overlap each other', () => {
  for (const mode of ['grid', 'horizontal', 'vertical']) {
    for (const n of [2, 3, 4, 6]) {
      assertNoOverlap(computeTileLayout(vms(n), mode, { width: 400, height: 300 }));
    }
  }
});

test('plenty of viewport space still yields tiles above the minimum', () => {
  const layout = computeTileLayout(vms(2), 'horizontal', { width: 1440, height: 900 });
  for (const tile of layout) {
    assert.ok(tile.width >= 320 && tile.height >= 240);
  }
});
