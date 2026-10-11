import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import Layout from '../components/Layout.jsx';
import api from '../api.js';
import useDocumentTitle from '../hooks/useDocumentTitle.js';
import { useAuth } from '../contexts/AuthContext.jsx';
import EnergyBudgetAdminPanel from './admin/EnergyBudgetAdminPanel.jsx';
import {
  basisLabel, componentStatusLabel, costStatusLabel, currentMonth, decisionText, dkk, fundingStatusLabel, historyPath,
  localTime, markerPositions, modeLabel, monthLabel, progressView, quantity, reasonText, shiftMonth,
} from '../utils/energyView.js';

function Tile({ label, value, detail, status }) {
  return <div className="border border-gray-700 bg-gray-900/80 p-4 min-h-28">
    <div className="flex items-start justify-between gap-2"><h3 className="font-mono text-[11px] uppercase tracking-widest text-gray-400">{label}</h3>{status && <span className="font-mono text-[10px] uppercase text-amber-400">{status}</span>}</div>
    <p className="mt-3 text-2xl font-semibold tabular-nums text-gray-100">{value}</p>
    {detail && <p className="mt-1 text-sm text-gray-400">{detail}</p>}
  </div>;
}
function Row({ label, value, note }) {
  return <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 border-t border-gray-800 py-3 text-sm">
    <span className="text-gray-400">{label}{note && <span className="block text-xs text-gray-500">{note}</span>}</span>
    <span className="font-mono tabular-nums text-gray-100">{value}</span>
  </div>;
}
function Section({ number, title, children, id }) {
  return <section className="mt-10" aria-labelledby={id}><div className="flex items-baseline gap-4 border-b border-gray-700 pb-3"><span className="font-mono text-sm text-orange-400">{number} /</span><h2 id={id} className="aaris-display text-xl text-gray-100">{title}</h2></div>{children}</section>;
}
const panel = 'border border-gray-700 bg-gray-900/80 p-4';
const focus = 'focus-visible:outline-2 focus-visible:outline-orange-500';
const time = (value) => (value && Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Copenhagen', weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : 'Unknown');

async function downloadCsv(path, params, filename) {
  try {
    const { data } = await api.get(path, { params, responseType: 'blob' });
    const url = URL.createObjectURL(data);
    const link = document.createElement('a');
    link.href = url; link.download = filename;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (err) {
    // A failed blob download carries its JSON error as a Blob; decode it so a
    // reauthentication flow sees the machine-readable code.
    if (err.response?.data instanceof Blob) {
      try { err.response.data = JSON.parse(await err.response.data.text()); } catch { /* keep original */ }
    }
    throw err;
  }
}

function HostCard({ host, preview }) {
  const next = preview?.nextKnownChangeAt;
  return <div className="border border-gray-700 bg-gray-900/80 p-4">
    <div className="flex justify-between gap-2"><h3 className="font-mono text-xs uppercase tracking-widest text-orange-300">{host.alias}</h3><span className="font-mono text-xs text-gray-400">{host.stale ? 'Stale' : host.monitoring}</span></div>
    <p className="mt-3 text-lg">{host.observedMode ? `Observed ${modeLabel(host.observedMode)}` : 'Mode unknown'}</p>
    <p className="mt-1 text-sm text-gray-400">{host.watts == null ? 'Power unknown' : `${quantity(host.watts, 0)} W`} · {host.ageSeconds == null ? 'No observation' : `${host.ageSeconds}s old`}</p>
    {host.reason ? <dl className="mt-3 space-y-1 text-xs text-gray-400">
      <div><dt className="inline text-gray-500">Selected: </dt><dd className="inline text-gray-200">{decisionText({ mode: host.desiredMode, reason: host.reason, validUntil: host.manualUntil || host.priceValidUntil })}</dd></div>
      <div><dt className="inline text-gray-500">Weekly baseline: </dt><dd className="inline">{modeLabel(host.baseMode)}</dd></div>
      <div><dt className="inline text-gray-500">Next known change: </dt><dd className="inline">{next ? `${time(next)} → ${modeLabel(preview.nextKnownMode)}` : 'none known in the next 24 hours'}</dd></div>
      {host.priceRulesEnabled && <div><dt className="inline text-gray-500">Price rules: </dt><dd className="inline">{preview?.priceKnownUntil ? `prices published until ${time(preview.priceKnownUntil)}; later periods are unknown` : 'active where prices are published'}</dd></div>}
    </dl> : <p className="mt-2 text-xs text-gray-500">Control reason unavailable</p>}
  </div>;
}

function PreviewTable({ preview }) {
  if (!preview?.segments?.length) return null;
  return <details className="mt-2 text-sm"><summary className={`cursor-pointer text-orange-300 ${focus}`}>{preview.alias}: next 24 hours</summary>
    <div className="mt-2 max-h-72 overflow-auto"><table className="w-full text-left text-xs"><thead><tr className="text-gray-400"><th className="py-2 font-normal">From</th><th className="font-normal">Until</th><th className="font-normal">Weekly baseline</th><th className="font-normal">Selected</th><th className="font-normal">Reason</th><th className="font-normal">kr./kWh</th></tr></thead>
      <tbody>{preview.segments.map((segment) => <tr key={segment.startAt} className="border-t border-gray-800"><td className="py-2">{time(segment.startAt)}</td><td>{time(segment.endAt)}</td><td>{modeLabel(segment.baseMode)}</td>
        <td>{segment.unknown ? <span className="text-amber-300">Unknown (price not published)</span> : modeLabel(segment.selectedMode)}</td><td>{segment.unknown ? 'depends on unpublished price' : reasonText(segment.reason)}</td>
        <td className="tabular-nums">{segment.orePerKwh == null ? '—' : quantity(segment.orePerKwh / 100, 3)}</td></tr>)}</tbody></table></div></details>;
}

export default function EnergyBudgetPage() {
  useDocumentTitle('Energy & Budget');
  const { user } = useAuth();
  const [month, setMonth] = useState(currentMonth);
  const [range, setRange] = useState('24h');
  const [summary, setSummary] = useState(null);
  const [hosts, setHosts] = useState(null);
  const [history, setHistory] = useState(null);
  const [preview, setPreview] = useState(null);
  const [months, setMonths] = useState(null);
  const [errors, setErrors] = useState({});
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (key, request, setter, message) => {
    try { const { data } = await request(); setter(data); setErrors((old) => ({ ...old, [key]: '' })); }
    catch { setter(null); setErrors((old) => ({ ...old, [key]: message })); }
  }, []);
  const loadSummary = useCallback(() => load('summary', () => api.get('/energy/summary', { params: { month } }), setSummary, 'Monthly energy and budget data is unavailable.'), [load, month]);
  const loadHosts = useCallback(() => load('hosts', () => api.get('/energy/hosts'), setHosts, 'Server status is unavailable.'), [load]);
  const loadHistory = useCallback(() => load('history', () => api.get('/energy/history', { params: { range } }), setHistory, 'Power history is unavailable.'), [load, range]);
  const loadPreview = useCallback(() => load('preview', () => api.get('/energy/preview'), setPreview, 'Mode preview is unavailable.'), [load]);
  const loadMonths = useCallback(() => load('months', () => api.get('/energy/months', { params: { count: 12 } }), setMonths, 'Monthly history is unavailable.'), [load]);
  useEffect(() => { let active = true; setLoading(true); Promise.allSettled([loadSummary(), loadHosts(), loadHistory()]).then(() => { if (active) setLoading(false); }); return () => { active = false; }; }, [loadSummary, loadHosts, loadHistory]);
  useEffect(() => { void loadMonths(); }, [loadMonths]);
  useEffect(() => { void loadPreview(); const timer = setInterval(() => { void loadPreview(); }, 15 * 60_000); return () => clearInterval(timer); }, [loadPreview]);
  useEffect(() => { const timer = setInterval(() => { void loadSummary(); void loadHosts(); void loadHistory(); }, 60_000); return () => clearInterval(timer); }, [loadSummary, loadHosts, loadHistory]);

  const telemetry = summary?.telemetry;
  const cost = summary?.cost;
  const funding = summary?.funding;
  const price = summary?.price;
  const household = summary?.household;
  const points = history?.points || [];
  const path = historyPath(points, 'watts', history?.from, history?.through, history?.energy?.binSeconds);
  const energyPoints = history?.energy?.points || [];
  const energyPath = historyPath(energyPoints, 'kwh', history?.from, history?.through, history?.energy?.binSeconds);
  const markers = markerPositions(history?.modeChanges, history?.from, history?.through);
  const progress = progressView(funding?.progress);
  const previewByAlias = new Map((preview?.hosts || []).map((item) => [item.alias, item]));
  const held = funding?.held;

  return <Layout><div className="mx-auto max-w-6xl px-4 py-8 text-gray-100 sm:px-8">
    <header className="flex flex-wrap items-end justify-between gap-5 border-b border-gray-700 pb-6">
      <div><p className="font-mono text-xs uppercase tracking-[.18em] text-orange-400">Private / Power & Energy</p><h1 className="aaris-display mt-2 text-3xl sm:text-4xl">Energy & Budget</h1><p className="mt-2 max-w-2xl text-sm text-gray-400">Measured server power, calculated electricity cost and confirmed voluntary support. Figures remain unknown until their sources are available.</p></div>
      <div className="flex items-center gap-3 font-mono text-xs"><button aria-label="Previous month" onClick={() => setMonth(shiftMonth(month, -1))} className={`border border-gray-700 px-3 py-2 hover:border-orange-500 ${focus}`}>←</button><span className="min-w-30 text-center uppercase" aria-live="polite">{monthLabel(month)}</span><button aria-label="Next month" onClick={() => setMonth(shiftMonth(month, 1))} disabled={month >= currentMonth()} className={`border border-gray-700 px-3 py-2 hover:border-orange-500 disabled:opacity-40 ${focus}`}>→</button></div>
    </header>
    {loading && <p role="status" className="mt-5 text-sm text-gray-400">Loading energy data…</p>}
    {Object.values(errors).filter(Boolean).map((error) => <p key={error} role="alert" className="mt-3 border-l-2 border-amber-500 bg-amber-500/5 p-3 text-sm text-amber-200">{error}</p>)}
    {summary?.snapshot && !summary.snapshot.consistent && <p role="status" className="mt-3 border-l-2 border-amber-500 bg-amber-500/5 p-3 text-sm text-amber-200">Sources changed while this page loaded; figures may come from slightly different revisions. They refresh automatically.</p>}

    <Section number="01" id="energy-current" title="Current draw & use"><div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Tile label="Live server input" value={telemetry?.watts == null ? 'Unknown' : `${quantity(telemetry.watts, 0)} W`} status={telemetry?.status} detail={telemetry?.observedAt ? `Oldest included reading: ${localTime(telemetry.observedAt)}` : 'No fresh fleet reading'} />
      <Tile label="Lab energy this month" value={telemetry?.kwh == null ? 'Unknown' : `${quantity(telemetry.kwh, 2)} kWh`} status={telemetry?.energyStatus} detail={telemetry?.coveragePercent == null ? 'Coverage unknown' : `${quantity(telemetry.coveragePercent, 0)}% of server time monitored${telemetry.retiredHostsInPeriod ? ` · includes ${telemetry.retiredHostsInPeriod} retired server(s)` : ''}`} />
      <Tile label="Electricity unit price" value={price?.orePerKwh == null ? 'Unknown' : `${quantity(price.orePerKwh / 100, 3)} kr./kWh`} status={price?.status} detail={price?.basis ? `${basisLabel(price.basis)} · ${price.validUntil ? `valid until ${localTime(price.validUntil)}` : 'validity unavailable'}` : 'Price basis not configured'} />
      <Tile label="Lab electricity cost" value={dkk(cost?.actualOre)} status={cost?.status && costStatusLabel(cost.status)} detail={cost?.statementRevision ? `Finalized statement, revision ${cost.statementRevision}` : cost?.forecastOre == null ? 'Month-end forecast unavailable' : `Forecast (estimate): ${dkk(cost.forecastOre)}`} />
    </div><p className="mt-3 text-xs text-gray-500">Watts are instantaneous input power. kWh is energy integrated over monitored time. A unit price (kr./kWh) is not the servers’ running cost per hour. Missing coverage or price components make the cost partial, never zero.</p></Section>

    <Section number="02" id="energy-cost" title="Cost breakdown"><div className="mt-4 grid gap-3 lg:grid-cols-2">
      <div className={panel}>
        <p className="font-mono text-xs uppercase tracking-widest text-gray-400">Calculated lab cost · {costStatusLabel(cost?.status)}</p>
        {cost?.components?.length ? cost.components.map((component) => <Row key={component.key} label={component.label} note={componentStatusLabel(component.status)} value={dkk(component.ore)} />) : <p className="mt-3 text-sm text-gray-400">No cost components are available for this month.</p>}
        <Row label="Calculated lab cost" note={cost?.source === 'finalized_statement' ? `Immutable finalized statement, revision ${cost.statementRevision}` : cost?.observedThrough ? `Live calculation through ${localTime(cost.observedThrough)}` : 'Not calculated'} value={dkk(cost?.actualOre)} />
        <Row label="Month-end forecast" note="Estimate from recent measured days and published prices; not a bill." value={cost?.forecastOre == null ? cost?.forecastStatus ? cost.forecastStatus.replaceAll('_', ' ') : 'Not applicable' : dkk(cost.forecastOre)} />
      </div>
      <div className={panel}>
        <p className="font-mono text-xs uppercase tracking-widest text-gray-400">Whole-household electricity</p>
        {household?.shared ? <>
          <Row label={household.basis === 'paid' ? 'Household amount paid' : 'Household invoice total'} note={household.status === 'available' ? `${household.billKind === 'advance' ? 'Advance' : 'Settlement'} invoice · ${String(household.billStatus || '').replaceAll('_', ' ')}` : 'No invoice recorded for this month'} value={dkk(household.totalOre)} />
          <p className="mt-3 text-xs text-gray-500">Shared by the owner for context. It covers the entire household, servers included; it is not added to the lab cost and support is not requested for it.</p>
        </> : <p className="mt-3 text-sm text-gray-400">The owner has not shared household electricity totals.</p>}
      </div>
    </div></Section>

    <Section number="03" id="energy-history" title="Power history"><div className={`mt-4 ${panel}`}>
      <div className="flex flex-wrap items-center justify-between gap-3"><p className="font-mono text-xs uppercase tracking-widest text-gray-400">Measured input / watts</p><div className="flex gap-2" role="group" aria-label="History range">{['24h', '7d'].map((value) => <button key={value} onClick={() => setRange(value)} aria-pressed={range === value} className={`border px-3 py-1 font-mono text-xs ${focus} ${range === value ? 'border-orange-500 text-orange-300' : 'border-gray-700 text-gray-400'}`}>{value}</button>)}</div></div>
      {path ? <svg className="mt-5 h-32 w-full" viewBox="0 0 600 120" preserveAspectRatio="none" role="img" aria-label={`Server power over the last ${range}${markers.length ? `, with ${markers.length} verified mode changes` : ''}`}>{markers.map((marker) => <line key={`${marker.at}-${marker.mode}`} x1={marker.x} x2={marker.x} y1="0" y2="120" stroke="#6b7280" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />)}<path d={path} fill="none" stroke="#fb923c" strokeWidth="2" vectorEffect="non-scaling-stroke" /></svg> : <p className="mt-6 text-sm text-gray-400">No measured trend yet.</p>}
      {points.length > 0 && <details className="mt-3 text-sm"><summary className={`cursor-pointer text-orange-300 ${focus}`}>Power readings table</summary><div className="mt-2 max-h-64 overflow-auto"><table className="w-full text-left"><thead><tr><th className="py-2 font-normal text-gray-400">Time</th><th className="py-2 font-normal text-gray-400">Watts</th><th className="py-2 font-normal text-gray-400">Servers measured</th></tr></thead><tbody>{points.map((point) => <tr key={point.at} className="border-t border-gray-800"><td className="py-2">{localTime(point.at)}</td><td>{quantity(point.watts, 0)}</td><td>{point.measuredHosts}</td></tr>)}</tbody></table></div></details>}
      {markers.length > 0 && <details className="mt-3 text-sm"><summary className={`cursor-pointer text-orange-300 ${focus}`}>Verified mode changes ({markers.length})</summary><ul className="mt-2 space-y-1 text-xs text-gray-400">{markers.map((marker) => <li key={`${marker.at}-${marker.mode}`}>{localTime(marker.at)}: {modeLabel(marker.mode)} ({reasonText(marker.reason)})</li>)}</ul><p className="mt-2 text-xs text-gray-500">Dashed lines mark verified changes. Power before and after a change is an observation, not proof of savings.</p></details>}
      <p className="mt-6 border-t border-gray-800 pt-4 font-mono text-xs uppercase tracking-widest text-gray-400">Integrated server energy / kWh per {range === '24h' ? 'hour' : 'two hours'}</p>
      {energyPath ? <svg className="mt-3 h-32 w-full" viewBox="0 0 600 120" preserveAspectRatio="none" role="img" aria-label={`Integrated server energy over the last ${range}`}><path d={energyPath} fill="none" stroke="#60a5fa" strokeWidth="2" vectorEffect="non-scaling-stroke" /></svg> : <p className="mt-4 text-sm text-gray-400">No integrated energy trend yet.</p>}
      {energyPoints.length > 0 && <details className="mt-3 text-sm"><summary className={`cursor-pointer text-orange-300 ${focus}`}>Energy intervals table</summary><div className="mt-2 max-h-64 overflow-auto"><table className="w-full text-left"><thead><tr><th className="py-2 font-normal text-gray-400">Time</th><th className="py-2 font-normal text-gray-400">Server kWh</th><th className="py-2 font-normal text-gray-400">Coverage</th></tr></thead><tbody>{energyPoints.map((point) => <tr key={point.at} className="border-t border-gray-800"><td className="py-2">{localTime(point.at)}</td><td>{quantity(point.kwh, 3)}</td><td>{point.expectedSeconds > 0 ? `${quantity(point.coveredSeconds / point.expectedSeconds * 100, 0)}%` : 'Unknown'}</td></tr>)}</tbody></table></div></details>}
    </div></Section>

    <Section number="04" id="energy-modes" title="Server modes"><div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{hosts?.hosts?.length ? hosts.hosts.map((host) => <HostCard key={host.alias} host={host} preview={previewByAlias.get(host.alias)} />) : <p className="text-sm text-gray-400">No server mode observations are configured.</p>}</div>
      {(preview?.hosts || []).map((item) => <PreviewTable key={item.alias} preview={item} />)}
      <p className="mt-3 text-xs text-gray-500">Observed modes are hardware readings and may be stale. The selected mode comes from the same policy resolver the controller uses. Periods after the last published price are shown as unknown, with the weekly baseline listed separately. This page cannot change any mode.</p></Section>

    <Section number="05" id="energy-budget" title="Budget & support"><p className="mt-3 font-mono text-xs uppercase tracking-widest text-gray-400">Allocation · {fundingStatusLabel(funding?.status)}{funding?.reconciledAt ? ` · PayPal reconciled ${localTime(funding.reconciledAt)}` : ' · PayPal reconciliation not yet run'}</p>
      <div className="mt-3 grid gap-3 lg:grid-cols-2"><div className={panel}>
        <p className="font-mono text-xs uppercase tracking-widest text-gray-400">Received this month</p>
        <Row label="Gross contributions received" value={dkk(funding?.grossOre)} /><Row label="Actual payment fees" value={dkk(funding?.feeDebitsOre)} /><Row label="Fee credits" value={dkk(funding?.feeCreditsOre)} /><Row label="Refunds and reversals" value={dkk(funding?.refundDebitsOre)} />
        <Row label="Known net received" value={dkk(funding?.knownNetOre)} note="Already net of fees; fees are not subtracted again." />
        <Row label="Unresolved net" value={funding?.unresolvedOre === 0 ? dkk(0) : 'Unknown'} note={funding?.unresolvedOre === 0 ? undefined : 'Some payments are awaiting their actual fee; net stays unknown until then.'} />
        {held && <Row label="Pending or disputed (not counted)" value={`${held.pendingCount + held.disputeCount} open`} note={`Pending ${held.pendingOre == null ? 'amount unknown' : dkk(held.pendingOre)} · disputed ${held.disputedOre == null ? 'amount unknown' : dkk(held.disputedOre)}`} />}
      </div><div className={panel}>
        <p className="font-mono text-xs uppercase tracking-widest text-gray-400">Applied to this month’s cost</p>
        <Row label="Credit carried in from earlier months" value={dkk(funding?.openingCreditOre)} />
        <Row label="Eligible net support available" value={dkk(funding?.eligibleNetOre)} note="Carried-in credit plus this month’s known net." />
        <Row label="Credit applied to this month" value={dkk(funding?.appliedOre)} />
        <Row label="Remaining owner-funded cost" value={dkk(funding?.ownerFundedOre)} />
        <Row label="Owner adjustment after refunds" value={dkk(funding?.ownerAdjustmentOre)} />
        <Row label="Credit carried forward" value={dkk(funding?.carryForwardOre)} />
        {progress ? <div className="mt-4"><p className="text-xs text-gray-300">Confirmed net credit applied / {progress.basis}: {quantity(progress.percent, 1)}%{progress.estimate ? ' (estimate, the month is still open)' : ''}</p><div className="mt-2 h-2 bg-gray-800" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percent} aria-label={`Funding progress against ${progress.basis}`}><div className="h-full bg-orange-500" style={{ width: `${progress.percent}%` }} /></div>{progress.estimate && <p className="mt-1 text-xs text-gray-500">Estimated owner share so far: {dkk(funding.progress.ownerRemainderOre)}</p>}</div>
          : <p className="mt-4 text-xs text-gray-500">Funding progress is shown once the cost is calculated and verified receipts are allocated.</p>}
      </div></div>
      <p className="mt-3 text-xs text-gray-500">Support is entirely optional. It never changes access, quotas or service priority, and it does not change the electricity cost itself. These figures describe this lab’s recorded receipts, not a PayPal or bank balance.</p>
      <div className="mt-3 flex flex-wrap gap-4 font-mono text-xs"><Link className={`text-orange-300 underline underline-offset-4 ${focus}`} to="/support">Optional contribution controls and your private history →</Link>
        <button type="button" onClick={() => downloadCsv('/energy/summary.csv', { month }, `energy-budget-${month}.csv`).catch(() => setErrors((old) => ({ ...old, export: 'Export failed.' })))} className={`text-orange-300 underline underline-offset-4 ${focus}`}>Download this month as CSV</button></div></Section>

    <Section number="06" id="energy-months" title="Monthly history">{months?.months?.length ? <div className="mt-4 overflow-x-auto"><table className="w-full min-w-[640px] text-left text-sm"><caption className="sr-only">Monthly lab energy, cost and support</caption><thead><tr className="text-xs text-gray-400"><th className="py-2 font-normal">Month</th><th className="font-normal">Lab kWh</th><th className="font-normal">Lab cost</th><th className="font-normal">Gross</th><th className="font-normal">Known net</th><th className="font-normal">Applied</th><th className="font-normal">Owner-funded</th><th className="font-normal">Carried forward</th></tr></thead>
      <tbody>{months.months.map((item) => <tr key={item.month} className="border-t border-gray-800 tabular-nums"><td className="py-2"><button type="button" onClick={() => setMonth(item.month)} className={`text-orange-300 underline-offset-4 hover:underline ${focus}`}>{monthLabel(item.month)}</button></td><td>{item.kwh == null ? 'Unknown' : quantity(item.kwh, 1)}</td>
        <td>{item.costOre == null ? <span className="text-gray-500">{item.costStatus === 'open' ? 'Open month' : 'Not finalized'}</span> : `${dkk(item.costOre)}${item.costStatus === 'finalized_partial' ? ' (partial)' : ''}`}</td><td>{dkk(item.grossOre)}</td><td>{dkk(item.knownNetOre)}</td><td>{dkk(item.appliedOre)}</td><td>{dkk(item.ownerFundedOre)}</td><td>{dkk(item.carryForwardOre)}</td></tr>)}</tbody></table>
      <p className="mt-2 text-xs text-gray-500">Costs appear once a month is finalized; applied credit and owner share once verified receipts are allocated to that cost.</p></div> : <p className="mt-4 text-sm text-gray-400">No monthly history yet.</p>}</Section>

    {user?.isAdmin && <EnergyBudgetAdminPanel month={month} onChanged={loadSummary} downloadCsv={downloadCsv} />}
  </div></Layout>;
}
