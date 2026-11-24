import { useState, useEffect, useCallback, useMemo } from 'react';
import api from '../../api.js';
import { useConfirm } from '../../contexts/FeedbackContext.jsx';

// ── Backups Section ─────────────────────────────────────────────────────────

const STORAGE_TYPE_LABELS = {
  pbs: 'PBS',
  dir: 'Directory',
  nfs: 'NFS',
  cifs: 'CIFS',
  btrfs: 'Btrfs',
  cephfs: 'CephFS',
  glusterfs: 'GlusterFS',
};

// Small bordered status tag with a square LED (AARIS §7.6/§10)
function BackupTag({ led, children, title }) {
  const ledColor = { ok: 'bg-green-400', warning: 'bg-yellow-400', error: 'bg-red-400', off: 'bg-gray-600' }[led] || 'bg-gray-600';
  return (
    <span title={title}
      className="inline-flex items-center gap-1.5 px-1.5 py-0.5 border border-gray-700/60 font-mono text-[10px] uppercase tracking-wider text-gray-400 whitespace-nowrap shrink-0">
      <span className={`w-1.5 h-1.5 shrink-0 ${ledColor}`} />
      {children}
    </span>
  );
}

export default function BackupsSection({ node, vmid }) {
  const confirm = useConfirm();
  const [backups, setBackups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [storages, setStorages] = useState([]);
  const [creating, setCreating] = useState(false);
  const [restoring, setRestoring] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [form, setForm] = useState({ storage: '', mode: 'snapshot', compress: 'zstd', notes: '' });
  const [restoreConfirm, setRestoreConfirm] = useState(null); // volid to confirm
  const [restoreStorage, setRestoreStorage] = useState('');
  const [browseBackup, setBrowseBackup] = useState(null); // { storage, volid }
  const [browseFiles, setBrowseFiles] = useState([]);
  const [browsePathStack, setBrowsePathStack] = useState([]); // [{filepath, label}]
  const [browseLoading, setBrowseLoading] = useState(false);
  const [browseError, setBrowseError] = useState('');
  const [collapsedGroups, setCollapsedGroups] = useState({});
  // The archive list is long and rarely the reason someone opens a VM, so the
  // section starts folded and only the summary line is shown until asked for.
  const [expanded, setExpanded] = useState(false);
  // Backup tasks tracked by the backend. Proxmox lists the archive it is still
  // writing, so without these a half-written dump looks like a finished backup.
  const [tasks, setTasks] = useState([]);
  const [dismissedTaskId, setDismissedTaskId] = useState(null);

  const loadBackups = useCallback(async () => {
    try {
      const r = await api.get(`/vms/${node}/${vmid}/backups`);
      setBackups(r.data);
    } catch { setBackups([]); }
    finally { setLoading(false); }
  }, [node, vmid]);

  const loadTasks = useCallback(async () => {
    try {
      const r = await api.get(`/vms/${node}/${vmid}/backup-tasks`);
      setTasks(r.data || []);
      return r.data || [];
    } catch { return []; }
  }, [node, vmid]);

  useEffect(() => { loadBackups(); }, [loadBackups]);

  // Picked up on mount too, so a dump that outlived the tab is still reported.
  useEffect(() => { loadTasks(); }, [loadTasks]);

  const latestTask = tasks[0] || null;
  const runningTask = tasks.find(t => t.status === 'running') || null;
  const runningTaskId = runningTask?.id ?? null;

  // Poll only while something is running; the row id is stable across polls, so
  // the interval isn't torn down and rebuilt on every tick.
  useEffect(() => {
    if (runningTaskId == null) return undefined;
    const timer = setInterval(async () => {
      const next = await loadTasks();
      // Finished: refresh the list so the archive loses its in-progress flag
      // and its real size and verification state show up.
      if (!next.some(t => t.status === 'running')) loadBackups();
    }, 5000);
    return () => clearInterval(timer);
  }, [runningTaskId, loadTasks, loadBackups]);

  useEffect(() => {
    api.get(`/vms/${node}/${vmid}/backup-storages`)
      .then(r => {
        setStorages(r.data);
        if (r.data.length > 0) setForm(f => (f.storage ? f : { ...f, storage: r.data[0].storage }));
      })
      .catch(() => {});
  }, [node, vmid]);

  // Group backups by the storage they live on, enriched with storage metadata
  const groups = useMemo(() => {
    const map = new Map();
    for (const b of backups) {
      const key = b.storage || 'unknown';
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(b);
    }
    return [...map.entries()]
      .map(([storage, items]) => {
        const meta = storages.find(s => s.storage === storage);
        return {
          storage,
          items,
          type: meta?.type || (items.some(i => /^pbs-/.test(i.format || '')) ? 'pbs' : undefined),
          total: meta?.total,
          used: meta?.used,
          size: items.reduce((sum, i) => sum + (i.size || 0), 0),
        };
      })
      .sort((a, b) => a.storage.localeCompare(b.storage));
  }, [backups, storages]);

  const totalSize = useMemo(
    () => backups.reduce((sum, b) => sum + (b.size || 0), 0),
    [backups],
  );

  const createBackup = async () => {
    setCreating(true); setError(''); setSuccess('');
    try {
      await api.post(`/vms/${node}/${vmid}/backup`, form);
      setShowForm(false);
      setDismissedTaskId(null);
      // No optimistic reload: the progress panel takes it from here and the
      // list is refreshed once the task actually finishes. Reloading at a fixed
      // delay is what used to render a half-written archive as a finished one.
      await Promise.all([loadTasks(), loadBackups()]);
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to create backup');
    } finally { setCreating(false); }
  };

  const restoreBackup = async (backup) => {
    setRestoring(backup.volid); setError(''); setSuccess('');
    try {
      await api.post(`/vms/${node}/${vmid}/restore`, {
        archive: backup.volid,
        ...(restoreStorage && { storage: restoreStorage }),
      });
      setSuccess('Restore started — the VM will be overwritten with the backup contents. This may take several minutes.');
      setRestoreConfirm(null);
      setRestoreStorage('');
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to restore backup');
    } finally { setRestoring(null); }
  };

  const deleteBackup = async (storage, volid) => {
    if (!await confirm({ message: 'Delete this backup? This cannot be undone.', confirmLabel: 'Delete', danger: true })) return;
    setDeleting(volid); setError('');
    try {
      await api.delete(`/vms/${node}/${vmid}/backups/${storage}/${volid}`);
      setBackups(b => b.filter(x => x.volid !== volid));
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to delete backup');
    } finally { setDeleting(null); }
  };

  const openFileBrowser = async (backup) => {
    setBrowseBackup(backup);
    setBrowsePathStack([]);
    setBrowseError('');
    await loadFiles(backup.storage, backup.volid, '/');
  };

  const loadFiles = async (storage, volid, filepath) => {
    setBrowseLoading(true); setBrowseError('');
    try {
      const r = await api.get(`/vms/${node}/${vmid}/backup-files/${storage}/${volid}`, {
        params: { filepath },
      });
      setBrowseFiles(Array.isArray(r.data) ? r.data : []);
    } catch (e) {
      setBrowseError(e.response?.data?.error || 'Failed to list files. File-level restore may not be supported for this backup format.');
      setBrowseFiles([]);
    } finally { setBrowseLoading(false); }
  };

  const navigateInto = async (item) => {
    const targetPath = item.filepath;
    setBrowsePathStack(prev => [...prev, { filepath: targetPath, label: item.text }]);
    await loadFiles(browseBackup.storage, browseBackup.volid, targetPath);
  };

  const navigateBack = async () => {
    const newStack = [...browsePathStack];
    newStack.pop();
    setBrowsePathStack(newStack);
    const parentPath = newStack.length > 0 ? newStack[newStack.length - 1].filepath : '/';
    await loadFiles(browseBackup.storage, browseBackup.volid, parentPath);
  };

  const navigateTo = async (index) => {
    if (index < 0) {
      setBrowsePathStack([]);
      await loadFiles(browseBackup.storage, browseBackup.volid, '/');
    } else {
      const newStack = browsePathStack.slice(0, index + 1);
      setBrowsePathStack(newStack);
      await loadFiles(browseBackup.storage, browseBackup.volid, newStack[newStack.length - 1].filepath);
    }
  };

  const downloadFile = (filepath) => {
    const params = new URLSearchParams({ filepath });
    window.open(`/api/vms/${node}/${vmid}/backup-download/${browseBackup.storage}/${browseBackup.volid}?${params}`, '_blank');
  };

  const fmtDate = (ts) => {
    if (!ts) return '—';
    return new Date(ts * 1000).toLocaleString();
  };

  const fmtSize = (bytes) => {
    if (!bytes) return '—';
    const gb = bytes / 1024 / 1024 / 1024;
    if (gb >= 1) return `${gb.toFixed(2)} GB`;
    const mb = bytes / 1024 / 1024;
    if (mb >= 1) return `${mb.toFixed(1)} MB`;
    const kb = bytes / 1024;
    return `${kb.toFixed(1)} KB`;
  };

  const selectStyle = "w-full bg-gray-800 border border-gray-700/50 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/20 transition-all";

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="aaris-display text-sm text-gray-100 min-w-0">
          <button
            onClick={() => setExpanded(v => !v)}
            aria-expanded={expanded}
            className="flex items-center gap-2 min-w-0 text-left hover:text-white transition-colors"
            title={expanded ? 'Hide backups' : 'Show backups'}
          >
            <svg className="w-4 h-4 text-gray-400 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5m8.25 3v6.75m0 0l-3-3m3 3l3-3M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z" /></svg>
            <span>Backups</span>
            {/* Folded away, the count is the only thing telling you whether it is
                worth opening — so it has to survive the fold. */}
            {!expanded && (
              <span className="text-xs text-gray-500 font-mono font-normal truncate">
                {loading
                  ? 'loading…'
                  : backups.length === 0
                    ? 'none'
                    : `${backups.length} · ${fmtSize(totalSize)}`}
              </span>
            )}
            <svg className={`w-3.5 h-3.5 text-gray-500 shrink-0 transition-transform ${expanded ? '' : '-rotate-90'}`} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" /></svg>
          </button>
        </h2>
        <button
          onClick={() => {
            // The form lives inside the fold, so asking for it has to open it.
            if (!expanded) { setExpanded(true); setShowForm(true); }
            else setShowForm(v => !v);
          }}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-medium ring-1 bg-blue-600/15 text-blue-400 hover:bg-blue-600/25 ring-blue-500/20 transition-all shrink-0"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" /></svg>
          New Backup
        </button>
      </div>

      {error && <p className="text-xs text-red-400 bg-red-900/20 rounded-lg p-2.5">{error}</p>}
      {success && <p className="text-xs text-green-400 bg-green-900/20 rounded-lg p-2.5">{success}</p>}

      {/* Running dump — survives a reload because the task is tracked server-side */}
      {runningTask && (
        <div className="bg-gray-900 border border-blue-800/40 rounded-2xl p-4">
          <div className="flex items-center gap-2.5">
            <span className="w-1.5 h-1.5 bg-blue-400 animate-pulse shrink-0" />
            <span className="aaris-display text-xs text-gray-100 uppercase tracking-wider">Backing up…</span>
            <span className="text-xs text-gray-500 font-mono truncate">
              {runningTask.storage ? `→ ${runningTask.storage}` : ''}
            </span>
            <div className="flex-1" />
            {runningTask.progress != null && (
              <span className="text-xs text-blue-300 font-mono shrink-0">{Math.round(runningTask.progress)}%</span>
            )}
          </div>

          {runningTask.progress != null ? (
            <div className="mt-2.5 h-1 bg-gray-800 overflow-hidden">
              <div className="h-full bg-blue-500 transition-[width] duration-500" style={{ width: `${runningTask.progress}%` }} />
            </div>
          ) : (
            // vzdump prints no percentage for LXC (rsync) or before the first
            // progress line — an indeterminate bar is honest, a 0% one is not.
            <div className="mt-2.5 h-1 bg-gray-800 overflow-hidden">
              <div className="h-full w-1/3 bg-blue-500/60 animate-pulse" />
            </div>
          )}

          <p className="text-xs text-gray-500 font-mono mt-2">
            {runningTask.progress_detail || 'Waiting for the first progress line from Proxmox…'}
          </p>
          <p className="text-[11px] text-gray-400 mt-1.5">
            Leave this VM alone until it finishes — powering it off, deleting it or migrating it now would leave the archive incomplete.
          </p>
        </div>
      )}

      {/* A dump that failed after it was submitted — previously this left a
          partial archive in the list with nothing to explain it */}
      {!runningTask && latestTask?.status === 'failed' && latestTask.id !== dismissedTaskId && (
        <div className="flex items-start gap-3 bg-red-900/20 border border-red-800/40 rounded-2xl p-4">
          <span className="w-1.5 h-1.5 bg-red-400 shrink-0 mt-1.5" />
          <div className="min-w-0 flex-1">
            <p className="text-xs text-red-300">
              The last backup failed{latestTask.storage ? ` on ${latestTask.storage}` : ''}. Any archive it left behind is incomplete — delete it before relying on this VM's backups.
            </p>
            {latestTask.status_detail && (
              <p className="text-xs text-red-400/70 font-mono mt-1 break-all">{latestTask.status_detail}</p>
            )}
          </div>
          <button
            onClick={() => setDismissedTaskId(latestTask.id)}
            className="text-red-400/60 hover:text-red-300 transition-colors shrink-0"
            title="Dismiss"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>
      )}

      {/* Create form */}
      {expanded && showForm && (
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs text-gray-500 mb-1.5 font-medium">Storage</label>
              <select value={form.storage} onChange={e => setForm(f => ({ ...f, storage: e.target.value }))} className={selectStyle}>
                {storages.map(s => <option key={s.storage} value={s.storage}>{s.storage}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1.5 font-medium">Mode</label>
              <select value={form.mode} onChange={e => setForm(f => ({ ...f, mode: e.target.value }))} className={selectStyle}>
                <option value="snapshot">Snapshot</option>
                <option value="suspend">Suspend</option>
                <option value="stop">Stop</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1.5 font-medium">Compression</label>
              <select value={form.compress} onChange={e => setForm(f => ({ ...f, compress: e.target.value }))} className={selectStyle}>
                <option value="zstd">ZSTD</option>
                <option value="lzo">LZO</option>
                <option value="gzip">GZIP</option>
                <option value="0">None</option>
              </select>
            </div>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1.5 font-medium">Notes (optional)</label>
            <input
              type="text" value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
              placeholder="Backup description..."
              className="w-full bg-gray-800 border border-gray-700/50 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/20 transition-all"
            />
          </div>
          <div className="flex items-center gap-3">
            <button onClick={createBackup} disabled={creating || !form.storage}
              className="text-xs px-5 py-2 btn-primary disabled:opacity-40 rounded-lg font-medium">
              {creating ? 'Starting...' : 'Start Backup'}
            </button>
            <button onClick={() => setShowForm(false)} className="text-xs px-4 py-2 text-gray-400 hover:text-white transition-colors">Cancel</button>
          </div>
        </div>
      )}

      {/* Restore confirmation modal */}
      {expanded && restoreConfirm && (
        <div className="bg-yellow-900/20 border border-yellow-800/50 rounded-2xl p-5 space-y-4">
          <div className="flex items-start gap-3">
            <svg className="w-5 h-5 text-yellow-400 shrink-0 mt-0.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" /></svg>
            <div className="flex-1">
              <h3 className="text-sm font-semibold text-yellow-300">Full VM Restore</h3>
              <p className="text-xs text-yellow-200/70 mt-1">
                This will <strong>overwrite the entire VM</strong> with the contents of this backup. The VM must be stopped. This action cannot be undone.
              </p>
              <p className="text-xs text-gray-400 font-mono mt-2">{restoreConfirm.volid?.split('/').pop()}</p>
              <div className="mt-3">
                <label className="block text-xs text-gray-500 mb-1.5 font-medium">Target Storage (optional — leave empty to use original)</label>
                <select value={restoreStorage} onChange={e => setRestoreStorage(e.target.value)} className={selectStyle}>
                  <option value="">Use original storage</option>
                  {storages.map(s => <option key={s.storage} value={s.storage}>{s.storage}</option>)}
                </select>
              </div>
              <div className="flex items-center gap-3 mt-4">
                <button
                  onClick={() => restoreBackup(restoreConfirm)}
                  disabled={restoring === restoreConfirm.volid}
                  className="text-xs px-5 py-2 bg-yellow-600 hover:bg-yellow-500 disabled:opacity-40 text-white rounded-lg font-medium transition-colors"
                >
                  {restoring === restoreConfirm.volid ? 'Restoring...' : 'Confirm Restore'}
                </button>
                <button onClick={() => { setRestoreConfirm(null); setRestoreStorage(''); }}
                  className="text-xs px-4 py-2 text-gray-400 hover:text-white transition-colors">
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* File browser modal */}
      {expanded && browseBackup && (
        <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
          <div className="flex items-center justify-between px-5 py-3 border-b border-gray-800">
            <div>
              <h3 className="aaris-display text-sm text-gray-100 flex items-center gap-2">
                <svg className="w-4 h-4 text-cyan-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" /></svg>
                File Browser
              </h3>
              <p className="text-xs text-gray-500 font-mono mt-0.5">{browseBackup.volid?.split('/').pop()}</p>
            </div>
            <button onClick={() => { setBrowseBackup(null); setBrowseFiles([]); setBrowsePathStack([]); }}
              className="text-gray-500 hover:text-white p-1.5 rounded-lg hover:bg-gray-800 transition-colors">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          </div>

          {/* Breadcrumb */}
          <div className="px-5 py-2 border-b border-gray-800/50 flex items-center gap-1 flex-wrap">
            <button onClick={() => navigateTo(-1)}
              className={`text-xs transition-colors font-mono ${browsePathStack.length > 0 ? 'text-blue-400 hover:text-blue-300' : 'text-white'}`}>
              {browsePathStack.length === 0 ? 'Volumes' : 'Volumes'}
            </button>
            {browsePathStack.map((entry, i) => (
              <span key={i} className="flex items-center gap-1">
                <span className="text-gray-600 text-xs">/</span>
                <button onClick={() => navigateTo(i)}
                  className={`text-xs transition-colors font-mono ${i < browsePathStack.length - 1 ? 'text-blue-400 hover:text-blue-300' : 'text-white'}`}>
                  {entry.label}
                </button>
              </span>
            ))}
          </div>

          {browseError && <p className="text-xs text-red-400 bg-red-900/20 p-3 mx-5 my-3 rounded-lg">{browseError}</p>}

          {browseLoading ? (
            <div className="p-6 space-y-2">
              {[1,2,3].map(i => <div key={i} className="h-8 bg-gray-800 rounded animate-pulse" />)}
            </div>
          ) : (
            <div className="divide-y divide-gray-800/50 max-h-80 overflow-y-auto">
              {browsePathStack.length > 0 && (
                <button onClick={navigateBack}
                  className="w-full flex items-center gap-3 px-5 py-2.5 hover:bg-gray-800/30 transition-colors text-left">
                  <svg className="w-4 h-4 text-gray-500" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" /></svg>
                  <span className="text-xs text-gray-400 font-mono">..</span>
                </button>
              )}
              {browseFiles.map(f => {
                const isNavigable = f.type === 'd' || f.type === 'v' || f.leaf === 0;
                const isFile = f.type === 'f' || f.leaf === 1;
                const displayName = f.text || f.filepath;
                return (
                  <div key={f.filepath || f.text} className="flex items-center justify-between px-5 py-2.5 hover:bg-gray-800/30 transition-colors">
                    <button
                      onClick={() => isNavigable ? navigateInto(f) : null}
                      className={`flex items-center gap-3 min-w-0 flex-1 text-left ${isNavigable ? 'cursor-pointer' : 'cursor-default'}`}
                    >
                      {f.type === 'v' ? (
                        <svg className="w-4 h-4 text-blue-400 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 0v3.75m-16.5-3.75v3.75m16.5 0v3.75C20.25 16.153 16.556 18 12 18s-8.25-1.847-8.25-4.125v-3.75m16.5 0c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125" /></svg>
                      ) : isNavigable ? (
                        <svg className="w-4 h-4 text-yellow-400 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" /></svg>
                      ) : (
                        <svg className="w-4 h-4 text-gray-500 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" /></svg>
                      )}
                      <span className="text-xs text-white font-mono truncate">{displayName}</span>
                      {f.type === 'v' && <span className="text-xs text-gray-400 italic ml-1">volume</span>}
                    </button>
                    <div className="flex items-center gap-3 shrink-0 ml-3">
                      {f.size != null && <span className="text-xs text-gray-500">{fmtSize(f.size)}</span>}
                      {f.type !== 'v' && (
                        <button
                          onClick={() => downloadFile(f.filepath)}
                          className="text-gray-500 hover:text-cyan-400 transition-colors p-1.5 rounded-lg hover:bg-cyan-900/20"
                          title={isNavigable ? 'Download as archive' : 'Download file'}
                        >
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" /></svg>
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
              {browseFiles.length === 0 && !browseError && (
                <div className="p-6 text-center text-xs text-gray-500">No files found in this directory</div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Backups grouped by storage location */}
      {expanded && (loading ? (
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 space-y-3">
          {[1,2].map(i => <div key={i} className="h-10 bg-gray-800 rounded-lg animate-pulse" />)}
        </div>
      ) : backups.length === 0 ? (
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-8 text-center">
          <svg className="w-8 h-8 text-gray-700 mx-auto mb-2" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5m8.25 3v6.75m0 0l-3-3m3 3l3-3M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z" /></svg>
          <p className="text-sm text-gray-500">No backups found</p>
        </div>
      ) : (
        <div className="space-y-3">
          {groups.map(g => {
            const isCollapsed = !!collapsedGroups[g.storage];
            const usedPct = g.total > 0 && g.used != null ? Math.round((g.used / g.total) * 100) : null;
            const isPbs = g.type === 'pbs';
            return (
              <div key={g.storage} className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
                {/* Storage group header */}
                <button
                  onClick={() => setCollapsedGroups(c => ({ ...c, [g.storage]: !c[g.storage] }))}
                  className="w-full flex items-center justify-between gap-3 px-5 py-3 hover:bg-gray-800/30 transition-colors text-left"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <svg className="w-4 h-4 text-blue-400 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 0v3.75m-16.5-3.75v3.75m16.5 0v3.75C20.25 16.153 16.556 18 12 18s-8.25-1.847-8.25-4.125v-3.75m16.5 0c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125" /></svg>
                    <span className="text-sm text-white font-mono truncate">{g.storage}</span>
                    <span
                      className="px-1.5 py-0.5 border border-gray-700/60 font-mono text-[10px] uppercase tracking-wider text-gray-500 shrink-0"
                      title={isPbs ? 'Proxmox Backup Server' : `Storage type: ${g.type || 'unknown'}`}
                    >
                      {STORAGE_TYPE_LABELS[g.type] || g.type || 'storage'}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className="text-xs text-gray-500 font-mono">
                      {g.items.length} {g.items.length === 1 ? 'backup' : 'backups'} · {fmtSize(g.size)}
                    </span>
                    {usedPct != null && (
                      <span className={`hidden sm:inline text-xs font-mono ${usedPct >= 85 ? 'text-yellow-400' : 'text-gray-400'}`} title={`${fmtSize(g.used)} of ${fmtSize(g.total)} used on this storage`}>
                        {usedPct}% full
                      </span>
                    )}
                    <svg className={`w-3.5 h-3.5 text-gray-500 transition-transform ${isCollapsed ? '-rotate-90' : ''}`} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" /></svg>
                  </div>
                </button>

                {!isCollapsed && (
                  <div className="divide-y divide-gray-800 border-t border-gray-800">
                    {g.items.map(b => {
                      // PVE reports `encrypted` as 1, a key fingerprint, or a crypt-mode string
                      const isEncrypted = b.encrypted === 1 || b.encrypted === true ||
                        (typeof b.encrypted === 'string' && b.encrypted !== '' && b.encrypted !== '0' && b.encrypted !== 'none' && b.encrypted !== 'sign-only');
                      const isProtected = b.protected === 1 || b.protected === '1' || b.protected === true;
                      const verifyState = b.verification?.state;
                      // Flagged by the backend while a vzdump task is writing
                      // this archive. Its size, encryption and verification
                      // state are all meaningless until the dump finishes.
                      const isWriting = b.inProgress === true;
                      return (
                      <div key={b.volid} className="px-5 py-3.5 hover:bg-gray-800/30 transition-colors">
                        <div className="flex items-center justify-between">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <svg className="w-4 h-4 text-blue-400 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5M10 11.25h4M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z" /></svg>
                              <span className={`text-sm font-mono truncate ${isWriting ? 'text-gray-400' : 'text-white'}`} title={b.volid}>{b.volid?.split('/').pop() || b.volid}</span>
                              {isWriting && (
                                <span title="Proxmox is still writing this archive — it is not a usable backup yet"
                                  className="inline-flex items-center gap-1.5 px-1.5 py-0.5 border border-blue-800/50 font-mono text-[10px] uppercase tracking-wider text-blue-300 whitespace-nowrap shrink-0">
                                  <span className="w-1.5 h-1.5 shrink-0 bg-blue-400 animate-pulse" />
                                  Backing up
                                </span>
                              )}
                              {/* Every tag below describes the finished archive, so they stay
                                  hidden until there is a finished archive to describe. */}
                              {!isWriting && isPbs && (isEncrypted
                                ? <BackupTag led="ok" title="This backup is encrypted on the backup server">Encrypted</BackupTag>
                                : <BackupTag led="off" title="This backup is stored unencrypted">Not encrypted</BackupTag>
                              )}
                              {!isWriting && isPbs && (verifyState === 'ok'
                                ? <BackupTag led="ok" title="Last PBS verification passed">Verified</BackupTag>
                                : verifyState === 'failed'
                                  ? <BackupTag led="error" title="Last PBS verification FAILED — this backup may be corrupt">Verify failed</BackupTag>
                                  : <BackupTag led="off" title="This backup has not been verified yet">Not verified</BackupTag>
                              )}
                              {!isWriting && isProtected && <BackupTag led="warning" title="Protected — cannot be pruned or deleted until protection is removed">Protected</BackupTag>}
                            </div>
                            <div className="flex items-center gap-4 mt-1 ml-[24px]">
                              <span className="text-xs text-gray-500">{fmtDate(b.ctime)}</span>
                              {isWriting
                                ? <span className="text-xs text-gray-400 italic">size not final</span>
                                : <span className="text-xs text-gray-500">{fmtSize(b.size)}</span>}
                              {b.format && <span className="text-xs text-gray-400 font-mono">{b.format}</span>}
                              {b.notes && <span className="text-xs text-gray-500 italic truncate" title={b.notes}>{b.notes}</span>}
                            </div>
                          </div>
                          {/* Nothing destructive or read-through is offered while the
                              archive is being written: it is incomplete, and on a
                              failed dump it is about to be garbage. */}
                          <div className="flex items-center gap-1 shrink-0 ml-3">
                            {/* Browse files */}
                            <button
                              onClick={() => openFileBrowser(b)}
                              disabled={isWriting}
                              className="text-gray-600 hover:text-cyan-400 transition-colors p-2 rounded-lg hover:bg-cyan-900/20 disabled:opacity-30 disabled:hover:text-gray-600 disabled:hover:bg-transparent disabled:cursor-not-allowed"
                              title={isWriting ? 'Available once the backup finishes' : 'Browse files (file-level restore)'}
                            >
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" /></svg>
                            </button>
                            {/* Restore */}
                            <button
                              onClick={() => setRestoreConfirm(b)}
                              disabled={restoring === b.volid || isWriting}
                              className="text-gray-600 hover:text-yellow-400 transition-colors p-2 rounded-lg hover:bg-yellow-900/20 disabled:opacity-30 disabled:hover:text-gray-600 disabled:hover:bg-transparent disabled:cursor-not-allowed"
                              title={isWriting ? 'Available once the backup finishes' : 'Full VM restore'}
                            >
                              {restoring === b.volid ? (
                                <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
                              ) : (
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182" /></svg>
                              )}
                            </button>
                            {/* Delete */}
                            <button
                              onClick={() => deleteBackup(b.storage, b.volid)}
                              disabled={deleting === b.volid || isWriting}
                              className="text-gray-600 hover:text-red-400 transition-colors p-2 rounded-lg hover:bg-red-900/20 disabled:opacity-30 disabled:hover:text-gray-600 disabled:hover:bg-transparent disabled:cursor-not-allowed"
                              title={isWriting ? 'Cancel the backup in Proxmox first — deleting the archive under a running dump leaves the task writing to nothing' : 'Delete backup'}
                            >
                              {deleting === b.volid ? (
                                <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
                              ) : (
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" /></svg>
                              )}
                            </button>
                          </div>
                        </div>
                      </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
