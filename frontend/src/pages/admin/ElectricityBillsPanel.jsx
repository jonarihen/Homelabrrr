import { useCallback, useEffect, useState } from 'react';
import api from '../../api.js';
import RecentReauthDialog from '../../components/account/RecentReauthDialog.jsx';
import { dkk, localTime } from '../../utils/energyView.js';

const inputClass = 'w-full border border-slate-700 bg-slate-950 px-2 py-2 text-slate-100';
const button = 'border border-slate-600 px-3 py-1.5 font-mono text-xs disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-orange-500';
const STATUS = { due: 'Due', partially_paid: 'Partially paid', paid: 'Paid', void: 'Void' };
// datetime-local value in the browser's zone from an ISO instant.
const localInput = (value) => { const date = new Date(value); return Number.isFinite(date.getTime()) ? new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : ''; };

// Recorded household bills: payments, voiding and revisions. Bills are never
// edited in place; the backend voids and appends a revision. Every change
// needs recent identity confirmation and is audited server-side.
export default function ElectricityBillsPanel() {
  const [bills, setBills] = useState([]);
  const [showVoid, setShowVoid] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({});
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [reauth, setReauth] = useState(null);
  const [reauthError, setReauthError] = useState('');
  const load = useCallback(async () => {
    try { setBills((await api.get('/admin/electricity-pricing/bills')).data); }
    catch { setMessage('Bills are unavailable.'); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const run = async (request, done) => {
    setBusy(true); setMessage('');
    try { await request(); setEditing(null); setForm({}); setMessage(done); await load(); return true; }
    catch (err) {
      if (err.response?.data?.code === 'REAUTHENTICATION_REQUIRED') { setReauth({ request, done }); setReauthError(''); }
      else setMessage(err.response?.data?.error || 'Request failed.');
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
  const field = (key, label, props = {}) => <label className="text-xs text-slate-400">{label}<input {...props} value={form[key] ?? ''} onChange={(event) => setForm((value) => ({ ...value, [key]: event.target.value }))} className={inputClass} /></label>;
  const visible = bills.filter((bill) => showVoid || bill.status !== 'void');

  return <section className="rounded border border-slate-700 bg-slate-900 p-5 space-y-3" aria-labelledby="bills-heading">
    <RecentReauthDialog open={!!reauth} busy={busy} error={reauthError} onCancel={() => setReauth(null)} onConfirm={confirmReauth} />
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 id="bills-heading" className="text-lg font-medium">Recorded household bills</h2>
      <label className="flex items-center gap-2 text-xs text-slate-400"><input type="checkbox" checked={showVoid} onChange={(event) => setShowVoid(event.target.checked)} />Show voided revisions</label></div>
    <p className="text-sm text-slate-400">Actual invoices stay separate from calculated lab cost. Corrections void the bill and append a revision; recorded payments carry over.</p>
    {message && <p role="status" className="rounded border border-orange-700 p-2 text-sm">{message}</p>}
    {visible.length ? <div className="overflow-x-auto"><table className="w-full min-w-[640px] text-left text-sm"><thead><tr className="text-xs text-slate-400"><th className="py-2 font-normal">Period</th><th className="font-normal">Kind</th><th className="font-normal">Invoiced</th><th className="font-normal">Paid</th><th className="font-normal">Status</th><th className="font-normal">Rev.</th><th className="font-normal"><span className="sr-only">Actions</span></th></tr></thead>
      <tbody>{visible.map((bill) => <tr key={bill.id} className="border-t border-slate-800 align-top"><td className="py-2">{localTime(bill.period_start)} → {localTime(bill.period_end)}</td><td>{bill.kind}</td><td className="tabular-nums">{dkk(bill.amount_ore)}</td><td className="tabular-nums">{bill.paid_ore == null ? '—' : dkk(bill.paid_ore)}</td>
        <td>{STATUS[bill.status] || bill.status}{bill.void_reason && <span className="block text-xs text-slate-500">{bill.void_reason}</span>}</td><td>{bill.revision}</td>
        <td className="space-x-1 whitespace-nowrap py-2">{bill.status !== 'void' && <>
          {bill.status !== 'paid' && <button type="button" disabled={busy} onClick={() => open(bill, 'paid')} className={button}>Record payment</button>}
          <button type="button" disabled={busy} onClick={() => open(bill, 'revise')} className={button}>Revise</button>
          <button type="button" disabled={busy} onClick={() => open(bill, 'void')} className={`${button} border-red-700 text-red-300`}>Void</button></>}
          {editing?.id === bill.id && <form onSubmit={(event) => submit(event, bill)} aria-label={`${editing.mode} bill ${bill.id}`} className="mt-2 grid gap-2 whitespace-normal md:grid-cols-2">
            {editing.mode === 'paid' && <>{field('paidOre', 'Cumulative amount paid (øre)', { type: 'number', min: 1, required: true })}{field('paidAt', 'Paid at', { type: 'datetime-local', required: true })}</>}
            {editing.mode === 'revise' && <>{field('periodStart', 'Period start', { type: 'datetime-local', required: true })}{field('periodEnd', 'Period end', { type: 'datetime-local', required: true })}
              {field('amountOre', 'Invoiced amount (øre)', { type: 'number', min: 0, required: true })}{field('billedKwh', 'Billed kWh (optional)')}{field('reference', 'Private reference')}{field('note', 'Private note')}</>}
            {editing.mode !== 'paid' && field('reason', 'Reason (audited)', { required: true, maxLength: 1000 })}
            <div className="flex gap-2 md:col-span-2"><button disabled={busy} className={`${button} border-orange-600 text-orange-400`}>{editing.mode === 'paid' ? 'Save payment' : editing.mode === 'void' ? 'Void bill' : 'Save revision'}</button><button type="button" onClick={() => setEditing(null)} className={button}>Cancel</button></div>
          </form>}
        </td></tr>)}</tbody></table></div> : <p className="text-sm text-slate-400">No bills recorded.</p>}
  </section>;
}
