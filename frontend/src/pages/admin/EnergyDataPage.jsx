import { useEffect, useState } from 'react';
import api from '../../api.js';
import Field from '../../components/Field.jsx';
import ElectricityPricingPanel from './ElectricityPricingPanel.jsx';
import ExtraLabLoadsPanel from './ExtraLabLoadsPanel.jsx';
import ElectricityBillsPanel from './ElectricityBillsPanel.jsx';
import { useConfirm } from '../../contexts/FeedbackContext.jsx';
import RecentReauthDialog from '../../components/account/RecentReauthDialog.jsx';
import { localTime } from '../../utils/energyView.js';

const card = 'bg-gray-900 border border-gray-800 rounded-2xl p-5';
const inputCls = 'w-full bg-gray-800 border border-gray-700/50 rounded-xl px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/20 transition-all disabled:opacity-60';
const btnPrimary = 'btn-primary rounded-xl px-4 py-2.5 text-sm font-medium';
const btnSecondary = 'border border-gray-700 hover:border-gray-500 text-gray-200 rounded-lg px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
const btnDanger = 'border border-red-800 hover:border-red-600 text-red-400 hover:text-red-300 rounded-lg px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
const calloutCls = { error: 'border-red-800/30 bg-red-900/20 text-red-400', ok: 'border-green-800/30 bg-green-900/20 text-green-400' };

function Card({ title, description, children }) {
  return <section className={card} aria-label={title}>
    <h2 className="aaris-display text-sm text-gray-200">{title}</h2>
    {description && <p className="mt-1.5 max-w-3xl text-xs text-gray-500">{description}</p>}
    <div className="mt-5 space-y-5">{children}</div>
  </section>;
}
function Stat({ label, children }) {
  return <div><dt className="text-[11px] font-mono uppercase tracking-[0.1em] text-gray-500">{label}</dt><dd className="mt-0.5 text-sm text-gray-200">{children}</dd></div>;
}

