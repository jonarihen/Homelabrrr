import { useCallback, useEffect, useState } from 'react';
import api from '../../api.js';

const card = 'border border-gray-800 bg-gray-900/90 p-5';
const button = 'border border-gray-700 px-3 py-1.5 text-xs text-gray-200 disabled:opacity-40';
const when = (value) => value ? new Intl.DateTimeFormat('da-DK', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)) : '—';

// Explicit setup actions: a read-only connection test and idempotent creation
// of the product, monthly plan and webhook registration. Created IDs are only
// copied into the form; saving them is a separate, versioned step.
export default function PayPalSetupPanel({ environment, act, busy, configVersion, onUseId }) {
  const [checks, setChecks] = useState(null);
  const [created, setCreated] = useState({});
  const [planAmount, setPlanAmount] = useState('50.00');
  const [history, setHistory] = useState([]);
  const loadHistory = useCallback(async () => {
    try { const { data } = await api.get('/payments/admin/config/history', { params: { environment } }); setHistory(data.items); }
    catch { setHistory([]); }
  }, [environment]);
  useEffect(() => { setChecks(null); setCreated({}); loadHistory(); }, [loadHistory, configVersion]);
  const testConnection = () => act('test', async () => {
    const { data } = await api.post('/payments/admin/test-connection', { environment }); setChecks(data);
  });
  const provision = (kind) => act(`setup-${kind}`, async () => {
    const { data } = await api.post(`/payments/admin/setup/${kind}`, { environment, ...(kind === 'plan' ? { amount: planAmount } : {}) });
    setCreated((old) => ({ ...old, [kind]: data }));
  });
  return <section className={card}>
    <h2 className="aaris-display text-lg text-gray-100">Setup · {environment}</h2>
    <p className="text-xs text-gray-500 mt-1">Nothing here charges anyone. Creation is explicit, scoped to this environment and REST app, and safe to repeat.</p>
    <div className="flex flex-wrap gap-2 mt-4">
      <button type="button" disabled={!!busy} onClick={testConnection} className={button}>Test connection</button>
      <button type="button" disabled={!!busy} onClick={() => provision('webhook')} className={button}>Register webhook</button>
      <button type="button" disabled={!!busy} onClick={() => provision('product')} className={button}>Create product</button>
      <label className="flex items-center gap-2 text-xs text-gray-400">Plan DKK
        <input value={planAmount} onChange={(event) => setPlanAmount(event.target.value)} inputMode="decimal" className="w-24 bg-gray-950 border border-gray-700 px-2 py-1 text-white" /></label>
      <button type="button" disabled={!!busy || !/^\d{1,6}(\.\d{2})?$/.test(planAmount)} onClick={() => provision('plan')} className={button}>Create monthly plan</button>
    </div>
    {checks && <ul className="mt-4 space-y-1 font-mono text-xs">{checks.checks.map((item) => <li key={item.name} className={item.ok ? 'text-green-300' : 'text-red-300'}>
      {item.ok ? 'OK' : 'FAIL'} · {item.name}{item.code ? ` · ${item.code}` : ''}</li>)}</ul>}
    {Object.entries(created).map(([kind, data]) => <p key={kind} className="mt-3 text-xs text-gray-300">
      {kind}: <span className="font-mono">{data.providerId}</span> {data.created ? '(created)' : '(existing)'}
      {kind === 'webhook' && <button type="button" className={`${button} ml-2`} onClick={() => onUseId('webhookId', data.providerId)}>Use in form</button>}
      {kind === 'plan' && <button type="button" className={`${button} ml-2`} onClick={() => { onUseId('monthlyPlanId', data.providerId); onUseId('monthlyAmount', planAmount); }}>Use in form</button>}
    </p>)}
    <h3 className="font-mono text-[10px] uppercase tracking-[0.2em] text-gray-500 mt-5">Configuration history</h3>
    {history.length === 0 ? <p className="text-xs text-gray-500 mt-2">No recorded changes.</p> :
      <ul className="mt-2 divide-y divide-gray-800 text-xs">{history.map((item) => <li key={`${item.configVersion}-${item.action}-${item.createdAt}`} className="py-2 text-gray-300">
        v{item.configVersion} · {item.action} · {when(item.createdAt)} · merchant {item.merchantId || '—'} · webhook {item.webhookId || '—'}
        {item.monthlyPlanId ? ` · plan ${item.monthlyPlanId}` : ''}{item.secretChanged ? ' · secret replaced' : ''} · {item.enabled ? 'enabled' : 'disabled'}</li>)}</ul>}
  </section>;
}
