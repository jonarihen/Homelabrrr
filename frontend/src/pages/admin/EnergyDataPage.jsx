import { useEffect, useState } from 'react';
import api from '../../api.js';
import ElectricityPricingPanel from './ElectricityPricingPanel.jsx';
import ExtraLabLoadsPanel from './ExtraLabLoadsPanel.jsx';
import ElectricityBillsPanel from './ElectricityBillsPanel.jsx';

export default function EnergyDataPage() {
  const [status, setStatus] = useState(null);
  const [meters, setMeters] = useState([]);
  const [token, setToken] = useState('');
  const [meterId, setMeterId] = useState('');
  const [scope, setScope] = useState('household');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [period, setPeriod] = useState({ from: '', to: '' });
  const refresh = async () => {
    const { data } = await api.get('/admin/energy-data/status');
    setStatus(data);
    if (data.configured) setMeters((await api.get('/admin/energy-data/meters')).data.meters);
  };
  useEffect(() => { refresh().catch(() => setMessage('Could not load energy data setup.')); }, []);
  const local = (value) => value ? new Date(value).toLocaleString() : 'Unknown';
  const action = async (path, body = {}) => {
    setBusy(true); setMessage('');
    try { await api.post(`/admin/energy-data/${path}`, body); await refresh(); setMessage('Saved.'); }
    catch (err) { setMessage(err.response?.data?.error || 'Request failed.'); }
    finally { setBusy(false); }
  };
  return <main className="max-w-4xl space-y-6 p-6 text-slate-100">
    <header><p className="text-xs uppercase tracking-[.2em] text-orange-500">Power & Energy</p><h1 className="text-3xl font-semibold">Electricity meter data</h1>
      <p className="mt-2 text-sm text-slate-400">Connect your own ElOverblik Customer API token. Household meter readings are private and are never counted as server use.</p></header>
    {message && <p role="status" className="rounded border border-orange-700 p-3 text-sm">{message}</p>}
    <section className="rounded border border-slate-700 bg-slate-900 p-5 space-y-3">
      <h2 className="text-lg font-medium">Connection</h2>
      <p className="text-sm text-slate-400">Create a Customer API refresh token in ElOverblik and paste it here. The token is stored encrypted. No MitID credentials are needed.</p>
      <form onSubmit={(event) => { event.preventDefault(); action('connection', { refreshToken: token }).then(() => setToken('')); }} className="flex gap-3">
        <input aria-label="ElOverblik refresh token" type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} className="min-w-0 flex-1 rounded bg-slate-800 p-2" />
        <button disabled={busy || !token} className="rounded bg-orange-700 px-4 py-2 disabled:opacity-50">Test and save</button>
      </form>
      <p className="text-sm">{status?.configured ? 'Connected' : 'Not configured'} · {status?.enabled ? 'Sync enabled' : 'Sync disabled'}</p>
    </section>
    {status?.configured && <section className="rounded border border-slate-700 bg-slate-900 p-5 space-y-3">
      <h2 className="text-lg font-medium">Selected meter</h2>
      <p className="text-sm text-slate-400">Current: {status.selectedMeter || 'None'} · Scope: {status.scope}</p>
      <select aria-label="Meter" value={meterId} onChange={(event) => setMeterId(event.target.value)} className="w-full rounded bg-slate-800 p-2"><option value="">Choose a linked meter</option>{meters.filter((meter) => meter.hasRelation).map((meter) => <option key={meter.id} value={meter.id}>••••{meter.id.slice(-4)} ({meter.type || 'meter'})</option>)}</select>
      <select aria-label="Meter scope" value={scope} onChange={(event) => setScope(event.target.value)} className="w-full rounded bg-slate-800 p-2"><option value="household">Whole household (default)</option><option value="dedicated_lab">Dedicated lab meter</option></select>
      <button disabled={busy || !meterId} onClick={() => action('meter', { meterId, scope })} className="rounded bg-orange-700 px-4 py-2 disabled:opacity-50">Select meter and enable sync</button>
      {status.attention && <p role="alert" className="rounded border border-red-700 p-3 text-sm text-red-300">Sync paused since {local(status.attention.since)}: {status.attention.code === 'RECONNECT_REQUIRED' ? 'the refresh token was rejected — paste a new token above.' : 'the selected meter is not authorized or no longer linked — check the relation in ElOverblik, then reselect the meter.'}</p>}
      <dl className="grid gap-2 text-sm text-slate-400 md:grid-cols-2">
        <div>Last attempt: {local(status.lastAttemptAt)}</div>
        <div>Last success: {status.lastSuccessAt ? local(status.lastSuccessAt) : 'Never'}</div>
        <div>Covered: {status.coverage?.earliestIntervalStart ? `${local(status.coverage.earliestIntervalStart)} → ${local(status.coverage.latestIntervalEnd)}` : 'No data yet'}</div>
        <div>Backfill: {status.backfill?.inProgress ? `in progress${status.backfill.cursor ? ` (next from ${local(status.backfill.cursor)})` : ''}` : 'complete'}</div>
        <div>Intervals: {status.coverage?.intervals ?? 0} · unknown values: {status.coverage?.unknownValues ?? 0}</div>
        <div>Charges: {status.charges?.available ? `observed ${local(status.charges.lastObservedAt)} · ${status.charges.observedVersions} version(s)` : 'not available (consumption still imports)'}</div>
        <div>Error: {status.lastErrorCode || 'None'}{status.retry?.consecutiveFailures ? ` · ${status.retry.consecutiveFailures} consecutive failure(s)` : ''}</div>
        <div>Next attempt: {status.retry?.retryAfterUntil ? `provider asked to wait until ${local(status.retry.retryAfterUntil)}` : status.retry?.nextAttemptAt ? local(status.retry.nextAttemptAt) : 'scheduled'}</div>
      </dl>
      {(status.gaps?.length > 0 || status.skippedRanges?.length > 0) && <div className="rounded border border-slate-700 p-3 text-xs text-slate-400">
        <p className="font-mono uppercase tracking-widest text-orange-400">Gaps</p>
        <ul className="mt-1 space-y-1">{status.skippedRanges?.map((range) => <li key={`s-${range.from}`}>Skipped after repeated failures ({range.code}): {local(range.from)} → {local(range.to)}</li>)}
          {status.gaps?.map((gap) => <li key={`g-${gap.from}`}>Missing intervals: {local(gap.from)} → {local(gap.to)}</li>)}</ul>
      </div>}
      <form onSubmit={(event) => { event.preventDefault(); action('sync', period); }} className="flex flex-wrap items-end gap-2 text-xs text-slate-400">
        <label>Resync from<input type="date" required value={period.from} onChange={(event) => setPeriod((value) => ({ ...value, from: event.target.value }))} className="ml-1 rounded bg-slate-800 p-2" /></label>
        <label>to (exclusive, max 31 days)<input type="date" required value={period.to} onChange={(event) => setPeriod((value) => ({ ...value, to: event.target.value }))} className="ml-1 rounded bg-slate-800 p-2" /></label>
        <button disabled={busy || !status.enabled} className="rounded border border-slate-600 px-3 py-2 disabled:opacity-50">Resync period</button>
      </form>
      <div className="flex flex-wrap gap-3"><button disabled={busy || !status.enabled} onClick={() => action('sync')} className="rounded border border-slate-600 px-4 py-2 disabled:opacity-50">Sync now</button><button disabled={busy} onClick={() => action('disconnect')} className="rounded border border-red-700 px-4 py-2 disabled:opacity-50">Disconnect and keep history</button><button disabled={busy} onClick={() => { if (window.confirm('Disconnect and permanently delete all imported meter intervals and charge snapshots? Finalized cost statements are kept.')) action('disconnect', { purgeHistory: true }); }} className="rounded border border-red-700 px-4 py-2 text-red-300 disabled:opacity-50">Disconnect and purge history</button></div>
    </section>}
    <ElectricityPricingPanel />
    <ElectricityBillsPanel />
    <ExtraLabLoadsPanel />
  </main>;
}
