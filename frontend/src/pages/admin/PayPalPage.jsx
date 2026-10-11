import { useCallback, useEffect, useState } from 'react';
import api from '../../api.js';
import useDocumentTitle from '../../hooks/useDocumentTitle.js';
import RecentReauthDialog from '../../components/account/RecentReauthDialog.jsx';

const monthNow = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Copenhagen', year: 'numeric', month: '2-digit' }).format(new Date());
const money = (ore) => typeof ore === 'number' ? new Intl.NumberFormat('da-DK', { style: 'currency', currency: 'DKK' }).format(ore / 100) : 'Unknown';
const card = 'border border-gray-800 bg-gray-900/90 p-5';

export default function PayPalPage() {
  useDocumentTitle('PayPal administration');
  const [configs, setConfigs] = useState([]);
  const [environment, setEnvironment] = useState('sandbox');
  const [form, setForm] = useState({ clientId: '', clientSecret: '', merchantId: '', webhookId: '', monthlyPlanId: '', monthlyAmount: '' });
  const [summary, setSummary] = useState(null);
  const [month, setMonth] = useState(monthNow);
  const [allocation, setAllocation] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reauth, setReauth] = useState(null);
  const [reauthError, setReauthError] = useState('');
  const [reauthBusy, setReauthBusy] = useState(false);
  const load = useCallback(async () => {
    const [{ data: setup }, { data: figures }] = await Promise.all([api.get('/payments/admin/config'), api.get('/payments/admin/summary')]);
    setConfigs(setup); setSummary(figures);
  }, []);
  const loadAllocation = useCallback(async () => {
    const { data } = await api.get('/payments/admin/allocation', { params: { month } });
    setAllocation(data.allocation);
  }, [month]);
  useEffect(() => { load().catch(() => setError('Could not load PayPal administration.')); }, [load]);
  useEffect(() => { loadAllocation().catch(() => setAllocation(null)); }, [loadAllocation]);
  const current = configs.find((item) => item.environment === environment);
  const act = async (key, request) => {
    setBusy(key); setError(''); setNotice('');
    try { await request(); await load(); await loadAllocation(); setNotice('Operation completed.'); return true; }
    catch (err) {
      if (err.response?.data?.code === 'REAUTHENTICATION_REQUIRED') { setReauth({ key, request }); setReauthError(''); }
      else setError(err.response?.data?.error || 'Operation failed.');
      return false;
    } finally { setBusy(''); }
  };
  const confirmReauth = async (credentials) => {
    setReauthBusy(true);
    try { await api.post('/auth/reauthenticate', credentials); const pending = reauth; setReauth(null); await act(pending.key, pending.request); return true; }
    catch (err) { setReauthError(err.response?.data?.error || 'Identity confirmation failed.'); return false; }
    finally { setReauthBusy(false); }
  };
  const save = (event) => {
    event.preventDefault();
    const payload = { environment, ...form, monthlyPlanId: form.monthlyPlanId || null, monthlyAmount: form.monthlyAmount || null };
    act('save', () => api.post('/payments/admin/config', payload)).then((saved) => { if (saved) setForm({ clientId: '', clientSecret: '', merchantId: '', webhookId: '', monthlyPlanId: '', monthlyAmount: '' }); });
  };
  const toggle = () => {
    const enabling = !current?.enabled;
    if (enabling && !window.confirm(`Enable ${environment.toUpperCase()} PayPal checkout? This permits real charges if LIVE is selected.`)) return;
    act('toggle', () => api.post('/payments/admin/enabled', { environment, enabled: enabling, confirmLive: environment === 'live' && enabling }));
  };
  return <div className="p-6 lg:p-8 max-w-6xl space-y-6">
    <RecentReauthDialog open={!!reauth} busy={reauthBusy} error={reauthError} onCancel={() => setReauth(null)} onConfirm={confirmReauth} />
    <header><p className="font-mono text-[10px] uppercase tracking-[0.2em] text-orange-500">Restricted · Payments</p>
      <h1 className="aaris-display text-2xl text-gray-100 mt-2">PayPal administration</h1>
      <p className="text-sm text-gray-400 mt-2">Checkout starts disabled. Configure sandbox separately from live. Secrets are write-only and encrypted at rest.</p></header>
    {error && <p role="alert" className="border border-red-800 bg-red-950/30 p-3 text-sm text-red-300">{error}</p>}
    {notice && <p role="status" className="border border-green-800 bg-green-950/30 p-3 text-sm text-green-300">{notice}</p>}
    <div className="grid lg:grid-cols-2 gap-4">
      <section className={card}><h2 className="aaris-display text-lg text-gray-100">Checkout configuration</h2>
        <label className="block text-xs text-gray-400 mt-4">Environment<select value={environment} onChange={(event) => setEnvironment(event.target.value)} className="block w-full mt-2 bg-gray-950 border border-gray-700 px-3 py-2 text-white"><option value="sandbox">Sandbox</option><option value="live">Live</option></select></label>
        <p className="text-sm mt-3 text-gray-300">{current?.configured ? 'Configured' : 'Not configured'} · {current?.enabled ? 'Checkout enabled' : 'Checkout disabled'} · Version {current?.configVersion || '—'}</p>
        <p className="text-xs text-gray-500 mt-1">Merchant {current?.merchantId || '—'} · Webhook {current?.webhookId || '—'}</p>
        <form onSubmit={save} className="mt-5 space-y-3">
          {[['clientId', 'Client ID'], ['clientSecret', 'Client secret'], ['merchantId', 'Merchant ID'], ['webhookId', 'Webhook ID'], ['monthlyPlanId', 'Monthly plan ID (optional)'], ['monthlyAmount', 'Monthly amount in DKK (optional)']].map(([field, label]) => <label key={field} className="block text-xs text-gray-400">{label}<input value={form[field]} onChange={(event) => setForm((old) => ({ ...old, [field]: event.target.value }))} type={field === 'clientSecret' ? 'password' : 'text'} autoComplete="off" className="block w-full mt-1 bg-gray-950 border border-gray-700 px-3 py-2 text-white" /></label>)}
          <p className="text-xs text-gray-500">Saving replaces this environment’s configuration and disables checkout until explicitly enabled again. Enter every field, including the secret.</p>
          <div className="flex flex-wrap gap-2"><button disabled={!!busy} className="border border-orange-600 px-4 py-2 text-xs text-orange-200 disabled:opacity-40">Save configuration</button>
            <button type="button" disabled={!!busy || !current?.configured} onClick={toggle} className="border border-gray-700 px-4 py-2 text-xs text-gray-200 disabled:opacity-40">{current?.enabled ? 'Disable checkout' : 'Enable checkout'}</button></div>
        </form>
      </section>
      <div className="space-y-4"><section className={card}><h2 className="aaris-display text-lg text-gray-100">Verified live ledger</h2>
        {summary ? <dl className="grid grid-cols-2 gap-3 mt-4 text-sm">{[['Gross', money(summary.grossOre)], ['Fees', money(summary.feeDebitsOre + summary.feeCreditsOre)], ['Refunds / reversals', money(summary.refundDebitsOre)], ['Known net', money(summary.knownNetOre)], ['Unresolved transactions', summary.unresolvedTransactions], ['Review events', summary.reviewEvents]].map(([name, value]) => <div key={name}><dt className="text-xs text-gray-500">{name}</dt><dd className="text-white">{value}</dd></div>)}</dl> : <p className="text-gray-500 mt-4">Loading…</p>}
        <p className="text-xs text-gray-500 mt-3">Unknown fees and review items are excluded from confirmed net totals.</p>
        <button type="button" disabled={!!busy || !current?.configured} onClick={() => act('reconcile', () => api.post('/payments/admin/reconcile', { environment }))} className="mt-3 border border-gray-700 px-4 py-2 text-xs text-gray-200 disabled:opacity-40">Reconcile {environment}</button>
      </section>
      <section className={card}><h2 className="aaris-display text-lg text-gray-100">Monthly allocation</h2>
        <p className="text-xs text-gray-500 mt-2">Append-only revisions apply verified live net support to finalized lab electricity costs. A negative balance is owner funded; no member owes money.</p>
        <label className="block text-xs text-gray-400 mt-4">Month<input type="month" value={month} onChange={(event) => setMonth(event.target.value)} className="block mt-1 bg-gray-950 border border-gray-700 px-3 py-2 text-white" /></label>
        {allocation ? <dl className="grid grid-cols-2 gap-3 text-sm mt-4">{[['Revision', allocation.revision], ['Status', allocation.status], ['Cost', money(allocation.cost_ore)], ['Net received', money(allocation.received_net_ore)], ['Applied', money(allocation.applied_ore)], ['Owner remainder', money(allocation.owner_remainder_ore)], ['Owner adjustment', money(allocation.owner_adjustment_ore)], ['Closing balance', money(allocation.closing_balance_ore)]].map(([name, value]) => <div key={name}><dt className="text-gray-500 text-xs">{name}</dt><dd className="text-gray-100">{value}</dd></div>)}</dl> : <p className="text-sm text-gray-500 mt-4">No allocation snapshot yet.</p>}
        <button type="button" disabled={!!busy || !month} onClick={() => act('allocate', () => api.post('/payments/admin/allocate', { month }))} className="mt-4 border border-gray-700 px-4 py-2 text-xs text-gray-200 disabled:opacity-40">Recalculate through month</button>
      </section></div>
    </div>
  </div>;
}
