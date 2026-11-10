import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api.js';
import { coverageOverview } from '../../utils/supportCoverage.js';
import { currentMonth, monthLabel } from '../../utils/energyView.js';
import { Cell, DataTable, EmptyState, Row, RowsSkeleton, Section, Skeleton, money } from './PayPalOperationsPanel.jsx';

const MONTHS = 24;
const STATE = { finalized: 'Finalized', so_far: 'So far this month', open_unknown: 'This month · cost not calculated yet', not_finalized: 'Cost not finalized' };
const amount = (ore) => ore === null ? '—' : money(ore);

function Figure({ label, value, hint, loading, accent = false }) {
  return <div className="min-w-0">
    <dt className="aaris-meta">{label}</dt>
    <dd className={`mt-2 font-mono text-2xl break-words ${accent ? 'text-orange-400' : 'text-gray-100'}`}>
      {loading ? <><Skeleton className="h-8 w-32" /><span className="sr-only">Loading</span></> : value}
    </dd>
    {hint && <p className="mt-1 text-xs text-gray-500">{hint}</p>}
  </div>;
}

// Totals only: what the lab's electricity has cost and how much of it member
// support has covered. No member, payer or individual payment appears here.
export default function SupportOverviewPanel({ refreshKey, uncounted = 0 }) {
  const [view, setView] = useState(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let stale = false;
    // The open month's summary only adds its cost so far; the totals still load without it.
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
  const loading = !view && !failed;
  const percent = view?.percent ?? null;
  return <Section title="Cost coverage"
    description={`Lab electricity cost against net support from members over the last ${MONTHS} months. Totals only; no member is named here.`}>
    {failed && !view ? <EmptyState>Cost coverage could not be loaded.</EmptyState> : <>
      <dl className="grid sm:grid-cols-3 gap-6">
        <Figure label="Lab electricity cost" loading={loading} value={amount(view?.costOre ?? null)} hint="Finalized months plus this month so far." />
        <Figure label="Covered by members" loading={loading} accent value={amount(view?.coveredOre ?? null)}
          hint={view?.creditOre > 0 ? `${money(view.creditOre)} more received than spent; carried forward.` : 'Net of fees and refunds.'} />
        <Figure label="Paid by you" loading={loading} value={amount(view?.ownerOre ?? null)} hint="Cost not covered by support." />
      </dl>
      <div className="mt-6">
        <div className="flex items-baseline justify-between gap-3 font-mono text-xs text-gray-400">
          <span>Share of cost covered by members</span>
          <span className="text-gray-100">{loading ? '…' : percent === null ? 'No cost recorded yet' : `${percent.toLocaleString('da-DK', { maximumFractionDigits: 1 })} %`}</span>
        </div>
        <div className="mt-2 h-2 bg-gray-800 overflow-hidden" role="progressbar" aria-label="Share of cost covered by members"
          aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent === null ? undefined : Math.round(percent)}>
          <div className="h-full bg-orange-600 transition-[width]" style={{ width: `${percent ?? 0}%` }} />
        </div>
      </div>
      {view?.missingMonths.length > 0 && <p className="mt-4 text-xs text-yellow-300 bg-yellow-900/20 border border-yellow-700/40 rounded-xl px-3 py-2">
        Not in the cost total yet: {view.missingMonths.map(monthLabel).join(', ')}. Finalize {view.missingMonths.length === 1 ? 'that month' : 'those months'} under <Link to="/admin/energy-data" className="underline underline-offset-4">Energy Data</Link>.
      </p>}
      {uncounted > 0 && <p className="mt-4 text-xs text-gray-500">{uncounted} payment{uncounted === 1 ? '' : 's'} still waiting for a fee or review; not counted until resolved below.</p>}
      <h3 className="aaris-meta border-t border-gray-800 pt-5 mt-6 mb-3">By month</h3>
      {loading ? <RowsSkeleton /> : view.rows.length === 0 ? <EmptyState>No cost or support recorded yet.</EmptyState> :
        <DataTable columns={['Month', 'Lab cost', 'Member support (net)', 'Status']}>
          {view.rows.map((row) => <Row key={row.month}>
            <Cell className="text-gray-200 whitespace-nowrap">{monthLabel(row.month)}</Cell>
            <Cell className="font-mono text-gray-100 whitespace-nowrap">{amount(row.costOre)}</Cell>
            <Cell className="font-mono text-gray-100 whitespace-nowrap">{amount(row.supportOre)}</Cell>
            <Cell className="text-xs text-gray-400">{STATE[row.state]}</Cell>
          </Row>)}
        </DataTable>}
    </>}
  </Section>;
}
