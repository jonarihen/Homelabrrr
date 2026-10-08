import { useEffect, useState } from 'react';
import api from '../../api.js';

const inputClass = 'w-full border border-slate-700 bg-slate-950 px-2 py-2 text-slate-100';
const initialContract = { label: '', kind: 'spot', area: 'DK1', validFrom: '', validTo: '', fixedDkkPerKwh: '', spotMarginDkkPerKwh: '', vatRate: '', fixedMonthlyOre: '', provenance: '', requiredComponents: ['network', 'system', 'tax'], active: false };
const initialTariff = { component: 'network', validFrom: '', validTo: '', dkkPerKwh: '', vatIncluded: false, provenance: '' };
const initialBill = { periodStart: '', periodEnd: '', amountOre: '', billedKwh: '', kind: 'settlement', reference: '', note: '' };

export default function ElectricityPricingPanel() {
  const [contracts, setContracts] = useState([]);
  const [selected, setSelected] = useState('');
  const [contract, setContract] = useState(initialContract);
  const [tariff, setTariff] = useState(initialTariff);
  const [bill, setBill] = useState(initialBill);
  const [current, setCurrent] = useState(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const load = async () => {
    const { data } = await api.get('/admin/electricity-pricing/contracts');
    setContracts(data);
    if (!selected && data.length) setSelected(String(data[data.length - 1].id));
  };
  useEffect(() => {
    api.get('/admin/electricity-pricing/contracts').then(({ data }) => {
      setContracts(data);
      if (data.length) setSelected(String(data[data.length - 1].id));
    }).catch(() => setMessage('Pricing configuration unavailable.'));
  }, []);
  useEffect(() => {
    if (!selected) { setCurrent(null); return; }
    api.get('/admin/electricity-pricing/current', { params: { contractRef: selected } }).then(({ data }) => setCurrent(data)).catch(() => setCurrent(null));
  }, [selected, contracts]);
  const action = async (work) => { setBusy(true); setMessage(''); try { await work(); await load(); setMessage('Saved.'); } catch (err) { setMessage(err.response?.data?.error || 'Request failed.'); } finally { setBusy(false); } };
  return <section className="space-y-4 border border-slate-700 bg-slate-900 p-5">
    <div><p className="font-mono text-xs uppercase tracking-widest text-orange-500">Pricing / private</p><h2 className="text-lg font-semibold uppercase">Electricity contract & cost</h2><p className="text-sm text-slate-400">Enter actual supplier terms and tariffs. Wholesale spot is never the full household price. Nothing here changes server modes.</p></div>
    {message && <p role="status" className="border border-orange-700 p-2 text-sm">{message}</p>}
    <div className="grid gap-3 md:grid-cols-2">
      <label className="text-xs text-slate-400">Contract<select value={selected} onChange={(e) => setSelected(e.target.value)} className={inputClass}><option value="">Choose</option>{contracts.map((c) => <option key={c.id} value={c.id}>{c.label} · {c.kind} · {c.active ? 'active' : 'draft'}</option>)}</select></label>
      <div className="border border-slate-700 p-3 text-sm"><span className="font-mono text-xs uppercase text-slate-500">Applicable now</span><div className="mt-1 text-xl text-slate-100">{current?.status === 'valid' ? `${current.dkk_per_kwh} DKK/kWh` : 'Unavailable'}</div><div className="text-xs text-slate-500">{current?.basis || 'variable retail incl. VAT'} · {current?.reason || 'Current interval'} · {current?.end_utc ? `until ${new Date(current.end_utc).toLocaleString()}` : 'no valid interval'}</div></div>
    </div>
    <form onSubmit={(e) => { e.preventDefault(); action(() => api.post('/admin/electricity-pricing/contracts', { ...contract, fixedMonthlyOre: contract.fixedMonthlyOre === '' ? null : Number(contract.fixedMonthlyOre), validFrom: new Date(contract.validFrom).toISOString(), validTo: contract.validTo ? new Date(contract.validTo).toISOString() : null })); }} className="grid gap-2 border-t border-slate-700 pt-4 md:grid-cols-2">
      <h3 className="font-mono text-xs uppercase tracking-widest text-orange-400 md:col-span-2">Add contract revision</h3>
      <label className="text-xs text-slate-400">Label<input required value={contract.label} onChange={(e) => setContract((v) => ({ ...v, label: e.target.value }))} className={inputClass} /></label>
      <label className="text-xs text-slate-400">Agreement<select value={contract.kind} onChange={(e) => setContract((v) => ({ ...v, kind: e.target.value }))} className={inputClass}><option value="spot">Spot + charges</option><option value="fixed_all_in">Fixed all-in variable rate</option></select></label>
      <label className="text-xs text-slate-400">Price area<select value={contract.area} onChange={(e) => setContract((v) => ({ ...v, area: e.target.value }))} className={inputClass}><option>DK1</option><option>DK2</option></select></label>
      <label className="text-xs text-slate-400">Effective from<input required type="datetime-local" value={contract.validFrom} onChange={(e) => setContract((v) => ({ ...v, validFrom: e.target.value }))} className={inputClass} /></label>
      <label className="text-xs text-slate-400">Effective until (optional)<input type="datetime-local" value={contract.validTo} onChange={(e) => setContract((v) => ({ ...v, validTo: e.target.value }))} className={inputClass} /></label>
      {contract.kind === 'spot' ? <><label className="text-xs text-slate-400">Retailer margin DKK/kWh<input required value={contract.spotMarginDkkPerKwh} onChange={(e) => setContract((v) => ({ ...v, spotMarginDkkPerKwh: e.target.value }))} className={inputClass} placeholder="0.000000 if confirmed zero" /></label><label className="text-xs text-slate-400">VAT fraction<input required value={contract.vatRate} onChange={(e) => setContract((v) => ({ ...v, vatRate: e.target.value }))} className={inputClass} placeholder="Enter actual applicable fraction" /></label><div className="md:col-span-2 text-xs text-slate-400">Required variable charges {['network', 'system', 'tax', 'retailer'].map((name) => <label key={name} className="ml-3 inline-flex gap-1"><input type="checkbox" checked={contract.requiredComponents.includes(name)} onChange={(e) => setContract((v) => ({ ...v, requiredComponents: e.target.checked ? [...v.requiredComponents, name] : v.requiredComponents.filter((x) => x !== name) }))} />{name}</label>)}</div></> : <label className="text-xs text-slate-400">Fixed all-in DKK/kWh<input required value={contract.fixedDkkPerKwh} onChange={(e) => setContract((v) => ({ ...v, fixedDkkPerKwh: e.target.value }))} className={inputClass} /></label>}
      <label className="text-xs text-slate-400">Separate fixed monthly fee (øre)<input type="number" min="0" value={contract.fixedMonthlyOre} onChange={(e) => setContract((v) => ({ ...v, fixedMonthlyOre: e.target.value }))} className={inputClass} /></label>
      <label className="text-xs text-slate-400">Source / reason<input required value={contract.provenance} onChange={(e) => setContract((v) => ({ ...v, provenance: e.target.value }))} className={inputClass} /></label>
      <label className="text-xs text-slate-400"><input type="checkbox" checked={contract.active} onChange={(e) => setContract((v) => ({ ...v, active: e.target.checked }))} /> Activate this dated contract</label>
      <button disabled={busy} className="border border-orange-600 px-3 py-2 font-mono text-xs uppercase text-orange-400 disabled:opacity-50 md:col-span-2">Save contract</button>
    </form>
    {selected && <form onSubmit={(e) => { e.preventDefault(); action(() => api.post(`/admin/electricity-pricing/contracts/${selected}/tariffs`, { ...tariff, validFrom: new Date(tariff.validFrom).toISOString(), validTo: new Date(tariff.validTo).toISOString() })); }} className="grid gap-2 border-t border-slate-700 pt-4 md:grid-cols-2">
      <h3 className="font-mono text-xs uppercase tracking-widest text-orange-400 md:col-span-2">Add effective tariff</h3>
      <label className="text-xs text-slate-400">Component<select value={tariff.component} onChange={(e) => setTariff((v) => ({ ...v, component: e.target.value }))} className={inputClass}>{['network', 'system', 'tax', 'retailer'].map((item) => <option key={item}>{item}</option>)}</select></label>
      <label className="text-xs text-slate-400">DKK/kWh<input required value={tariff.dkkPerKwh} onChange={(e) => setTariff((v) => ({ ...v, dkkPerKwh: e.target.value }))} className={inputClass} /></label>
      <label className="text-xs text-slate-400">From<input required type="datetime-local" value={tariff.validFrom} onChange={(e) => setTariff((v) => ({ ...v, validFrom: e.target.value }))} className={inputClass} /></label>
      <label className="text-xs text-slate-400">Until<input required type="datetime-local" value={tariff.validTo} onChange={(e) => setTariff((v) => ({ ...v, validTo: e.target.value }))} className={inputClass} /></label>
      <label className="text-xs text-slate-400">Source / reason<input required value={tariff.provenance} onChange={(e) => setTariff((v) => ({ ...v, provenance: e.target.value }))} className={inputClass} /></label>
      <label className="text-xs text-slate-400"><input type="checkbox" checked={tariff.vatIncluded} onChange={(e) => setTariff((v) => ({ ...v, vatIncluded: e.target.checked }))} /> Rate already includes VAT</label>
      <button disabled={busy} className="border border-orange-600 px-3 py-2 font-mono text-xs uppercase text-orange-400 disabled:opacity-50 md:col-span-2">Save tariff</button>
    </form>}
    {selected && <form onSubmit={(e) => { e.preventDefault(); action(() => api.post('/admin/electricity-pricing/bills', { ...bill, contractId: Number(selected), amountOre: Number(bill.amountOre), periodStart: new Date(bill.periodStart).toISOString(), periodEnd: new Date(bill.periodEnd).toISOString(), billedKwh: bill.billedKwh || null })); }} className="grid gap-2 border-t border-slate-700 pt-4 md:grid-cols-2">
      <h3 className="font-mono text-xs uppercase tracking-widest text-orange-400 md:col-span-2">Record actual household bill</h3>
      <label className="text-xs text-slate-400">Period start<input required type="datetime-local" value={bill.periodStart} onChange={(e) => setBill((v) => ({ ...v, periodStart: e.target.value }))} className={inputClass} /></label>
      <label className="text-xs text-slate-400">Period end<input required type="datetime-local" value={bill.periodEnd} onChange={(e) => setBill((v) => ({ ...v, periodEnd: e.target.value }))} className={inputClass} /></label>
      <label className="text-xs text-slate-400">Invoiced amount (øre)<input required type="number" min="0" value={bill.amountOre} onChange={(e) => setBill((v) => ({ ...v, amountOre: e.target.value }))} className={inputClass} /></label>
      <label className="text-xs text-slate-400">Billed kWh (optional)<input value={bill.billedKwh} onChange={(e) => setBill((v) => ({ ...v, billedKwh: e.target.value }))} className={inputClass} /></label>
      <label className="text-xs text-slate-400">Bill kind<select value={bill.kind} onChange={(e) => setBill((v) => ({ ...v, kind: e.target.value }))} className={inputClass}><option value="settlement">Consumption settlement</option><option value="advance">Advance payment</option></select></label>
      <label className="text-xs text-slate-400">Private reference<input value={bill.reference} onChange={(e) => setBill((v) => ({ ...v, reference: e.target.value }))} className={inputClass} /></label>
      <button disabled={busy} className="border border-orange-600 px-3 py-2 font-mono text-xs uppercase text-orange-400 disabled:opacity-50 md:col-span-2">Record bill as due</button>
    </form>}
    <button disabled={busy} onClick={() => action(() => api.post('/admin/electricity-pricing/sync'))} className="border border-slate-600 px-3 py-2 font-mono text-xs uppercase disabled:opacity-50">Refresh published spot cache</button>
  </section>;
}
