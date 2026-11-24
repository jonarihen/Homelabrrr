import { Fragment, useCallback, useEffect, useState } from 'react';
import api from '../../api.js';
import Field from '../../components/Field.jsx';
import RecentReauthDialog from '../../components/account/RecentReauthDialog.jsx';
import { dkk, localTime } from '../../utils/energyView.js';

const inputClass = 'w-full bg-gray-800 border border-gray-700/50 rounded-xl px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/20 transition-all';
const button = 'rounded-lg border border-gray-700 px-2.5 py-1.5 text-xs font-medium text-gray-300 transition-colors hover:border-gray-500 hover:text-white disabled:cursor-not-allowed disabled:opacity-50';
const BADGE = { due: 'bg-amber-500/10 text-amber-300 ring-amber-500/20', partially_paid: 'bg-amber-500/10 text-amber-300 ring-amber-500/20', paid: 'bg-green-500/10 text-green-400 ring-green-500/20', void: 'bg-gray-800 text-gray-400 ring-gray-700' };
const STATUS = { due: 'Due', partially_paid: 'Partially paid', paid: 'Paid', void: 'Void' };
// datetime-local value in the browser's zone from an ISO instant.
const localInput = (value) => { const date = new Date(value); return Number.isFinite(date.getTime()) ? new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : ''; };

