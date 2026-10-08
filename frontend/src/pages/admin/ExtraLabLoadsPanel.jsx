import { useEffect, useState } from 'react';
import api from '../../api.js';
import RecentReauthDialog from '../../components/account/RecentReauthDialog.jsx';

const field = 'w-full border border-slate-700 bg-slate-950 px-2 py-2 text-slate-100';
const initial = { sourceKey: '', label: '', estimatedWatts: '', validFrom: '', validTo: '', provenance: '',
  sourceScope: 'incremental_excluding_servers', excludesServerEnergy: false };

export default function ExtraLabLoadsPanel() {
  const [loads, setLoads] = useState([]);
  const [form, setForm] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [reauth, setReauth] = useState(false);
  const [reauthError, setReauthError] = useState('');
  const refresh = () => api.get('/admin/electricity-pricing/extra-loads').then(({ data }) => setLoads(data));
  useEffect(() => { refresh().catch(() => setMessage('Could not load extra lab loads.')); }, []);
  const save = async () => {
    setBusy(true); setMessage('');
    try {
      await api.post('/admin/electricity-pricing/extra-loads', { ...form,
        validFrom: new Date(form.validFrom).toISOString(), validTo: new Date(form.validTo).toISOString() });
      setForm(initial); await refresh(); setMessage('Estimated load saved. Recalculate any affected finalized month explicitly.');
    } catch (err) {
      if (err.response?.data?.code === 'REAUTHENTICATION_REQUIRED') setReauth(true);
      else setMessage(err.response?.data?.error || 'Could not save extra load.');
    } finally { setBusy(false); }
  };
  const confirmReauth = async (credentials) => {
    try { await api.post('/auth/reauthenticate', credentials); setReauth(false); await save(); return true; }
    catch (err) { setReauthError(err.response?.data?.error || 'Identity confirmation failed.'); return false; }
  };
  const update = (key, value) => setForm((old) => ({ ...old, [key]: value }));
  return <section className="space-y-4 border border-slate-700 bg-slate-900 p-5 text-slate-100">
    <RecentReauthDialog open={reauth} busy={busy} error={reauthError} onCancel={() => setReauth(false)} onConfirm={confirmReauth} />
    <div><p className="font-mono text-xs uppercase tracking-widest text-orange-500">Energy attribution / private</p>
      <h2 className="text-lg font-semibold uppercase">Optional extra lab loads</h2>
      <p className="text-sm text-slate-400">None by default. Add only switch, UPS or similar draw outside the measured iLO server input watts. Household or inclusive upstream meter readings must never be added here.</p></div>
    {message && <p role="status" className="border border-orange-700 p-2 text-sm">{message}</p>}
    {loads.length ? <div className="divide-y divide-slate-800 border border-slate-700">{loads.map((load) => <div key={load.id} className="grid gap-1 p-3 text-xs md:grid-cols-2">
      <p className="text-slate-100">{load.label} · {load.estimated_watts} W <span className="text-slate-500">estimated</span></p>
      <p className="text-slate-400">{load.source_key} · {new Date(load.valid_from).toLocaleString()} to {new Date(load.valid_to).toLocaleString()}</p>
    </div>)}</div> : <p className="text-sm text-slate-500">No extra loads configured; calculated lab energy uses measured servers only.</p>}
    <form onSubmit={(event) => { event.preventDefault(); save(); }} className="grid gap-3 border-t border-slate-700 pt-4 md:grid-cols-2">
      <label className="text-xs text-slate-400">Stable source key<input required pattern="[a-z0-9][a-z0-9_-]{2,63}" value={form.sourceKey} onChange={(event) => update('sourceKey', event.target.value)} className={field} placeholder="switch-rack-1" /></label>
      <label className="text-xs text-slate-400">Display label<input required value={form.label} onChange={(event) => update('label', event.target.value)} className={field} placeholder="Rack switch overhead" /></label>
      <label className="text-xs text-slate-400">Estimated constant watts<input required inputMode="decimal" value={form.estimatedWatts} onChange={(event) => update('estimatedWatts', event.target.value)} className={field} placeholder="35.000" /></label>
      <label className="text-xs text-slate-400">Source / calculation reason<input required value={form.provenance} onChange={(event) => update('provenance', event.target.value)} className={field} /></label>
      <label className="text-xs text-slate-400">Valid from<input required type="datetime-local" value={form.validFrom} onChange={(event) => update('validFrom', event.target.value)} className={field} /></label>
      <label className="text-xs text-slate-400">Valid until<input required type="datetime-local" value={form.validTo} onChange={(event) => update('validTo', event.target.value)} className={field} /></label>
      <label className="flex items-start gap-2 text-xs text-slate-300 md:col-span-2"><input required type="checkbox" checked={form.excludesServerEnergy} onChange={(event) => update('excludesServerEnergy', event.target.checked)} />I confirm this estimate excludes measured server input power and is not an inclusive upstream or household meter reading.</label>
      <button disabled={busy || !form.excludesServerEnergy} className="border border-orange-600 px-3 py-2 font-mono text-xs uppercase text-orange-400 disabled:opacity-50 md:col-span-2">Save dated estimate</button>
    </form>
  </section>;
}
