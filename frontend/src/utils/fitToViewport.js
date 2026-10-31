/**
 * Shrink and move a floating window rect so it lies fully inside the viewport
 * with `margin` px to spare on the top/left/right, and `bottomReserve` px left
 * clear at the bottom for the console dock. Returns the same object when
 * nothing changes, so callers can skip a state update.
 */
export function fitToViewport(rect, viewport, margin = 8, bottomReserve = 72) {
  const width = Math.max(0, Math.min(rect.width, viewport.width - margin * 2));
  const height = Math.max(0, Math.min(rect.height, viewport.height - margin - bottomReserve));
  const x = Math.min(Math.max(rect.x, margin), viewport.width - width - margin);
  const y = Math.min(Math.max(rect.y, margin), viewport.height - bottomReserve - height);
  if (x === rect.x && y === rect.y && width === rect.width && height === rect.height) return rect;
  return { ...rect, x, y, width, height };
}
