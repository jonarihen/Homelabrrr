import { useEffect, useState } from 'react';
import api from '../../api.js';
import Field from '../../components/Field.jsx';
import { useConfirm } from '../../contexts/FeedbackContext.jsx';
import RecentReauthDialog from '../../components/account/RecentReauthDialog.jsx';

const inputClass = 'w-full bg-gray-800 border border-gray-700/50 rounded-xl px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/20 transition-all disabled:opacity-60';
const btnPrimary = 'btn-primary rounded-xl px-4 py-2.5 text-sm font-medium';
const btnSecondary = 'rounded-lg border border-gray-700 px-4 py-2 text-sm font-medium text-gray-200 transition-colors hover:border-gray-500 disabled:cursor-not-allowed disabled:opacity-50';
const btnDanger = 'rounded-lg border border-red-800 px-4 py-2 text-sm font-medium text-red-400 transition-colors hover:border-red-600 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-50';
const checkRow = 'flex cursor-pointer items-start gap-3 rounded-xl border border-gray-700/50 bg-gray-800/40 px-3 py-3 text-sm text-gray-200';
const subForm = 'grid gap-4 border-t border-gray-800 pt-6 md:grid-cols-2';
const initialContract = { label: '', kind: 'spot', area: 'DK1', validFrom: '', validTo: '', fixedDkkPerKwh: '', spotMarginDkkPerKwh: '', vatRate: '', fixedMonthlyOre: '', fixedFeeAllocation: 'none', fixedFeeManualShare: '', provenance: '', requiredComponents: ['network', 'system', 'tax'], active: false };
const initialTariff = { component: 'network', validFrom: '', validTo: '', dkkPerKwh: '', vatIncluded: false, provenance: '' };
const initialBill = { periodStart: '', periodEnd: '', amountOre: '', billedKwh: '', kind: 'settlement', reference: '', note: '' };
const currentCopenhagenMonth = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Copenhagen', year: 'numeric', month: '2-digit' }).format(new Date());

// Section heading + optional hint, spanning the whole sub-form grid.
function Head({ title, children }) {
  return <div className="md:col-span-2"><h3 className="text-sm font-semibold text-white">{title}</h3>{children && <p className="mt-1 max-w-3xl text-xs text-gray-500">{children}</p>}</div>;
}
const Actions = ({ children }) => <div className="flex flex-wrap items-center gap-3 md:col-span-2">{children}</div>;

