import { useCallback, useEffect, useState } from 'react';
import api from '../../api.js';
import { useConfirm } from '../../contexts/FeedbackContext.jsx';
import ErrorCallout from '../../components/ErrorCallout.jsx';

// Shared look for the three PayPal admin files (same classes as the Users /
// Firewalls / PVE pages). Exported so the page and setup panel reuse them.
export const card = 'flex flex-col bg-gray-900 border border-gray-800 rounded-xl p-5 sm:p-6';
export const inputCls = 'w-full bg-gray-800 border border-gray-700/50 rounded-xl px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/20 transition-all';
const btnBase = 'transition-colors disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap';
export const btnPrimary = `btn-primary rounded-xl px-4 py-2.5 text-sm font-medium ${btnBase}`;
export const btnSecondary = `bg-gray-700 hover:bg-gray-600 text-white rounded-xl px-4 py-2.5 text-sm ${btnBase}`;
export const btnSm = `bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white rounded-lg px-2.5 py-1.5 text-xs ${btnBase}`;
export const btnSmDanger = `bg-red-500/10 hover:bg-red-500/20 text-red-400 hover:text-red-300 rounded-lg px-2.5 py-1.5 text-xs ${btnBase}`;
const rowCls = 'border-b border-gray-800 last:border-0 hover:bg-gray-800/50 transition-colors';
const cell = 'px-4 py-3 align-top';

export const money = (ore) => typeof ore === 'number' ? new Intl.NumberFormat('da-DK', { style: 'currency', currency: 'DKK' }).format(ore / 100) : '—';
export const when = (value) => value ? new Intl.DateTimeFormat('da-DK', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)) : '—';

const TONES = {
  ok: 'bg-green-900 text-green-300',
  warn: 'bg-yellow-900 text-yellow-300',
  bad: 'bg-red-900 text-red-300',
  neutral: 'bg-gray-800 text-gray-400',
};

export function Badge({ tone = 'neutral', children }) {
  return <span className={`inline-block text-xs px-2 py-0.5 rounded ${TONES[tone]}`}>{children}</span>;
}

export function Skeleton({ className = 'h-4 w-16' }) {
  return <span aria-hidden="true" className={`block bg-gray-800 animate-pulse ${className}`} />;
}

// Card with a title block, an optional description and a footer action row.
export function Section({ title, description, actions, footer, children }) {
  return <section className={card}>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-white font-semibold">{title}</h2>
        {description && <p className="text-xs text-gray-500 mt-1 max-w-2xl">{description}</p>}
      </div>
      {actions}
    </div>
    <div className="mt-5 flex-1">{children}</div>
    {footer && <div className="mt-5 pt-5 border-t border-gray-800 flex flex-wrap items-center gap-3">{footer}</div>}
  </section>;
}

export function SubHead({ children }) {
  return <h3 className="aaris-meta border-t border-gray-800 pt-5 mt-6 mb-3">{children}</h3>;
}

// Label/value tile. While loading it shows a pulse block, never a fallback word.
export function Stat({ label, value, loading, mono = true }) {
  return <div className="bg-gray-950/50 border border-gray-800 rounded-xl px-3 py-2.5 min-w-0">
    <dt className="text-[11px] text-gray-500">{label}</dt>
    <dd className={`mt-1 text-sm text-gray-100 break-words ${mono ? 'font-mono' : ''}`}>
      {loading ? <><Skeleton className="h-4 w-16" /><span className="sr-only">Loading</span></> : value}
    </dd>
  </div>;
}

export function EmptyState({ children }) {
  return <p className="text-sm text-gray-500 border border-dashed border-gray-800 rounded-xl px-4 py-6 text-center">{children}</p>;
}

export function RowsSkeleton() {
  return <div className="space-y-2" aria-busy="true"><span className="sr-only">Loading</span>
    {[1, 2].map((i) => <div key={i} aria-hidden="true" className="h-12 bg-gray-800/50 rounded-xl animate-pulse" />)}</div>;
}

export function DataTable({ columns, children }) {
  return <div className="border border-gray-800 rounded-xl overflow-x-auto">
    <table className="w-full text-sm">
      <thead><tr className="border-b border-gray-800 text-gray-500 text-xs uppercase tracking-wider">
        {columns.map((name) => <th key={name} scope="col" className="text-left px-4 py-3 font-medium whitespace-nowrap">{name}</th>)}
      </tr></thead>
      <tbody>{children}</tbody>
    </table>
  </div>;
}

export function Row({ children }) { return <tr className={rowCls}>{children}</tr>; }
export function Cell({ children, className = '' }) { return <td className={`${cell} ${className}`}>{children}</td>; }
export function Actions({ children }) { return <div className="flex flex-wrap gap-2">{children}</div>; }

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

