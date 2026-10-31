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

  // Cells never shrink below the resizable-window minimum, so a row/column
  // count that assumed smaller cells would push later windows past the area.
  // Cap the count by how many minimum cells fit and wrap the overflow onto
  // the next row/column instead.
  const minCellW = 320;
  const minCellH = 240;
  const maxCols = Math.max(1, Math.floor((areaW + gap) / (minCellW + gap)));
  const maxRows = Math.max(1, Math.floor((areaH + gap) / (minCellH + gap)));

  let cols, rows;
  if (mode === 'horizontal') {
    cols = Math.min(n, maxCols);
    rows = Math.ceil(n / cols);
  } else if (mode === 'vertical') {
    rows = Math.min(n, maxRows);
    cols = Math.ceil(n / rows);
  } else {
    // grid
    cols = Math.min(Math.ceil(Math.sqrt(n)), maxCols);
    rows = Math.ceil(n / cols);
  }

  const cellW = Math.max(minCellW, (areaW - gap * (cols - 1)) / cols);
  const cellH = Math.max(minCellH, (areaH - gap * (rows - 1)) / rows);

  return sessions.map((session, i) => {
    // Stacked mode fills each column top-to-bottom before starting the next.
    const col = mode === 'vertical' ? Math.floor(i / rows) : i % cols;
    const row = mode === 'vertical' ? i % rows : Math.floor(i / cols);

    return {
      id: session.id,
      x: Math.round(areaX + col * (cellW + gap)),
      y: Math.round(areaY + row * (cellH + gap)),
      width: Math.round(cellW),
      height: Math.round(cellH),
    };
  });
}