export default function ElectricityPricingPanel() {
  const confirm = useConfirm();
  const [contracts, setContracts] = useState([]);
  const [contractsLoaded, setContractsLoaded] = useState(false);
  const [selected, setSelected] = useState('');
  const [contract, setContract] = useState(initialContract);
  const [tariff, setTariff] = useState(initialTariff);
  const [tariffs, setTariffs] = useState([]);
  const [revisionTarget, setRevisionTarget] = useState('');
  const [revision, setRevision] = useState({ effectiveFrom: '', dkkPerKwh: '', vatIncluded: false, reason: '' });
  const [bill, setBill] = useState(initialBill);
  const [current, setCurrent] = useState(null);
  const [currentLoading, setCurrentLoading] = useState(false);
  const [month, setMonth] = useState(currentCopenhagenMonth);
  const [scenario, setScenario] = useState('');
  const [preview, setPreview] = useState(null);
  const [calculating, setCalculating] = useState(false);
  const [finalizeReason, setFinalizeReason] = useState('');
  const [acknowledgePartial, setAcknowledgePartial] = useState(false);
  const [ending, setEnding] = useState({ validTo: '', reason: '' });
  const [supersede, setSupersede] = useState({ enabled: false, reason: '' });
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [reauth, setReauth] = useState(null);
  const [reauthError, setReauthError] = useState('');
  const say = (text, error = false) => setNotice(text ? { text, error } : null);
  // Controlled-input props for one key of an object held in state.
  const text = (value, set, key) => ({ value: value[key], onChange: (e) => set((v) => ({ ...v, [key]: e.target.value })) });
  const flag = (value, set, key) => ({ checked: value[key], onChange: (e) => set((v) => ({ ...v, [key]: e.target.checked })) });
  const load = async () => {
    const { data } = await api.get('/admin/electricity-pricing/contracts');
    setContracts(data);
    if (!selected && data.length) setSelected(String(data[data.length - 1].id));
  };
  useEffect(() => {
    api.get('/admin/electricity-pricing/contracts').then(({ data }) => {
      setContracts(data);
      if (data.length) setSelected(String(data[data.length - 1].id));
    }).catch(() => say('Pricing configuration unavailable.', true)).finally(() => setContractsLoaded(true));
  }, []);
  useEffect(() => {
    if (!selected) { setCurrent(null); setCurrentLoading(false); return; }
    setCurrentLoading(true);
    api.get('/admin/electricity-pricing/current', { params: { contractRef: selected } }).then(({ data }) => setCurrent(data)).catch(() => setCurrent(null)).finally(() => setCurrentLoading(false));
    api.get(`/admin/electricity-pricing/contracts/${selected}/tariffs`).then(({ data }) => setTariffs(data)).catch(() => setTariffs([]));
  }, [selected, contracts]);
  useEffect(() => { setPreview(null); }, [selected, month, scenario]);
  // Contract, tariff and statement writes need a recent password + 2FA check;
  // on REAUTHENTICATION_REQUIRED the work is parked and retried after the dialog.
  const action = async (work) => {
    setBusy(true); say('');
    try { await work(); await load(); say('Saved.'); }
    catch (err) {
      if (err.response?.data?.code === 'REAUTHENTICATION_REQUIRED') { setReauth({ work }); setReauthError(''); }
      else say(err.response?.data?.error || 'Request failed.', true);
    } finally { setBusy(false); }
  };
  const confirmReauth = async (credentials) => {
    try { await api.post('/auth/reauthenticate', credentials); }
    catch (err) { setReauthError(err.response?.data?.error || 'Identity confirmation failed.'); return false; }
    const pending = reauth; setReauth(null); await action(pending.work); return true;
  };
  const calculate = async () => {
    setBusy(true); setCalculating(true); say('');
    try { setPreview((await api.get(`/admin/electricity-pricing/months/${month}/preview`, { params: { contractRef: selected, scenarioDkkPerKwh: scenario || undefined } })).data); }
    catch (err) { say(err.response?.data?.error || 'Preview unavailable.', true); }
    finally { setBusy(false); setCalculating(false); }
  };
  const selectedContract = contracts.find((item) => String(item.id) === selected);
  return <section className="space-y-6 rounded-2xl border border-gray-800 bg-gray-900 p-5" aria-labelledby="pricing-heading">
    <RecentReauthDialog open={!!reauth} busy={busy} error={reauthError} onCancel={() => setReauth(null)} onConfirm={confirmReauth} />
    <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
      <div><p className="font-mono text-[11px] uppercase tracking-[0.12em] text-orange-500">Pricing / private</p><h2 id="pricing-heading" className="aaris-display mt-1.5 text-sm text-gray-200">Electricity contract & cost</h2><p className="mt-1.5 max-w-3xl text-xs text-gray-500">Enter actual supplier terms and tariffs. Wholesale spot is never the full household price. Nothing here changes server modes.</p></div>
      <button disabled={busy} onClick={() => action(() => api.post('/admin/electricity-pricing/sync'))} className={btnSecondary}>Refresh published spot cache</button>
    </div>
    {notice && <p role={notice.error ? 'alert' : 'status'} className={`rounded-xl border p-3 text-xs ${notice.error ? 'border-red-800/30 bg-red-900/20 text-red-400' : 'border-green-800/30 bg-green-900/20 text-green-400'}`}>{notice.text}</p>}
    <div className="grid gap-4 md:grid-cols-2">
      <Field label="Contract"><select value={selected} disabled={!contractsLoaded} onChange={(e) => setSelected(e.target.value)} className={inputClass}><option value="">{contractsLoaded ? 'Choose' : 'Loading contracts…'}</option>{contracts.map((c) => <option key={c.id} value={c.id}>{c.label} · {c.kind} · {c.active ? 'active' : 'draft'}</option>)}</select></Field>
      <div className="rounded-xl border border-gray-700/50 bg-gray-800/40 p-4 text-sm" aria-busy={currentLoading}>
        <span className="font-mono text-[11px] uppercase tracking-[0.1em] text-gray-500">Applicable now</span>
        {!contractsLoaded || (currentLoading && !current)
          ? <div className="mt-2 space-y-2" role="status" aria-label="Loading applicable price"><div className="h-7 w-40 animate-pulse rounded-lg bg-gray-700/50" /><div className="h-4 w-64 max-w-full animate-pulse rounded-lg bg-gray-700/40" /></div>
          : <div className={currentLoading ? 'opacity-60' : ''}><div className="mt-1 text-xl font-semibold tabular-nums text-white">{current?.status === 'valid' ? `${current.dkk_per_kwh} DKK/kWh` : 'Unavailable'}</div><div className="mt-0.5 text-xs text-gray-500">{current?.basis || 'variable retail incl. VAT'} · {current?.reason || 'Current interval'} · {current?.end_utc ? `until ${new Date(current.end_utc).toLocaleString()}` : 'no valid interval'}</div></div>}
      </div>
    </div>
    {selectedContract?.active && <form onSubmit={(e) => { e.preventDefault(); action(() => api.post(`/admin/electricity-pricing/contracts/${selected}/end`, { validTo: new Date(ending.validTo).toISOString(), reason: ending.reason })); }} className={subForm}>
      <Head title="End selected contract">{selectedContract.valid_to ? `Currently ends ${new Date(selectedContract.valid_to).toLocaleString()}. ` : ''}{selectedContract.end_reason ? `Reason: ${selectedContract.end_reason}. ` : ''}History before the end keeps its price. Deactivating instead withdraws the contract entirely. A finalized month cannot be cut.</Head>
      <Field label="Ends at"><input required type="datetime-local" {...text(ending, setEnding, 'validTo')} className={inputClass} /></Field>
      <Field label="Reason"><input required {...text(ending, setEnding, 'reason')} className={inputClass} /></Field>
      <Actions>
        <button disabled={busy} className={btnPrimary}>End contract</button>
        <button type="button" disabled={busy} onClick={async () => { if (await confirm({ message: 'Deactivate this electricity contract? Price-based power rules will fall back to the schedule until another configured contract is selected.', confirmLabel: 'Deactivate', danger: true })) action(() => api.post(`/admin/electricity-pricing/contracts/${selected}/deactivate`)); }} className={btnDanger}>Deactivate selected contract</button>
      </Actions>
    </form>}
    <form onSubmit={(e) => { e.preventDefault(); const body = { ...contract, fixedMonthlyOre: contract.fixedMonthlyOre === '' ? null : Number(contract.fixedMonthlyOre), validFrom: new Date(contract.validFrom).toISOString(), validTo: contract.validTo ? new Date(contract.validTo).toISOString() : null };
      if (supersede.enabled && selectedContract?.active) { action(() => api.post(`/admin/electricity-pricing/contracts/${selected}/supersede`, { effectiveAt: body.validFrom, reason: supersede.reason, successor: body })); return; }
      action(() => api.post('/admin/electricity-pricing/contracts', body)); }} className={subForm}>
      <Head title="Add contract revision" />
      <Field label="Label"><input required {...text(contract, setContract, 'label')} className={inputClass} /></Field>
      <Field label="Agreement"><select {...text(contract, setContract, 'kind')} className={inputClass}><option value="spot">Spot + charges</option><option value="fixed_all_in">Fixed all-in variable rate</option><option value="fixed_plus_tariffs">Fixed energy + charges</option></select></Field>
      <Field label="Price area"><select {...text(contract, setContract, 'area')} className={inputClass}><option>DK1</option><option>DK2</option></select></Field>
      <Field label="Effective from"><input required type="datetime-local" {...text(contract, setContract, 'validFrom')} className={inputClass} /></Field>
      <Field label="Effective until (optional)"><input type="datetime-local" {...text(contract, setContract, 'validTo')} className={inputClass} /></Field>
      {contract.kind !== 'spot' && <Field label={contract.kind === 'fixed_all_in' ? 'Fixed all-in DKK/kWh' : 'Fixed energy DKK/kWh excl. VAT'}><input required {...text(contract, setContract, 'fixedDkkPerKwh')} className={inputClass} /></Field>}
      {contract.kind !== 'fixed_all_in' && <>
        <Field label={`Retailer margin DKK/kWh${contract.kind === 'fixed_plus_tariffs' ? ' (optional)' : ''}`}><input required={contract.kind === 'spot'} {...text(contract, setContract, 'spotMarginDkkPerKwh')} className={inputClass} placeholder="0.000000 if confirmed zero" /></Field>
        <Field label="VAT fraction"><input required {...text(contract, setContract, 'vatRate')} className={inputClass} placeholder="Enter actual applicable fraction" /></Field>
        <fieldset className="md:col-span-2"><legend className="mb-1.5 block text-xs font-medium text-gray-400">Required variable charges</legend>
          <div className="flex flex-wrap gap-2.5">{['network', 'system', 'tax', 'retailer'].map((name) => <label key={name} className={`${checkRow} items-center py-2`}><input type="checkbox" className="accent-blue-500" checked={contract.requiredComponents.includes(name)} onChange={(e) => setContract((v) => ({ ...v, requiredComponents: e.target.checked ? [...v.requiredComponents, name] : v.requiredComponents.filter((x) => x !== name) }))} />{name}</label>)}</div></fieldset></>}
      <Field label="Separate fixed monthly fee (øre)"><input type="number" min="0" {...text(contract, setContract, 'fixedMonthlyOre')} className={inputClass} /></Field>
      <Field label="Fixed-fee allocation"><select {...text(contract, setContract, 'fixedFeeAllocation')} className={inputClass}><option value="none">None (default)</option><option value="energy_proportion">Household energy proportion</option><option value="manual_share">Manual share</option></select></Field>
      {contract.fixedFeeAllocation === 'manual_share' && <Field label="Manual share (0–1)"><input required {...text(contract, setContract, 'fixedFeeManualShare')} className={inputClass} /></Field>}
      <Field label="Source / reason"><input required {...text(contract, setContract, 'provenance')} className={inputClass} /></Field>
      <label className={`${checkRow} md:col-span-2`}><input type="checkbox" className="mt-0.5 accent-blue-500" {...flag(contract, setContract, 'active')} />Activate this dated contract</label>
      {selectedContract?.active && <label className={`${checkRow} md:col-span-2`}><input type="checkbox" className="mt-0.5 accent-blue-500" {...flag(supersede, setSupersede, 'enabled')} />Supersede the selected contract at “Effective from” (atomic end + activate)</label>}
      {supersede.enabled && selectedContract?.active && <Field label="Supersession reason"><input required {...text(supersede, setSupersede, 'reason')} className={inputClass} /></Field>}
      <Actions><button disabled={busy} className={btnPrimary}>Save contract</button></Actions>
    </form>
    {selected && <form onSubmit={(e) => { e.preventDefault(); action(() => api.post(`/admin/electricity-pricing/contracts/${selected}/tariffs`, { ...tariff, validFrom: new Date(tariff.validFrom).toISOString(), validTo: new Date(tariff.validTo).toISOString() })); }} className={subForm}>
      <Head title="Add effective tariff" />
      <Field label="Component"><select {...text(tariff, setTariff, 'component')} className={inputClass}>{['network', 'system', 'tax', 'retailer'].map((item) => <option key={item}>{item}</option>)}</select></Field>
      <Field label="DKK/kWh"><input required {...text(tariff, setTariff, 'dkkPerKwh')} className={inputClass} /></Field>
      <Field label="From"><input required type="datetime-local" {...text(tariff, setTariff, 'validFrom')} className={inputClass} /></Field>
      <Field label="Until"><input required type="datetime-local" {...text(tariff, setTariff, 'validTo')} className={inputClass} /></Field>
      <Field label="Source / reason"><input required {...text(tariff, setTariff, 'provenance')} className={inputClass} /></Field>
      <label className={`${checkRow} items-center self-end`}><input type="checkbox" className="accent-blue-500" {...flag(tariff, setTariff, 'vatIncluded')} />Rate already includes VAT</label>
      <Actions><button disabled={busy} className={btnPrimary}>Save tariff</button></Actions>
    </form>}
    {selected && tariffs.length > 0 && <form onSubmit={(e) => { e.preventDefault(); action(() => api.post(`/admin/electricity-pricing/contracts/${selected}/tariffs/${revisionTarget}/revise`, { ...revision, effectiveFrom: new Date(revision.effectiveFrom).toISOString() })); }} className={subForm}>
      <Head title="Future tariff revision">A revision closes the prior tariff at the chosen instant. A finalized month cannot be silently changed.</Head>
      <Field label="Tariff"><select required value={revisionTarget} onChange={(e) => setRevisionTarget(e.target.value)} className={inputClass}><option value="">Choose tariff</option>{tariffs.map((item) => <option key={item.id} value={item.id}>{item.component} · {item.dkk_per_kwh} DKK/kWh · from {new Date(item.valid_from).toLocaleString()}</option>)}</select></Field>
      <Field label="Effective from"><input required type="datetime-local" {...text(revision, setRevision, 'effectiveFrom')} className={inputClass} /></Field>
      <Field label="Revised DKK/kWh"><input required {...text(revision, setRevision, 'dkkPerKwh')} className={inputClass} /></Field>
      <Field label="Reason"><input required {...text(revision, setRevision, 'reason')} className={inputClass} /></Field>
      <label className={`${checkRow} items-center md:col-span-2`}><input type="checkbox" className="accent-blue-500" {...flag(revision, setRevision, 'vatIncluded')} />Revised rate includes VAT</label>
      <Actions><button disabled={busy || !revisionTarget} className={btnPrimary}>Append tariff revision</button></Actions>
    </form>}
    {selected && <form onSubmit={(e) => { e.preventDefault(); action(() => api.post('/admin/electricity-pricing/bills', { ...bill, contractId: Number(selected), amountOre: Number(bill.amountOre), periodStart: new Date(bill.periodStart).toISOString(), periodEnd: new Date(bill.periodEnd).toISOString(), billedKwh: bill.billedKwh || null })); }} className={subForm}>
      <Head title="Record actual household bill" />
      <Field label="Period start"><input required type="datetime-local" {...text(bill, setBill, 'periodStart')} className={inputClass} /></Field>
      <Field label="Period end"><input required type="datetime-local" {...text(bill, setBill, 'periodEnd')} className={inputClass} /></Field>
      <Field label="Invoiced amount (øre)"><input required type="number" min="0" {...text(bill, setBill, 'amountOre')} className={inputClass} /></Field>
      <Field label="Billed kWh (optional)"><input {...text(bill, setBill, 'billedKwh')} className={inputClass} /></Field>
      <Field label="Bill kind"><select {...text(bill, setBill, 'kind')} className={inputClass}><option value="settlement">Consumption settlement</option><option value="advance">Advance payment</option></select></Field>
      <Field label="Private reference"><input {...text(bill, setBill, 'reference')} className={inputClass} /></Field>
      <Actions><button disabled={busy} className={btnPrimary}>Record bill as due</button></Actions>
    </form>}
    {selected && <div className="space-y-4 border-t border-gray-800 pt-6">
      <Head title="Monthly calculation / forecast" />
      <div className="grid gap-4 md:grid-cols-3 md:items-end">
        <Field label="Copenhagen month"><input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className={inputClass} /></Field>
        <Field label="Future scenario DKK/kWh"><input value={scenario} onChange={(e) => setScenario(e.target.value)} placeholder="Required beyond published prices" className={inputClass} /></Field>
        <div><button disabled={busy} onClick={calculate} className={btnSecondary}>{calculating ? 'Calculating…' : 'Calculate preview'}</button></div>
      </div>
      {preview && <div className="grid gap-4 text-xs leading-relaxed text-gray-300 md:grid-cols-2">
        <p className="space-y-1 rounded-xl border border-gray-700/50 bg-gray-800/40 p-4"><span className="block">Measured server energy {Number(preview.serverKwh).toFixed(3)} kWh · estimated extra loads {Number(preview.estimatedExtraKwh).toFixed(3)} kWh</span><span className="block">Lab total {Number(preview.labKwh).toFixed(3)} kWh · measured coverage {preview.labCoveredSeconds}/{preview.expectedSeconds} s</span><span className="block">Calculated variable cost {Number(preview.variableCostOre) / 100} DKK · {preview.variableCostComplete ? 'priced intervals complete' : 'partial'}</span></p>
        <p className="space-y-1 rounded-xl border border-gray-700/50 bg-gray-800/40 p-4"><span className="block">Household comparison {preview.household.status} · share {preview.household.labShare || 'unavailable'}</span><span className="block">Fixed-fee allocation {Number(preview.allocatedFixedFeeOre) / 100} DKK · {preview.fixedFeeStatus}</span></p>
        <p className="space-y-1 rounded-xl border border-gray-700/50 bg-gray-800/40 p-4"><span className="block">Forecast {preview.forecast?.forecastTotalOre == null ? 'insufficient or missing scenario' : `${Number(preview.forecast.forecastTotalOre) / 100} DKK`}</span><span className="block">Price method {preview.forecast?.priceBasis || 'closed period'} · known future price {preview.forecast?.knownPriceSeconds || 0} s</span><span className="block">Scheduled extra-load forecast {preview.forecast?.estimatedExtraFutureOre == null ? 'unavailable' : `${Number(preview.forecast.estimatedExtraFutureOre) / 100} DKK`}</span></p>
        <p className="space-y-1 rounded-xl border border-gray-700/50 bg-gray-800/40 p-4"><span className="block">Actual household bills {preview.actualBills.length} · payment status recorded separately</span><span className="block">{preview.closed ? 'Closed month; finalization requires complete coverage or an explicit partial acknowledgement' : 'Open month; preview only'}{preview.contractRefs?.length > 1 ? ` · priced under ${preview.contractRefs.length} successive contracts` : ''}</span></p></div>}
      {preview?.closed && <div className="space-y-4 rounded-xl border border-gray-700/50 bg-gray-800/40 p-4">
        <Field label="Finalization or recalculation reason"><input placeholder="Reason for finalization / revision" value={finalizeReason} onChange={(e) => setFinalizeReason(e.target.value)} className={inputClass} /></Field>
        <label className="flex cursor-pointer items-start gap-3 text-sm text-gray-200"><input type="checkbox" className="mt-0.5 accent-blue-500" checked={acknowledgePartial} onChange={(e) => setAcknowledgePartial(e.target.checked)} />I acknowledge missing energy/price/fee coverage (statement is marked partial)</label>
        <button disabled={busy || !finalizeReason.trim()} onClick={() => action(() => api.post(`/admin/electricity-pricing/months/${month}/finalize`, { contractRef: selected, reason: finalizeReason, acknowledgePartial }))} className={btnPrimary}>Finalize new revision</button></div>}
    </div>}
  </section>;
}
