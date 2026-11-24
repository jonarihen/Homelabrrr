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
    rows.push({ month: month.month, costOre, supportOre, state, appliedOre: ore(month.appliedOre),
      ownerAdjustmentOre: ore(month.ownerAdjustmentOre), carryForwardOre: ore(month.carryForwardOre) });
  }
  // Coverage is allocated month by month, oldest first, as the backend does:
  // an owner-funded shortfall stays with the owner and is never repaid by
  // later support. A reconciled month's stored allocation is used as is (it
  // includes credit from before the window); a refund after its credit was
  // spent is an owner adjustment that takes back covered cost. A month without
  // a known allocation counts only its own support plus credit carried into
  // it, and breaks the chain: no credit is carried out of it.
  let costOre = 0; let appliedOre = 0; let adjustedOre = 0; let creditOre = 0;
  for (const row of [...rows].reverse()) {
    if (row.costOre !== null && row.appliedOre !== null) {
      costOre += row.costOre; appliedOre += row.appliedOre; adjustedOre += row.ownerAdjustmentOre ?? 0; creditOre = row.carryForwardOre ?? 0;
      continue;
    }
    const available = (creditOre ?? 0) + (row.supportOre ?? 0);
    const applied = row.costOre === null ? 0 : Math.min(row.costOre, Math.max(0, available));
    costOre += row.costOre ?? 0; appliedOre += applied;
    creditOre = ['so_far', 'open_unknown'].includes(row.state) ? Math.max(0, available - applied) : null;
  }
  const coveredOre = Math.max(0, appliedOre - adjustedOre);
  return {
    rows, costOre, coveredOre, ownerOre: costOre - coveredOre, creditOre: creditOre ?? 0,
    supportOre: rows.reduce((sum, row) => sum + (row.supportOre ?? 0), 0),
    projection: monthProjection(rows, current),
    percent: costOre > 0 ? coveredOre / costOre * 100 : null,
    // Closed months whose cost is not finalized are missing from the cost total.
    missingMonths: rows.filter((row) => row.state === 'not_finalized').map((row) => row.month),
  };
}
