import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../api.js';
import Layout from '../components/Layout.jsx';
import useDocumentTitle from '../hooks/useDocumentTitle.js';

const money = (ore) => typeof ore === 'number' ? new Intl.NumberFormat('da-DK', { style: 'currency', currency: 'DKK' }).format(ore / 100) : '—';
const date = (value) => value ? new Intl.DateTimeFormat('da-DK', { dateStyle: 'medium' }).format(new Date(value)) : '—';
const card = 'border border-gray-800 bg-gray-900/90 p-5';

export default function SupportPage() {
  useDocumentTitle('Support the lab');
  const [searchParams, setSearchParams] = useSearchParams();
  const [status, setStatus] = useState(null);
  const [history, setHistory] = useState({ items: [], postings: [], subscriptions: [] });
  const [amount, setAmount] = useState('50.00');
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    const [{ data: nextStatus }, { data: nextHistory }] = await Promise.all([api.get('/payments/status'), api.get('/payments/mine')]);
    setStatus(nextStatus); setHistory(nextHistory);
  }, []);
  useEffect(() => { refresh().catch(() => setError('Could not load private contribution information.')); }, [refresh]);
  useEffect(() => {
    const returned = searchParams.get('paypal');
    if (!returned) return;
    const pending = sessionStorage.getItem('paypalPendingIntent');
    sessionStorage.removeItem('paypalPendingIntent');
    setSearchParams({}, { replace: true });
    if (returned === 'cancelled') { setNotice('PayPal approval was cancelled. No contribution was confirmed.'); return; }
    if (returned !== 'one-off' || !pending) {
      setNotice('Approval returned. Your private history will update after PayPal verification.');
      return;
    }
    setBusy('capture');
    api.post(`/payments/one-off/${encodeURIComponent(pending)}/capture`).then(({ data }) => {
      setNotice(data.status === 'verified' ? 'Your contribution was verified. Thank you.' : 'PayPal processing is pending verification.');
      refresh().catch(() => {});
    }).catch(() => setNotice('Payment verification is pending. Check your private history later or contact the owner.'))
      .finally(() => setBusy(''));
  }, [searchParams, setSearchParams, refresh]);
  const begin = async (kind) => {
    setBusy(kind); setError(''); setNotice('');
    try {
      const { data } = await api.post(kind === 'monthly' ? '/payments/monthly' : '/payments/one-off',
        kind === 'monthly' ? { environment: 'live' } : { amount, environment: 'live' });
      sessionStorage.setItem('paypalPendingIntent', data.intentId);
      window.location.assign(data.approvalUrl);
    } catch (err) { setError(err.response?.data?.error || 'Could not open PayPal checkout.'); setBusy(''); }
  };
  const cancel = async (subscription) => {
    if (!window.confirm('Cancel this monthly contribution? PayPal may still process a payment already due.')) return;
    setBusy(subscription.id); setError('');
    try { await api.post(`/payments/monthly/${encodeURIComponent(subscription.id)}/cancel`); await refresh(); setNotice('Cancellation requested and will be verified with PayPal.'); }
    catch (err) { setError(err.response?.data?.error || 'Could not cancel the subscription.'); }
    finally { setBusy(''); }
  };
  return <Layout><div className="max-w-5xl p-6 lg:p-8 space-y-6">
    <header><p className="font-mono text-[10px] uppercase tracking-[0.2em] text-orange-500">Private · Energy & Budget</p>
      <h1 className="aaris-display text-2xl text-gray-100 mt-2">Support the lab</h1>
      <p className="text-sm text-gray-400 mt-2 max-w-2xl">Contributions are entirely voluntary. They never change your permissions, quotas, or service priority.</p></header>
    {error && <p role="alert" className="border border-red-800 bg-red-950/30 p-3 text-sm text-red-300">{error}</p>}
    {notice && <p role="status" className="border border-orange-800 bg-orange-950/20 p-3 text-sm text-orange-200">{notice}</p>}
    <section className="grid md:grid-cols-2 gap-4">
      <div className={card}><p className="font-mono text-xs uppercase tracking-widest text-gray-500">One-off contribution</p>
        <p className="text-sm text-gray-400 mt-3">Choose an amount in DKK. PayPal shows the final payment for your approval.</p>
        <label className="block text-xs text-gray-400 mt-5" htmlFor="support-amount">Amount · DKK</label>
        <input id="support-amount" inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)}
          className="mt-2 w-full border border-gray-700 bg-gray-950 px-3 py-2 text-white" />
        <button type="button" disabled={!status?.checkoutEnabled || !!busy || !/^\d{1,5}\.\d{2}$/.test(amount)} onClick={() => begin('one-off')}
          className="mt-4 border border-orange-600 bg-orange-700/30 px-4 py-2 font-mono text-xs uppercase text-orange-100 disabled:opacity-40">Continue to PayPal</button>
      </div>
      <div className={card}><p className="font-mono text-xs uppercase tracking-widest text-gray-500">Optional monthly contribution</p>
        <p className="text-2xl text-white mt-4">{money(status?.monthlyAmountOre)} <span className="text-sm text-gray-400">per month</span></p>
        <p className="text-sm text-gray-400 mt-3">A recurring subscription requires your explicit approval at PayPal. You can cancel it here at any time.</p>
        <button type="button" disabled={!status?.monthlyAvailable || !!busy} onClick={() => begin('monthly')}
          className="mt-5 border border-orange-600 bg-orange-700/30 px-4 py-2 font-mono text-xs uppercase text-orange-100 disabled:opacity-40">Review monthly subscription</button>
      </div>
    </section>
    {!status?.checkoutEnabled && <p className="border border-gray-800 p-3 text-sm text-gray-400">Online contributions are currently unavailable. Your existing contribution history remains private below.</p>}
    <section className={card}><h2 className="aaris-display text-lg text-gray-100">Your subscriptions</h2>
      {history.subscriptions.length === 0 ? <p className="text-sm text-gray-500 mt-3">No subscriptions recorded.</p> :
        <div className="mt-4 space-y-3">{history.subscriptions.map((item) => <div key={item.id} className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-800 pt-3 text-sm">
          <div><p className="text-white">{money(item.amountOre)} monthly · {item.status}</p><p className="text-xs text-gray-500">{item.environment === 'sandbox' ? 'Sandbox test · ' : ''}Next billing {date(item.nextBillingAt)}</p></div>
          {!['CANCELLED', 'EXPIRED'].includes(item.status) && <button type="button" disabled={!!busy} onClick={() => cancel(item)} className="border border-gray-700 px-3 py-2 text-xs text-gray-300 disabled:opacity-40">Cancel subscription</button>}
        </div>)}</div>}
    </section>
    <section className={card}><h2 className="aaris-display text-lg text-gray-100">Your contribution history</h2>
      <p className="text-xs text-gray-500 mt-2">Only verified postings count toward the lab budget. Refunds and actual PayPal fees reduce net support.</p>
      {history.postings.length === 0 ? <p className="text-sm text-gray-500 mt-4">No verified contributions recorded.</p> :
        <div className="mt-4 divide-y divide-gray-800">{history.postings.map((item, index) => <div key={`${item.effectiveAt}-${index}`} className="flex justify-between gap-4 py-3 text-sm">
          <span className="text-gray-300">{item.postingKind.replaceAll('_', ' ')} <span className="text-gray-500">· {date(item.effectiveAt)}{item.environment === 'sandbox' ? ' · sandbox' : ''}</span></span>
          <span className={item.amountOre < 0 ? 'text-red-300' : 'text-green-300'}>{money(item.amountOre)}</span>
        </div>)}</div>}
    </section>
  </div></Layout>;
}
