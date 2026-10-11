import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api.js';
import RecentReauthDialog from '../../components/account/RecentReauthDialog.jsx';
import { dkk, localTime } from '../../utils/energyView.js';

const card = 'border border-gray-700 bg-gray-900/80 p-4';
const button = 'border border-gray-700 px-3 py-2 font-mono text-xs text-orange-300 hover:border-orange-500 disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-orange-500';
const SETUP_LINKS = [
  ['/admin/hosts', 'iLO connections & telemetry'], ['/admin/hosts', 'Power policies (schedules, price rules)'],
  ['/admin/energy-data', 'ElOverblik meter'], ['/admin/energy-data', 'Contract, prices & bills'], ['/admin/paypal', 'PayPal setup, review & subscriptions'],
];
const SHARE_OPTIONS = [['off', 'Not shared (default)'], ['invoiced', 'Share monthly household invoice total'], ['paid', 'Share monthly household amount paid']];

function Item({ label, value, warn }) {
  return <div className="flex justify-between gap-3 border-t border-gray-800 py-2 text-sm"><dt className="text-gray-400">{label}</dt><dd className={`font-mono tabular-nums ${warn ? 'text-amber-300' : 'text-gray-100'}`}>{value}</dd></div>;
}
const errored = (part) => !part || part.status === 'error';

