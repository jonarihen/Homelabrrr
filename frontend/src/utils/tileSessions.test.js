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

test('two sessions tile without overlap at a 320px viewport', () => {
  for (const mode of ['grid', 'horizontal', 'vertical']) {
    const layout = computeTileLayout(vms(2), mode, { width: 320, height: 700 });
    assertNoOverlap(layout);
    for (const tile of layout) {
      assert.ok(tile.x >= 0 && tile.x + tile.width <= 320, `${mode}: tile ${tile.id} exceeds the viewport horizontally`);
      assert.ok(tile.y >= 0 && tile.y + tile.height <= 700 - 72, `${mode}: tile ${tile.id} covers the dock area`);
    }
  }
});

test('four sessions tile without overlap at phone width', () => {
  const layout = computeTileLayout(vms(4), 'grid', { width: 375, height: 740 });
  assertNoOverlap(layout);
});

test('desktop tiling is unchanged by the narrow-viewport fix', () => {
  const layout = computeTileLayout(vms(2), 'horizontal', { width: 1440, height: 900 });
  assert.deepEqual(layout.map(({ id, x, y, width, height }) => ({ id, x, y, width, height })), [
    { id: 's1', x: 260, y: 80, width: 580, height: 748 },
    { id: 's2', x: 848, y: 80, width: 580, height: 748 },
  ]);
});
