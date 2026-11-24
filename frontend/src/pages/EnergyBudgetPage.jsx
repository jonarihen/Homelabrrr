import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import Layout from '../components/Layout.jsx';
import api from '../api.js';
import useDocumentTitle from '../hooks/useDocumentTitle.js';
import { useAuth } from '../contexts/AuthContext.jsx';
import EnergyBudgetAdminPanel from './admin/EnergyBudgetAdminPanel.jsx';
import TimeSeriesChart from '../components/energy/TimeSeriesChart.jsx';
import {
  basisLabel, componentStatusLabel, costStatusLabel, currentMonth, decisionText, dkk, fundingStatusLabel,
  localTime, markerPositions, modeLabel, monthEstimateView, monthLabel, progressView, quantity, reasonText, shiftMonth,
} from '../utils/energyView.js';

const panel = 'border border-gray-800 bg-gray-900/90 p-5';
const eyebrow = 'font-mono text-[11px] uppercase tracking-[0.12em] text-gray-400';
const focus = 'focus-visible:outline-2 focus-visible:outline-orange-500';
const btnGhost = `border border-gray-700 px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.1em] text-gray-400 transition-colors hover:border-gray-500 hover:text-gray-100 disabled:cursor-not-allowed disabled:opacity-40 ${focus}`;
const btnToggle = (active) => `border px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.1em] transition-colors ${focus} ${active ? 'border-orange-500 bg-orange-500/10 text-orange-300' : 'border-gray-700 text-gray-400 hover:border-gray-500 hover:text-gray-100'}`;
const linkCls = `text-orange-300 underline underline-offset-4 hover:text-orange-200 ${focus}`;

function Skel({ className = 'h-4 w-16' }) {
  return <span aria-hidden="true" className={`inline-block animate-pulse bg-gray-700/60 align-middle ${className}`} />;
}
function Tile({ label, value, detail, status }) {
  return <div className={`${panel} min-h-28`}>
    <div className="flex items-start justify-between gap-2"><h3 className={eyebrow}>{label}</h3>{status && <span className="font-mono text-[11px] uppercase text-amber-400">{status}</span>}</div>
    <p className="mt-3 break-words text-2xl font-semibold tabular-nums text-gray-100">{value}</p>
    {detail && <p className="mt-1 text-sm text-gray-400">{detail}</p>}
  </div>;
}
function Row({ label, value, note }) {
  return <div className="flex justify-between gap-x-4 border-t border-gray-800 py-2.5 text-sm">
    <span className="min-w-0 text-gray-400">{label}{note && <span className="block text-xs text-gray-500">{note}</span>}</span>
    <span className="shrink-0 text-right font-mono tabular-nums text-gray-100">{value}</span>
  </div>;
}
function Section({ number, title, children, id, busy }) {
  return <section className="space-y-4" aria-labelledby={id} aria-busy={busy || undefined}><div className="flex items-baseline gap-3 border-b border-gray-800 pb-3"><span className="font-mono text-xs font-semibold tracking-[0.12em] text-orange-600">{number} /</span><h2 id={id} className="aaris-display text-lg text-gray-100">{title}</h2></div>{children}</section>;
}
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

