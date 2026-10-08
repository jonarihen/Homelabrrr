import { useEffect, useState } from 'react';
import api from '../../api.js';

const blank = { host: '', port: 443, username: '', password: '', verifyTls: true, caCertificate: '' };

export default function HardwareConnection({ nodeRef }) {
  const [connection, setConnection] = useState(null);
  const [form, setForm] = useState(blank);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [discovery, setDiscovery] = useState(null);
  useEffect(() => {
    let live = true;
    api.get('/admin/hardware-connections').then(({ data }) => {
      if (!live) return;
      const found = data.find((x) => x.node_ref === nodeRef) || null;
      setConnection(found);
      if (found) setForm({ host: found.target_host, port: found.target_port, username: found.username, password: '', verifyTls: found.verify_tls, caCertificate: '' });
    }).catch(() => { if (live) setError('Could not load hardware connection'); });
    return () => { live = false; };
  }, [nodeRef]);
  async function save(e) {
    e.preventDefault(); setBusy(true); setError('');
    try {
      const payload = { ...form, nodeRef, configVersion: connection?.config_version };
      const { data } = connection ? await api.put(`/admin/hardware-connections/${connection.id}`, payload) : await api.post('/admin/hardware-connections', payload);
      setConnection(data); setForm((v) => ({ ...v, password: '', caCertificate: '' })); setEditing(false); setDiscovery(null);
    } catch (err) { setError(err.response?.data?.error || 'Could not save connection'); }
    finally { setBusy(false); }
  }
  async function test() {
    setBusy(true); setError(''); setDiscovery(null);
    try {
      const { data } = await api.post(`/admin/hardware-connections/${connection.id}/test`);
      setConnection(data.connection); setDiscovery(data.discovery);
    } catch (err) { setError(err.response?.data?.error || 'Connection test failed'); }
    finally { setBusy(false); }
  }
  async function disconnect() {
    if (!window.confirm(`Decommission iLO binding for ${nodeRef}? Collection and control will stop.`)) return;
    setBusy(true); setError('');
    try { await api.delete(`/admin/hardware-connections/${connection.id}`); setConnection(null); setDiscovery(null); setForm(blank); setEditing(false); }
    catch (err) { setError(err.response?.data?.error || 'Could not disconnect'); }
    finally { setBusy(false); }
  }
  return <div className="mt-3 border-t border-gray-700/50 pt-3 text-xs font-mono">
    <div className="flex flex-wrap items-center gap-3">
      <span className="uppercase tracking-widest text-orange-400">Hardware / iLO</span>
      <span className="text-gray-400">{connection ? `${connection.last_status} · ${connection.generation || 'generation unknown'} · ${connection.model || 'model unknown'}` : 'not configured'}</span>
      {connection && <button disabled={busy} onClick={test} className="text-orange-400 hover:text-orange-300 disabled:opacity-50">Test read-only connection</button>}
      <button disabled={busy} onClick={() => setEditing((v) => !v)} className="text-gray-200 hover:text-orange-400 disabled:opacity-50">{editing ? 'Cancel' : connection ? 'Edit' : 'Configure'}</button>
      {connection && <button disabled={busy} onClick={disconnect} className="text-red-400 hover:text-red-300 disabled:opacity-50">Decommission</button>}
    </div>
    {connection && <p className="mt-2 text-gray-500">Collection disabled · Control disabled · Runtime write privilege unverified</p>}
    {discovery && <div className="mt-2 text-gray-300">Mode {discovery.mode.value} · Actual input {discovery.sample.watts == null ? 'unavailable' : `${discovery.sample.watts} W`} · Monitoring {discovery.capabilities.monitoring} · Runtime mode {discovery.capabilities.runtimeMode}</div>}
    {error && <p role="alert" className="mt-2 text-red-400">{error}</p>}
    {editing && <form onSubmit={save} className="mt-3 grid gap-2 sm:grid-cols-2">
      <label className="text-gray-400">Management host<input required value={form.host} onChange={(e) => setForm((v) => ({ ...v, host: e.target.value }))} className="block w-full bg-gray-900 border border-gray-700 px-2 py-1 text-white" /></label>
      <label className="text-gray-400">HTTPS port<input required type="number" min="1" max="65535" value={form.port} onChange={(e) => setForm((v) => ({ ...v, port: Number(e.target.value) }))} className="block w-full bg-gray-900 border border-gray-700 px-2 py-1 text-white" /></label>
      <label className="text-gray-400">Username<input required value={form.username} onChange={(e) => setForm((v) => ({ ...v, username: e.target.value }))} className="block w-full bg-gray-900 border border-gray-700 px-2 py-1 text-white" /></label>
      <label className="text-gray-400">Password {connection && '(blank keeps existing)'}<input type="password" required={!connection} autoComplete="new-password" value={form.password} onChange={(e) => setForm((v) => ({ ...v, password: e.target.value }))} className="block w-full bg-gray-900 border border-gray-700 px-2 py-1 text-white" /></label>
      <label className="text-gray-400 sm:col-span-2">Private CA certificate (PEM; blank keeps existing)<textarea value={form.caCertificate} onChange={(e) => setForm((v) => ({ ...v, caCertificate: e.target.value }))} className="block w-full bg-gray-900 border border-gray-700 px-2 py-1 text-white" /></label>
      <label className="text-gray-400 sm:col-span-2"><input type="checkbox" checked={form.verifyTls} onChange={(e) => setForm((v) => ({ ...v, verifyTls: e.target.checked }))} /> Verify TLS certificate</label>
      <button disabled={busy} className="border border-orange-500 px-3 py-2 text-orange-400 uppercase sm:col-span-2 disabled:opacity-50">Save iLO connection</button>
    </form>}
  </div>;
}