export default function EnergyDataPage() {
  const confirm = useConfirm();
  const [status, setStatus] = useState(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [meters, setMeters] = useState(null);
  const [token, setToken] = useState('');
  const [meterId, setMeterId] = useState('');
  const [scope, setScope] = useState('household');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [period, setPeriod] = useState({ from: '', to: '' });
  const [reauth, setReauth] = useState(null);
  const [reauthError, setReauthError] = useState('');
  const say = (text, error = false) => setNotice(text ? { text, error } : null);
  const refresh = async () => {
    const { data } = await api.get('/admin/energy-data/status');
    setStatus(data);
    if (data.configured) {
      try { setMeters((await api.get('/admin/energy-data/meters')).data.meters); }
      catch (err) { setMeters((old) => old ?? []); throw err; }
    }
  };
  useEffect(() => { refresh().catch(() => { setLoadFailed(true); say('Could not load energy data setup.', true); }); }, []);
  // Connection, meter and disconnect need a recent password + 2FA check; on
  // REAUTHENTICATION_REQUIRED the request is parked and retried after the dialog.
  const action = async (path, body = {}) => {
    setBusy(true); say('');
    try { await api.post(`/admin/energy-data/${path}`, body); await refresh(); say('Saved.'); return true; }
    catch (err) {
      if (err.response?.data?.code === 'REAUTHENTICATION_REQUIRED') { setReauth({ path, body }); setReauthError(''); }
      else say(err.response?.data?.error || 'Request failed.', true);
      return false;
    } finally { setBusy(false); }
  };
  const confirmReauth = async (credentials) => {
    try { await api.post('/auth/reauthenticate', credentials); }
    catch (err) { setReauthError(err.response?.data?.error || 'Identity confirmation failed.'); return false; }
    const pending = reauth; setReauth(null);
    if (await action(pending.path, pending.body) && pending.path === 'connection') setToken('');
    return true;
  };
  const loading = !status && !loadFailed;
  return <main className="mx-auto max-w-5xl space-y-6 p-6 text-gray-100 lg:p-8">
    <header><p className="font-mono text-[11px] uppercase tracking-[0.12em] text-orange-500">Power & Energy</p><h1 className="aaris-display mt-1.5 text-xl text-gray-100">Electricity meter data</h1>
      <p className="mt-1 max-w-3xl text-sm text-gray-500">Connect your own ElOverblik Customer API token. Household meter readings are private and are never counted as server use.</p></header>
    {notice && <p role={notice.error ? 'alert' : 'status'} className={`rounded-xl border p-3 text-xs ${notice.error ? calloutCls.error : calloutCls.ok}`}>{notice.text}</p>}
    <Card title="Connection" description="Create a Customer API refresh token in ElOverblik and paste it here. The token is stored encrypted. No MitID credentials are needed.">
      <form onSubmit={(event) => { event.preventDefault(); action('connection', { refreshToken: token }).then((ok) => { if (ok) setToken(''); }); }} className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1"><Field label="ElOverblik refresh token"><input type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} className={inputCls} /></Field></div>
        <button disabled={busy || !token} className={btnPrimary}>Test and save</button>
      </form>
      {loading ? <div className="h-7 w-64 animate-pulse rounded-full bg-gray-800/60" role="status" aria-label="Loading connection status" />
        : loadFailed ? <p className="text-sm text-gray-500">Connection status unavailable.</p>
        : <p className="flex flex-wrap items-center gap-2 text-xs">
          <span className={`rounded-full px-2.5 py-1 ${status.configured ? 'bg-green-500/10 text-green-400 ring-1 ring-green-500/20' : 'bg-gray-800 text-gray-400'}`}>{status.configured ? 'Connected' : 'Not configured'}</span>
          <span className={`rounded-full px-2.5 py-1 ${status.enabled ? 'bg-green-500/10 text-green-400 ring-1 ring-green-500/20' : 'bg-gray-800 text-gray-400'}`}>{status.enabled ? 'Sync enabled' : 'Sync disabled'}</span></p>}
    </Card>
    {status?.configured && <Card title="Selected meter" description={`Current: ${status.selectedMeter || 'None'} · Scope: ${status.scope}`}>
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Meter"><select value={meterId} disabled={!meters} onChange={(event) => setMeterId(event.target.value)} className={inputCls}><option value="">{meters ? 'Choose a linked meter' : 'Loading meters…'}</option>{(meters || []).filter((meter) => meter.hasRelation).map((meter) => <option key={meter.id} value={meter.id}>••••{meter.id.slice(-4)} ({meter.type || 'meter'})</option>)}</select></Field>
        <Field label="Meter scope"><select value={scope} onChange={(event) => setScope(event.target.value)} className={inputCls}><option value="household">Whole household (default)</option><option value="dedicated_lab">Dedicated lab meter</option></select></Field>
      </div>
      <div><button disabled={busy || !meterId} onClick={() => action('meter', { meterId, scope })} className={btnPrimary}>Select meter and enable sync</button></div>
      {status.attention && <p role="alert" className="rounded-xl border border-red-800/30 bg-red-900/20 p-3 text-xs text-red-400">Sync paused since {localTime(status.attention.since)}: {status.attention.code === 'RECONNECT_REQUIRED' ? 'the refresh token was rejected — paste a new token above.' : 'the selected meter is not authorized or no longer linked — check the relation in ElOverblik, then reselect the meter.'}</p>}
      <dl className="grid gap-x-6 gap-y-4 border-t border-gray-800 pt-5 sm:grid-cols-2">
        <Stat label="Last attempt">{localTime(status.lastAttemptAt)}</Stat>
        <Stat label="Last success">{status.lastSuccessAt ? localTime(status.lastSuccessAt) : 'Never'}</Stat>
        <Stat label="Covered">{status.coverage?.earliestIntervalStart ? `${localTime(status.coverage.earliestIntervalStart)} → ${localTime(status.coverage.latestIntervalEnd)}` : 'No data yet'}</Stat>
        <Stat label="Backfill">{status.backfill?.inProgress ? `in progress${status.backfill.cursor ? ` (next from ${localTime(status.backfill.cursor)})` : ''}` : 'complete'}</Stat>
        <Stat label="Intervals">{status.coverage?.intervals ?? 0} · unknown values: {status.coverage?.unknownValues ?? 0}</Stat>
        <Stat label="Charges">{status.charges?.available ? `observed ${localTime(status.charges.lastObservedAt)} · ${status.charges.observedVersions} version(s)` : 'not available (consumption still imports)'}</Stat>
        <Stat label="Error">{status.lastErrorCode || 'None'}{status.retry?.consecutiveFailures ? ` · ${status.retry.consecutiveFailures} consecutive failure(s)` : ''}</Stat>
        <Stat label="Next attempt">{status.retry?.retryAfterUntil ? `provider asked to wait until ${localTime(status.retry.retryAfterUntil)}` : status.retry?.nextAttemptAt ? localTime(status.retry.nextAttemptAt) : 'scheduled'}</Stat>
      </dl>
      {(status.gaps?.length > 0 || status.skippedRanges?.length > 0) && <div className="rounded-xl border border-gray-700/50 bg-gray-800/40 p-4 text-xs text-gray-400">
        <p className="font-mono text-[11px] uppercase tracking-[0.1em] text-amber-300">Gaps</p>
        <ul className="mt-2 space-y-1.5">{status.skippedRanges?.map((range) => <li key={`s-${range.from}`}>Skipped after repeated failures ({range.code}): {localTime(range.from)} → {localTime(range.to)}</li>)}
          {status.gaps?.map((gap) => <li key={`g-${gap.from}`}>Missing intervals: {localTime(gap.from)} → {localTime(gap.to)}</li>)}</ul>
      </div>}
      <form onSubmit={(event) => { event.preventDefault(); action('sync', period); }} className="flex flex-wrap items-end gap-4 border-t border-gray-800 pt-5">
        <div className="w-full sm:w-48"><Field label="Resync from"><input type="date" required value={period.from} onChange={(event) => setPeriod((value) => ({ ...value, from: event.target.value }))} className={inputCls} /></Field></div>
        <div className="w-full sm:w-72"><Field label="to (exclusive, max 31 days)"><input type="date" required value={period.to} onChange={(event) => setPeriod((value) => ({ ...value, to: event.target.value }))} className={inputCls} /></Field></div>
        <button disabled={busy || !status.enabled} className={btnSecondary}>Resync period</button>
      </form>
      <div className="flex flex-wrap items-center gap-3 border-t border-gray-800 pt-5">
        <button disabled={busy || !status.enabled} onClick={() => action('sync')} className={btnSecondary}>Sync now</button>
        <span className="hidden h-6 w-px bg-gray-800 sm:block" aria-hidden="true" />
        <button disabled={busy} onClick={() => action('disconnect')} className={btnDanger}>Disconnect and keep history</button>
        <button disabled={busy} onClick={async () => { if (await confirm({ message: 'Disconnect and permanently delete all imported meter intervals and charge snapshots? Finalized cost statements are kept.', confirmLabel: 'Purge history', danger: true })) action('disconnect', { purgeHistory: true }); }} className={btnDanger}>Disconnect and purge history</button>
      </div>
    </Card>}
    <RecentReauthDialog open={!!reauth} busy={busy} error={reauthError} onCancel={() => setReauth(null)} onConfirm={confirmReauth} />
    <ElectricityPricingPanel />
    <ElectricityBillsPanel />
    <ExtraLabLoadsPanel />
  </main>;
}