function HostCard({ host, preview, v }) {
  const next = preview?.nextKnownChangeAt;
  return <div className={panel}>
    <div className="flex justify-between gap-2"><h3 className="font-mono text-xs uppercase tracking-[0.12em] text-orange-300">{host.name || host.alias}</h3><span className="font-mono text-xs text-gray-400">{host.stale ? 'Stale' : host.monitoring}</span></div>
    <p className="mt-3 text-lg">{host.observedMode ? `Observed ${modeLabel(host.observedMode)}` : 'Mode unknown'}</p>
    <p className="mt-1 text-sm text-gray-400">{host.watts == null ? 'Power unknown' : `${quantity(host.watts, 0)} W`} · {host.ageSeconds == null ? 'No observation' : `${host.ageSeconds}s old`}</p>
    {host.reason ? <dl className="mt-3 space-y-1 text-xs text-gray-400">
      <div><dt className="inline text-gray-500">Selected: </dt><dd className="inline text-gray-200">{decisionText({ mode: host.desiredMode, reason: host.reason, validUntil: host.manualUntil || host.priceValidUntil })}</dd></div>
      <div><dt className="inline text-gray-500">Weekly baseline: </dt><dd className="inline">{modeLabel(host.baseMode)}</dd></div>
      <div><dt className="inline text-gray-500">Next known change: </dt><dd className="inline">{v('preview', next ? `${time(next)} → ${modeLabel(preview.nextKnownMode)}` : 'none known in the next 24 hours', 'h-3 w-32')}</dd></div>
      {host.priceRulesEnabled && <div><dt className="inline text-gray-500">Price rules: </dt><dd className="inline">{v('preview', preview?.priceKnownUntil ? `prices published until ${time(preview.priceKnownUntil)}; later periods are unknown` : 'active where prices are published', 'h-3 w-32')}</dd></div>}
    </dl> : <p className="mt-2 text-xs text-gray-500">Control reason unavailable</p>}
  </div>;
}

