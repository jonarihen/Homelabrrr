import test from 'node:test';
import assert from 'node:assert/strict';
import { fitToViewport } from './fitToViewport.js';

test('a window that already fits is returned unchanged', () => {
  const rect = { id: 'a', x: 260, y: 68, width: 1040, height: 720 };
  assert.equal(fitToViewport(rect, { width: 1440, height: 900 }), rect);
});

test('a desktop-sized window shrinks and moves inside a phone viewport', () => {
  const fitted = fitToViewport({ id: 'a', x: 56, y: 68, width: 440, height: 720 }, { width: 375, height: 667 });
  assert.deepEqual(fitted, { id: 'a', x: 8, y: 8, width: 359, height: 587 });
});

test('a window pushed past the right and bottom edges is pulled back', () => {
  const fitted = fitToViewport({ x: 900, y: 800, width: 400, height: 300 }, { width: 1024, height: 768 }, 12);
  assert.deepEqual(fitted, { x: 612, y: 396, width: 400, height: 300 });
});

test('a window above or left of the viewport is pulled back to the margin', () => {
  assert.deepEqual(fitToViewport({ x: -50, y: -20, width: 100, height: 100 }, { width: 800, height: 600 }), { x: 8, y: 8, width: 100, height: 100 });
});

test('a window near the bottom is pulled up to leave room for the console dock', () => {
  const fitted = fitToViewport({ x: 10, y: 500, width: 300, height: 200 }, { width: 375, height: 667 });
  assert.deepEqual(fitted, { x: 10, y: 395, width: 300, height: 200 });
  assert.equal(fitted.y + fitted.height, 667 - 72);
});

test('a window taller than the dock-free area is shrunk instead of covering the dock', () => {
  const fitted = fitToViewport({ x: 0, y: 0, width: 375, height: 720 }, { width: 375, height: 667 });
  assert.deepEqual(fitted, { x: 8, y: 8, width: 359, height: 587 });
});
