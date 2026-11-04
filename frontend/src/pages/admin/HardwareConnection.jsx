import { useEffect, useState } from 'react';
import api from '../../api.js';
import Field from '../../components/Field.jsx';
import HardwareTelemetryView from './HardwareTelemetryView.jsx';
import HardwarePowerPolicy from './HardwarePowerPolicy.jsx';
import { connectionNotices, connectionStatusText, connectionStatusTone, testFailureText, tlsTrustText, writePrivilegeText } from '../../utils/hardwareView.js';
import { useConfirm } from '../../contexts/FeedbackContext.jsx';

const blank = { host: '', port: 443, username: '', password: '', tlsMode: 'pinned', caCertificate: '', clearCaCertificate: false };
// iLOs almost always present a self-signed certificate, so pinning it is the default.
const tlsModeOf = (connection) => (connection.tls_fingerprint ? 'pinned' : connection.verify_tls ? 'ca' : 'insecure');
// Every node's Hardware section reloads when a connection moves between nodes.
const CHANGED_EVENT = 'hardware-connections-changed';
const NOTICE_CLASS = { warn: 'border-yellow-500/40 bg-yellow-500/5 text-yellow-300', error: 'border-red-500/40 bg-red-900/20 text-red-300', info: 'border-gray-700 bg-gray-800/40 text-gray-400' };
const STATUS_CLASS = { ok: 'text-green-400', info: 'text-gray-400', error: 'text-red-400' };
const STATUS_LED = { ok: 'aaris-led--ok', info: 'aaris-led--off', error: 'aaris-led--error' };
const HEADING = 'font-mono text-xs uppercase tracking-widest text-orange-400';
const BTN = 'shrink-0 border border-gray-700 px-3 py-1.5 text-xs font-medium text-gray-300 transition-colors hover:border-gray-600 hover:text-white disabled:cursor-not-allowed disabled:opacity-50';
const BTN_ACCENT = 'shrink-0 border border-orange-500/40 px-3 py-1.5 text-xs font-medium text-orange-400 transition-colors hover:bg-orange-500/10 disabled:cursor-not-allowed disabled:opacity-50';
const BTN_DANGER = 'shrink-0 border border-red-500/40 px-3 py-1.5 text-xs font-medium text-red-400 transition-colors hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-50';

function Detail({ label, children }) {
  return <div className="min-w-0"><dt className="text-[10px] uppercase tracking-wider text-gray-500">{label}</dt><dd className="mt-0.5 break-words text-sm text-gray-200">{children}</dd></div>;
}