// Administrator-only part of the Energy & Budget page: setup links, source and
// payment health from stored state, the household-total disclosure toggle and
// private exports. It never triggers hardware, meter or payment actions.
export default function EnergyBudgetAdminPanel({ month, onChanged, downloadCsv }) {
  const [overview, setOverview] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [reauth, setReauth] = useState(null);
  const [reauthError, setReauthError] = useState('');
  const [reauthBusy, setReauthBusy] = useState(false);
  const [range, setRange] = useState({ from: month, to: month });
  const load = useCallback(async () => {
    try { setOverview((await api.get('/energy/admin/overview')).data); }
    catch { setError('Administrator overview is unavailable.'); }
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

  return <section className="mt-10" aria-labelledby="energy-admin">
    <RecentReauthDialog open={!!reauth} busy={reauthBusy} error={reauthError} onCancel={() => setReauth(null)} onConfirm={confirmReauth} />
    <div className="flex items-baseline gap-4 border-b border-gray-700 pb-3"><span className="font-mono text-sm text-orange-400">07 /</span><h2 id="energy-admin" className="aaris-display text-xl text-gray-100">Administrator: setup & coverage</h2></div>
    <p className="mt-2 text-xs text-gray-500">Visible to administrators only. Figures come from stored state; opening this panel contacts no hardware, meter or payment provider.</p>
    {error && <p role="alert" className="mt-3 border-l-2 border-red-500 bg-red-500/5 p-3 text-sm text-red-200">{error}</p>}
    {notice && <p role="status" className="mt-3 border-l-2 border-orange-500 p-3 text-sm text-gray-200">{notice}</p>}
    <nav aria-label="Power and energy setup" className="mt-4 flex flex-wrap gap-3">{SETUP_LINKS.map(([to, label]) => <Link key={label} className={button} to={to}>{label} ↗</Link>)}</nav>
    <div className="mt-4 grid gap-3 lg:grid-cols-3">
      <dl className={card}><p className="font-mono text-xs uppercase tracking-widest text-gray-400">Server telemetry & control</p>
        {errored(hardware) ? <p className="mt-2 text-sm text-amber-300">Unavailable</p> : <>
          <Item label="Active iLO connections" value={hardware.active} warn={!hardware.active} /><Item label="Collecting" value={hardware.collecting} />
          <Item label="Degraded / stale" value={`${hardware.degraded} / ${hardware.stale}`} warn={hardware.degraded > 0 || hardware.stale > 0} />
          <Item label="Control / automation enabled" value={`${hardware.controlEnabled} / ${hardware.automationEnabled}`} />
          <Item label="Paused or held" value={hardware.pausedOrHeld} warn={hardware.pausedOrHeld > 0} /><Item label="Decommissioned (history kept)" value={hardware.decommissioned} /></>}
      </dl>
      <dl className={card}><p className="font-mono text-xs uppercase tracking-widest text-gray-400">Household meter (ElOverblik)</p>
        {errored(meter) ? <p className="mt-2 text-sm text-amber-300">Unavailable</p> : meter.status === 'unconfigured' ? <p className="mt-2 text-sm text-gray-400">Not configured. Lab cost uses server telemetry and contract prices only.</p> : <>
          <Item label="Sync" value={meter.status} warn={meter.status !== 'enabled'} /><Item label="Scope" value={meter.scope === 'dedicated_lab' ? 'Dedicated lab meter' : 'Whole household'} />
          <Item label="Last success" value={localTime(meter.lastSuccessAt)} /><Item label="Covered" value={meter.earliestIntervalStart ? `${localTime(meter.earliestIntervalStart)} → ${localTime(meter.latestIntervalEnd)}` : 'No data'} />
          <Item label="Gaps / skipped ranges" value={`${meter.gapCount} / ${meter.skippedRangeCount}`} warn={meter.gapCount + meter.skippedRangeCount > 0} />
          <Item label="Charges" value={meter.chargesAvailable ? 'available' : 'not available'} />{meter.attentionCode && <Item label="Attention" value={meter.attentionCode} warn />}</>}
        {!errored(bills) && <Item label="Bills due / partly paid / paid" value={`${bills.due} / ${bills.partiallyPaid} / ${bills.paid}`} warn={bills.due + bills.partiallyPaid > 0} />}
      </dl>
      <dl className={card}><p className="font-mono text-xs uppercase tracking-widest text-gray-400">PayPal (live)</p>
        {errored(health) ? <p className="mt-2 text-sm text-amber-300">Unavailable</p> : <>
          <Item label="Reconciliation" value={health.status} warn={health.status !== 'ok'} /><Item label="Last success" value={localTime(health.lastSuccessAt)} />
          <Item label="Unknown-net payments" value={health.unresolvedTransactions} warn={health.unresolvedTransactions > 0} />
          <Item label="Review queue / pending webhooks" value={`${health.reviewEvents} / ${health.pendingInboxEvents}`} warn={health.reviewEvents > 0} />
          <Item label="Uncertain captures / failing subscriptions" value={`${health.uncertainCaptures} / ${health.failingSubscriptions}`} warn={health.uncertainCaptures + health.failingSubscriptions > 0} />
          <Item label="Cancellations awaiting confirmation" value={health.cancellationsAwaitingConfirmation} /></>}
        {!errored(contributions) && <><Item label="Lifetime gross / fees / refunds" value={`${dkk(contributions.grossOre)} / ${dkk(-contributions.feeDebitsOre)} / ${dkk(-contributions.refundDebitsOre)}`} />
          <Item label="Lifetime known net" value={dkk(contributions.knownNetOre)} /></>}
        {!errored(subscriptions) && <Item label="Subscriptions by status" value={Object.entries(subscriptions).map(([status, count]) => `${status} ${count}`).join(' · ') || 'none'} />}
      </dl>
    </div>
    <div className="mt-3 grid gap-3 lg:grid-cols-2">
      <fieldset className={card}><legend className="font-mono text-xs uppercase tracking-widest text-gray-400">Share household total with members</legend>
        <p className="mt-2 text-xs text-gray-500">Off by default. When on, members see only the chosen monthly total and its paid status, labeled as whole-household, never readings, meter or account identifiers, references or notes. Requires identity confirmation and is audited.</p>
        <div className="mt-3 space-y-2">{SHARE_OPTIONS.map(([value, label]) => <label key={value} className="flex items-center gap-2 text-sm text-gray-200"><input type="radio" name="household-share" value={value} checked={share === value} disabled={!!busy || typeof share !== 'string'}
          onChange={() => act('share', () => api.put('/energy/admin/household-share', { mode: value }), value === 'off' ? 'Household total is no longer shared.' : 'Household total sharing saved.')} />{label}</label>)}</div>
      </fieldset>
      <div className={card}><p className="font-mono text-xs uppercase tracking-widest text-gray-400">Private exports</p>
        <p className="mt-2 text-xs text-gray-500">Calculation statements and allocation revisions (live only; sandbox never included). Requires identity confirmation and is audited. The PayPal ledger export is on the PayPal page.</p>
        <div className="mt-3 flex flex-wrap items-end gap-2 text-xs text-gray-400">
          <label>From<input type="month" value={range.from} onChange={(event) => setRange((value) => ({ ...value, from: event.target.value }))} className="ml-1 border border-gray-700 bg-gray-950 p-1.5 text-gray-100" /></label>
          <label>To<input type="month" value={range.to} onChange={(event) => setRange((value) => ({ ...value, to: event.target.value }))} className="ml-1 border border-gray-700 bg-gray-950 p-1.5 text-gray-100" /></label>
          <button type="button" disabled={!!busy || !range.from || !range.to} className={button}
            onClick={() => act('export', () => downloadCsv('/energy/admin/export.csv', range, `energy-budget-records-${range.from}-${range.to}.csv`), 'Export downloaded.')}>Export budget records CSV</button>
          <Link className={button} to="/admin/paypal">PayPal ledger export ↗</Link>
        </div>
      </div>
    </div>
  </section>;
}
