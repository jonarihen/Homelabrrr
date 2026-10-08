import { useEffect, useState } from 'react';
import api from '../../api.js';

export default function EnergyDataPage() {
  const [status, setStatus] = useState(null);
  const [meters, setMeters] = useState([]);
  const [token, setToken] = useState('');
  const [meterId, setMeterId] = useState('');
  const [scope, setScope] = useState('household');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const refresh = async () => {
    const { data } = await api.get('/admin/energy-data/status');
    setStatus(data);
    if (data.configured) setMeters((await api.get('/admin/energy-data/meters')).data.meters);
  };
  useEffect(() => { refresh().catch(() => setMessage('Could not load energy data setup.')); }, []);
  const action = async (path, body = {}) => {
    setBusy(true); setMessage('');
    try { await api.post(`/admin/energy-data/${path}`, body); await refresh(); setMessage('Saved.'); }
    catch (err) { setMessage(err.response?.data?.error || 'Request failed.'); }
    finally { setBusy(false); }
  };
  return <main className="max-w-4xl space-y-6 p-6 text-slate-100">
    <header><p className="text-xs uppercase tracking-[.2em] text-cyan-400">Power & Energy</p><h1 className="text-3xl font-semibold">Electricity meter data</h1>
      <p className="mt-2 text-sm text-slate-400">Connect your own ElOverblik Customer API token. Household meter readings are private and are never counted as server use.</p></header>
    {message && <p role="status" className="rounded border border-cyan-700 p-3 text-sm">{message}</p>}
    <section className="rounded border border-slate-700 bg-slate-900 p-5 space-y-3">
      <h2 className="text-lg font-medium">Connection</h2>
      <p className="text-sm text-slate-400">Create a Customer API refresh token in ElOverblik and paste it here. The token is stored encrypted. No MitID credentials are needed.</p>
      <form onSubmit={(event) => { event.preventDefault(); action('connection', { refreshToken: token }).then(() => setToken('')); }} className="flex gap-3">
        <input aria-label="ElOverblik refresh token" type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} className="min-w-0 flex-1 rounded bg-slate-800 p-2" />
        <button disabled={busy || !token} className="rounded bg-cyan-700 px-4 py-2 disabled:opacity-50">Test and save</button>
      </form>
      <p className="text-sm">{status?.configured ? 'Connected' : 'Not configured'} · {status?.enabled ? 'Sync enabled' : 'Sync disabled'}</p>
    </section>
    {status?.configured && <section className="rounded border border-slate-700 bg-slate-900 p-5 space-y-3">
      <h2 className="text-lg font-medium">Selected meter</h2>
      <p className="text-sm text-slate-400">Current: {status.selectedMeter || 'None'} · Scope: {status.scope}</p>
      <select aria-label="Meter" value={meterId} onChange={(event) => setMeterId(event.target.value)} className="w-full rounded bg-slate-800 p-2"><option value="">Choose a linked meter</option>{meters.filter((meter) => meter.hasRelation).map((meter) => <option key={meter.id} value={meter.id}>••••{meter.id.slice(-4)} ({meter.type || 'meter'})</option>)}</select>
      <select aria-label="Meter scope" value={scope} onChange={(event) => setScope(event.target.value)} className="w-full rounded bg-slate-800 p-2"><option value="household">Whole household (default)</option><option value="dedicated_lab">Dedicated lab meter</option></select>
      <button disabled={busy || !meterId} onClick={() => action('meter', { meterId, scope })} className="rounded bg-cyan-700 px-4 py-2 disabled:opacity-50">Select meter and enable sync</button>
      <p className="text-sm text-slate-400">Last sync: {status.lastSuccessAt ? new Date(status.lastSuccessAt).toLocaleString() : 'Never'} · Latest interval: {status.latestIntervalEnd ? new Date(status.latestIntervalEnd).toLocaleString() : 'Unknown'} · Error: {status.lastErrorCode || 'None'}</p>
      <div className="flex gap-3"><button disabled={busy || !status.enabled} onClick={() => action('sync')} className="rounded border border-slate-600 px-4 py-2 disabled:opacity-50">Sync now</button><button disabled={busy} onClick={() => action('disconnect')} className="rounded border border-red-700 px-4 py-2 disabled:opacity-50">Disconnect and keep history</button></div>
    </section>}
  </main>;
}
