import { useCallback, useEffect, useState } from 'react';
import api from '../../api.js';

const card = 'border border-gray-800 bg-gray-900/90 p-5';
const money = (ore) => typeof ore === 'number' ? new Intl.NumberFormat('da-DK', { style: 'currency', currency: 'DKK' }).format(ore / 100) : '—';
const when = (value) => value ? new Intl.DateTimeFormat('da-DK', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)) : '—';
const button = 'border border-gray-700 px-3 py-1.5 text-xs text-gray-200 disabled:opacity-40';

// A blob download that fails carries its JSON error as a Blob; decode it so
// the reauthentication flow sees the machine-readable code.
async function downloadCsv(environment) {
  try {
    const { data } = await api.get('/payments/admin/export.csv', { params: { environment }, responseType: 'blob' });
    const url = URL.createObjectURL(data);
    const link = document.createElement('a');
    link.href = url; link.download = `paypal-ledger-${environment}.csv`;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (err) {
    if (err.response?.data instanceof Blob) {
      try { err.response.data = JSON.parse(await err.response.data.text()); } catch { /* keep original */ }
    }
    throw err;
  }
}

export default function PayPalOperationsPanel({ environment, act, busy }) {
  const [health, setHealth] = useState(null);
  const [review, setReview] = useState({ items: [], nextOffset: null });
  const [subscriptions, setSubscriptions] = useState({ items: [], nextOffset: null });
  const [loadError, setLoadError] = useState('');
  const load = useCallback(async () => {
    setLoadError('');
    try {
      const [h, r, s] = await Promise.all([
        api.get('/payments/admin/health', { params: { environment } }),
        api.get('/payments/admin/review', { params: { environment } }),
        api.get('/payments/admin/subscriptions', { params: { environment } }),
      ]);
      setHealth(h.data); setReview(r.data); setSubscriptions(s.data);
    } catch { setLoadError('Could not load reconciliation details.'); }
  }, [environment]);
  useEffect(() => { load(); }, [load]);
  const run = async (key, request) => { if (await act(key, request)) await load(); };
  const dismiss = (item) => {
    const note = window.prompt('Why is this event not lab income? (required, stored privately)');
    if (!note || note.trim().length < 3) return;
    run(`dismiss-${item.id}`, () => api.post(`/payments/admin/review/${encodeURIComponent(item.id)}/dismiss`, { environment, note }));
  };
  const cancel = (item) => {
    if (!window.confirm('Request cancellation at PayPal? A payment already in flight may still complete.')) return;
    run(`cancel-${item.id}`, () => api.post(`/payments/admin/subscriptions/${encodeURIComponent(item.id)}/cancel`, { environment }));
  };
  const metrics = health ? [
    ['Reconciliation', health.status], ['Last run', when(health.lastRunAt)], ['Last full success', when(health.lastSuccessAt)],
    ['Event cursor', when(health.eventCursorAt)], ['Failed items (last run)', health.failedItems], ['Consecutive partial runs', health.consecutiveFailures],
    ['Unresolved transactions', health.unresolvedTransactions], ['Uncertain captures', health.uncertainCaptures],
    ['Subscriptions in backoff', health.failingSubscriptions], ['Review events', health.reviewEvents],
    ['Inbox pending', health.pendingInboxEvents], ['Cancellations unconfirmed', health.cancellationsAwaitingConfirmation],
  ] : [];
  return <div className="space-y-4">
    {loadError && <p role="alert" className="border border-red-800 bg-red-950/30 p-3 text-sm text-red-300">{loadError}</p>}
    <section className={card}>
      <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="aaris-display text-lg text-gray-100">Reconciliation health · {environment}</h2>
        <button type="button" disabled={!!busy} onClick={() => run('export', () => downloadCsv(environment))} className={button}>Export ledger CSV</button></div>
      {health ? <dl className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-4 text-sm">{metrics.map(([name, value]) => <div key={name}>
        <dt className="text-xs text-gray-500">{name}</dt><dd className="font-mono text-gray-100">{String(value)}</dd></div>)}</dl>
        : <p className="text-gray-500 mt-4 text-sm">Loading…</p>}
      {health?.errorCode && <p className="mt-3 font-mono text-xs text-orange-300">Last error: {health.errorCode}</p>}
      <p className="text-xs text-gray-500 mt-3">Coverage is only what this integration created and reconciled. It is not your PayPal account or bank balance.</p>
    </section>
    <section className={card}>
      <h2 className="aaris-display text-lg text-gray-100">Review queue</h2>
      <p className="text-xs text-gray-500 mt-1">Quarantined events block finalized net support. Retry sends an event back through verified processing; dismiss records it as not lab income and posts nothing.</p>
      {review.items.length === 0 ? <p className="text-sm text-gray-500 mt-3">No events need review.</p> :
        <ul className="mt-3 divide-y divide-gray-800">{review.items.map((item) => <li key={item.id} className="py-3 flex flex-wrap items-center justify-between gap-3 text-sm">
          <div><p className="font-mono text-gray-200">{item.eventType}</p>
            <p className="text-xs text-gray-500">{item.errorCode || 'review'} · received {when(item.receivedAt)} · {item.attemptCount} attempts · {item.source}</p></div>
          <div className="flex gap-2">
            <button type="button" disabled={!!busy} className={button}
              onClick={() => run(`retry-${item.id}`, () => api.post(`/payments/admin/review/${encodeURIComponent(item.id)}/retry`, { environment }))}>Retry</button>
            <button type="button" disabled={!!busy} className={`${button} border-red-800 text-red-200`} onClick={() => dismiss(item)}>Dismiss</button>
          </div></li>)}</ul>}
    </section>
    <section className={card}>
      <h2 className="aaris-display text-lg text-gray-100">Monthly subscriptions</h2>
      <p className="text-xs text-gray-500 mt-1">Disabling new checkout never cancels existing billing. Cancellation is confirmed by reading PayPal back.</p>
      {subscriptions.items.length === 0 ? <p className="text-sm text-gray-500 mt-3">No subscriptions recorded.</p> :
        <ul className="mt-3 divide-y divide-gray-800">{subscriptions.items.map((item) => <li key={item.id} className="py-3 flex flex-wrap items-center justify-between gap-3 text-sm">
          <div><p className="text-gray-200">{money(item.amountOre)} monthly · <span className="font-mono">{item.status}</span></p>
            <p className="text-xs text-gray-500">Member #{item.userId ?? 'removed'} · next billing {when(item.nextBillingAt)}{item.reconcileErrorCode ? ` · sync ${item.reconcileErrorCode}` : ''}</p></div>
          {!['CANCELLED', 'EXPIRED'].includes(item.status) && <button type="button" disabled={!!busy} className={button} onClick={() => cancel(item)}>Cancel at PayPal</button>}
        </li>)}</ul>}
    </section>
  </div>;
}
