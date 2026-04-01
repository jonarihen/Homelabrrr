/**
 * Compute tiled positions for console session windows.
 *
 * @param {Array<{id:string, type:string}>} sessions  Visible (non-minimized) sessions
 * @param {'grid'|'horizontal'|'vertical'} mode       Tiling mode
 * @param {{width:number, height:number}} viewport     Window dimensions
 * @returns {Array<{id:string, x:number, y:number, width:number, height:number}>}
 */
export function computeTileLayout(sessions, mode, viewport) {
  const n = sessions.length;
  if (n === 0) return [];

  const sidebarOffset = viewport.width >= 1024 ? 248 : 16;
  const topOffset = 68;
  const bottomReserve = 72;
  const margin = 12;
  const gap = 8;

  const areaX = sidebarOffset + margin;
  const areaY = topOffset + margin;
  const areaW = Math.max(360, viewport.width - sidebarOffset - margin * 2);
  const areaH = Math.max(300, viewport.height - topOffset - bottomReserve - margin);

  let cols, rows;
  if (mode === 'horizontal') {
    cols = n;
    rows = 1;
  } else if (mode === 'vertical') {
    cols = 1;
    rows = n;
  } else {
    // grid
    cols = Math.ceil(Math.sqrt(n));
    rows = Math.ceil(n / cols);
  }

  const cellW = (areaW - gap * (cols - 1)) / cols;
  const cellH = (areaH - gap * (rows - 1)) / rows;

  return sessions.map((session, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);

    return {
      id: session.id,
      x: Math.round(areaX + col * (cellW + gap)),
      y: Math.round(areaY + row * (cellH + gap)),
      width: Math.round(cellW),
      height: Math.round(cellH),
    };
  });
}
