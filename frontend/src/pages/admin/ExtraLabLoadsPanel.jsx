import { useEffect, useState } from 'react';
import api from '../../api.js';
import Field from '../../components/Field.jsx';
import RecentReauthDialog from '../../components/account/RecentReauthDialog.jsx';

const field = 'w-full bg-gray-800 border border-gray-700/50 rounded-xl px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/20 transition-all';
const initial = { sourceKey: '', label: '', estimatedWatts: '', validFrom: '', validTo: '', provenance: '',
  sourceScope: 'incremental_excluding_servers', excludesServerEnergy: false };

export default function ExtraLabLoadsPanel() {
  const [loads, setLoads] = useState(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [form, setForm] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [reauth, setReauth] = useState(false);
  const [reauthError, setReauthError] = useState('');
  const refresh = () => api.get('/admin/electricity-pricing/extra-loads').then(({ data }) => { setLoads(data); setLoadFailed(false); });
  useEffect(() => { refresh().catch(() => { setLoadFailed(true); setNotice({ text: 'Could not load extra lab loads.', error: true }); }); }, []);
  const save = async () => {
    setBusy(true); setNotice(null);
    try {
      await api.post('/admin/electricity-pricing/extra-loads', { ...form,
        validFrom: new Date(form.validFrom).toISOString(), validTo: new Date(form.validTo).toISOString() });
      setForm(initial); await refresh(); setNotice({ text: 'Estimated load saved. Recalculate any affected finalized month explicitly.' });
    } catch (err) {
      if (err.response?.data?.code === 'REAUTHENTICATION_REQUIRED') setReauth(true);
      else setNotice({ text: err.response?.data?.error || 'Could not save extra load.', error: true });
    } finally { setBusy(false); }
  };
  const confirmReauth = async (credentials) => {
    try { await api.post('/auth/reauthenticate', credentials); setReauth(false); await save(); return true; }
    catch (err) { setReauthError(err.response?.data?.error || 'Identity confirmation failed.'); return false; }
  };
  const update = (key, value) => setForm((old) => ({ ...old, [key]: value }));
  const loading = !loads && !loadFailed;
  return <section className="rounded-2xl border border-gray-800 bg-gray-900 p-5 text-gray-100" aria-labelledby="extra-loads-heading">
    <RecentReauthDialog open={reauth} busy={busy} error={reauthError} onCancel={() => setReauth(false)} onConfirm={confirmReauth} />
    <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-orange-500">Energy attribution / private</p>
    <h2 id="extra-loads-heading" className="aaris-display mt-1.5 text-sm text-gray-200">Optional extra lab loads</h2>
    <p className="mt-1.5 max-w-3xl text-xs text-gray-500">None by default. Add only switch, UPS or similar draw outside the measured iLO server input watts. Household or inclusive upstream meter readings must never be added here.</p>
    {notice && <p role={notice.error ? 'alert' : 'status'} className={`mt-4 rounded-xl border p-3 text-xs ${notice.error ? 'border-red-800/30 bg-red-900/20 text-red-400' : 'border-green-800/30 bg-green-900/20 text-green-400'}`}>{notice.text}</p>}
    <div className="mt-5">
      {loading ? <div className="space-y-2" role="status" aria-label="Loading extra lab loads">{[1, 2].map((row) => <div key={row} className="h-12 animate-pulse rounded-xl bg-gray-800/60" />)}</div>
        : loadFailed ? null
        : loads.length ? <ul className="space-y-2">{loads.map((load) => <li key={load.id} className="grid gap-1 rounded-xl border border-gray-700/50 bg-gray-800/40 px-4 py-3 text-xs md:grid-cols-2 md:gap-4">
          <p className="text-sm text-white">{load.label} · <span className="font-mono tabular-nums">{load.estimated_watts} W</span> <span className="text-gray-500">estimated</span></p>
          <p className="text-gray-400 md:text-right"><span className="font-mono">{load.source_key}</span> · {new Date(load.valid_from).toLocaleString()} to {new Date(load.valid_to).toLocaleString()}</p>
        </li>)}</ul>
        : <p className="rounded-xl border border-gray-800 px-4 py-6 text-center text-xs italic text-gray-400">No extra loads configured; calculated lab energy uses measured servers only.</p>}
    </div>
    <form onSubmit={(event) => { event.preventDefault(); save(); }} className="mt-6 grid gap-4 border-t border-gray-800 pt-5 md:grid-cols-2">
      <h3 className="text-sm font-semibold text-white md:col-span-2">Add dated estimate</h3>
      <Field label="Stable source key"><input required pattern="[a-z0-9][a-z0-9_-]{2,63}" value={form.sourceKey} onChange={(event) => update('sourceKey', event.target.value)} className={field} placeholder="switch-rack-1" /></Field>
      <Field label="Display label"><input required value={form.label} onChange={(event) => update('label', event.target.value)} className={field} placeholder="Rack switch overhead" /></Field>
      <Field label="Estimated constant watts"><input required inputMode="decimal" value={form.estimatedWatts} onChange={(event) => update('estimatedWatts', event.target.value)} className={field} placeholder="35.000" /></Field>
      <Field label="Source / calculation reason"><input required value={form.provenance} onChange={(event) => update('provenance', event.target.value)} className={field} /></Field>
      <Field label="Valid from"><input required type="datetime-local" value={form.validFrom} onChange={(event) => update('validFrom', event.target.value)} className={field} /></Field>
      <Field label="Valid until"><input required type="datetime-local" value={form.validTo} onChange={(event) => update('validTo', event.target.value)} className={field} /></Field>
      <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-gray-700/50 bg-gray-800/40 px-3 py-3 text-sm text-gray-200 md:col-span-2"><input required type="checkbox" className="mt-0.5 accent-blue-500" checked={form.excludesServerEnergy} onChange={(event) => update('excludesServerEnergy', event.target.checked)} />I confirm this estimate excludes measured server input power and is not an inclusive upstream or household meter reading.</label>
      <div className="md:col-span-2"><button disabled={busy || !form.excludesServerEnergy} className="btn-primary rounded-xl px-4 py-2.5 text-sm font-medium">{busy ? 'Saving…' : 'Save dated estimate'}</button></div>
    </form>
  </section>;
}