// Recorded household bills: payments, voiding and revisions. Bills are never
// edited in place; the backend voids and appends a revision. Every change
// needs recent identity confirmation and is audited server-side.
export default function ElectricityBillsPanel() {
  const [bills, setBills] = useState(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [showVoid, setShowVoid] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({});
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [reauth, setReauth] = useState(null);
  const [reauthError, setReauthError] = useState('');
  const load = useCallback(async () => {
    try { setBills((await api.get('/admin/electricity-pricing/bills')).data); setLoadFailed(false); }
    catch { setLoadFailed(true); setNotice({ text: 'Bills are unavailable.', error: true }); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const run = async (request, done) => {
    setBusy(true); setNotice(null);
    try { await request(); setEditing(null); setForm({}); setNotice({ text: done }); await load(); return true; }
    catch (err) {
      if (err.response?.data?.code === 'REAUTHENTICATION_REQUIRED') { setReauth({ request, done }); setReauthError(''); }
      else setNotice({ text: err.response?.data?.error || 'Request failed.', error: true });
      return false;
    } finally { setBusy(false); }
  };
  const confirmReauth = async (credentials) => {
    try { await api.post('/auth/reauthenticate', credentials); const pending = reauth; setReauth(null); await run(pending.request, pending.done); return true; }
    catch (err) { setReauthError(err.response?.data?.error || 'Identity confirmation failed.'); return false; }
  };
  const open = (bill, mode) => {
    setEditing({ id: bill.id, mode });
    setForm(mode === 'revise' ? { periodStart: localInput(bill.period_start), periodEnd: localInput(bill.period_end), amountOre: String(bill.amount_ore),
      billedKwh: bill.billed_kwh ?? '', reference: bill.reference ?? '', note: bill.note ?? '', reason: '' }
      : mode === 'paid' ? { paidOre: String(bill.amount_ore), paidAt: localInput(new Date().toISOString()) } : { reason: '' });
  };
  const submit = (event, bill) => {
    event.preventDefault();
    const path = `/admin/electricity-pricing/bills/${bill.id}`;
    if (editing.mode === 'paid') return run(() => api.post(`${path}/paid`, { paidOre: Number(form.paidOre), paidAt: new Date(form.paidAt).toISOString() }), 'Payment recorded.');
    if (editing.mode === 'void') return run(() => api.post(`${path}/void`, { reason: form.reason }), 'Bill voided.');
    return run(() => api.post(`${path}/revise`, { periodStart: new Date(form.periodStart).toISOString(), periodEnd: new Date(form.periodEnd).toISOString(),
      amountOre: Number(form.amountOre), billedKwh: form.billedKwh || null, reference: form.reference || null, note: form.note || null, reason: form.reason }), 'Bill revised.');
  };
  const field = (key, label, props = {}) => <Field label={label}><input {...props} value={form[key] ?? ''} onChange={(event) => setForm((value) => ({ ...value, [key]: event.target.value }))} className={inputClass} /></Field>;
  const visible = (bills || []).filter((bill) => showVoid || bill.status !== 'void');
  const loading = !bills && !loadFailed;

  return <section className="rounded-2xl border border-gray-800 bg-gray-900 p-5" aria-labelledby="bills-heading">
    <RecentReauthDialog open={!!reauth} busy={busy} error={reauthError} onCancel={() => setReauth(null)} onConfirm={confirmReauth} />
    <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
      <div><h2 id="bills-heading" className="aaris-display text-sm text-gray-200">Recorded household bills</h2>
        <p className="mt-1.5 max-w-3xl text-xs text-gray-500">Actual invoices stay separate from calculated lab cost. Corrections void the bill and append a revision; recorded payments carry over.</p></div>
      <label className="flex cursor-pointer items-center gap-2 text-xs text-gray-400"><input type="checkbox" className="accent-blue-500" checked={showVoid} onChange={(event) => setShowVoid(event.target.checked)} />Show voided revisions</label>
    </div>
    {notice && <p role={notice.error ? 'alert' : 'status'} className={`mt-4 rounded-xl border p-3 text-xs ${notice.error ? 'border-red-800/30 bg-red-900/20 text-red-400' : 'border-green-800/30 bg-green-900/20 text-green-400'}`}>{notice.text}</p>}
    <div className="mt-5">
      {loading ? <div className="space-y-3" role="status" aria-label="Loading bills">{[1, 2].map((row) => <div key={row} className="h-12 animate-pulse rounded-xl bg-gray-800/60" />)}</div>
        : loadFailed ? null
        : visible.length ? <div className="overflow-x-auto rounded-xl border border-gray-800"><table className="w-full min-w-[720px] text-left text-sm"><thead><tr className="border-b border-gray-800 text-xs uppercase tracking-wider text-gray-500"><th className="px-4 py-3 font-normal">Period</th><th className="px-4 py-3 font-normal">Kind</th><th className="px-4 py-3 font-normal">Invoiced</th><th className="px-4 py-3 font-normal">Paid</th><th className="px-4 py-3 font-normal">Status</th><th className="px-4 py-3 font-normal">Rev.</th><th className="px-4 py-3 font-normal"><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>{visible.map((bill) => <Fragment key={bill.id}><tr className={`align-top transition-colors hover:bg-gray-800/50 ${editing?.id === bill.id ? '' : 'border-b border-gray-800 last:border-0'}`}><td className="px-4 py-3 text-gray-200">{localTime(bill.period_start)} → {localTime(bill.period_end)}</td><td className="px-4 py-3 text-gray-400">{bill.kind}</td><td className="px-4 py-3 tabular-nums text-white">{dkk(bill.amount_ore)}</td><td className="px-4 py-3 tabular-nums text-gray-300">{bill.paid_ore == null ? '—' : dkk(bill.paid_ore)}</td>
          <td className="px-4 py-3"><span className={`inline-block rounded-full px-2.5 py-0.5 text-xs ring-1 ${BADGE[bill.status] || BADGE.void}`}>{STATUS[bill.status] || bill.status}</span>{bill.void_reason && <span className="mt-1 block text-xs text-gray-500">{bill.void_reason}</span>}</td><td className="px-4 py-3 text-gray-400">{bill.revision}</td>
          <td className="px-4 py-3"><div className="flex flex-wrap justify-end gap-2">{bill.status !== 'void' && <>
            {bill.status !== 'paid' && <button type="button" disabled={busy} onClick={() => open(bill, 'paid')} className={button}>Record payment</button>}
            <button type="button" disabled={busy} onClick={() => open(bill, 'revise')} className={button}>Revise</button>
            <button type="button" disabled={busy} onClick={() => open(bill, 'void')} className={`${button} border-red-800 text-red-400 hover:border-red-600 hover:text-red-300`}>Void</button></>}</div></td></tr>
          {editing?.id === bill.id && <tr className="border-b border-gray-800 last:border-0 bg-gray-800/30"><td colSpan={7} className="px-4 py-4"><form onSubmit={(event) => submit(event, bill)} aria-label={`${editing.mode} bill ${bill.id}`} className="grid gap-4 md:grid-cols-2">
            {editing.mode === 'paid' && <>{field('paidOre', 'Cumulative amount paid (øre)', { type: 'number', min: 1, required: true })}{field('paidAt', 'Paid at', { type: 'datetime-local', required: true })}</>}
            {editing.mode === 'revise' && <>{field('periodStart', 'Period start', { type: 'datetime-local', required: true })}{field('periodEnd', 'Period end', { type: 'datetime-local', required: true })}
              {field('amountOre', 'Invoiced amount (øre)', { type: 'number', min: 0, required: true })}{field('billedKwh', 'Billed kWh (optional)')}{field('reference', 'Private reference')}{field('note', 'Private note')}</>}
            {editing.mode !== 'paid' && field('reason', 'Reason (audited)', { required: true, maxLength: 1000 })}
            <div className="flex flex-wrap gap-3 md:col-span-2"><button disabled={busy} className={`${editing.mode === 'void' ? 'rounded-lg bg-red-700 px-4 py-2 text-sm font-medium text-white hover:bg-red-600 disabled:opacity-50' : 'btn-primary rounded-lg px-4 py-2 text-sm font-medium'}`}>{editing.mode === 'paid' ? 'Save payment' : editing.mode === 'void' ? 'Void bill' : 'Save revision'}</button><button type="button" onClick={() => setEditing(null)} className="rounded-lg border border-gray-700 px-4 py-2 text-sm font-medium text-gray-200 transition-colors hover:border-gray-500">Cancel</button></div>
          </form></td></tr>}</Fragment>)}</tbody></table></div>
        : <p className="rounded-xl border border-gray-800 bg-gray-900 px-4 py-6 text-center text-xs italic text-gray-400">No bills recorded.</p>}
    </div>
  </section>;
}
