import { useCallback, useEffect, useState } from 'react';
import api from '../../api.js';
import useDocumentTitle from '../../hooks/useDocumentTitle.js';
import RecentReauthDialog from '../../components/account/RecentReauthDialog.jsx';

const card = 'bg-gray-900 border border-gray-800 rounded-2xl p-5';

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

export default function OperationsPage() {
  useDocumentTitle('Operations');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [reauth, setReauth] = useState(null);
  const [reauthBusy, setReauthBusy] = useState(false);
  const [reauthError, setReauthError] = useState('');

  const load = useCallback(() => {
    api.get('/admin/operations').then(({ data: result }) => { setData(result); setError(''); })
      .catch((err) => setError(err.response?.data?.error || 'Could not load operations'));
  }, []);
  useEffect(load, [load]);

  const act = async (key, request) => {
    setBusy(key); setError('');
    try { await request(); load(); }
    catch (err) {
      if (err.response?.data?.code === 'REAUTHENTICATION_REQUIRED') {
        setReauth({ key, request });
        setReauthError('');
      } else setError(err.response?.data?.error || 'Operation failed');
    }
    finally { setBusy(''); }
  };

  const confirmReauth = async (credentials) => {
    setReauthBusy(true);
    try {
      await api.post('/auth/reauthenticate', credentials);
      const pending = reauth;
      setReauth(null);
      await act(pending.key, pending.request);
      return true;
    } catch (err) { setReauthError(err.response?.data?.error || 'Identity confirmation failed'); return false; }
    finally { setReauthBusy(false); }
  };

  const cleanup = (operation) => {
    if (!window.confirm('Remove only this portal tracking record? This does not stop a Proxmox task or delete any VM, disk, or configuration.')) return;
    act(`cleanup-${operation.type}-${operation.id}`, () => api.delete(`/admin/operations/${operation.type}/${operation.id}`));
  };

  if (!data) return <div className="p-8 text-sm text-gray-400">{error || 'Loading operations…'}</div>;
  const actionable = data.operations.filter((operation) => operation.status === 'needs_review');

  return (
    <div className="p-6 lg:p-8 space-y-6">
      <RecentReauthDialog open={!!reauth} busy={reauthBusy} error={reauthError} onCancel={() => setReauth(null)} onConfirm={confirmReauth} />
      <div>
        <h1 className="aaris-display text-xl text-gray-100">Operations & Recovery</h1>
        <p className="text-sm text-gray-500 mt-1">Reconcile interrupted Proxmox jobs, verify backups, and monitor SQLite health.</p>
      </div>
      {error && <div className="border border-red-800 bg-red-950/30 text-red-300 rounded-xl px-4 py-3 text-sm">{error}</div>}

      <div className="grid md:grid-cols-3 gap-4">
        <section className={card}>
          <p className="text-xs uppercase tracking-wide text-gray-500">Database</p>
          <p className="text-2xl text-white mt-2">{formatBytes(data.database.databaseBytes)}</p>
          <p className="text-xs text-gray-500 mt-1">WAL {formatBytes(data.database.walBytes)} · {formatBytes(data.database.reclaimableBytes)} reclaimable · audit {data.database.retentionDays.audit}d · jobs {data.database.retentionDays.jobs}d</p>
          <button onClick={() => act('maintenance', () => api.post('/admin/operations/database-maintenance'))} disabled={!!busy} className="mt-4 px-3 py-2 rounded-lg bg-gray-800 hover:bg-gray-700 disabled:opacity-40 text-xs text-white">{busy === 'maintenance' ? 'Running…' : 'Run maintenance'}</button>
        </section>
        <section className={card}>
          <p className="text-xs uppercase tracking-wide text-gray-500">Encrypted backups</p>
          <p className={`text-lg mt-2 ${data.backups.enabled ? 'text-green-400' : 'text-yellow-400'}`}>{data.backups.enabled ? 'Enabled' : 'Not configured'}</p>
          <p className="text-xs text-gray-500 mt-1">{data.backups.latest ? `Last ${data.backups.latest.status} · ${formatBytes(data.backups.latest.size_bytes)}` : 'No backup run recorded'}</p>
          <button onClick={() => act('backup', () => api.post('/admin/operations/backups'))} disabled={!!busy || !data.backups.enabled} className="mt-4 px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-xs text-white">{busy === 'backup' ? 'Backing up…' : 'Back up & verify'}</button>
        </section>
        <section className={card}>
          <p className="text-xs uppercase tracking-wide text-gray-500">Encryption keyring</p>
          <p className="text-lg text-white mt-2">{data.encryption.currentKeyId}</p>
          <p className="text-xs text-gray-500 mt-1">{data.encryption.legacyKeyCount} legacy decryption key(s) configured</p>
          <p className="text-xs text-gray-500 mt-1">{data.encryptionRotation?.total || 0} value(s) awaiting rotation</p>
          {data.capabilities?.rotateEncryption && (data.encryptionRotation?.total || 0) > 0 && <button disabled={!!busy || data.encryptionRotation.undecryptable > 0} onClick={() => act('rotation', () => api.post('/admin/operations/encryption/rotate'))} className="mt-4 px-3 py-2 rounded-lg bg-gray-800 hover:bg-gray-700 disabled:opacity-40 text-xs text-white">{busy === 'rotation' ? 'Rotating…' : 'Rotate now'}</button>}
        </section>
      </div>

      <section className={card}>
        <div className="flex items-center justify-between gap-4 mb-4">
          <div><h2 className="text-sm font-semibold text-white">Needs attention</h2><p className="text-xs text-gray-500 mt-1">Always verify the VM in Proxmox before acknowledging an interrupted job.</p></div>
          <button onClick={load} className="text-xs text-blue-400 hover:text-blue-300">Refresh</button>
        </div>
        {actionable.length === 0 ? <p className="text-sm text-gray-500">No interrupted provisioning jobs need attention.</p> : (
          <div className="space-y-3">
            {actionable.map((operation) => (
              <div key={`${operation.type}-${operation.id}`} className="border border-gray-800 rounded-xl p-4 flex flex-wrap items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-sm text-white truncate">{operation.type} #{operation.id} · {operation.label || `${operation.node}/${operation.vmid}`}</p>
                  <p className="text-xs text-gray-500 mt-1">{operation.status} · {operation.detail || 'No detail'} · {operation.upid ? 'UPID saved' : 'manual verification required'}{operation.request_id ? ` · request ${operation.request_id}` : ''}</p>
                </div>
                <div className="flex gap-2">
                  {operation.upid && <button disabled={!!busy} onClick={() => act(`reconcile-${operation.type}-${operation.id}`, () => api.post(`/admin/operations/${operation.type}/${operation.id}/reconcile`))} className="px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-xs text-white">Check upstream</button>}
                  {operation.status === 'needs_review' && <>
                    <button disabled={!!busy} onClick={() => act(`ready-${operation.id}`, () => api.post(`/admin/operations/${operation.type}/${operation.id}/resolve`, { status: operation.type === 'migration' ? 'done' : 'ready' }))} className="px-3 py-2 rounded-lg bg-green-700 hover:bg-green-600 disabled:opacity-40 text-xs text-white">Verified ready</button>
                    <button disabled={!!busy} onClick={() => act(`error-${operation.id}`, () => api.post(`/admin/operations/${operation.type}/${operation.id}/resolve`, { status: 'error' }))} className="px-3 py-2 rounded-lg bg-red-900 hover:bg-red-800 disabled:opacity-40 text-xs text-white">Mark failed</button>
                  </>}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className={card}>
        <div className="mb-4"><h2 className="text-sm font-semibold text-white">Recent operation state</h2><p className="text-xs text-gray-500 mt-1">Local phase, last observed Proxmox state, actor/request correlation, and terminal tracking cleanup.</p></div>
        <div className="space-y-2">
          {data.operations.slice(0, 30).map((operation) => {
            const terminal = ['ready', 'done', 'error', 'failed', 'timeout'].includes(operation.status);
            return (
              <div key={`history-${operation.type}-${operation.id}`} className="border border-gray-800 rounded-xl px-4 py-3 flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm text-white truncate">{operation.type} #{operation.id} · {operation.label || `${operation.node}/${operation.vmid}`}</p>
                  <p className="text-xs text-gray-500 mt-1">local {operation.status}{operation.phase ? ` / ${operation.phase}` : ''} · upstream {operation.upstream_status || 'not checked'}{operation.upstream_checked_at ? ` at ${operation.upstream_checked_at}` : ''}</p>
                  <p className="text-[11px] text-gray-600 mt-1">actor {operation.actor_username || (operation.actor_user_id ? `#${operation.actor_user_id}` : 'system')}{operation.request_id ? ` · request ${operation.request_id}` : ''}</p>
                </div>
                {terminal && <button disabled={!!busy} onClick={() => cleanup(operation)} className="px-3 py-2 rounded-lg bg-gray-800 hover:bg-red-950 disabled:opacity-40 text-xs text-gray-300">Remove tracking only</button>}
              </div>
            );
          })}
          {data.operations.length === 0 && <p className="text-sm text-gray-500">No operation history recorded.</p>}
        </div>
      </section>
    </div>
  );
}
