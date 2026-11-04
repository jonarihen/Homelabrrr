import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../api.js';
import Layout from '../components/Layout.jsx';
import useDocumentTitle from '../hooks/useDocumentTitle.js';
import { useConfirm } from '../contexts/FeedbackContext.jsx';

const money = (ore) => typeof ore === 'number' ? new Intl.NumberFormat('da-DK', { style: 'currency', currency: 'DKK' }).format(ore / 100) : '—';
const date = (value) => value ? new Intl.DateTimeFormat('da-DK', { dateStyle: 'medium' }).format(new Date(value)) : '—';
const card = 'bg-gray-900 border border-gray-800 rounded-2xl p-6';
const inputCls = 'w-full bg-gray-800 border border-gray-700/50 rounded-xl px-4 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/20 transition-all';
const primaryBtn = 'btn-primary px-5 py-2.5 text-sm font-medium rounded-xl disabled:opacity-40 disabled:cursor-not-allowed';
const secondaryBtn = 'px-4 py-2 text-xs font-medium rounded-xl border border-gray-700 text-gray-300 hover:text-white hover:bg-gray-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed';
const toneCls = {
  info: 'border-gray-700 bg-gray-900 text-gray-200',
  success: 'border-green-800/60 bg-green-900/20 text-green-300',
  warning: 'border-yellow-700/50 bg-yellow-900/20 text-yellow-300',
};
const Skeleton = ({ className = 'h-4 w-40' }) => <div aria-hidden="true" className={`bg-gray-800 rounded-lg animate-pulse ${className}`} />;
function Card({ title, hint, children, className = '' }) {
  return <section className={`${card} ${className}`}><h2 className="aaris-display text-base text-gray-100">{title}</h2>
    {hint && <p className="text-xs text-gray-500 mt-2">{hint}</p>}{children}</section>;
}

