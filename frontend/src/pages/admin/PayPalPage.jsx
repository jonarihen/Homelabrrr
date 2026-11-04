import { useCallback, useEffect, useState } from 'react';
import api from '../../api.js';
import useDocumentTitle from '../../hooks/useDocumentTitle.js';
import ErrorCallout from '../../components/ErrorCallout.jsx';
import Field from '../../components/Field.jsx';
import RecentReauthDialog from '../../components/account/RecentReauthDialog.jsx';
import PayPalOperationsPanel, { Badge, EmptyState, Section, Skeleton, Stat, btnPrimary, btnSecondary, inputCls, money } from './PayPalOperationsPanel.jsx';
import PayPalSetupPanel from './PayPalSetupPanel.jsx';
import { useConfirm } from '../../contexts/FeedbackContext.jsx';

const monthNow = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Copenhagen', year: 'numeric', month: '2-digit' }).format(new Date());
const EMPTY_FORM = { clientId: '', clientSecret: '', merchantId: '', webhookId: '', monthlyPlanId: '', monthlyAmount: '' };
const FIELDS = [['clientId', 'Client ID'], ['clientSecret', 'Client secret'], ['merchantId', 'Merchant ID'], ['webhookId', 'Webhook ID'], ['monthlyPlanId', 'Monthly plan ID (optional)'], ['monthlyAmount', 'Monthly amount in DKK (optional)']];
const LEDGER = [
  ['Gross', (s) => money(s.grossOre)], ['Fees', (s) => money(s.feeDebitsOre + s.feeCreditsOre)],
  ['Refunds / reversals', (s) => money(s.refundDebitsOre)], ['Known net', (s) => money(s.knownNetOre)],
  ['Unresolved transactions', (s) => s.unresolvedTransactions], ['Review events', (s) => s.reviewEvents],
  ['Pending · not counted', (s) => `${s.pendingCount ?? 0} · ${money(s.pendingOre)}`],
  ['Disputed · not deducted', (s) => `${s.disputeCount ?? 0} · ${money(s.disputedOre)}`],
];
const ALLOCATION = [
  ['Revision', (a) => a.revision], ['Status', (a) => a.status], ['Cost', (a) => money(a.cost_ore)],
  ['Net received', (a) => money(a.received_net_ore)], ['Applied', (a) => money(a.applied_ore)],
  ['Owner remainder', (a) => money(a.owner_remainder_ore)], ['Owner adjustment', (a) => money(a.owner_adjustment_ore)],
  ['Closing balance', (a) => money(a.closing_balance_ore)],
];