// `mode="summary"` is the node row on PVE Hosts: status, read-only test,
// telemetry and power policy. `mode="config"` lives in the Edit Host dialog and
// owns the connection settings, rebind and decommission.
export default function HardwareConnection({ nodeRef, rebindTargets = [], mode = 'summary' }) {
  const confirm = useConfirm();
  const configMode = mode === 'config';
  const [connection, setConnection] = useState(null);
  const [form, setForm] = useState(blank);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [discovery, setDiscovery] = useState(null);
  const [rebindTo, setRebindTo] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [saved, setSaved] = useState(false);
  // Nothing about the connection is shown (e.g. "not configured") until the first load settles.
  const [loadState, setLoadState] = useState('loading');
  // Certificate the iLO presented on "Fetch certificate", and whether the admin confirmed it.
  const [probe, setProbe] = useState(null);
  const [pinConfirmed, setPinConfirmed] = useState(false);
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
      setConnection(found); setLoadState('ready');
      if (found) setForm({ host: found.target_host, port: found.target_port, username: found.username, password: '', tlsMode: tlsModeOf(found), caCertificate: '', clearCaCertificate: false });
      setProbe(null); setPinConfirmed(false);
    }).catch(() => { if (live) { setError('Could not load hardware connection'); setLoadState((state) => (state === 'ready' ? state : 'failed')); } });
    return () => { live = false; };
  }, [nodeRef, reloadKey]);
  async function save(e) {
    e.preventDefault(); setError(''); setSaved(false);
    const newPin = form.tlsMode === 'pinned' && probe && pinConfirmed ? probe.fingerprint256 : undefined;
    if (form.tlsMode === 'pinned' && !newPin && !connection?.tls_fingerprint) { setError('Fetch the iLO certificate and confirm it before saving.'); return; }
    setBusy(true);
    try {
      const payload = { ...form, tlsFingerprint: newPin, nodeRef, configVersion: connection?.config_version };
      const { data } = connection ? await api.put(`/admin/hardware-connections/${connection.id}`, payload) : await api.post('/admin/hardware-connections', payload);
      setConnection(data); setForm((v) => ({ ...v, password: '', caCertificate: '', clearCaCertificate: false })); setDiscovery(null);
      setSaved(true); window.dispatchEvent(new Event(CHANGED_EVENT));
    } catch (err) { setError(err.response?.data?.error || 'Could not save connection'); }
    finally { setBusy(false); }
  }
  async function fetchCertificate() {
    setBusy(true); setError(''); setProbe(null); setPinConfirmed(false);
    try {
      const { data } = await api.post('/admin/hardware-connections/certificate-probe', { host: form.host, port: form.port });
      setProbe(data);
    } catch (err) { setError(testFailureText(err.response?.data).replace('Connection test failed', 'Could not read the certificate')); }
    finally { setBusy(false); }
  }
  const setTarget = (patch) => { setForm((v) => ({ ...v, ...patch })); setProbe(null); setPinConfirmed(false); };
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
    if (!rebindTo || !await confirm(`Move this iLO binding from ${nodeRef} to ${rebindTo}? Collection and control will be disabled until it is tested again.`)) return;
    setBusy(true); setError('');
    try {
      await api.post(`/admin/hardware-connections/${connection.id}/rebind`, { nodeRef: rebindTo, configVersion: connection.config_version });
      setConnection(null); setDiscovery(null); setForm(blank); setRebindTo('');
      window.dispatchEvent(new Event(CHANGED_EVENT));
    } catch (err) { setError(err.response?.data?.error || 'Could not rebind connection'); }
    finally { setBusy(false); }
  }
  async function disconnect() {
    if (!await confirm({ message: `Decommission iLO binding for ${nodeRef}? Collection and control will stop.`, confirmLabel: 'Decommission', danger: true })) return;
    setBusy(true); setError('');
    try { await api.delete(`/admin/hardware-connections/${connection.id}`); setConnection(null); setDiscovery(null); setForm(blank); window.dispatchEvent(new Event(CHANGED_EVENT)); }
    catch (err) { setError(err.response?.data?.error || 'Could not disconnect'); }
    finally { setBusy(false); }
  }
  const ready = loadState === 'ready';
  const tone = connection ? connectionStatusTone(connection.last_status) : 'info';
  return <div className="mt-4 space-y-4 border-t border-gray-800 pt-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
        {!configMode && <h3 className={HEADING}>Hardware / iLO</h3>}
        {loadState === 'loading' && <span className="text-xs text-gray-500">Loading…</span>}
        {ready && (connection
          ? <span className="inline-flex items-center gap-2 text-sm"><span className={`aaris-led ${STATUS_LED[tone]}`} aria-hidden="true" /><span className={STATUS_CLASS[tone]}>{connectionStatusText(connection.last_status)}</span></span>
          : <span className="text-sm text-gray-400">not configured{configMode ? '' : ' — add it under Edit Host'}</span>)}
      </div>
      {ready && connection && <div className="flex flex-wrap items-center gap-2">
        <button type="button" disabled={busy} onClick={test} className={BTN_ACCENT}>Test read-only connection</button>
        {configMode && <button type="button" disabled={busy} onClick={disconnect} className={BTN_DANGER}>Decommission</button>}
      </div>}
    </div>
    {loadState === 'loading' && <div role="status" aria-label="Loading hardware connection" className="h-16 animate-pulse border border-gray-800 bg-gray-800/40" />}
    {error && <div role="alert" className="flex flex-wrap items-center justify-between gap-2 bg-red-900/20 p-2 text-xs text-red-400">
      <span>{error}</span>
      {loadState === 'failed' && <button type="button" onClick={() => { setError(''); setLoadState('loading'); setReloadKey((k) => k + 1); }} className={BTN}>Retry</button>}
    </div>}
    {ready && connection && <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">
      <Detail label="Model">{connection.model || 'unknown'}</Detail>
      <Detail label="Generation">{connection.generation || 'unknown'}</Detail>
      <Detail label="Firmware">{connection.firmware || 'unknown'}</Detail>
      <Detail label="Collection">{connection.collection_enabled ? 'enabled' : 'disabled'}</Detail>
      <Detail label="Control">{connection.control_enabled ? 'enabled' : 'disabled'}</Detail>
      <Detail label="Runtime capability">{connection.capabilities?.runtimeMode || 'unverified'}</Detail>
      <Detail label="Write privilege">{writePrivilegeText(connection.capabilities)}</Detail>
      <Detail label="TLS">{tlsTrustText(connection)}</Detail>
      {connection.last_test_at && <Detail label="Last test">{new Date(connection.last_test_at).toLocaleString()}</Detail>}
    </dl>}
    {ready && connectionNotices(connection).map((notice) => <p key={notice.text} className={`border-l-2 px-3 py-2 text-xs ${NOTICE_CLASS[notice.tone]}`}>{notice.text}</p>)}
    {discovery && <div className="border border-gray-800 bg-gray-800/40 p-3">
      <h4 className="mb-2 text-[10px] uppercase tracking-wider text-gray-500">Read-only test result</h4>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">
        <Detail label="Mode">{discovery.mode.value}</Detail>
        <Detail label="Actual input">{discovery.sample.watts == null ? 'unavailable' : `${discovery.sample.watts} W`}</Detail>
        <Detail label="Monitoring">{discovery.capabilities.monitoring}</Detail>
        <Detail label="Runtime mode">{discovery.capabilities.runtimeMode}</Detail>
        <Detail label="Temperatures">{discovery.capabilities.temperatures}</Detail>
        <Detail label="Fans">{discovery.capabilities.fans}</Detail>
        <Detail label="Power supplies">{discovery.capabilities.powerSupplies}</Detail>
      </dl>
    </div>}
    {!configMode && ready && connection && <HardwareTelemetryView connection={connection} onConnectionChange={setConnection} />}
    {!configMode && ready && connection && <HardwarePowerPolicy connection={connection} onConnectionChange={setConnection} />}
    {configMode && ready && <form onSubmit={save} className="grid gap-4 sm:grid-cols-2">
      <Field label="Management host"><input required value={form.host} onChange={(e) => setTarget({ host: e.target.value })} className="input" /></Field>
      <Field label="HTTPS port"><input required type="number" min="1" max="65535" value={form.port} onChange={(e) => setTarget({ port: Number(e.target.value) })} className="input" /></Field>
      <Field label="Username"><input required value={form.username} onChange={(e) => setForm((v) => ({ ...v, username: e.target.value }))} className="input" /></Field>
      <Field label="Password">
        <input type="password" required={!connection} autoComplete="new-password" aria-describedby={connection ? `ilo-pw-hint-${nodeRef}` : undefined} value={form.password} onChange={(e) => setForm((v) => ({ ...v, password: e.target.value }))} className="input" />
        {connection && <p id={`ilo-pw-hint-${nodeRef}`} className="mt-1.5 text-xs text-gray-500">Leave blank to keep the existing password, only while address, account and TLS trust are unchanged.</p>}
      </Field>
      <fieldset className="space-y-2 border border-gray-800 bg-gray-900/50 p-4 sm:col-span-2">
        <legend className="px-1 text-xs text-gray-400">Certificate trust</legend>
        {[['pinned', 'Pin this iLO’s certificate (recommended: iLOs use self-signed certificates)'], ['ca', 'Verify against a trusted or private CA'], ['insecure', 'No verification (break-glass; the server must allow it)']].map(([value, label]) => (
          <label key={value} className="flex items-start gap-2 py-0.5 text-sm text-gray-200"><input type="radio" name={`tls-${nodeRef}`} value={value} checked={form.tlsMode === value} onChange={() => setForm((v) => ({ ...v, tlsMode: value }))} className="mt-1 accent-orange-500" /> {label}</label>
        ))}
        {form.tlsMode === 'pinned' && <div className="space-y-3 pt-2">
          <p className="text-xs text-gray-500">Only the confirmed certificate is trusted. If the iLO ever presents a different one, every connection stops before the password is sent, until you confirm the new certificate here.</p>
          {connection?.tls_fingerprint && <p className="break-all font-mono text-xs text-gray-300">Pinned SHA-256: {connection.tls_fingerprint}</p>}
          <button type="button" disabled={busy || !form.host} onClick={fetchCertificate} className={BTN}>{connection?.tls_fingerprint ? 'Fetch current certificate' : 'Fetch certificate'}</button>
          {probe && <div className="space-y-2 border-l-2 border-orange-500/40 bg-gray-800/40 px-3 py-2 text-xs text-gray-300">
            <p>Subject {probe.subject || 'unknown'} · Issuer {probe.issuer || 'unknown'}{probe.selfSigned ? ' (self-signed)' : ''}{probe.validTo ? ` · Valid until ${probe.validTo}` : ''}</p>
            <p className="break-all font-mono">SHA-256 {probe.fingerprint256}</p>
            {connection?.tls_fingerprint === probe.fingerprint256
              ? <p className="text-green-400">Matches the pinned certificate.</p>
              : <label className="flex items-start gap-2 text-yellow-300"><input type="checkbox" checked={pinConfirmed} onChange={(e) => setPinConfirmed(e.target.checked)} className="mt-0.5 accent-orange-500" /> This is my iLO’s certificate. I compared the fingerprint with the iLO web interface (Security → SSL Certificate).</label>}
          </div>}
        </div>}
        {form.tlsMode === 'ca' && <div className="space-y-3 pt-2">
          <Field label="Private CA certificate (PEM; blank keeps existing or uses public CAs)"><textarea rows={5} value={form.caCertificate} onChange={(e) => setForm((v) => ({ ...v, caCertificate: e.target.value }))} className="input font-mono text-xs" /></Field>
          {connection?.has_ca_certificate && <label className="flex items-center gap-2 text-sm text-gray-300"><input type="checkbox" checked={form.clearCaCertificate} onChange={(e) => setForm((v) => ({ ...v, clearCaCertificate: e.target.checked, caCertificate: e.target.checked ? '' : v.caCertificate }))} className="accent-orange-500" /> Remove the stored private CA certificate</label>}
        </div>}
        {form.tlsMode === 'insecure' && <p role="alert" className="mt-2 border-l-2 border-yellow-500/40 bg-yellow-500/5 px-3 py-2 text-xs text-yellow-300">Break-glass only: without verification anyone on the management path can impersonate this iLO and receive its password. The server must also allow it explicitly. Pinning the certificate is safer and needs no server setting.</p>}
      </fieldset>
      <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
        <button disabled={busy} className="btn-primary px-4 py-2 text-sm font-medium">{connection ? 'Save iLO changes' : 'Add iLO connection'}</button>
        {saved && <p role="status" className="text-xs text-green-400">Saved. Run the read-only test to bring collection and control back.</p>}
      </div>
    </form>}
    {configMode && ready && connection && rebindTargets.filter((ref) => ref !== nodeRef).length > 0 && <div className="space-y-2 border-t border-gray-800 pt-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[14rem] flex-1">
          <Field label="Rebind to node">
            <select value={rebindTo} onChange={(e) => setRebindTo(e.target.value)} className="input">
              <option value="">Select node…</option>
              {rebindTargets.filter((ref) => ref !== nodeRef).map((ref) => <option key={ref} value={ref}>{ref}</option>)}
            </select>
          </Field>
        </div>
        <button type="button" disabled={busy || !rebindTo} onClick={rebind} className={`${BTN} py-2 text-sm`}>Rebind</button>
      </div>
      <p className="text-xs text-gray-500">Use when the node was renamed or moved. Keeps the hardware ID and history.</p>
    </div>}
  </div>;
}
