import { useState, useEffect, useCallback } from 'react';
import api from '../../api.js';
import Modal from '../../components/Modal.jsx';
import LeaseBadge from '../../components/LeaseBadge.jsx';
import useDocumentTitle from '../../hooks/useDocumentTitle.js';
import { routeNode } from '../../utils/nodeRef.js';

const inputCls = 'w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 transition-colors';
const btnPrimary = 'font-mono text-xs font-semibold uppercase tracking-[0.12em] text-gray-950 bg-orange-600 hover:bg-orange-500 border border-orange-600 px-4 py-2 transition-colors disabled:opacity-50';
const btnGhost = 'font-mono text-xs uppercase tracking-[0.12em] text-gray-400 hover:text-gray-100 bg-transparent hover:bg-gray-800 border border-gray-700 px-3 py-1.5 transition-colors disabled:opacity-50';

function fmtDate(value) {
  if (!value) return '—';
  const ms = Date.parse(`${String(value).replace(' ', 'T')}${value.includes('T') ? '' : 'Z'}`);
  if (!Number.isFinite(ms)) return value;
  return new Date(ms).toLocaleString();
}

export default function LeasesPage() {
  useDocumentTitle('VM Leases');
  const [leases, setLeases] = useState([]);
  const [settings, setSettings] = useState({ defaultDays: 30, graceDays: 7 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [editRow, setEditRow] = useState(null);

  const [settingsForm, setSettingsForm] = useState({ defaultDays: 30, graceDays: 7 });

  const load = useCallback(async () => {
    try {
      const r = await api.get('/admin/leases');
      setLeases(r.data.leases || []);
      setSettings(r.data.settings || { defaultDays: 30, graceDays: 7 });
      setSettingsForm(r.data.settings || { defaultDays: 30, graceDays: 7 });
      setError('');
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to load leases');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const flash = (msg) => { setNotice(msg); setTimeout(() => setNotice(''), 4000); };

  const saveSettings = async (e) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const r = await api.put('/admin/lease-settings', {
        defaultDays: parseInt(settingsForm.defaultDays, 10) || 0,
        graceDays: parseInt(settingsForm.graceDays, 10) || 0,
      });
      setSettings(r.data);
      flash('Lease settings saved');
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to save settings');
    } finally { setBusy(false); }
  };

  const runSweep = async () => {
    setBusy(true); setError('');
    try {
      const r = await api.post('/admin/leases/sweep');
      flash(`Sweep complete — ${r.data.checked} checked, ${r.data.stopped} stopped`);
      load();
    } catch (e) {
      setError(e.response?.data?.error || 'Sweep failed');
    } finally { setBusy(false); }
  };

  const backfill = async () => {
    setBusy(true); setError('');
    try {
      const r = await api.post('/admin/leases/backfill');
      flash(`Backfill complete — ${r.data.created} lease(s) created`);
      load();
    } catch (e) {
      setError(e.response?.data?.error || 'Backfill failed');
    } finally { setBusy(false); }
  };

  const renew = async (row) => {
    setBusy(true); setError('');
    try {
      await api.post(`/admin/leases/${routeNode(row)}/${row.vmid}/renew`);
      flash(`Lease renewed for ${row.name}`);
      load();
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to renew');
    } finally { setBusy(false); }
  };

  const toggleExempt = async (row) => {
    setBusy(true); setError('');
    try {
      await api.put(`/admin/leases/${routeNode(row)}/${row.vmid}`, { exempt: !row.exempt });
      flash(`${row.name} ${row.exempt ? 'is now leased' : 'is now exempt'}`);
      load();
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to update');
    } finally { setBusy(false); }
  };

  const reclaimable = leases.filter(l => l.reclaimable);

  return (
    <div className="p-6 lg:p-8">
      {/* Header */}
      <div className="flex items-start justify-between mb-6 gap-4 flex-wrap">
        <div>
          <div className="flex items-baseline gap-3">
            <span className="font-mono text-xs font-semibold text-orange-600 tracking-[0.12em]">LEASES</span>
            <h1 className="aaris-display text-xl text-gray-100">VM Leases</h1>
          </div>
          <p className="text-sm text-gray-500 mt-1">
            Per-VM expiry. Expired VMs are gracefully stopped (never deleted) and, after the grace period, appear in the reclaimable list.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={runSweep} disabled={busy} className={btnGhost}>Run sweep now</button>
          <button onClick={backfill} disabled={busy} className={btnGhost}>Backfill missing</button>
        </div>
      </div>

      {error && <div className="bg-red-900/20 border border-red-800/50 rounded-xl p-4 text-red-400 text-sm mb-5">{error}</div>}
      {notice && <div className="bg-green-900/20 border border-green-800/50 rounded-xl p-4 text-green-400 text-sm mb-5">{notice}</div>}

      {/* Settings */}
      <form onSubmit={saveSettings} className="bg-gray-900 border border-gray-800 rounded-2xl p-5 mb-6 flex flex-wrap items-end gap-4">
        <div>
          <label className="block font-mono text-[10px] uppercase tracking-[0.12em] text-gray-500 mb-1.5">Default lease (days)</label>
          <input
            type="number" min="0" value={settingsForm.defaultDays}
            onChange={(e) => setSettingsForm(f => ({ ...f, defaultDays: e.target.value }))}
            className={`${inputCls} w-40`}
          />
          <p className="text-[10px] text-gray-600 mt-1">0 = unlimited (no expiry)</p>
        </div>
        <div>
          <label className="block font-mono text-[10px] uppercase tracking-[0.12em] text-gray-500 mb-1.5">Grace period (days)</label>
          <input
            type="number" min="0" value={settingsForm.graceDays}
            onChange={(e) => setSettingsForm(f => ({ ...f, graceDays: e.target.value }))}
            className={`${inputCls} w-40`}
          />
          <p className="text-[10px] text-gray-600 mt-1">After expiry, before reclaimable</p>
        </div>
        <button type="submit" disabled={busy} className={btnPrimary}>Save settings</button>
      </form>

      {/* Reclaimable */}
      {reclaimable.length > 0 && (
        <div className="bg-red-950/20 border border-red-900/40 rounded-2xl p-5 mb-6">
          <h2 className="aaris-display text-sm text-red-300 mb-1">Reclaimable ({reclaimable.length})</h2>
          <p className="text-xs text-gray-500 mb-3">Expired past the grace period — safe to reclaim (delete from the VM page) or renew if still needed.</p>
          <div className="space-y-2">
            {reclaimable.map(row => (
              <div key={`${row.nodeRef}-${row.vmid}`} className="flex items-center justify-between gap-3 bg-gray-900/60 border border-gray-800 rounded-lg px-3 py-2">
                <div className="min-w-0">
                  <span className="text-sm text-gray-200 font-medium truncate">{row.name}</span>
                  <span className="ml-2 font-mono text-[10px] uppercase tracking-[0.1em] text-gray-500">ID {row.vmid} / {row.node}{row.owner ? ` / ${row.owner}` : ''}</span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <LeaseBadge lease={row} />
                  <button onClick={() => renew(row)} disabled={busy} className={btnGhost}>Renew</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Table */}
      {loading ? (
        <div className="space-y-2">
          {[1, 2, 3].map(i => <div key={i} className="h-12 bg-gray-900 border border-gray-800 rounded-lg animate-pulse" />)}
        </div>
      ) : leases.length === 0 ? (
        <div className="text-center py-16 text-gray-500">
          <p className="text-gray-400 font-medium">No leases yet</p>
          <p className="text-sm text-gray-600 mt-1">Leases start at provisioning. Use “Backfill missing” to lease existing VMs.</p>
        </div>
      ) : (
        <div className="overflow-x-auto border border-gray-800 rounded-2xl">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-900/80 text-left font-mono text-[10px] uppercase tracking-[0.12em] text-gray-500">
                <th className="px-4 py-3">VM</th>
                <th className="px-4 py-3">Owner</th>
                <th className="px-4 py-3">Lease</th>
                <th className="px-4 py-3">Renewals</th>
                <th className="px-4 py-3">Expires</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {leases.map(row => (
                <tr key={`${row.nodeRef}-${row.vmid}`} className="hover:bg-gray-900/40">
                  <td className="px-4 py-3">
                    <div className="text-gray-200 font-medium">{row.name}</div>
                    <div className="font-mono text-[10px] uppercase tracking-[0.1em] text-gray-600">
                      ID {row.vmid} / {row.node}
                      {row.autoStopped && <span className="ml-1 text-red-400">· auto-stopped</span>}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-gray-400">{row.owner || <span className="text-gray-600">—</span>}</td>
                  <td className="px-4 py-3"><LeaseBadge lease={row} /></td>
                  <td className="px-4 py-3 text-gray-400 font-mono">{row.renewalCount}</td>
                  <td className="px-4 py-3 text-gray-400 text-xs">{row.exempt || !row.expiresAt ? '—' : fmtDate(row.expiresAt)}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-2">
                      <button onClick={() => renew(row)} disabled={busy} className={btnGhost}>Renew</button>
                      <button onClick={() => setEditRow(row)} disabled={busy} className={btnGhost}>Adjust</button>
                      <button onClick={() => toggleExempt(row)} disabled={busy} className={btnGhost}>
                        {row.exempt ? 'Un-exempt' : 'Exempt'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editRow && (
        <AdjustLeaseModal
          row={editRow}
          onClose={() => setEditRow(null)}
          onSaved={() => { setEditRow(null); load(); }}
          onError={setError}
        />
      )}
    </div>
  );
}

function AdjustLeaseModal({ row, onClose, onSaved, onError }) {
  const [leaseDays, setLeaseDays] = useState('');
  const [extendDays, setExtendDays] = useState('');
  const [exempt, setExempt] = useState(!!row.exempt);
  const [saving, setSaving] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    const body = { exempt };
    if (leaseDays !== '') body.leaseDays = parseInt(leaseDays, 10) || 0;
    if (extendDays !== '') body.extendDays = parseInt(extendDays, 10) || 0;
    try {
      await api.put(`/admin/leases/${routeNode(row)}/${row.vmid}`, body);
      onSaved();
    } catch (e) {
      onError(e.response?.data?.error || 'Failed to adjust lease');
      onClose();
    } finally { setSaving(false); }
  };

  return (
    <Modal title={`Adjust lease — ${row.name}`} onClose={saving ? () => {} : onClose} size="sm">
      <form onSubmit={submit} className="p-5 space-y-4">
        <label className="flex items-center gap-2.5 text-sm text-gray-300">
          <input type="checkbox" checked={exempt} onChange={(e) => setExempt(e.target.checked)} className="w-4 h-4" />
          Exempt from expiry (infra VM — never expires)
        </label>

        <div className={exempt ? 'opacity-40 pointer-events-none' : ''}>
          <label className="block font-mono text-[10px] uppercase tracking-[0.12em] text-gray-500 mb-1.5">Set new duration (days)</label>
          <input
            type="number" min="0" value={leaseDays} placeholder={`current: ${row.leaseDays || 'unlimited'}`}
            onChange={(e) => setLeaseDays(e.target.value)} className={inputCls}
          />
          <p className="text-[10px] text-gray-600 mt-1">Resets the clock from now. 0 = unlimited. Leave blank to keep.</p>
        </div>

        <div className={exempt ? 'opacity-40 pointer-events-none' : ''}>
          <label className="block font-mono text-[10px] uppercase tracking-[0.12em] text-gray-500 mb-1.5">Extend by (days)</label>
          <input
            type="number" value={extendDays} placeholder="e.g. 30"
            onChange={(e) => setExtendDays(e.target.value)} className={inputCls}
          />
          <p className="text-[10px] text-gray-600 mt-1">Adds days to the current expiry. Leave blank to skip.</p>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} disabled={saving} className={btnGhost}>Cancel</button>
          <button type="submit" disabled={saving} className={btnPrimary}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  );
}
