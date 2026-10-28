/**
 * Shrink and move a floating window rect so it lies fully inside the viewport
 * with `margin` px to spare. Returns the same object when nothing changes, so
 * callers can skip a state update.
 */
export function fitToViewport(rect, viewport, margin = 8) {
  const width = Math.max(0, Math.min(rect.width, viewport.width - margin * 2));
  const height = Math.max(0, Math.min(rect.height, viewport.height - margin * 2));
  const x = Math.min(Math.max(rect.x, margin), viewport.width - width - margin);
  const y = Math.min(Math.max(rect.y, margin), viewport.height - height - margin);
  if (x === rect.x && y === rect.y && width === rect.width && height === rect.height) return rect;
  return { ...rect, x, y, width, height };
}
