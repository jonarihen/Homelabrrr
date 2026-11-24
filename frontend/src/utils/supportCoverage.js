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
    rows.push({ month: month.month, costOre, supportOre, state,
      appliedOre: ore(month.appliedOre), ownerFundedOre: ore(month.ownerFundedOre), carryForwardOre: ore(month.carryForwardOre) });
  }
  // Coverage is allocated month by month, oldest first, as the backend does:
  // an owner-funded shortfall stays with the owner and is never repaid by
  // later support. A reconciled month's stored allocation is used as is (it
  // includes credit from before the window); other months with a cost (the
  // open one, or one not reconciled yet) apply the credit carried into them.
  let costOre = 0; let coveredOre = 0; let ownerOre = 0; let creditOre = 0;
  for (const row of [...rows].reverse()) {
    const { appliedOre, ownerFundedOre, carryForwardOre } = row;
    if (row.costOre !== null && appliedOre !== null && ownerFundedOre !== null) {
      costOre += row.costOre; coveredOre += appliedOre; ownerOre += ownerFundedOre; creditOre = carryForwardOre ?? 0;
      continue;
    }
    const available = creditOre + (row.supportOre ?? 0);
    const applied = row.costOre === null ? 0 : Math.min(row.costOre, Math.max(0, available));
    if (row.costOre !== null) { costOre += row.costOre; coveredOre += applied; ownerOre += row.costOre - applied; }
    creditOre = Math.max(0, available - applied);
  }
  return {
    rows, costOre, coveredOre, ownerOre, creditOre,
    supportOre: rows.reduce((sum, row) => sum + (row.supportOre ?? 0), 0),
    projection: monthProjection(rows, current),
    percent: costOre > 0 ? coveredOre / costOre * 100 : null,
    // Closed months whose cost is not finalized are missing from the cost total.
    missingMonths: rows.filter((row) => row.state === 'not_finalized').map((row) => row.month),
  };
}
