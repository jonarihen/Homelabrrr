import { useCallback, useEffect, useState } from 'react';
import api from '../../api.js';
import { Actions, Badge, Cell, DataTable, EmptyState, Row, RowsSkeleton, Section, SubHead, btnSecondary, btnSm, btnSmDanger, inputCls, money, when } from './PayPalOperationsPanel.jsx';

const step = 'bg-gray-950/50 border border-gray-800 rounded-xl p-4 flex flex-col gap-3';

// Explicit setup actions: a read-only connection test and idempotent creation
// of the product, monthly plan and webhook registration. Created IDs are only
// copied into the form; saving them is a separate, versioned step.
export default function PayPalSetupPanel({ environment, act, busy, configVersion, onUseId }) {
  const [checks, setChecks] = useState(null);
  const [created, setCreated] = useState({});
  const [planAmount, setPlanAmount] = useState('50.00');
  // null = still loading; each list settles on its own so one slow endpoint cannot hide the other.
  const [history, setHistory] = useState(null);
  const [plans, setPlans] = useState(null);
  const loadHistory = useCallback(() => {
    api.get('/payments/admin/config/history', { params: { environment } }).then(({ data }) => setHistory(data.items), () => setHistory([]));
    api.get('/payments/admin/monthly-plans', { params: { environment } }).then(({ data }) => setPlans(data.items), () => setPlans([]));
  }, [environment]);
  useEffect(() => { setChecks(null); setCreated({}); setHistory(null); setPlans(null); loadHistory(); }, [loadHistory, configVersion]);
  const testConnection = () => act('test', async () => {
    const { data } = await api.post('/payments/admin/test-connection', { environment }); setChecks(data);
  });
  const provision = (kind) => act(`setup-${kind}`, async () => {
    const { data } = await api.post(`/payments/admin/setup/${kind}`, { environment, ...(kind === 'plan' ? { amount: planAmount } : {}) });
    setCreated((old) => ({ ...old, [kind]: data }));
  });
  const offerPlan = (planId, amount) => act('offer-plan', async () => {
    const { data } = await api.post('/payments/admin/monthly-plans', { environment, planId, amount }); setPlans(data.items);
  });
  const retirePlan = (plan) => {
    if (!window.confirm('Stop offering this amount to new subscribers? Existing subscriptions keep billing until cancelled.')) return;
    act('retire-plan', async () => { const { data } = await api.post(`/payments/admin/monthly-plans/${plan.id}/deactivate`, { environment }); setPlans(data.items); });
  };
  const planValid = /^\d{1,6}(\.\d{2})?$/.test(planAmount);
  return <Section title={`Setup · ${environment}`}
    description="Nothing here charges anyone. Creation is explicit, scoped to this environment and REST app, and safe to repeat. Created IDs are only copied into the form; saving them is a separate, versioned step.">
    <div className="grid sm:grid-cols-2 gap-3">
      <div className={step}>
        <div><h3 className="text-sm text-white font-medium">Connection</h3><p className="text-xs text-gray-500 mt-1">Read-only test of the saved credentials.</p></div>
        <div className="mt-auto"><button type="button" disabled={!!busy} onClick={testConnection} className={btnSecondary}>{busy === 'test' ? 'Testing…' : 'Test connection'}</button></div>
      </div>
      <div className={step}>
        <div><h3 className="text-sm text-white font-medium">Webhook</h3><p className="text-xs text-gray-500 mt-1">Register this app's webhook with PayPal.</p></div>
        <div className="mt-auto"><button type="button" disabled={!!busy} onClick={() => provision('webhook')} className={btnSecondary}>{busy === 'setup-webhook' ? 'Registering…' : 'Register webhook'}</button></div>
      </div>
      <div className={step}>
        <div><h3 className="text-sm text-white font-medium">Product</h3><p className="text-xs text-gray-500 mt-1">Create the PayPal product that plans belong to.</p></div>
        <div className="mt-auto"><button type="button" disabled={!!busy} onClick={() => provision('product')} className={btnSecondary}>{busy === 'setup-product' ? 'Creating…' : 'Create product'}</button></div>
      </div>
      <div className={step}>
        <div><h3 className="text-sm text-white font-medium">Monthly plan</h3><p className="text-xs text-gray-500 mt-1">Create a plan for one monthly amount.</p></div>
        <div className="mt-auto flex flex-wrap items-end gap-3">
          <div className="w-32">
            <label htmlFor="paypal-plan-amount" className="block text-xs text-gray-400 mb-1.5">Plan amount (DKK)</label>
            <input id="paypal-plan-amount" value={planAmount} onChange={(event) => setPlanAmount(event.target.value)} inputMode="decimal" aria-invalid={!planValid} className={inputCls} />
          </div>
          <button type="button" disabled={!!busy || !planValid} onClick={() => provision('plan')} className={btnSecondary}>{busy === 'setup-plan' ? 'Creating…' : 'Create monthly plan'}</button>
        </div>
      </div>
    </div>

    {checks && <ul className="mt-4 space-y-1.5 font-mono text-xs" aria-label="Connection test results">{checks.checks.map((item) => <li key={item.name} className="flex items-center gap-2">
      <Badge tone={item.ok ? 'ok' : 'bad'}>{item.ok ? 'OK' : 'FAIL'}</Badge><span className="text-gray-300">{item.name}{item.code ? ` · ${item.code}` : ''}</span></li>)}</ul>}
    {Object.keys(created).length > 0 && <ul className="mt-4 space-y-2">{Object.entries(created).map(([kind, data]) => <li key={kind} className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-gray-300 bg-gray-950/50 border border-gray-800 rounded-xl px-4 py-3">
      <span className="text-gray-500 capitalize">{kind}</span><span className="font-mono break-all">{data.providerId}</span><Badge tone={data.created ? 'ok' : 'neutral'}>{data.created ? 'created' : 'existing'}</Badge>
      {kind === 'webhook' && <button type="button" className={btnSm} onClick={() => onUseId('webhookId', data.providerId)}>Use in form</button>}
      {kind === 'plan' && <button type="button" disabled={!!busy} className={btnSm} onClick={() => offerPlan(data.providerId, (data.amountOre / 100).toFixed(2))}>Offer this amount</button>}
    </li>)}</ul>}

    <SubHead>Offered monthly amounts</SubHead>
    {!plans ? <RowsSkeleton /> : plans.length === 0 ? <EmptyState>No validated plans beyond the configured default.</EmptyState> :
      <DataTable columns={['Amount', 'Plan ID', 'State', 'Actions']}>{plans.map((plan) => <Row key={plan.id}>
        <Cell className="text-gray-100 whitespace-nowrap">{money(plan.amountOre)}</Cell>
        <Cell className="font-mono text-gray-300 break-all">{plan.planId}</Cell>
        <Cell><Badge tone={plan.active ? 'ok' : 'neutral'}>{plan.active ? 'offered' : 'retired'}</Badge></Cell>
        <Cell>{plan.active && <Actions><button type="button" disabled={!!busy} className={btnSmDanger} onClick={() => retirePlan(plan)}>Stop offering</button></Actions>}</Cell>
      </Row>)}</DataTable>}

    <SubHead>Configuration history</SubHead>
    {!history ? <RowsSkeleton /> : history.length === 0 ? <EmptyState>No recorded changes.</EmptyState> :
      <DataTable columns={['Version', 'Action', 'When', 'Merchant', 'Webhook', 'Plan', 'Checkout', 'Notes']}>{history.map((item) => <Row key={`${item.configVersion}-${item.action}-${item.createdAt}`}>
        <Cell className="font-mono text-gray-100">v{item.configVersion}</Cell>
        <Cell className="text-gray-300">{item.action}</Cell>
        <Cell className="text-gray-400 whitespace-nowrap">{when(item.createdAt)}</Cell>
        <Cell className="font-mono text-gray-400 break-all">{item.merchantId || '—'}</Cell>
        <Cell className="font-mono text-gray-400 break-all">{item.webhookId || '—'}</Cell>
        <Cell className="font-mono text-gray-400 break-all">{item.monthlyPlanId || '—'}</Cell>
        <Cell><Badge tone={item.enabled ? 'ok' : 'neutral'}>{item.enabled ? 'enabled' : 'disabled'}</Badge></Cell>
        <Cell className="text-gray-400">{item.secretChanged ? 'secret replaced' : '—'}</Cell>
      </Row>)}</DataTable>}
  </Section>;
}
