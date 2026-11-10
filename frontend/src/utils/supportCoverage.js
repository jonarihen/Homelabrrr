// How much of the lab's electricity cost member support has covered. Works on
// the monthly aggregates only (GET /energy/months and the open month's
// GET /energy/summary), so nothing here can identify a contributor.

// PostgreSQL sums arrive as decimal strings; only whole, safe øre are used.
const ore = (value) => {
  const amount = typeof value === 'string' && /^-?\d+$/.test(value) ? Number(value) : value;
  return Number.isSafeInteger(amount) ? amount : null;
};

// A month's cost: the finalized statement once closed, the measured cost so
// far while it is still open. Null when neither is known yet.
function monthCost(month, current) {
  if (!month.open) return ore(month.costOre);
  return current?.month === month.month ? ore(current.cost?.actualOre) : null;
}

// The open month's projected total, only when the backend produced a real estimate.
function monthProjection(rows, current) {
  const estimate = current?.cost?.estimate;
  const row = rows.find((item) => item.month === current?.month && item.state !== 'finalized' && item.state !== 'not_finalized');
  const totalOre = estimate?.status === 'estimated' ? ore(estimate.totalOre) : null;
  if (!row || totalOre === null) return null;
  return { month: row.month, totalOre, lowOre: ore(estimate.lowOre), highOre: ore(estimate.highOre), soFarOre: row.costOre };
}

export function coverageOverview(months, current = null) {
  const rows = [];
  for (const month of months ?? []) {
    const costOre = monthCost(month, current);
    const supportOre = ore(month.knownNetOre);
    const metered = Number(month.kwh) > 0;
    // Months before the lab was metered carry nothing and are left out.
    if (!month.open && costOre === null && !supportOre && !metered) continue;
    const state = month.open ? (costOre === null ? 'open_unknown' : 'so_far') : costOre === null ? 'not_finalized' : 'finalized';
    rows.push({ month: month.month, costOre, supportOre, state });
  }
  const costOre = rows.reduce((sum, row) => sum + (row.costOre ?? 0), 0);
  const supportOre = rows.reduce((sum, row) => sum + (row.supportOre ?? 0), 0);
  const coveredOre = Math.max(0, Math.min(supportOre, costOre));
  return {
    rows, costOre, supportOre, coveredOre,
    projection: monthProjection(rows, current),
    ownerOre: Math.max(0, costOre - supportOre),
    creditOre: Math.max(0, supportOre - costOre),
    percent: costOre > 0 ? coveredOre / costOre * 100 : null,
    // Closed months whose cost is not finalized are missing from the cost total.
    missingMonths: rows.filter((row) => row.state === 'not_finalized').map((row) => row.month),
  };
}