function PreviewTable({ preview }) {
  if (!preview?.segments?.length) return null;
  return <details className="text-sm"><summary className={`cursor-pointer text-orange-300 ${focus}`}>{preview.name || preview.alias}: next 24 hours</summary>
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
  // Per-fetch "first load / parameter changed" flag; background refreshes are silent.
  const [pending, setPending] = useState({ summary: true, hosts: true, history: true, preview: true, months: true });
  const latest = useRef({});
  const inflight = useRef({});

  // silent: truthy keeps current figures on screen; 'poll' also yields to a request
  // still in flight, so a slow response is never superseded by every timer tick.
  const load = useCallback(async (key, request, setter, message, silent) => {
    if (silent === 'poll' && inflight.current[key]) return;
    const id = (latest.current[key] || 0) + 1;
    latest.current[key] = id;
    inflight.current[key] = true;
    if (!silent) setPending((old) => ({ ...old, [key]: true }));
    try {
      const { data } = await request();
      if (latest.current[key] !== id) return;
      setter(data); setErrors((old) => ({ ...old, [key]: '' }));
    } catch {
      if (latest.current[key] !== id) return;
      setter(null); setErrors((old) => ({ ...old, [key]: message }));
    }
    inflight.current[key] = false;
    setPending((old) => ({ ...old, [key]: false }));
  }, []);
  const loadSummary = useCallback((silent) => load('summary', () => api.get('/energy/summary', { params: { month } }), setSummary, 'Monthly energy and budget data is unavailable.', silent), [load, month]);
  const loadHosts = useCallback((silent) => load('hosts', () => api.get('/energy/hosts'), setHosts, 'Server status is unavailable.', silent), [load]);
  const loadHistory = useCallback((silent) => load('history', () => api.get('/energy/history', { params: { range } }), setHistory, 'Power history is unavailable.', silent), [load, range]);
  const loadPreview = useCallback((silent) => load('preview', () => api.get('/energy/preview'), setPreview, 'Mode preview is unavailable.', silent), [load]);
  const loadMonths = useCallback(() => load('months', () => api.get('/energy/months', { params: { count: 12 } }), setMonths, 'Monthly history is unavailable.'), [load]);
  // Flag the new selection pending in the same render, so old figures never show under it.
  const selectMonth = (next) => { if (next === month) return; setPending((old) => ({ ...old, summary: true })); setMonth(next); };
  const selectRange = (next) => { if (next === range) return; setPending((old) => ({ ...old, history: true })); setRange(next); };
  useEffect(() => { void loadSummary(); }, [loadSummary]);
  useEffect(() => { void loadHosts(); }, [loadHosts]);
  useEffect(() => { void loadHistory(); }, [loadHistory]);
  useEffect(() => { void loadMonths(); }, [loadMonths]);
  useEffect(() => { void loadPreview(); const timer = setInterval(() => { void loadPreview('poll'); }, 15 * 60_000); return () => clearInterval(timer); }, [loadPreview]);
  useEffect(() => { const timer = setInterval(() => { void loadSummary('poll'); void loadHosts('poll'); void loadHistory('poll'); }, 60_000); return () => clearInterval(timer); }, [loadSummary, loadHosts, loadHistory]);

  // Data only counts once its fetch has finished; before that (or for another month/range) it is hidden.
  const ready = (key) => !pending[key] && !errors[key];
  // Loading -> pulsing placeholder; failed -> dash (the error banner explains); else the value.
  const v = (key, node, skel) => (pending[key] ? <Skel className={skel} /> : errors[key] ? <span>—<span className="sr-only">Unavailable</span></span> : node);
  // Block-level fallback while a section's data is not ready.
  const blockFallback = (key, skel = 'h-24 w-full') => (pending[key] ? <Skel className={`block ${skel}`} /> : <p className="text-sm text-amber-300">Unavailable. See the message above.</p>);
  const anyPending = Object.values(pending).some(Boolean);

  const S = ready('summary') ? summary : null;
  const telemetry = S?.telemetry;
  const cost = S?.cost;
  const funding = S?.funding;
  const price = S?.price;
  const household = S?.household;
  const estimate = monthEstimateView(cost?.estimate);
  const points = history?.points || [];
  const energyPoints = history?.energy?.points || [];
  const markers = markerPositions(history?.modeChanges, history?.from, history?.through);
  const progress = progressView(funding?.progress);
  const previewByAlias = new Map((preview?.hosts || []).map((item) => [item.alias, item]));
  const held = funding?.held;
  const tileSkel = 'h-7 w-28';
  const detailSkel = 'h-3.5 w-40';

  return <Layout><div className="max-w-6xl space-y-8 p-6 text-gray-100 lg:p-8">
    <header className="flex flex-wrap items-end justify-between gap-4 border-b border-gray-800 pb-6">
      <div><p className="font-mono text-[11px] uppercase tracking-[0.2em] text-orange-500">Private · Power & Energy</p><h1 className="aaris-display mt-2 text-2xl text-gray-100">Energy & Budget</h1><p className="mt-2 max-w-2xl text-sm text-gray-400">Measured server power, calculated electricity cost and confirmed voluntary support. Figures remain unknown until their sources are available.</p></div>
      <div className="flex items-center gap-2 font-mono text-xs"><button aria-label="Previous month" onClick={() => selectMonth(shiftMonth(month, -1))} className={btnGhost}>←</button><span className="min-w-[9rem] text-center uppercase tracking-[0.1em]" aria-live="polite">{monthLabel(month)}</span><button aria-label="Next month" onClick={() => selectMonth(shiftMonth(month, 1))} disabled={month >= currentMonth()} className={btnGhost}>→</button></div>
    </header>
    <p role="status" className="sr-only">{anyPending ? 'Loading energy data…' : ''}</p>
    {(Object.values(errors).some(Boolean) || (summary?.snapshot && !summary.snapshot.consistent)) && <div className="space-y-2">
      {Object.values(errors).filter(Boolean).map((error) => <p key={error} role="alert" className="border border-red-800 bg-red-950/30 p-3 text-sm text-red-300">{error}</p>)}
      {summary?.snapshot && !summary.snapshot.consistent && <p role="status" className="border-l-2 border-amber-500 bg-amber-500/5 p-3 text-sm text-amber-200">Sources changed while this page loaded; figures may come from slightly different revisions. They refresh automatically.</p>}
    </div>}

    <Section number="01" id="energy-current" title="Current draw & use" busy={pending.summary}><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <Tile label="Live server input" value={v('summary', telemetry?.watts == null ? 'Unknown' : `${quantity(telemetry.watts, 0)} W`, tileSkel)} status={telemetry?.status} detail={v('summary', telemetry?.observedAt ? `Oldest included reading: ${localTime(telemetry.observedAt)}` : 'No fresh fleet reading', detailSkel)} />
      <Tile label="Lab energy this month" value={v('summary', telemetry?.kwh == null ? 'Unknown' : `${quantity(telemetry.kwh, 2)} kWh`, tileSkel)} status={telemetry?.energyStatus} detail={v('summary', telemetry?.coveragePercent == null ? 'Coverage unknown' : `${quantity(telemetry.coveragePercent, 0)}% of server time monitored${telemetry.retiredHostsInPeriod ? ` · includes ${telemetry.retiredHostsInPeriod} retired server(s)` : ''}`, detailSkel)} />
      <Tile label="Electricity unit price" value={v('summary', price?.orePerKwh == null ? 'Unknown' : `${quantity(price.orePerKwh / 100, 3)} kr./kWh`, tileSkel)} status={price?.status} detail={v('summary', price?.basis ? `${basisLabel(price.basis)} · ${price.validUntil ? `valid until ${localTime(price.validUntil)}` : 'validity unavailable'}` : 'Price basis not configured', detailSkel)} />
      <Tile label="Lab electricity cost" value={v('summary', dkk(cost?.actualOre), tileSkel)} status={cost?.status && costStatusLabel(cost.status)} detail={v('summary', cost?.statementRevision ? `Finalized statement, revision ${cost.statementRevision}` : estimate.total == null ? 'Month estimate unavailable' : `Estimated month total: ${estimate.total}`, detailSkel)} />
    </div><p className="text-xs text-gray-500">Watts are instantaneous input power. kWh is energy integrated over monitored time. A unit price (kr./kWh) is not the servers’ running cost per hour. Missing coverage or price components make the cost partial, never zero.</p></Section>

    <Section number="02" id="energy-cost" title="Cost breakdown" busy={pending.summary}><div className="grid gap-4 lg:grid-cols-2">
      <div className={panel}>
        <p className={`${eyebrow} pb-2`}>Calculated lab cost · {v('summary', costStatusLabel(cost?.status), 'h-3 w-20')}</p>
        {cost?.components?.length ? cost.components.map((component) => <Row key={component.key} label={component.label} note={componentStatusLabel(component.status)} value={dkk(component.ore)} />) : <p className="border-t border-gray-800 pt-3 text-sm text-gray-400">{ready('summary') ? 'No cost components are available for this month.' : v('summary', null, 'h-4 w-48')}</p>}
        <Row label="Calculated lab cost" note={v('summary', cost?.source === 'finalized_statement' ? `Immutable finalized statement, revision ${cost.statementRevision}` : cost?.observedThrough ? `Live calculation through ${localTime(cost.observedThrough)}` : 'Not calculated', detailSkel)} value={v('summary', dkk(cost?.actualOre), 'h-4 w-20')} />
        <Row label="Estimated month total" note={v('summary', estimate.note, detailSkel)} value={v('summary', estimate.value, 'h-4 w-20')} />
      </div>
      <div className={panel}>
        <p className={`${eyebrow} pb-2`}>Whole-household electricity</p>
        {!ready('summary') ? <p className="border-t border-gray-800 pt-3 text-sm text-gray-400">{v('summary', null, 'h-4 w-48')}</p> : household?.shared ? <>
          <Row label={household.basis === 'paid' ? 'Household amount paid' : 'Household invoice total'} note={household.status === 'available' ? `${household.billKind === 'advance' ? 'Advance' : 'Settlement'} invoice · ${String(household.billStatus || '').replaceAll('_', ' ')}` : 'No invoice recorded for this month'} value={dkk(household.totalOre)} />
          <p className="mt-3 text-xs text-gray-500">Shared by the owner for context. It covers the entire household, servers included; it is not added to the lab cost and support is not requested for it.</p>
        </> : <p className="border-t border-gray-800 pt-3 text-sm text-gray-400">The owner has not shared household electricity totals.</p>}
      </div>
    </div></Section>

    <Section number="03" id="energy-history" title="Power history" busy={pending.history}><div className={panel}>
      <div className="flex flex-wrap items-center justify-between gap-3"><p className={eyebrow}>Measured input / watts</p><div className="flex gap-2" role="group" aria-label="History range">{['24h', '7d'].map((value) => <button key={value} onClick={() => selectRange(value)} aria-pressed={range === value} className={btnToggle(range === value)}>{value}</button>)}</div></div>
      {!ready('history') ? <div className="mt-4">{blockFallback('history', 'h-32 w-full')}</div> : <>
      <TimeSeriesChart points={points} field="watts" from={history?.from} through={history?.through} binSeconds={history?.energy?.binSeconds} color="#fb923c" empty="No measured trend yet."
        label={`Server power over the last ${range}${markers.length ? `, with ${markers.length} verified mode changes` : ''}`} formatValue={(watts) => `${quantity(watts, 0)} W`}
        detail={(point) => `${point.measuredHosts} server${point.measuredHosts === 1 ? '' : 's'} measured, average for the interval`} markers={markers} markerText={(marker) => `${modeLabel(marker.mode)} (${reasonText(marker.reason)})`} />
      {points.length > 0 && <details className="mt-3 text-sm"><summary className={`cursor-pointer text-orange-300 ${focus}`}>Power readings table</summary><div className="mt-2 max-h-64 overflow-auto"><table className="w-full text-left"><thead><tr><th className="py-2 font-normal text-gray-400">Time</th><th className="py-2 font-normal text-gray-400">Watts</th><th className="py-2 font-normal text-gray-400">Servers measured</th></tr></thead><tbody>{points.map((point) => <tr key={point.at} className="border-t border-gray-800"><td className="py-2">{localTime(point.at)}</td><td>{quantity(point.watts, 0)}</td><td>{point.measuredHosts}</td></tr>)}</tbody></table></div></details>}
      {markers.length > 0 && <details className="mt-3 text-sm"><summary className={`cursor-pointer text-orange-300 ${focus}`}>Verified mode changes ({markers.length})</summary><ul className="mt-2 space-y-1 text-xs text-gray-400">{markers.map((marker) => <li key={`${marker.at}-${marker.mode}`}>{localTime(marker.at)}: {modeLabel(marker.mode)} ({reasonText(marker.reason)})</li>)}</ul><p className="mt-2 text-xs text-gray-500">Dashed lines mark verified changes. Power before and after a change is an observation, not proof of savings.</p></details>}
      <p className={`mt-6 border-t border-gray-800 pt-5 ${eyebrow}`}>Integrated server energy / kWh per {range === '24h' ? 'hour' : 'two hours'}</p>
      <TimeSeriesChart kind="bar" points={energyPoints} field="kwh" from={history?.from} through={history?.through} binSeconds={history?.energy?.binSeconds} color="#60a5fa" empty="No integrated energy trend yet."
        label={`Integrated server energy over the last ${range}`} formatValue={(kwh) => `${new Intl.NumberFormat('da-DK', { minimumFractionDigits: 3, maximumFractionDigits: 3 }).format(kwh)} kWh`} faded={(point) => point.expectedSeconds > 0 && point.coveredSeconds / point.expectedSeconds < 0.8}
        detail={(point) => point.expectedSeconds > 0 ? `${quantity(point.coveredSeconds / point.expectedSeconds * 100, 0)}% of the interval measured` : 'Coverage unknown'} />
      {energyPoints.length > 0 && <details className="mt-3 text-sm"><summary className={`cursor-pointer text-orange-300 ${focus}`}>Energy intervals table</summary><div className="mt-2 max-h-64 overflow-auto"><table className="w-full text-left"><thead><tr><th className="py-2 font-normal text-gray-400">Time</th><th className="py-2 font-normal text-gray-400">Server kWh</th><th className="py-2 font-normal text-gray-400">Coverage</th></tr></thead><tbody>{energyPoints.map((point) => <tr key={point.at} className="border-t border-gray-800"><td className="py-2">{localTime(point.at)}</td><td>{quantity(point.kwh, 3)}</td><td>{point.expectedSeconds > 0 ? `${quantity(point.coveredSeconds / point.expectedSeconds * 100, 0)}%` : 'Unknown'}</td></tr>)}</tbody></table></div></details>}
      </>}
    </div></Section>

    <Section number="04" id="energy-modes" title="Server modes" busy={pending.hosts}><div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{!ready('hosts') ? (pending.hosts ? [0, 1, 2].map((n) => <div key={n} className={panel}><Skel className="block h-24 w-full" /></div>) : <p className="text-sm text-amber-300 sm:col-span-full">Unavailable. See the message above.</p>) : hosts?.hosts?.length ? hosts.hosts.map((host) => <HostCard key={host.alias} host={host} preview={previewByAlias.get(host.alias)} v={v} />) : <p className="text-sm text-gray-400">No server mode observations are configured.</p>}</div>
      {(preview?.hosts || []).length > 0 && <div className="space-y-2">{preview.hosts.map((item) => <PreviewTable key={item.alias} preview={item} />)}</div>}
      <p className="text-xs text-gray-500">Observed modes are hardware readings and may be stale. The selected mode comes from the same policy resolver the controller uses. Periods after the last published price are shown as unknown, with the weekly baseline listed separately. This page cannot change any mode.</p></Section>

    <Section number="05" id="energy-budget" title="Budget & support" busy={pending.summary}><p className={eyebrow}>Allocation · {v('summary', <>{fundingStatusLabel(funding?.status)}{funding?.reconciledAt ? ` · PayPal reconciled ${localTime(funding.reconciledAt)}` : ' · PayPal reconciliation not yet run'}</>, 'h-3 w-40')}</p>
      <div className="grid gap-4 lg:grid-cols-2"><div className={panel}>
        <p className={`${eyebrow} pb-2`}>Received this month</p>
        <Row label="Gross contributions received" value={v('summary', dkk(funding?.grossOre), 'h-4 w-20')} /><Row label="Actual payment fees" value={v('summary', dkk(funding?.feeDebitsOre), 'h-4 w-20')} /><Row label="Fee credits" value={v('summary', dkk(funding?.feeCreditsOre), 'h-4 w-20')} /><Row label="Refunds and reversals" value={v('summary', dkk(funding?.refundDebitsOre), 'h-4 w-20')} />
        <Row label="Known net received" value={v('summary', dkk(funding?.knownNetOre), 'h-4 w-20')} note="Already net of fees; fees are not subtracted again." />
        <Row label="Unresolved net" value={v('summary', funding?.unresolvedOre === 0 ? dkk(0) : 'Unknown', 'h-4 w-20')} note={ready('summary') && funding?.unresolvedOre !== 0 ? 'Some payments are awaiting their actual fee; net stays unknown until then.' : undefined} />
        {held && <Row label="Pending or disputed (not counted)" value={`${held.pendingCount + held.disputeCount} open`} note={`Pending ${held.pendingOre == null ? 'amount unknown' : dkk(held.pendingOre)} · disputed ${held.disputedOre == null ? 'amount unknown' : dkk(held.disputedOre)}`} />}
      </div><div className={panel}>
        <p className={`${eyebrow} pb-2`}>Applied to this month’s cost</p>
        <Row label="Credit carried in from earlier months" value={v('summary', dkk(funding?.openingCreditOre), 'h-4 w-20')} />
        <Row label="Eligible net support available" value={v('summary', dkk(funding?.eligibleNetOre), 'h-4 w-20')} note="Carried-in credit plus this month’s known net." />
        <Row label="Credit applied to this month" value={v('summary', dkk(funding?.appliedOre), 'h-4 w-20')} />
        <Row label="Remaining owner-funded cost" value={v('summary', dkk(funding?.ownerFundedOre), 'h-4 w-20')} />
        <Row label="Owner adjustment after refunds" value={v('summary', dkk(funding?.ownerAdjustmentOre), 'h-4 w-20')} />
        <Row label="Credit carried forward" value={v('summary', dkk(funding?.carryForwardOre), 'h-4 w-20')} />
        {!ready('summary') ? <div className="mt-4">{v('summary', null, 'h-3 w-full')}</div> : progress ? <div className="mt-4"><p className="text-xs text-gray-300">Confirmed net credit applied / {progress.basis}: {quantity(progress.percent, 1)}%{progress.estimate ? ' (estimate, the month is still open)' : ''}</p><div className="mt-2 h-2 bg-gray-800" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percent} aria-label={`Funding progress against ${progress.basis}`}><div className="h-full bg-orange-500" style={{ width: `${progress.percent}%` }} /></div>{progress.estimate && <p className="mt-1 text-xs text-gray-500">Estimated owner share so far: {dkk(funding.progress.ownerRemainderOre)}</p>}</div>
          : <p className="mt-4 text-xs text-gray-500">Funding progress is shown once the cost is calculated and verified receipts are allocated.</p>}
      </div></div>
      <p className="text-xs text-gray-500">Support is entirely optional. It never changes access, quotas or service priority, and it does not change the electricity cost itself. These figures describe this lab’s recorded receipts, not a PayPal or bank balance.</p>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3 font-mono text-xs"><Link className={linkCls} to="/support">Optional contribution controls and your private history →</Link>
        <button type="button" onClick={() => downloadCsv('/energy/summary.csv', { month }, `energy-budget-${month}.csv`).catch(() => setErrors((old) => ({ ...old, export: 'Export failed.' })))} className={btnGhost}>Download this month as CSV</button></div></Section>

    <Section number="06" id="energy-months" title="Monthly history" busy={pending.months}>{!ready('months') ? <div className={panel}>{blockFallback('months', 'h-32 w-full')}</div> : months?.months?.length ? <div className={`${panel} overflow-x-auto`}><table className="w-full min-w-[640px] text-left text-sm"><caption className="sr-only">Monthly lab energy, cost and support</caption><thead><tr className="text-xs text-gray-400"><th className="py-2 font-normal">Month</th><th className="font-normal">Lab kWh</th><th className="font-normal">Lab cost</th><th className="font-normal">Gross</th><th className="font-normal">Known net</th><th className="font-normal">Applied</th><th className="font-normal">Owner-funded</th><th className="font-normal">Carried forward</th></tr></thead>
      <tbody>{months.months.map((item) => <tr key={item.month} className="border-t border-gray-800 tabular-nums"><td className="py-2"><button type="button" onClick={() => selectMonth(item.month)} className={`text-orange-300 underline-offset-4 hover:underline ${focus}`}>{monthLabel(item.month)}</button></td><td>{item.kwh == null ? 'Unknown' : quantity(item.kwh, 1)}</td>
        <td>{item.costOre == null ? <span className="text-gray-500">{item.costStatus === 'open' ? 'Open month' : 'Not finalized'}</span> : `${dkk(item.costOre)}${item.costStatus === 'finalized_partial' ? ' (partial)' : ''}`}</td><td>{dkk(item.grossOre)}</td><td>{dkk(item.knownNetOre)}</td><td>{dkk(item.appliedOre)}</td><td>{dkk(item.ownerFundedOre)}</td><td>{dkk(item.carryForwardOre)}</td></tr>)}</tbody></table>
      <p className="mt-3 text-xs text-gray-500">Costs appear once a month is finalized; applied credit and owner share once verified receipts are allocated to that cost.</p></div> : <p className="text-sm text-gray-400">No monthly history yet.</p>}</Section>

    {user?.isAdmin && <EnergyBudgetAdminPanel month={month} onChanged={() => loadSummary(true)} downloadCsv={downloadCsv} />}
  </div></Layout>;
}
