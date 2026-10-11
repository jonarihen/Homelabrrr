import { useEffect, useState } from 'react';
import api from '../../api.js';
import HardwareTelemetryView from './HardwareTelemetryView.jsx';
import HardwarePowerPolicy from './HardwarePowerPolicy.jsx';
import { connectionNotices, connectionStatusText, connectionStatusTone, testFailureText, writePrivilegeText } from '../../utils/hardwareView.js';

const blank = { host: '', port: 443, username: '', password: '', verifyTls: true, caCertificate: '', clearCaCertificate: false };
// Every node's Hardware section reloads when a connection moves between nodes.
const CHANGED_EVENT = 'hardware-connections-changed';
const NOTICE_CLASS = { warn: 'border-yellow-500/40 text-yellow-300', error: 'border-red-500/40 text-red-300', info: 'border-gray-700 text-gray-400' };
const STATUS_CLASS = { ok: 'text-green-400', info: 'text-gray-400', error: 'text-red-400' };

// `mode="summary"` is the node row on PVE Hosts: status, read-only test,
// telemetry and power policy. `mode="config"` lives in the Edit Host dialog and
// owns the connection settings, rebind and decommission.
export default function HardwareConnection({ nodeRef, rebindTargets = [], mode = 'summary' }) {
  const configMode = mode === 'config';
  const [connection, setConnection] = useState(null);
  const [form, setForm] = useState(blank);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [discovery, setDiscovery] = useState(null);
  const [rebindTo, setRebindTo] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    const reload = () => setReloadKey((k) => k + 1);
    window.addEventListener(CHANGED_EVENT, reload);
    return () => window.removeEventListener(CHANGED_EVENT, reload);
  }, []);
  useEffect(() => {
    let live = true;
    api.get('/admin/hardware-connections').then(({ data }) => {
      if (!live) return;
      const found = data.find((x) => x.node_ref === nodeRef) || null;
      setConnection(found);
      if (found) setForm({ host: found.target_host, port: found.target_port, username: found.username, password: '', verifyTls: found.verify_tls, caCertificate: '', clearCaCertificate: false });
    }).catch(() => { if (live) setError('Could not load hardware connection'); });
    return () => { live = false; };
  }, [nodeRef, reloadKey]);
  async function save(e) {
    e.preventDefault(); setBusy(true); setError(''); setSaved(false);
    try {
      const payload = { ...form, nodeRef, configVersion: connection?.config_version };
      const { data } = connection ? await api.put(`/admin/hardware-connections/${connection.id}`, payload) : await api.post('/admin/hardware-connections', payload);
      setConnection(data); setForm((v) => ({ ...v, password: '', caCertificate: '', clearCaCertificate: false })); setDiscovery(null);
      setSaved(true); window.dispatchEvent(new Event(CHANGED_EVENT));
    } catch (err) { setError(err.response?.data?.error || 'Could not save connection'); }
    finally { setBusy(false); }
  }
  async function test() {
    setBusy(true); setError(''); setDiscovery(null);
    try {
      const { data } = await api.post(`/admin/hardware-connections/${connection.id}/test`);
      setConnection(data.connection); setDiscovery(data.discovery);
      window.dispatchEvent(new Event(CHANGED_EVENT));
    } catch (err) {
      setError(testFailureText(err.response?.data));
      // The backend persisted the failed result; every view of this node shows it.
      window.dispatchEvent(new Event(CHANGED_EVENT));
    }
    finally { setBusy(false); }
  }
  async function rebind() {
    if (!rebindTo || !window.confirm(`Move this iLO binding from ${nodeRef} to ${rebindTo}? Collection and control will be disabled until it is tested again.`)) return;
    setBusy(true); setError('');
    try {
      await api.post(`/admin/hardware-connections/${connection.id}/rebind`, { nodeRef: rebindTo, configVersion: connection.config_version });
      setConnection(null); setDiscovery(null); setForm(blank); setRebindTo('');
      window.dispatchEvent(new Event(CHANGED_EVENT));
    } catch (err) { setError(err.response?.data?.error || 'Could not rebind connection'); }
    finally { setBusy(false); }
  }
  async function disconnect() {
    if (!window.confirm(`Decommission iLO binding for ${nodeRef}? Collection and control will stop.`)) return;
    setBusy(true); setError('');
    try { await api.delete(`/admin/hardware-connections/${connection.id}`); setConnection(null); setDiscovery(null); setForm(blank); window.dispatchEvent(new Event(CHANGED_EVENT)); }
    catch (err) { setError(err.response?.data?.error || 'Could not disconnect'); }
    finally { setBusy(false); }
  }
  return <div className="mt-3 border-t border-gray-700/50 pt-3 text-xs font-mono">
    <div className="flex flex-wrap items-center gap-3">
      {!configMode && <span className="uppercase tracking-widest text-orange-400">Hardware / iLO</span>}
      {connection
        ? <span><span className={STATUS_CLASS[connectionStatusTone(connection.last_status)]}>{connectionStatusText(connection.last_status)}</span><span className="text-gray-400"> · {connection.generation || 'generation unknown'} · {connection.model || 'model unknown'} · firmware {connection.firmware || 'unknown'}</span></span>
        : <span className="text-gray-400">not configured{configMode ? '' : ' — add it under Edit Host'}</span>}
      {connection && <button type="button" disabled={busy} onClick={test} className="text-orange-400 hover:text-orange-300 disabled:opacity-50">Test read-only connection</button>}
      {configMode && connection && <button type="button" disabled={busy} onClick={disconnect} className="text-red-400 hover:text-red-300 disabled:opacity-50">Decommission</button>}
    </div>
    {connection && <p className="mt-2 text-gray-500">Collection {connection.collection_enabled ? 'enabled' : 'disabled'} · Control {connection.control_enabled ? 'enabled' : 'disabled'} · Runtime capability {connection.capabilities?.runtimeMode || 'unverified'} · Write privilege {writePrivilegeText(connection.capabilities)} · TLS {connection.verify_tls ? 'verified' : 'NOT verified'}{connection.has_ca_certificate ? ' (private CA)' : ''}{connection.last_test_at ? ` · Last test ${new Date(connection.last_test_at).toLocaleString()}` : ''}</p>}
    {connectionNotices(connection).map((notice) => <p key={notice.text} className={`mt-2 border-l-2 pl-2 ${NOTICE_CLASS[notice.tone]}`}>{notice.text}</p>)}
    {discovery && <div className="mt-2 text-gray-300">Mode {discovery.mode.value} · Actual input {discovery.sample.watts == null ? 'unavailable' : `${discovery.sample.watts} W`} · Monitoring {discovery.capabilities.monitoring} · Runtime mode {discovery.capabilities.runtimeMode} · Temperatures {discovery.capabilities.temperatures} · Fans {discovery.capabilities.fans} · Power supplies {discovery.capabilities.powerSupplies}</div>}
    {error && <p role="alert" className="mt-2 text-red-400">{error}</p>}
    {!configMode && connection && <HardwareTelemetryView connection={connection} onConnectionChange={setConnection} />}
    {!configMode && connection && <HardwarePowerPolicy connection={connection} onConnectionChange={setConnection} />}
    {configMode && <form onSubmit={save} className="mt-3 grid gap-2 sm:grid-cols-2">
      <label className="text-gray-400">Management host<input required value={form.host} onChange={(e) => setForm((v) => ({ ...v, host: e.target.value }))} className="block w-full bg-gray-900 border border-gray-700 px-2 py-1 text-white" /></label>
      <label className="text-gray-400">HTTPS port<input required type="number" min="1" max="65535" value={form.port} onChange={(e) => setForm((v) => ({ ...v, port: Number(e.target.value) }))} className="block w-full bg-gray-900 border border-gray-700 px-2 py-1 text-white" /></label>
      <label className="text-gray-400">Username<input required value={form.username} onChange={(e) => setForm((v) => ({ ...v, username: e.target.value }))} className="block w-full bg-gray-900 border border-gray-700 px-2 py-1 text-white" /></label>
      <label className="text-gray-400">Password {connection && '(blank keeps existing only while address, account and TLS trust are unchanged)'}<input type="password" required={!connection} autoComplete="new-password" value={form.password} onChange={(e) => setForm((v) => ({ ...v, password: e.target.value }))} className="block w-full bg-gray-900 border border-gray-700 px-2 py-1 text-white" /></label>
      <label className="text-gray-400 sm:col-span-2">Private CA certificate (PEM; blank keeps existing)<textarea value={form.caCertificate} onChange={(e) => setForm((v) => ({ ...v, caCertificate: e.target.value }))} className="block w-full bg-gray-900 border border-gray-700 px-2 py-1 text-white" /></label>
      {connection?.has_ca_certificate && <label className="text-gray-400 sm:col-span-2"><input type="checkbox" checked={form.clearCaCertificate} onChange={(e) => setForm((v) => ({ ...v, clearCaCertificate: e.target.checked, caCertificate: e.target.checked ? '' : v.caCertificate }))} /> Remove the stored private CA certificate</label>}
      <label className="text-gray-400 sm:col-span-2"><input type="checkbox" checked={form.verifyTls} onChange={(e) => setForm((v) => ({ ...v, verifyTls: e.target.checked }))} /> Verify TLS certificate</label>
      {!form.verifyTls && <p role="alert" className="sm:col-span-2 border-l-2 border-yellow-500/40 pl-2 text-yellow-300">Break-glass only: without verification anyone on the management path can impersonate this iLO and receive its password. The server must also allow it explicitly.</p>}
      <button disabled={busy} className="border border-orange-500 px-3 py-2 text-orange-400 uppercase sm:col-span-2 disabled:opacity-50">{connection ? 'Save iLO changes' : 'Add iLO connection'}</button>
      {saved && <p role="status" className="sm:col-span-2 text-green-400">Saved. Run the read-only test to bring collection and control back.</p>}
    </form>}
    {configMode && connection && rebindTargets.filter((ref) => ref !== nodeRef).length > 0 && <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-gray-700/50 pt-3">
      <label className="text-gray-400">Rebind to node (renamed or moved; keeps hardware ID and history)
        <select value={rebindTo} onChange={(e) => setRebindTo(e.target.value)} className="block w-full bg-gray-900 border border-gray-700 px-2 py-1 text-white">
          <option value="">Select node…</option>
          {rebindTargets.filter((ref) => ref !== nodeRef).map((ref) => <option key={ref} value={ref}>{ref}</option>)}
        </select>
      </label>
      <button type="button" disabled={busy || !rebindTo} onClick={rebind} className="border border-gray-600 px-3 py-1 text-gray-200 hover:border-orange-400 disabled:opacity-50">Rebind</button>
    </div>}
  </div>;
}