const SUB_TONE = { ACTIVE: 'ok', APPROVAL_PENDING: 'warn', APPROVED: 'warn', SUSPENDED: 'warn', CANCELLED: 'neutral', EXPIRED: 'neutral' };
const MANUAL_TONE = { confirmed: 'ok', reported: 'warn', rejected: 'neutral', reversed: 'neutral' };

const METRICS = [
  ['Reconciliation', (h) => h.status], ['Last run', (h) => when(h.lastRunAt)], ['Last full success', (h) => when(h.lastSuccessAt)],
  ['Event cursor', (h) => when(h.eventCursorAt)], ['Failed items (last run)', (h) => h.failedItems], ['Consecutive partial runs', (h) => h.consecutiveFailures],
  ['Unresolved transactions', (h) => h.unresolvedTransactions], ['Uncertain captures', (h) => h.uncertainCaptures],
  ['Subscriptions in backoff', (h) => h.failingSubscriptions], ['Review events', (h) => h.reviewEvents],
  ['Inbox pending', (h) => h.pendingInboxEvents], ['Cancellations unconfirmed', (h) => h.cancellationsAwaitingConfirmation],
];

export default function PayPalOperationsPanel({ environment, act, busy }) {
  const confirm = useConfirm();
  const [health, setHealth] = useState(null);
  const [review, setReview] = useState({ items: [], nextOffset: null });
  const [subscriptions, setSubscriptions] = useState({ items: [], nextOffset: null });
  const [manual, setManual] = useState({ items: [] });
  const [loadError, setLoadError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const load = useCallback(async () => {
    setLoadError('');
    try {
      const [h, r, s, m] = await Promise.all([
        api.get('/payments/admin/health', { params: { environment } }),
        api.get('/payments/admin/review', { params: { environment } }),
        api.get('/payments/admin/subscriptions', { params: { environment } }),
        api.get('/payments/admin/manual', { params: { status: 'all' } }),
      ]);
      setHealth(h.data); setReview(r.data); setSubscriptions(s.data); setManual(m.data);
    } catch { setLoadError('Could not load reconciliation details.'); }
    finally { setLoaded(true); }
  }, [environment]);
  // Switching environment clears the previous one so stale figures never show.
  useEffect(() => { setHealth(null); setLoaded(false); load(); }, [load]);
  const run = async (key, request) => { if (await act(key, request)) await load(); };
  const dismiss = (item) => {
    const note = window.prompt('Why is this event not lab income? (required, stored privately)');
    if (!note || note.trim().length < 3) return;
    run(`dismiss-${item.id}`, () => api.post(`/payments/admin/review/${encodeURIComponent(item.id)}/dismiss`, { environment, note }));
  };
  const cancel = async (item) => {
    if (!await confirm({ message: 'Request cancellation at PayPal? A payment already in flight may still complete.', confirmLabel: 'Request cancellation', danger: true })) return;
    run(`cancel-${item.id}`, () => api.post(`/payments/admin/subscriptions/${encodeURIComponent(item.id)}/cancel`, { environment }));
  };
  const decideManual = async (item, action) => {
    const field = action === 'confirm' ? 'evidence' : 'reason';
    const label = action === 'confirm' ? 'Evidence (statement line, bank reference) for this transfer:' : `Reason to ${action} this entry:`;
    const value = window.prompt(label);
    if (!value || value.trim().length < 3) return;
    const acknowledgeSimilar = action === 'confirm' && await confirm({ message: 'Only confirm if you already checked this is not the same money as an imported PayPal payment. Cancel keeps the duplicate check.', confirmLabel: 'Confirm', danger: true });
    run(`manual-${action}-${item.id}`, () => api.post(`/payments/admin/manual/${item.id}/${action}`, { [field]: value, acknowledgeSimilar }));
  };
  const loading = !loaded;
  const unavailable = <EmptyState>Unavailable until reconciliation details load.</EmptyState>;
  return <div className="space-y-6">
    {loadError && <div className="space-y-3">
      <ErrorCallout error={loadError} />
      <button type="button" onClick={() => { setLoaded(false); load(); }} className={btnSm}>Try again</button>
    </div>}
    <Section title={`Reconciliation health · ${environment}`}
      description="Coverage is only what this integration created and reconciled. It is not your PayPal account or bank balance."
      actions={<button type="button" disabled={!!busy} onClick={() => run('export', () => downloadCsv(environment))} className={btnSecondary}>Export ledger CSV</button>}>
      <dl className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3" aria-busy={loading}>
        {METRICS.map(([name, read]) => <Stat key={name} label={name} loading={loading} value={health ? String(read(health) ?? '—') : '—'} />)}
      </dl>
      {health?.errorCode && <p className="mt-4 font-mono text-xs text-orange-300">Last error: {health.errorCode}</p>}
    </Section>

    <Section title="Review queue"
      description="Quarantined events block finalized net support. Retry sends an event back through verified processing; dismiss records it as not lab income and posts nothing.">
      {loading ? <RowsSkeleton /> : loadError ? unavailable : review.items.length === 0 ? <EmptyState>No events need review.</EmptyState> :
        <DataTable columns={['Event', 'Reason', 'Received', 'Attempts', 'Source', 'Actions']}>
          {review.items.map((item) => <Row key={item.id}>
            <Cell className="font-mono text-gray-200 break-all">{item.eventType}</Cell>
            <Cell className="text-gray-400">{item.errorCode || 'review'}</Cell>
            <Cell className="text-gray-400 whitespace-nowrap">{when(item.receivedAt)}</Cell>
            <Cell className="text-gray-400">{item.attemptCount}</Cell>
            <Cell className="text-gray-400">{item.source}</Cell>
            <Cell><Actions>
              <button type="button" disabled={!!busy} className={btnSm}
                onClick={() => run(`retry-${item.id}`, () => api.post(`/payments/admin/review/${encodeURIComponent(item.id)}/retry`, { environment }))}>Retry</button>
              <button type="button" disabled={!!busy} className={btnSmDanger} onClick={() => dismiss(item)}>Dismiss</button>
            </Actions></Cell>
          </Row>)}
        </DataTable>}
    </Section>

    <Section title="Manual bank transfers · live"
      description="Member reports are not counted until confirmed with evidence. References matching an imported PayPal payment are refused; corrections append a reversal.">
      {loading ? <RowsSkeleton /> : loadError ? unavailable : manual.items.length === 0 ? <EmptyState>No manual entries.</EmptyState> :
        <DataTable columns={['Amount', 'Status', 'Reference', 'Member', 'Received', 'Note', 'Actions']}>
          {manual.items.map((item) => <Row key={item.id}>
            <Cell className="text-gray-100 whitespace-nowrap">{money(item.amountOre)}</Cell>
            <Cell><Badge tone={MANUAL_TONE[item.status]}><span className="font-mono">{item.status}</span></Badge></Cell>
            <Cell className="font-mono text-gray-300 break-all">{item.reference}</Cell>
            <Cell className="text-gray-400 whitespace-nowrap">#{item.userId ?? '—'}</Cell>
            <Cell className="text-gray-400 whitespace-nowrap">{when(item.receivedAt)}</Cell>
            <Cell className="text-gray-400 max-w-[16rem] break-words">{item.memberNote || '—'}</Cell>
            <Cell><Actions>
              {item.status === 'reported' && <><button type="button" disabled={!!busy} className={btnSm} onClick={() => decideManual(item, 'confirm')}>Confirm</button>
                <button type="button" disabled={!!busy} className={btnSm} onClick={() => decideManual(item, 'reject')}>Reject</button></>}
              {item.status === 'confirmed' && <button type="button" disabled={!!busy} className={btnSm} onClick={() => decideManual(item, 'reverse')}>Reverse</button>}
            </Actions></Cell>
          </Row>)}
        </DataTable>}
    </Section>

    <Section title="Monthly subscriptions"
      description="Disabling new checkout never cancels existing billing. Cancellation is confirmed by reading PayPal back.">
      {loading ? <RowsSkeleton /> : loadError ? unavailable : subscriptions.items.length === 0 ? <EmptyState>No subscriptions recorded.</EmptyState> :
        <DataTable columns={['Amount', 'Status', 'Member', 'Next billing', 'Sync', 'Actions']}>
          {subscriptions.items.map((item) => <Row key={item.id}>
            <Cell className="text-gray-100 whitespace-nowrap">{money(item.amountOre)} monthly</Cell>
            <Cell><Badge tone={SUB_TONE[item.status]}><span className="font-mono">{item.status}</span></Badge></Cell>
            <Cell className="text-gray-400 whitespace-nowrap">#{item.userId ?? 'removed'}</Cell>
            <Cell className="text-gray-400 whitespace-nowrap">{when(item.nextBillingAt)}</Cell>
            <Cell className="font-mono text-gray-400">{item.reconcileErrorCode || '—'}</Cell>
            <Cell>{!['CANCELLED', 'EXPIRED'].includes(item.status) && <button type="button" disabled={!!busy} className={btnSmDanger} onClick={() => cancel(item)}>Cancel at PayPal</button>}</Cell>
          </Row>)}
        </DataTable>}
    </Section>
  </div>;
}
