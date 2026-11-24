import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api.js';
import { coverageOverview } from '../utils/supportCoverage.js';
import { currentMonth, dkk, monthLabel } from '../utils/energyView.js';

const MONTHS = 24;
const STATE = { finalized: 'Finalized', so_far: 'So far this month', open_unknown: 'This month · cost not calculated yet', not_finalized: 'Cost not finalized' };
const amount = (ore) => ore === null || ore === undefined ? '—' : dkk(ore);
const pulse = (className) => <><span aria-hidden="true" className={`block bg-gray-800 animate-pulse ${className}`} /><span className="sr-only">Loading</span></>;

function Figure({ label, value, hint, loading, accent = false }) {
  return <div className="min-w-0">
    <dt className="aaris-meta">{label}</dt>
    <dd className={`mt-2 font-mono text-2xl break-words ${accent ? 'text-orange-400' : 'text-gray-100'}`}>{loading ? pulse('h-8 w-32') : value}</dd>
    {hint && <p className="mt-1 text-xs text-gray-500">{hint}</p>}
  </div>;
}

// What the lab's electricity costs and how much of it member support has
// covered: totals only, read from the monthly aggregates every member may see.
// No member, payer or single payment appears. `audience` only changes wording
// and the owner-only hints; `table` adds the month-by-month breakdown.
export default function SupportCoverage({ audience = 'member', table = false, refreshKey = 0, uncounted = 0 }) {
  const owner = audience === 'owner';
  const [view, setView] = useState(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let stale = false;
    // The open month's summary adds its cost so far and projection; the totals still load without it.
    Promise.all([api.get('/energy/months', { params: { count: MONTHS } }),
      api.get('/energy/summary', { params: { month: currentMonth() } }).catch(() => null)])
      .then(([months, summary]) => {
        if (stale) return;
        if (!Array.isArray(months.data?.months)) throw new Error('unexpected months');
        setView(coverageOverview(months.data.months, summary?.data ?? null)); setFailed(false);
      })
      .catch(() => { if (!stale) setFailed(true); });
    return () => { stale = true; };
  }, [refreshKey]);
  if (failed && !view) return <p className="text-sm text-gray-500">Cost coverage could not be loaded.</p>;
  const loading = !view;
  const percent = view?.percent ?? null;
  const projection = view?.projection ?? null;
  const range = projection && projection.lowOre !== null && projection.highOre !== null ? `Likely ${dkk(projection.lowOre)} to ${dkk(projection.highOre)}` : 'A guess, not a bill';
  return <div>
    <dl className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
      <Figure label="Projected this month" loading={loading} value={projection ? `≈ ${dkk(projection.totalOre)}` : 'Not yet'}
        hint={projection ? `${range}. So far ${amount(projection.soFarOre)}.` : 'Shown once there are enough readings this month.'} />
      <Figure label="Total lab cost" loading={loading} value={amount(view?.costOre)} hint="Finalized months plus this month so far." />
      <Figure label="Covered by members" loading={loading} accent value={amount(view?.coveredOre)}
        hint={view?.creditOre > 0 ? `${dkk(view.creditOre)} more received than spent; carried forward.` : 'Net of fees and refunds.'} />
      <Figure label={owner ? 'Paid by you' : 'Paid by the owner'} loading={loading} value={amount(view?.ownerOre)} hint="Cost not covered by support." />
    </dl>
    <div className="mt-6">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 font-mono text-xs text-gray-400">
        <span>Share of cost covered by members</span>
        <span className="text-gray-100">{loading ? '…' : percent === null ? 'No cost recorded yet' : `${percent.toLocaleString('da-DK', { maximumFractionDigits: 1 })} %`}</span>
      </div>
      <div className="mt-2 h-2 bg-gray-800 overflow-hidden" role="progressbar" aria-label="Share of cost covered by members"
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent === null ? undefined : Math.round(percent)}>
        <div className="h-full bg-orange-600 transition-[width]" style={{ width: `${percent ?? 0}%` }} />
      </div>
    </div>
    {view?.missingMonths.length > 0 && <p className="mt-4 text-xs text-yellow-300 bg-yellow-900/20 border border-yellow-700/40 px-3 py-2">
      Not in the cost total yet: {view.missingMonths.map(monthLabel).join(', ')}.
      {owner && <> Finalize {view.missingMonths.length === 1 ? 'that month' : 'those months'} under <Link to="/admin/energy-data" className="underline underline-offset-4">Energy Data</Link>.</>}
    </p>}
    {owner && uncounted > 0 && <p className="mt-4 text-xs text-gray-500">{uncounted} payment{uncounted === 1 ? '' : 's'} still waiting for a fee or review; not counted until resolved below.</p>}
    {table && <>
      <h3 className="aaris-meta border-t border-gray-800 pt-5 mt-6 mb-3">By month</h3>
      {loading ? pulse('h-12 w-full') : view.rows.length === 0 ? <p className="text-sm text-gray-500">No cost or support recorded yet.</p> :
        <div className="border border-gray-800 overflow-x-auto"><table className="w-full text-sm">
          <thead><tr className="border-b border-gray-800 text-gray-500 text-xs uppercase tracking-wider">
            {['Month', 'Lab cost', 'Member support (net)', 'Status'].map((name) => <th key={name} scope="col" className="text-left px-4 py-3 font-medium whitespace-nowrap">{name}</th>)}
          </tr></thead>
          <tbody>{view.rows.map((row) => <tr key={row.month} className="border-b border-gray-800 last:border-0">
            <td className="px-4 py-3 text-gray-200 whitespace-nowrap">{monthLabel(row.month)}</td>
            <td className="px-4 py-3 font-mono text-gray-100 whitespace-nowrap">{amount(row.costOre)}</td>
            <td className="px-4 py-3 font-mono text-gray-100 whitespace-nowrap">{amount(row.supportOre)}</td>
            <td className="px-4 py-3 text-xs text-gray-400">{STATE[row.state]}{projection?.month === row.month ? ` · projected ≈ ${dkk(projection.totalOre)}` : ''}</td>
          </tr>)}</tbody>
        </table></div>}
    </>}
  </div>;
}