export default function SupportPage() {
  const confirm = useConfirm();
  useDocumentTitle('Support the lab');
  const [searchParams, setSearchParams] = useSearchParams();
  const [status, setStatus] = useState(null);
  const [history, setHistory] = useState({ items: [], postings: [], subscriptions: [] });
  const [amount, setAmount] = useState('50.00');
  const [busy, setBusy] = useState('');
  const [notice, setNoticeState] = useState({ text: '', tone: 'info' });
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const setNotice = (text, tone = 'info') => setNoticeState({ text, tone });
  const [error, setError] = useState('');
  const [monthlyAmount, setMonthlyAmount] = useState(null);
  const [transfer, setTransfer] = useState({ amount: '', reference: '', receivedOn: '' });
  const refresh = useCallback(async () => {
    const [{ data: nextStatus }, { data: nextHistory }] = await Promise.all([api.get('/payments/status'), api.get('/payments/mine')]);
    setStatus(nextStatus); setHistory(nextHistory); setLoadFailed(false);
  }, []);
  useEffect(() => { refresh().catch(() => { setLoadFailed(true); setError('Could not load private contribution information.'); }).finally(() => setLoaded(true)); }, [refresh]);
  useEffect(() => {
    const returned = searchParams.get('paypal');
    if (!returned) return;
    const pending = sessionStorage.getItem('paypalPendingIntent');
    sessionStorage.removeItem('paypalPendingIntent');
    setSearchParams({}, { replace: true });
    if (returned === 'cancelled') { setNotice('PayPal approval was cancelled. No contribution was confirmed.', 'warning'); return; }
    if (returned !== 'one-off' || !pending) {
      setNotice('Approval returned. Your private history will update after PayPal verification.');
      return;
    }
    setBusy('capture');
    api.post(`/payments/one-off/${encodeURIComponent(pending)}/capture`).then(({ data }) => {
      if (data.status === 'verified') setNotice('Your contribution was verified. Thank you.', 'success'); else setNotice('PayPal processing is pending verification.', 'warning');
      refresh().catch(() => {});
    }).catch(() => setNotice('Payment verification is pending. Check your private history later or contact the owner.', 'warning'))
      .finally(() => setBusy(''));
  }, [searchParams, setSearchParams, refresh]);
  const begin = async (kind) => {
    setBusy(kind); setError(''); setNotice('');
    try {
      const { data } = await api.post(kind === 'monthly' ? '/payments/monthly' : '/payments/one-off',
        kind === 'monthly' ? { environment: 'live', amount: monthlyChoice != null ? (monthlyChoice / 100).toFixed(2) : undefined } : { amount, environment: 'live' });
      sessionStorage.setItem('paypalPendingIntent', data.intentId);
      window.location.assign(data.approvalUrl);
    } catch (err) { setError(err.response?.data?.error || 'Could not open PayPal checkout.'); setBusy(''); }
  };
  const reportTransfer = async (event) => {
    event.preventDefault();
    setBusy('manual'); setError(''); setNotice('');
    try { await api.post('/payments/manual-reports', transfer); setTransfer({ amount: '', reference: '', receivedOn: '' });
      setNotice('Transfer reported. It counts only after the owner confirms it against the bank statement.', 'success'); await refresh(); }
    catch (err) { setError(err.response?.data?.error || 'Could not report the transfer.'); }
    finally { setBusy(''); }
  };
  const options = status?.monthlyOptions || [];
  const monthlyChoice = options.includes(monthlyAmount) ? monthlyAmount : options[0] ?? null;
  const change = async (subscription, target) => {
    if (!await confirm(`Change to ${money(target)} per month? Your current subscription is cancelled at PayPal first; you then approve the new amount at PayPal. If you do not approve, no monthly contribution continues.`)) return;
    setBusy(`change:${subscription.id}:${target}`); setError(''); setNotice('');
    try {
      const { data } = await api.post(`/payments/monthly/${encodeURIComponent(subscription.id)}/change`, { environment: 'live', amount: (target / 100).toFixed(2) });
      if (data.status === 'cancellation_unknown') { setNotice('Cancellation of the current subscription is not yet confirmed by PayPal, so no new subscription was started. Try again later.', 'warning'); await refresh(); setBusy(''); return; }
      sessionStorage.setItem('paypalPendingIntent', data.intentId);
      window.location.assign(data.approvalUrl);
    } catch (err) { setError(err.response?.data?.error || 'Could not change the monthly amount.'); setBusy(''); }
  };
  const cancel = async (subscription) => {
    if (!await confirm({ message: 'Cancel this monthly contribution? PayPal may still process a payment already due.', confirmLabel: 'Cancel contribution', danger: true })) return;
    setBusy(`cancel:${subscription.id}`); setError('');
    try { await api.post(`/payments/monthly/${encodeURIComponent(subscription.id)}/cancel`); await refresh(); setNotice('Cancellation requested and will be verified with PayPal.', 'success'); }
    catch (err) { setError(err.response?.data?.error || 'Could not cancel the subscription.'); }
    finally { setBusy(''); }
  };
  const loading = !loaded;
  const amountValid = /^\d{1,5}\.\d{2}$/.test(amount);
  return <Layout><div className="max-w-5xl mx-auto p-6 lg:p-8 space-y-6">
    <header><p className="font-mono text-[11px] uppercase tracking-[0.2em] text-orange-500">Private · Energy & Budget</p>
      <h1 className="aaris-display text-xl text-gray-100 mt-2">Support the lab</h1>
      <p className="text-sm text-gray-500 mt-2 max-w-2xl">Contributions are entirely voluntary. They never change your permissions, quotas, or service priority.</p></header>
    {error && <p role="alert" className="rounded-2xl border border-red-800/50 bg-red-900/20 px-4 py-3 text-sm text-red-300">{error}</p>}
    {busy === 'capture' && <p role="status" className={`rounded-2xl border px-4 py-3 text-sm ${toneCls.info}`}>Verifying your PayPal payment…</p>}
    {notice.text && busy !== 'capture' && <p role="status" className={`rounded-2xl border px-4 py-3 text-sm ${toneCls[notice.tone]}`}>{notice.text}</p>}
    {loaded && status && !status.checkoutEnabled && <p className="rounded-2xl border border-gray-800 bg-gray-900 px-4 py-3 text-sm text-gray-400">Online contributions are currently unavailable. Your existing contribution history remains private below.</p>}
    <div className="grid lg:grid-cols-2 gap-6 items-stretch">
      <Card title="One-off contribution" className="flex flex-col">
        <p className="text-sm text-gray-400 mt-3">Choose an amount in DKK. PayPal shows the final payment for your approval.</p>
        <div className="mt-6">
          <label className="block text-xs text-gray-400 mb-2" htmlFor="support-amount">Amount · DKK</label>
          <input id="support-amount" inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)}
            aria-invalid={!!amount && !amountValid} aria-describedby="support-amount-hint" className={inputCls} />
          <p id="support-amount-hint" className={`text-xs mt-2 ${amount && !amountValid ? 'text-red-400' : 'text-gray-500'}`}>Enter the amount with two decimals, for example 50.00.</p>
        </div>
        <div className="mt-auto pt-6">
          <button type="button" disabled={loading || !status?.checkoutEnabled || !!busy || !amountValid} onClick={() => begin('one-off')} className={primaryBtn}>
            {busy === 'one-off' ? 'Opening PayPal…' : 'Continue to PayPal'}</button>
        </div>
      </Card>
      <Card title="Optional monthly contribution" className="flex flex-col">
        <div className="mt-4 min-h-[2.5rem]" aria-busy={loading}>
          {loading ? <Skeleton className="h-10 w-48" /> : loadFailed ? <p className="text-sm text-gray-500">Monthly amounts could not be loaded.</p> : options.length > 1
            ? <div className="flex flex-wrap gap-3" role="radiogroup" aria-label="Monthly amount">{options.map((ore) => <button key={ore} type="button" role="radio" aria-checked={monthlyChoice === ore}
              onClick={() => setMonthlyAmount(ore)} className={`px-4 py-2 text-sm rounded-xl border transition-colors ${monthlyChoice === ore ? 'border-orange-500 bg-orange-700/20 text-orange-100' : 'border-gray-700 text-gray-300 hover:bg-gray-800'}`}>{money(ore)}</button>)}</div>
            : monthlyChoice != null ? <p className="text-2xl text-white">{money(monthlyChoice)} <span className="text-sm text-gray-400">per month</span></p>
              : <p className="text-sm text-gray-500">Monthly contributions are not available right now.</p>}
        </div>
        <div className="mt-4 space-y-3">
          <p className="text-xs text-gray-500">Monthly, in DKK, first payment when you approve at PayPal. No setup fee or trial. Missed payments are never collected later.</p>
          <p className="text-sm text-gray-400">A recurring subscription requires your explicit approval at PayPal. You can cancel it here at any time.</p>
        </div>
        <div className="mt-auto pt-6">
          <button type="button" disabled={loading || !status?.monthlyAvailable || !!busy} onClick={() => begin('monthly')} className={primaryBtn}>
            {busy === 'monthly' ? 'Opening PayPal…' : 'Review monthly subscription'}</button>
        </div>
      </Card>
    </div>
    <Card title="Your subscriptions">
      {loading ? <div className="mt-4" aria-busy="true"><Skeleton className="h-12 w-full" /></div>
        : loadFailed ? <p className="text-sm text-gray-500 mt-4">Subscriptions could not be loaded.</p>
        : history.subscriptions.length === 0 ? <p className="text-sm text-gray-500 mt-4">No subscriptions recorded.</p> :
        <div className="mt-4 divide-y divide-gray-800">{history.subscriptions.map((item) => <div key={item.id} className="flex flex-wrap items-center justify-between gap-4 py-4 first:pt-0 last:pb-0 text-sm">
          <div><p className="text-white">{money(item.amountOre)} monthly · {item.status}</p><p className="text-xs text-gray-500 mt-1">{item.environment === 'sandbox' ? 'Sandbox test · ' : ''}Next billing {date(item.nextBillingAt)}</p></div>
          {!['CANCELLED', 'EXPIRED'].includes(item.status) && <div className="flex flex-wrap gap-3">
            {item.environment === 'live' && options.filter((ore) => ore !== item.amountOre).map((ore) => <button key={ore} type="button" disabled={!!busy} onClick={() => change(item, ore)}
              className={secondaryBtn}>{busy === `change:${item.id}:${ore}` ? 'Changing…' : `Change to ${money(ore)}`}</button>)}
            <button type="button" disabled={!!busy} onClick={() => cancel(item)} className={secondaryBtn}>{busy === `cancel:${item.id}` ? 'Cancelling…' : 'Cancel subscription'}</button></div>}
        </div>)}</div>}
    </Card>
    <Card title="Paid by bank transfer?" hint="Report it here so the owner can match it against the bank statement. A report is not counted until confirmed.">
      <form onSubmit={reportTransfer} className="mt-5 grid sm:grid-cols-2 lg:grid-cols-3 gap-4 text-xs text-gray-400">
        <div><label htmlFor="transfer-amount" className="block mb-2">Amount · DKK</label>
          <input id="transfer-amount" value={transfer.amount} inputMode="decimal" onChange={(event) => setTransfer((old) => ({ ...old, amount: event.target.value }))} className={inputCls} /></div>
        <div><label htmlFor="transfer-reference" className="block mb-2">Bank reference</label>
          <input id="transfer-reference" value={transfer.reference} onChange={(event) => setTransfer((old) => ({ ...old, reference: event.target.value }))} className={inputCls} /></div>
        <div><label htmlFor="transfer-date" className="block mb-2">Date sent</label>
          <input id="transfer-date" type="date" value={transfer.receivedOn} onChange={(event) => setTransfer((old) => ({ ...old, receivedOn: event.target.value }))} className={inputCls} /></div>
        <div className="sm:col-span-2 lg:col-span-3"><button disabled={!!busy || !transfer.amount || !transfer.reference || !transfer.receivedOn} className={primaryBtn}>
          {busy === 'manual' ? 'Reporting…' : 'Report transfer'}</button></div>
      </form>
      {(history.manualReports || []).length > 0 && <ul className="mt-6 divide-y divide-gray-800 text-sm">{history.manualReports.map((item) => <li key={item.id} className="py-3 flex flex-wrap justify-between gap-x-4 gap-y-1">
        <span className="text-gray-300">{money(item.amountOre)} · ref <span className="font-mono">{item.reference}</span> · {date(item.receivedAt)}</span>
        <span className="font-mono text-xs text-gray-400">{item.status === 'reported' ? 'awaiting confirmation' : item.status}</span></li>)}</ul>}
    </Card>
    <Card title="Your contribution history" hint="Only verified postings count toward the lab budget. Refunds and actual PayPal fees reduce net support.">
      {loading ? <div className="mt-5 space-y-3" aria-busy="true"><Skeleton className="h-5 w-full" /><Skeleton className="h-5 w-full" /></div>
        : loadFailed ? <p className="text-sm text-gray-500 mt-5">Contribution history could not be loaded.</p>
        : history.postings.length === 0 ? <p className="text-sm text-gray-500 mt-5">No verified contributions recorded.</p> :
        <div className="mt-5 divide-y divide-gray-800">{history.postings.map((item, index) => <div key={`${item.effectiveAt}-${index}`} className="flex justify-between gap-4 py-3 first:pt-0 last:pb-0 text-sm">
          <span className="text-gray-300">{item.postingKind.replaceAll('_', ' ')} <span className="text-gray-500">· {date(item.effectiveAt)}{item.environment === 'sandbox' ? ' · sandbox' : ''}</span></span>
          <span className={item.amountOre < 0 ? 'text-red-300' : 'text-green-300'}>{money(item.amountOre)}</span>
        </div>)}</div>}
    </Card>
  </div></Layout>;
}
