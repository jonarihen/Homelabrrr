import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api.js';
import Field from '../../components/Field.jsx';
import RecentReauthDialog from '../../components/account/RecentReauthDialog.jsx';
import { dkk, localTime } from '../../utils/energyView.js';

const card = 'bg-gray-900 border border-gray-800 rounded-2xl p-5';
const inputCls = 'w-full bg-gray-800 border border-gray-700/50 rounded-xl px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/20 transition-all';
const btnSecondary = 'inline-flex items-center border border-gray-700 hover:border-gray-500 text-gray-200 rounded-lg px-3.5 py-2 text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
const btnPrimary = 'btn-primary rounded-lg px-4 py-2 text-sm font-medium';
const SETUP_LINKS = [
  ['/admin/hosts', 'iLO connections & telemetry'], ['/admin/hosts', 'Power policies (schedules, price rules)'],
  ['/admin/energy-data', 'ElOverblik meter'], ['/admin/energy-data', 'Contract, prices & bills'], ['/admin/paypal', 'PayPal setup, review & subscriptions'],
];
const SHARE_OPTIONS = [['off', 'Not shared (default)'], ['invoiced', 'Share monthly household invoice total'], ['paid', 'Share monthly household amount paid']];

function Item({ label, value, warn }) {
  return <div className="flex items-baseline justify-between gap-4 border-t border-gray-800 py-2.5 text-sm first:border-t-0"><dt className="text-gray-400">{label}</dt><dd className={`text-right font-mono tabular-nums ${warn ? 'text-amber-300' : 'text-gray-100'}`}>{value}</dd></div>;
}
// One health card. While the overview is still loading it shows placeholder
// rows, so "Unavailable" only ever means the source really failed.
function Health({ title, loading, children }) {
  return <div className={card} aria-busy={loading}>
    <h3 className="mb-3 font-mono text-[11px] uppercase tracking-[0.1em] text-gray-500">{title}</h3>
    {loading ? <div className="space-y-2.5"><span className="sr-only">Loading…</span>{[1, 2, 3, 4].map((row) => <div key={row} className="h-5 animate-pulse rounded-lg bg-gray-800/60" />)}</div> : <dl>{children}</dl>}
  </div>;
}
const Unavailable = () => <p className="text-sm text-amber-300">Unavailable</p>;
const errored = (part) => !part || part.status === 'error';