export default function PayPalPage() {
  const confirm = useConfirm();
  useDocumentTitle('PayPal administration');
  const [configs, setConfigs] = useState([]);
  const [environment, setEnvironment] = useState('sandbox');
  const [form, setForm] = useState(EMPTY_FORM);
  const [summary, setSummary] = useState(null);
  const [month, setMonth] = useState(monthNow);
  const [allocation, setAllocation] = useState(null);
  const [loading, setLoading] = useState(true);
  const [allocLoading, setAllocLoading] = useState(true);
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
  useEffect(() => { load().catch(() => setError('Could not load PayPal administration.')).finally(() => setLoading(false)); }, [load]);
  useEffect(() => {
    setAllocLoading(true);
    loadAllocation().catch(() => setAllocation(null)).finally(() => setAllocLoading(false));
  }, [loadAllocation]);
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
    const payload = { environment, ...form, webhookId: form.webhookId || null, monthlyPlanId: form.monthlyPlanId || null,
      monthlyAmount: form.monthlyAmount || null, expectedVersion: current?.configVersion ?? null };
    act('save', () => api.post('/payments/admin/config', payload)).then((saved) => { if (saved) setForm(EMPTY_FORM); });
  };
  const toggle = async () => {
    const enabling = !current?.enabled;
    if (enabling && !await confirm(`Enable ${environment.toUpperCase()} PayPal checkout? This permits real charges if LIVE is selected.`)) return;
    act('toggle', () => api.post('/payments/admin/enabled', { environment, enabled: enabling, confirmLive: environment === 'live' && enabling,
      expectedVersion: current?.configVersion }));
  };
  return <div className="p-6 lg:p-8 max-w-5xl mx-auto space-y-6">
    <RecentReauthDialog open={!!reauth} busy={reauthBusy} error={reauthError} onCancel={() => setReauth(null)} onConfirm={confirmReauth} />
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-orange-500">Restricted · Payments</p>
        <h1 className="aaris-display text-xl text-gray-100 mt-2">PayPal administration</h1>
        <p className="text-sm text-gray-500 mt-1">Checkout starts disabled. Configure sandbox separately from live. Secrets are write-only and encrypted at rest.</p>
      </div>
      <div className="flex items-end gap-3">
        {environment === 'live' && <span className="pb-2.5"><Badge tone="bad">Live · real charges</Badge></span>}
        <div className="w-40"><Field label="Environment">
          <select value={environment} onChange={(event) => setEnvironment(event.target.value)} className={inputCls}><option value="sandbox">Sandbox</option><option value="live">Live</option></select>
        </Field></div>
      </div>
    </header>

    {(error || notice) && <div className="sticky top-2 z-10 space-y-2">
      {error && <div className="bg-gray-950"><ErrorCallout error={error} /></div>}
      {notice && <div className="bg-gray-950"><p role="status" className="text-xs text-green-400 bg-green-900/20 border border-green-800/30 rounded-xl p-3">{notice}</p></div>}
    </div>}

    <Section title="Checkout configuration"
      description="Saving creates a new configuration version and disables checkout until explicitly enabled again."
      actions={<div className="flex flex-wrap items-center gap-2" aria-busy={loading}>
        {loading ? <><Skeleton className="h-6 w-48" /><span className="sr-only">Loading</span></> : <>
          <Badge tone={current?.configured ? 'ok' : 'neutral'}>{current?.configured ? 'Configured' : 'Not configured'}</Badge>
          <Badge tone={current?.enabled ? 'ok' : 'neutral'}>{current?.enabled ? 'Checkout enabled' : 'Checkout disabled'}</Badge>
          <span className="font-mono text-xs text-gray-500">Version {current?.configVersion || '—'}</span></>}
      </div>}>
      <dl className="grid sm:grid-cols-2 gap-3">
        <Stat label="Merchant" value={current?.merchantId || '—'} loading={loading} />
        <Stat label="Webhook" value={current?.webhookId || '—'} loading={loading} />
      </dl>
      <form onSubmit={save} className="mt-5 pt-5 border-t border-gray-800">
        <div className="grid md:grid-cols-2 gap-4">
          {FIELDS.map(([field, label]) => <Field key={field} label={label}>
            <input value={form[field]} onChange={(event) => setForm((old) => ({ ...old, [field]: event.target.value }))} type={field === 'clientSecret' ? 'password' : 'text'} autoComplete="off" className={inputCls} />
          </Field>)}
        </div>
        <p className="text-xs text-gray-500 mt-4">Leave the secret blank to keep the stored one (only while the client ID is unchanged). A save based on an outdated version is refused.</p>
        <div className="flex flex-wrap gap-3 mt-5">
          <button disabled={!!busy || loading} className={btnPrimary}>{busy === 'save' ? 'Saving…' : 'Save configuration'}</button>
          <button type="button" disabled={!!busy || loading || !current?.configured} onClick={toggle} className={btnSecondary}>{current?.enabled ? 'Disable checkout' : 'Enable checkout'}</button>
        </div>
      </form>
    </Section>

    <div className="grid lg:grid-cols-2 gap-6">
      <Section title="Verified live ledger"
        footer={<button type="button" disabled={!!busy || loading || !current?.configured} onClick={() => act('reconcile', () => api.post('/payments/admin/reconcile', { environment }))} className={btnSecondary}>{busy === 'reconcile' ? 'Reconciling…' : `Reconcile ${environment}`}</button>}>
        <dl className="grid grid-cols-2 gap-3" aria-busy={loading}>
          {LEDGER.map(([name, read]) => <Stat key={name} label={name} loading={loading} mono={false} value={summary ? read(summary) : '—'} />)}
        </dl>
        <p className="text-xs text-gray-500 mt-4">Unknown fees and review items are excluded from confirmed net totals.</p>
      </Section>
      <Section title="Monthly allocation"
        description="Append-only revisions apply verified live net support to finalized lab electricity costs. A negative balance is owner funded; no member owes money."
        footer={<button type="button" disabled={!!busy || !month} onClick={() => act('allocate', () => api.post('/payments/admin/allocate', { month }))} className={btnSecondary}>{busy === 'allocate' ? 'Recalculating…' : 'Recalculate through month'}</button>}>
        <div className="w-48 mb-4"><Field label="Month">
          <input type="month" value={month} onChange={(event) => setMonth(event.target.value)} className={inputCls} />
        </Field></div>
        {!allocLoading && !allocation ? <EmptyState>No allocation snapshot yet.</EmptyState> :
          <dl className="grid grid-cols-2 gap-3" aria-busy={allocLoading}>
            {ALLOCATION.map(([name, read]) => <Stat key={name} label={name} loading={allocLoading} mono={false} value={allocation ? read(allocation) : '—'} />)}
          </dl>}
      </Section>
    </div>

    <PayPalSetupPanel environment={environment} act={act} busy={busy} configVersion={current?.configVersion} onUseId={(field, value) => setForm((old) => ({ ...old, [field]: value }))} />
    <PayPalOperationsPanel environment={environment} act={act} busy={busy} />
  </div>;
}
