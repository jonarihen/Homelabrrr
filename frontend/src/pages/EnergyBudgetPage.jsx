import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import Layout from '../components/Layout.jsx';
import api from '../api.js';
import useDocumentTitle from '../hooks/useDocumentTitle.js';
import { useAuth } from '../contexts/AuthContext.jsx';
import { currentMonth, dkk, fundingProgress, historyPath, localTime, monthLabel, quantity, shiftMonth } from '../utils/energyView.js';

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
function Section({ number, title, children }) {
  return <section className="mt-10"><div className="flex items-baseline gap-4 border-b border-gray-700 pb-3"><span className="font-mono text-sm text-orange-400">{number} /</span><h2 className="aaris-display text-xl text-gray-100">{title}</h2></div>{children}</section>;
}

export default function EnergyBudgetPage() {
  useDocumentTitle('Energy & Budget');
  const { user } = useAuth();
  const [month, setMonth] = useState(currentMonth);
  const [range, setRange] = useState('24h');
  const [summary, setSummary] = useState(null);
  const [hosts, setHosts] = useState(null);
  const [history, setHistory] = useState(null);
  const [errors, setErrors] = useState({});
  const [loading, setLoading] = useState(true);

  const loadSummary = useCallback(async () => {
    try { const { data } = await api.get('/energy/summary', { params: { month } }); setSummary(data); setErrors((old) => ({ ...old, summary: '' })); }
    catch { setSummary(null); setErrors((old) => ({ ...old, summary: 'Monthly energy and budget data is unavailable.' })); }
  }, [month]);
  const loadHosts = useCallback(async () => {
    try { const { data } = await api.get('/energy/hosts'); setHosts(data); setErrors((old) => ({ ...old, hosts: '' })); }
    catch { setHosts(null); setErrors((old) => ({ ...old, hosts: 'Server status is unavailable.' })); }
  }, []);
  const loadHistory = useCallback(async () => {
    try { const { data } = await api.get('/energy/history', { params: { range } }); setHistory(data); setErrors((old) => ({ ...old, history: '' })); }
    catch { setHistory(null); setErrors((old) => ({ ...old, history: 'Power history is unavailable.' })); }
  }, [range]);
  useEffect(() => { let active = true; setLoading(true); Promise.allSettled([loadSummary(), loadHosts(), loadHistory()]).then(() => { if (active) setLoading(false); }); return () => { active = false; }; }, [loadSummary, loadHosts, loadHistory]);
  useEffect(() => { const timer = setInterval(() => { void loadSummary(); void loadHosts(); void loadHistory(); }, 60_000); return () => clearInterval(timer); }, [loadSummary, loadHosts, loadHistory]);

  const telemetry = summary?.telemetry;
  const cost = summary?.cost;
  const funding = summary?.funding;
  const price = summary?.price;
  const points = history?.points || [];
  const path = historyPath(points, 'watts', history?.from, history?.through, history?.energy?.binSeconds);
  const energyPoints = history?.energy?.points || [];
  const energyPath = historyPath(energyPoints, 'kwh', history?.from, history?.through, history?.energy?.binSeconds);
  const progress = ['calculated', 'estimated', 'finalized'].includes(cost?.status) ? fundingProgress(cost?.actualOre, funding?.appliedOre) : null;

  return <Layout><div className="mx-auto max-w-6xl px-5 py-8 text-gray-100 sm:px-8">
    <header className="flex flex-wrap items-end justify-between gap-5 border-b border-gray-700 pb-6">
      <div><p className="font-mono text-xs uppercase tracking-[.18em] text-orange-400">Private / Power & Energy</p><h1 className="aaris-display mt-2 text-3xl sm:text-4xl">Energy & Budget</h1><p className="mt-2 max-w-2xl text-sm text-gray-400">Measured server power, calculated electricity cost and confirmed voluntary support. Figures remain unknown until their sources are available.</p></div>
      <div className="flex items-center gap-3 font-mono text-xs"><button aria-label="Previous month" onClick={() => setMonth(shiftMonth(month, -1))} className="border border-gray-700 px-3 py-2 hover:border-orange-500 focus-visible:outline-2 focus-visible:outline-orange-500">←</button><span className="min-w-30 text-center uppercase">{monthLabel(month)}</span><button aria-label="Next month" onClick={() => setMonth(shiftMonth(month, 1))} disabled={month >= currentMonth()} className="border border-gray-700 px-3 py-2 hover:border-orange-500 disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-orange-500">→</button></div>
    </header>
    {loading && <p role="status" className="mt-5 text-sm text-gray-400">Loading energy data…</p>}
    {Object.values(errors).filter(Boolean).map((error) => <p key={error} role="alert" className="mt-3 border-l-2 border-amber-500 bg-amber-500/5 p-3 text-sm text-amber-200">{error}</p>)}

    <Section number="01" title="Current draw & use"><div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Tile label="Live server input" value={telemetry?.watts == null ? 'Unknown' : `${quantity(telemetry.watts, 0)} W`} status={telemetry?.status} detail={telemetry?.observedAt ? `Oldest included reading: ${localTime(telemetry.observedAt)}` : 'No fresh fleet reading'} />
      <Tile label="Lab energy this month" value={telemetry?.kwh == null ? 'Unknown' : `${quantity(telemetry.kwh, 2)} kWh`} status={telemetry?.energyStatus} detail={telemetry?.coveragePercent == null ? 'Coverage unknown' : `${quantity(telemetry.coveragePercent, 0)}% of configured server time monitored`} />
      <Tile label="Electricity unit price" value={price?.orePerKwh == null ? 'Unknown' : `${quantity(price.orePerKwh / 100, 3)} kr./kWh`} status={price?.status} detail={price?.basis ? `${price.basis} · valid until ${localTime(price.validUntil)}` : 'Price basis not configured'} />
      <Tile label="Lab electricity cost" value={dkk(cost?.actualOre)} status={cost?.status} detail={cost?.forecastOre == null ? 'Month-end forecast unavailable' : `Forecast: ${dkk(cost.forecastOre)}`} />
    </div><p className="mt-3 text-xs text-gray-500">Watts are instantaneous input power. kWh is energy accumulated over monitored time. A unit price is not an hourly server cost. Missing coverage or price components make the cost partial.</p></Section>

    <Section number="02" title="Power history"><div className="mt-4 border border-gray-700 bg-gray-900/80 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3"><p className="font-mono text-xs uppercase tracking-widest text-gray-400">Measured input / watts</p><div className="flex gap-2">{['24h', '7d'].map((value) => <button key={value} onClick={() => setRange(value)} aria-pressed={range === value} className={`border px-3 py-1 font-mono text-xs focus-visible:outline-2 focus-visible:outline-orange-500 ${range === value ? 'border-orange-500 text-orange-300' : 'border-gray-700 text-gray-400'}`}>{value}</button>)}</div></div>
      {path ? <svg className="mt-5 h-32 w-full" viewBox="0 0 600 120" preserveAspectRatio="none" role="img" aria-label={`Server power over the last ${range}`}><path d={path} fill="none" stroke="#fb923c" strokeWidth="2" vectorEffect="non-scaling-stroke" /></svg> : <p className="mt-6 text-sm text-gray-400">No measured trend yet.</p>}
      {points.length > 0 && <details className="mt-3 text-sm"><summary className="cursor-pointer text-orange-300 focus-visible:outline-2 focus-visible:outline-orange-500">Power readings table</summary><div className="mt-2 max-h-64 overflow-auto"><table className="w-full text-left"><thead><tr><th className="py-2 font-normal text-gray-400">Time</th><th className="py-2 font-normal text-gray-400">Watts</th><th className="py-2 font-normal text-gray-400">Servers measured</th></tr></thead><tbody>{points.map((point) => <tr key={point.at} className="border-t border-gray-800"><td className="py-2">{localTime(point.at)}</td><td>{quantity(point.watts, 0)}</td><td>{point.measuredHosts}</td></tr>)}</tbody></table></div></details>}
      <p className="mt-6 border-t border-gray-800 pt-4 font-mono text-xs uppercase tracking-widest text-gray-400">Integrated server energy / kWh per {range === '24h' ? 'hour' : 'two hours'}</p>
      {energyPath ? <svg className="mt-3 h-32 w-full" viewBox="0 0 600 120" preserveAspectRatio="none" role="img" aria-label={`Integrated server energy over the last ${range}`}><path d={energyPath} fill="none" stroke="#60a5fa" strokeWidth="2" vectorEffect="non-scaling-stroke" /></svg> : <p className="mt-4 text-sm text-gray-400">No integrated energy trend yet.</p>}
      {energyPoints.length > 0 && <details className="mt-3 text-sm"><summary className="cursor-pointer text-orange-300 focus-visible:outline-2 focus-visible:outline-orange-500">Energy intervals table</summary><div className="mt-2 max-h-64 overflow-auto"><table className="w-full text-left"><thead><tr><th className="py-2 font-normal text-gray-400">Time</th><th className="py-2 font-normal text-gray-400">Server kWh</th><th className="py-2 font-normal text-gray-400">Coverage</th></tr></thead><tbody>{energyPoints.map((point) => <tr key={point.at} className="border-t border-gray-800"><td className="py-2">{localTime(point.at)}</td><td>{quantity(point.kwh, 3)}</td><td>{point.expectedSeconds > 0 ? `${quantity(point.coveredSeconds / point.expectedSeconds * 100, 0)}%` : 'Unknown'}</td></tr>)}</tbody></table></div></details>}
    </div></Section>

    <Section number="03" title="Server modes"><div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{hosts?.hosts?.length ? hosts.hosts.map((host) => <div key={host.alias} className="border border-gray-700 bg-gray-900/80 p-4"><div className="flex justify-between gap-2"><h3 className="font-mono text-xs uppercase tracking-widest text-orange-300">{host.alias}</h3><span className="font-mono text-xs text-gray-400">{host.stale ? 'Stale' : host.monitoring}</span></div><p className="mt-3 text-lg">{host.observedMode || 'Mode unknown'}</p><p className="mt-1 text-sm text-gray-400">{host.watts == null ? 'Power unknown' : `${quantity(host.watts, 0)} W`} · {host.ageSeconds == null ? 'No observation' : `${host.ageSeconds}s old`}</p><p className="mt-2 text-xs text-gray-500">{host.reason ? `Policy: ${host.reason.replaceAll('_', ' ')} · baseline ${host.baseMode || 'unknown'} · selected ${host.desiredMode || 'none'}` : 'Control reason unavailable'}{host.priceValidUntil ? ` · price valid until ${localTime(host.priceValidUntil)}` : ''}</p></div>) : <p className="text-sm text-gray-400">No server mode observations are configured.</p>}</div><p className="mt-3 text-xs text-gray-500">Displayed modes are hardware observations. The policy selection is calculated from the latest available configuration and price; an observation may be stale.</p></Section>

    <Section number="04" title="Budget & support"><div className="mt-4 grid gap-3 lg:grid-cols-2"><div className="border border-gray-700 bg-gray-900/80 p-4"><Row label="Gross contributions received" value={dkk(funding?.grossOre)} /><Row label="Actual payment fees" value={dkk(funding?.feeDebitsOre)} /><Row label="Fee credits" value={dkk(funding?.feeCreditsOre)} /><Row label="Refunds and reversals" value={dkk(funding?.refundDebitsOre)} /><Row label="Known net received" value={dkk(funding?.knownNetOre)} note="Already net of fees; fees are not subtracted again." /><Row label="Unresolved or held" value={dkk(funding?.unresolvedOre)} /></div><div className="border border-gray-700 bg-gray-900/80 p-4"><Row label="Eligible net support" value={dkk(funding?.eligibleNetOre)} /><Row label="Credit applied to this month" value={dkk(funding?.appliedOre)} /><Row label="Remaining owner-funded cost" value={dkk(funding?.ownerFundedOre)} /><Row label="Owner adjustment after refunds" value={dkk(funding?.ownerAdjustmentOre)} /><Row label="Credit carried forward" value={dkk(funding?.carryForwardOre)} /><Row label="Reconciled" value={localTime(funding?.reconciledAt)} />{progress !== null && <div className="mt-4"><p className="text-xs text-gray-400">Confirmed credit applied / current lab cost: {quantity(progress, 1)}%</p><div className="mt-2 h-2 bg-gray-800"><div className="h-full bg-orange-500" style={{ width: `${progress}%` }} /></div></div>}</div></div><p className="mt-3 text-xs text-gray-500">Support is entirely optional. It never changes access, quotas or service priority. These figures describe this lab’s recorded receipts, not a PayPal or bank balance.</p><Link className="mt-3 inline-block font-mono text-xs text-orange-300 underline underline-offset-4" to="/support">Optional contribution controls and your private history →</Link></Section>

    {user?.isAdmin && <Section number="05" title="Setup & coverage"><div className="mt-4 flex flex-wrap gap-3 font-mono text-xs"><Link className="border border-gray-700 px-4 py-3 text-orange-300 hover:border-orange-500" to="/admin/hosts">iLO & telemetry ↗</Link><Link className="border border-gray-700 px-4 py-3 text-orange-300 hover:border-orange-500" to="/admin/energy-data">Electricity meter & pricing ↗</Link><Link className="border border-gray-700 px-4 py-3 text-orange-300 hover:border-orange-500" to="/admin/paypal">PayPal setup ↗</Link></div></Section>}
  </div></Layout>;
}