// Administrator-only part of the Energy & Budget page: setup links, source and
// payment health from stored state, the household-total disclosure toggle and
// private exports. It never triggers hardware, meter or payment actions.
export default function EnergyBudgetAdminPanel({ month, onChanged, downloadCsv }) {
  const [overview, setOverview] = useState(null);
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [reauth, setReauth] = useState(null);
  const [reauthError, setReauthError] = useState('');
  const [reauthBusy, setReauthBusy] = useState(false);
  const [range, setRange] = useState({ from: month, to: month });
  const load = useCallback(async () => {
    try { setOverview((await api.get('/energy/admin/overview')).data); setFailed(false); }
    catch { setFailed(true); setError('Administrator overview is unavailable.'); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setRange({ from: month, to: month }); }, [month]);
  const act = async (key, request, done) => {
    setBusy(key); setError(''); setNotice('');
    try { await request(); setNotice(done); await load(); onChanged?.(); return true; }
    catch (err) {
      if (err.response?.data?.code === 'REAUTHENTICATION_REQUIRED') { setReauth({ key, request, done }); setReauthError(''); }
      else setError(err.response?.data?.error || 'Request failed.');
      return false;
    } finally { setBusy(''); }
  };
  const confirmReauth = async (credentials) => {
    setReauthBusy(true);
    try { await api.post('/auth/reauthenticate', credentials); const pending = reauth; setReauth(null); await act(pending.key, pending.request, pending.done); return true; }
    catch (err) { setReauthError(err.response?.data?.error || 'Identity confirmation failed.'); return false; }
    finally { setReauthBusy(false); }
  };
  const share = overview?.householdShare;
  const hardware = overview?.hardware;
  const meter = overview?.meter;
  const health = overview?.paypal?.health;
  const contributions = overview?.paypal?.contributions;
  const subscriptions = overview?.paypal?.subscriptions;
  const bills = overview?.bills;
  const loading = !overview && !failed;

  return <section className="mt-10" aria-labelledby="energy-admin">
    <RecentReauthDialog open={!!reauth} busy={reauthBusy} error={reauthError} onCancel={() => setReauth(null)} onConfirm={confirmReauth} />
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-gray-700 pb-3"><span className="font-mono text-sm text-orange-400">07 /</span><h2 id="energy-admin" className="aaris-display text-xl text-gray-100">Administrator: setup & coverage</h2></div>
    <p className="mt-3 max-w-3xl text-sm text-gray-500">Visible to administrators only. Figures come from stored state; opening this panel contacts no hardware, meter or payment provider.</p>
    <div className="mt-5 space-y-6">
      {error && <p role="alert" className="rounded-xl border border-red-800/30 bg-red-900/20 p-3 text-xs text-red-400">{error}</p>}
      {notice && <p role="status" className="rounded-xl border border-green-800/30 bg-green-900/20 p-3 text-xs text-green-400">{notice}</p>}
      <nav aria-label="Power and energy setup" className="flex flex-wrap gap-2.5">{SETUP_LINKS.map(([to, label]) => <Link key={label} className={btnSecondary} to={to}>{label} ↗</Link>)}</nav>
      <div className="grid gap-4 lg:grid-cols-3">
        <Health title="Server telemetry & control" loading={loading}>
          {errored(hardware) ? <Unavailable /> : <>
            <Item label="Active iLO connections" value={hardware.active} warn={!hardware.active} /><Item label="Collecting" value={hardware.collecting} />
            <Item label="Degraded / stale" value={`${hardware.degraded} / ${hardware.stale}`} warn={hardware.degraded > 0 || hardware.stale > 0} />
            <Item label="Control / automation enabled" value={`${hardware.controlEnabled} / ${hardware.automationEnabled}`} />
            <Item label="Paused or held" value={hardware.pausedOrHeld} warn={hardware.pausedOrHeld > 0} /><Item label="Decommissioned (history kept)" value={hardware.decommissioned} /></>}
        </Health>
        <Health title="Household meter (ElOverblik)" loading={loading}>
          {errored(meter) ? <Unavailable /> : meter.status === 'unconfigured' ? <p className="text-sm text-gray-400">Not configured. Lab cost uses server telemetry and contract prices only.</p> : <>
            <Item label="Sync" value={meter.status} warn={meter.status !== 'enabled'} /><Item label="Scope" value={meter.scope === 'dedicated_lab' ? 'Dedicated lab meter' : 'Whole household'} />
            <Item label="Last success" value={localTime(meter.lastSuccessAt)} /><Item label="Covered" value={meter.earliestIntervalStart ? `${localTime(meter.earliestIntervalStart)} → ${localTime(meter.latestIntervalEnd)}` : 'No data'} />
            <Item label="Gaps / skipped ranges" value={`${meter.gapCount} / ${meter.skippedRangeCount}`} warn={meter.gapCount + meter.skippedRangeCount > 0} />
            <Item label="Charges" value={meter.chargesAvailable ? 'available' : 'not available'} />{meter.attentionCode && <Item label="Attention" value={meter.attentionCode} warn />}</>}
          {!errored(bills) && <Item label="Bills due / partly paid / paid" value={`${bills.due} / ${bills.partiallyPaid} / ${bills.paid}`} warn={bills.due + bills.partiallyPaid > 0} />}
        </Health>
        <Health title="PayPal (live)" loading={loading}>
          {errored(health) ? <Unavailable /> : <>
            <Item label="Reconciliation" value={health.status} warn={health.status !== 'ok'} /><Item label="Last success" value={localTime(health.lastSuccessAt)} />
            <Item label="Unknown-net payments" value={health.unresolvedTransactions} warn={health.unresolvedTransactions > 0} />
            <Item label="Review queue / pending webhooks" value={`${health.reviewEvents} / ${health.pendingInboxEvents}`} warn={health.reviewEvents > 0} />
            <Item label="Uncertain captures / failing subscriptions" value={`${health.uncertainCaptures} / ${health.failingSubscriptions}`} warn={health.uncertainCaptures + health.failingSubscriptions > 0} />
            <Item label="Cancellations awaiting confirmation" value={health.cancellationsAwaitingConfirmation} /></>}
          {!errored(contributions) && <><Item label="Lifetime gross / fees / refunds" value={`${dkk(contributions.grossOre)} / ${dkk(-contributions.feeDebitsOre)} / ${dkk(-contributions.refundDebitsOre)}`} />
            <Item label="Lifetime known net" value={dkk(contributions.knownNetOre)} /></>}
          {!errored(subscriptions) && <Item label="Subscriptions by status" value={Object.entries(subscriptions).map(([status, count]) => `${status} ${count}`).join(' · ') || 'none'} />}
        </Health>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className={card}>
          <fieldset>
            <legend className="text-sm font-semibold text-white">Share household total with members</legend>
            <p className="mt-1 text-xs text-gray-500">Off by default. When on, members see only the chosen monthly total and its paid status, labeled as whole-household, never readings, meter or account identifiers, references or notes. Requires identity confirmation and is audited.</p>
            <div className="mt-4 space-y-2">{SHARE_OPTIONS.map(([value, label]) => <label key={value} className={`flex items-center gap-3 rounded-xl border px-3 py-3 text-sm text-gray-200 ${share === value ? 'border-orange-500/50 bg-orange-500/5' : 'border-gray-700/50 bg-gray-800/40'} ${busy || typeof share !== 'string' ? 'opacity-60' : 'cursor-pointer'}`}><input type="radio" name="household-share" value={value} className="accent-blue-500" checked={share === value} disabled={!!busy || typeof share !== 'string'}
              onChange={() => act('share', () => api.put('/energy/admin/household-share', { mode: value }), value === 'off' ? 'Household total is no longer shared.' : 'Household total sharing saved.')} />{label}</label>)}</div>
          </fieldset>
        </div>
        <div className={card}>
          <h3 className="text-sm font-semibold text-white">Private exports</h3>
          <p className="mt-1 text-xs text-gray-500">Calculation statements and allocation revisions (live only; sandbox never included). Requires identity confirmation and is audited. The PayPal ledger export is on the PayPal page.</p>
          <div className="mt-4 flex flex-wrap items-end gap-4">
            <Field label="From"><input type="month" value={range.from} onChange={(event) => setRange((value) => ({ ...value, from: event.target.value }))} className={`${inputCls} w-44`} /></Field>
            <Field label="To"><input type="month" value={range.to} onChange={(event) => setRange((value) => ({ ...value, to: event.target.value }))} className={`${inputCls} w-44`} /></Field>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2.5">
            <button type="button" disabled={!!busy || !range.from || !range.to} className={`${btnPrimary} disabled:opacity-50`}
              onClick={() => act('export', () => downloadCsv('/energy/admin/export.csv', range, `energy-budget-records-${range.from}-${range.to}.csv`), 'Export downloaded.')}>{busy === 'export' ? 'Exporting…' : 'Export budget records CSV'}</button>
            <Link className={btnSecondary} to="/admin/paypal">PayPal ledger export ↗</Link>
          </div>
        </div>
      </div>
    </div>
  </section>;
}
