import { Fragment, useState, useEffect, useRef } from 'react';
import api from '../../api.js';
import StatusBadge from '../../components/StatusBadge.jsx';
import MigrateVMModal from '../../components/MigrateVMModal.jsx';
import useDocumentTitle from '../../hooks/useDocumentTitle.js';
import { displayNode, routeNode, vmIdentityKey } from '../../utils/nodeRef.js';
import { useAuth } from '../../contexts/AuthContext.jsx';

function formatDuration(ms) {
  if (!ms || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem ? `${m}m ${rem}s` : `${m}m`;
}

function formatWhen(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString();
}

// ─── PVE tag auto-sync status card ─────────────────────────────────────────────

function TagSyncCard() {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);       // pause/resume/interval in flight
  const [syncing, setSyncing] = useState(false);  // manual force-sync in flight
  const [intervalDraft, setIntervalDraft] = useState('');
  const [showFailures, setShowFailures] = useState(false);
  const [msg, setMsg] = useState({ text: '', kind: 'info' });
  const pollRef = useRef(null);

  const note = (text, kind = 'info') => setMsg({ text, kind });

  const loadStatus = async () => {
    try {
      const { data } = await api.get('/admin/tag-sync/status');
      setStatus(data);
      setIntervalDraft((prev) => (prev === '' ? String(data.intervalHours ?? '') : prev));
      return data;
    } catch (e) {
      note(e.response?.data?.error || 'Failed to load tag-sync status', 'error');
      return null;
    }
  };

  useEffect(() => { loadStatus(); /* eslint-disable-next-line */ }, []);

  // Poll live while a run is in flight (manual or scheduled), then stop.
  useEffect(() => {
    if (status?.running && !pollRef.current) {
      pollRef.current = setInterval(loadStatus, 2000);
    } else if (!status?.running && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    // eslint-disable-next-line
  }, [status?.running]);

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  const togglePause = async () => {
    if (!status) return;
    setBusy(true);
    try {
      const path = status.paused ? '/admin/tag-sync/resume' : '/admin/tag-sync/pause';
      const { data } = await api.post(path);
      setStatus(data);
      note(status.paused ? 'Auto-sync resumed' : 'Auto-sync paused', 'success');
    } catch (e) {
      note(e.response?.data?.error || 'Failed to update auto-sync', 'error');
    } finally {
      setBusy(false);
    }
  };

  const saveInterval = async () => {
    const hours = Number(intervalDraft);
    if (!Number.isFinite(hours) || hours <= 0) {
      note('Interval must be a positive number of hours', 'error');
      return;
    }
    setBusy(true);
    try {
      const { data } = await api.post('/admin/tag-sync/interval', { intervalHours: hours });
      setStatus(data);
      note(`Interval set to ${hours}h`, 'success');
    } catch (e) {
      note(e.response?.data?.error || 'Failed to set interval', 'error');
    } finally {
      setBusy(false);
    }
  };

  const syncNow = async () => {
    setSyncing(true);
    note('', 'info');
    // Kick off polling immediately so progress shows while the request runs.
    if (!pollRef.current) pollRef.current = setInterval(loadStatus, 2000);
    try {
      const { data } = await api.post('/admin/sync-vm-tags');
      note(`${data.checked} checked · ${data.updated} retagged${data.failed ? ` · ${data.failed} failed` : ''}`, data.failed ? 'warning' : 'success');
    } catch (e) {
      if (e.response?.status === 409) {
        note('A tag sync is already running', 'warning');
      } else {
        note(e.response?.data?.error || 'Tag sync failed', 'error');
      }
    } finally {
      setSyncing(false);
      loadStatus();
    }
  };

  if (!status) {
    return <div className="h-24 bg-gray-900 border border-gray-800 rounded-xl animate-pulse mb-6" />;
  }

  const { running, paused, progress, lastRun: last } = status;

  const ledClass = running
    ? 'bg-orange-500 animate-pulse'
    : paused ? 'bg-yellow-500' : 'bg-green-500';
  const stateLabel = running ? 'Running' : paused ? 'Paused' : 'Armed';
  const stateColor = running ? 'text-orange-400' : paused ? 'text-yellow-500' : 'text-green-400';
  const msgColor = msg.kind === 'error' ? 'text-red-400'
    : msg.kind === 'warning' ? 'text-yellow-500'
    : msg.kind === 'success' ? 'text-green-400' : 'text-gray-500';

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 mb-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className={`inline-block w-2 h-2 rounded-sm ${ledClass}`} aria-hidden="true" />
            <h2 className="font-mono text-[11px] uppercase tracking-[0.12em] text-gray-300">
              PVE Tag Auto-Sync
            </h2>
            <span className={`font-mono text-[10px] uppercase tracking-[0.1em] ${stateColor}`}>{stateLabel}</span>
          </div>
          <p className="text-xs text-gray-500 mt-1">
            {paused
              ? <>Paused{status.pausedBy ? <> by <span className="text-gray-400">{status.pausedBy}</span></> : ''}{status.pausedAt ? <> · {formatWhen(status.pausedAt)}</> : ''} — scheduled runs are held.</>
              : <>Runs automatically every <span className="text-gray-400 font-mono">{status.intervalHours}h</span> and corrects owner/VLAN tag drift.</>
            }
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {msg.text && (
            <span className={`text-xs font-mono ${msgColor}`}>{msg.text}</span>
          )}
          <button
            onClick={togglePause}
            disabled={busy}
            className={`text-xs font-mono uppercase tracking-[0.08em] disabled:opacity-40 px-3 py-2 rounded-lg transition-colors bg-gray-800 hover:bg-gray-700 ${
              paused ? 'text-green-400 hover:text-green-300' : 'text-yellow-500 hover:text-yellow-400'
            }`}
          >
            {paused ? 'Resume' : 'Pause'}
          </button>
          <button
            onClick={syncNow}
            disabled={syncing || running}
            title="Walk every VM and re-stamp owner + VLAN tags now"
            className="text-xs font-mono uppercase tracking-[0.08em] text-orange-400 hover:text-orange-300 bg-gray-800 hover:bg-gray-700 disabled:opacity-40 px-3 py-2 rounded-lg transition-colors"
          >
            {running ? `Syncing ${progress ? `${progress.checked}/${progress.total}` : ''}…` : 'Sync now'}
          </button>
        </div>
      </div>

      {/* Live progress while running */}
      {running && progress && (
        <div className="mt-3">
          <div className="h-1.5 bg-gray-800 rounded overflow-hidden">
            <div
              className="h-full bg-orange-500 transition-all"
              style={{ width: `${progress.total ? Math.round((progress.checked / progress.total) * 100) : 0}%` }}
            />
          </div>
          <p className="text-[11px] font-mono text-gray-500 mt-1">
            {progress.checked}/{progress.total} checked · {progress.updated} updated · {progress.failed} failed
            {progress.trigger === 'scheduled' ? ' · scheduled' : ''}
          </p>
        </div>
      )}

      {/* Interval + last run */}
      <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className="block text-[10px] font-mono uppercase tracking-[0.1em] text-gray-600 mb-1">
            Interval (hours)
          </label>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min="1"
              step="1"
              value={intervalDraft}
              onChange={(e) => setIntervalDraft(e.target.value)}
              className="w-24 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:border-orange-500 transition-colors"
            />
            <button
              onClick={saveInterval}
              disabled={busy || String(status.intervalHours) === String(intervalDraft)}
              className="text-xs font-mono uppercase tracking-[0.08em] text-gray-400 hover:text-white bg-gray-800 hover:bg-gray-700 disabled:opacity-40 px-3 py-1.5 rounded-lg transition-colors"
            >
              Save
            </button>
          </div>
        </div>

        <div>
          <div className="text-[10px] font-mono uppercase tracking-[0.1em] text-gray-600 mb-1">Last run</div>
          {last ? (
            <div className="text-xs text-gray-400 font-mono">
              {formatWhen(last.time)} · {formatDuration(last.durationMs)}
              <span className="text-gray-600"> · {last.trigger}</span>
              <div className="mt-0.5">
                <span className="text-gray-300">{last.checked}</span> checked ·{' '}
                <span className="text-blue-400">{last.updated}</span> updated ·{' '}
                <span className={last.failed ? 'text-red-400' : 'text-gray-300'}>{last.failed}</span> failed
                {last.failures?.length > 0 && (
                  <button
                    onClick={() => setShowFailures((v) => !v)}
                    className="ml-2 text-red-400 hover:text-red-300 underline decoration-dotted"
                  >
                    {showFailures ? 'hide' : 'show'} failures
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div className="text-xs text-gray-600 font-mono italic">No run recorded yet</div>
          )}
        </div>
      </div>

      {/* Per-VM failures */}
      {showFailures && last?.failures?.length > 0 && (
        <div className="mt-3 border border-gray-800 rounded-lg overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-gray-800 text-gray-600 uppercase tracking-wider">
                <th className="text-left px-3 py-1.5 font-mono">Node / VMID</th>
                <th className="text-left px-3 py-1.5 font-mono">Name</th>
                <th className="text-left px-3 py-1.5 font-mono">Error</th>
              </tr>
            </thead>
            <tbody>
              {last.failures.map((f, i) => (
                <tr key={`${f.node}-${f.vmid}-${i}`} className="border-b border-gray-800 last:border-0">
                  <td className="px-3 py-1.5 font-mono text-gray-500 whitespace-nowrap">{displayNode(f.node)} / {f.vmid}</td>
                  <td className="px-3 py-1.5 text-gray-400">{f.name || '—'}</td>
                  <td className="px-3 py-1.5 text-red-400">{f.error}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function AssignmentsPage() {
  useDocumentTitle('Assignments');
  const { user } = useAuth();
  const [vms, setVms]       = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState('');
  const [claiming, setClaiming] = useState(false);
  const [claimMsg, setClaimMsg] = useState('');
  const [migrateVm, setMigrateVm] = useState(null);
  const [migrations, setMigrations] = useState([]);
  const [hostCount, setHostCount] = useState(0);
  const migrationPollRef = useRef(null);

  const load = async () => {
    try {
      const r = await api.get('/admin/vms');
      setVms(r.data);
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to load');
    } finally {
      setLoading(false);
    }
  };

  // Cross-host migrations run in the background — keep a banner alive while
  // any are running, even after the modal is closed. Admin-only endpoint.
  const loadMigrations = async () => {
    if (!user?.isAdmin) return;
    try {
      const { data } = await api.get('/migrate');
      setMigrations(data);
      const anyRunning = data.some((m) => m.status === 'running');
      if (anyRunning && !migrationPollRef.current) {
        migrationPollRef.current = setInterval(async () => {
          try {
            const r = await api.get('/migrate');
            setMigrations(r.data);
            if (!r.data.some((m) => m.status === 'running')) {
              clearInterval(migrationPollRef.current);
              migrationPollRef.current = null;
              load();
            }
          } catch { /* keep polling */ }
        }, 5000);
      }
    } catch { /* non-admin or endpoint unavailable */ }
  };

  useEffect(() => {
    load();
    loadMigrations();
    // Migration needs a second REGISTERED host — counting hosts that have VMs
    // would hide the button exactly when the target host is still empty.
    if (user?.isAdmin) {
      api.get('/admin/pve-hosts').then((r) => setHostCount(r.data.length)).catch(() => {});
    }
    return () => clearInterval(migrationPollRef.current);
  }, []);

  const unassign = async (assignment) => {
    if (!confirm('Remove this VM assignment?')) return;
    try {
      await api.delete(`/admin/assignments/${assignment.id}`);
      load();
    } catch (e) {
      alert(e.response?.data?.error || 'Failed');
    }
  };

  const claim = async (vm) => {
    setClaiming(true);
    setClaimMsg('');
    try {
      await api.post('/admin/assignments', { userId: user.id, node: routeNode(vm), vmid: vm.vmid });
      await load();
    } catch (e) {
      alert(e.response?.data?.error || 'Failed to claim VM');
    } finally {
      setClaiming(false);
    }
  };

  const claimAllUnassigned = async () => {
    const targets = vms.filter(v => !v.assignment);
    if (targets.length === 0) return;
    if (!confirm(`Assign all ${targets.length} unassigned VMs to ${user.username}?`)) return;
    setClaiming(true);
    let ok = 0;
    let failed = 0;
    for (const [i, vm] of targets.entries()) {
      setClaimMsg(`Claiming ${i + 1}/${targets.length}…`);
      try {
        await api.post('/admin/assignments', { userId: user.id, node: routeNode(vm), vmid: vm.vmid });
        ok += 1;
      } catch {
        failed += 1;
      }
    }
    setClaimMsg(failed ? `${ok} claimed, ${failed} failed` : `${ok} claimed`);
    setClaiming(false);
    load();
  };

  const assigned   = vms.filter(v => v.assignment);
  const unassigned = vms.filter(v => !v.assignment);
  // Migration only makes sense with 2+ registered hosts
  const multiHost = hostCount > 1 || new Set(vms.map(v => v.hostId).filter(Boolean)).size > 1;
  const visibleMigrations = migrations.filter(m =>
    m.status === 'running' || (m.finished_at && Date.now() - new Date(m.finished_at.replace(' ', 'T') + 'Z').getTime() < 60 * 60 * 1000)
  );

  // Unassigned first, then one group per user (alphabetical), VMs by VMID
  const byVmid = (a, b) => (a.vmid ?? 0) - (b.vmid ?? 0);
  const groups = [];
  if (unassigned.length > 0) {
    groups.push({ label: 'Unassigned', count: unassigned.length, vms: [...unassigned].sort(byVmid), unassigned: true });
  }
  const byUser = new Map();
  for (const vm of assigned) {
    const name = vm.assignment.username;
    if (!byUser.has(name)) byUser.set(name, []);
    byUser.get(name).push(vm);
  }
  for (const name of [...byUser.keys()].sort((a, b) => a.localeCompare(b))) {
    const list = byUser.get(name).sort(byVmid);
    groups.push({ label: name, count: list.length, vms: list, unassigned: false });
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="aaris-display text-lg text-gray-100">VM Assignments</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {assigned.length} assigned · {unassigned.length} unassigned
          </p>
        </div>
        <div className="flex items-center gap-2">
          {claimMsg && (
            <span className="text-xs font-mono text-gray-500">{claimMsg}</span>
          )}
          {unassigned.length > 0 && (
            <button
              onClick={claimAllUnassigned}
              disabled={claiming}
              title={`Assign every unassigned VM to ${user?.username}`}
              className="text-sm text-blue-400 hover:text-blue-300 bg-gray-800 hover:bg-gray-700 disabled:opacity-40 px-3 py-2 rounded-lg transition-colors"
            >
              {claiming ? 'Claiming…' : `Claim all unassigned (${unassigned.length})`}
            </button>
          )}
          <button
            onClick={load}
            className="text-sm text-gray-400 hover:text-white bg-gray-800 hover:bg-gray-700 px-3 py-2 rounded-lg transition-colors"
          >
            Refresh
          </button>
        </div>
      </div>

      <TagSyncCard />

      {error && <p className="text-red-400 text-sm mb-4 bg-red-900/20 rounded p-3">{error}</p>}

      {visibleMigrations.length > 0 && (
        <div className="mb-4 bg-gray-900 border border-gray-800 rounded-xl divide-y divide-gray-800">
          {visibleMigrations.map(m => (
            <div key={m.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
              {m.status === 'running'
                ? <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse shrink-0" />
                : <span className={`w-2 h-2 rounded-full shrink-0 ${m.status === 'ok' ? 'bg-green-500' : 'bg-red-500'}`} />}
              <span className="text-gray-200 font-medium">{m.name || `VM ${m.vmid}`}</span>
              <span className="text-xs font-mono text-gray-500">
                {m.sourceHostName || m.sourceNodeName} → {m.targetHostName || m.targetNodeName}
              </span>
              <span className={`ml-auto text-xs font-mono ${m.status === 'running' ? 'text-blue-400' : m.status === 'ok' ? 'text-green-500' : 'text-red-400'}`}>
                {m.status === 'running' ? 'migrating…' : m.status === 'ok' ? 'done' : 'failed'}
              </span>
              {m.status === 'error' && m.status_detail && (
                <span className="text-xs text-gray-500 truncate max-w-[24rem]" title={m.status_detail}>{m.status_detail}</span>
              )}
            </div>
          ))}
        </div>
      )}

      {loading ? (
        <div className="space-y-3">
          {[1,2,3,4].map(i => <div key={i} className="h-14 bg-gray-900 rounded-xl animate-pulse" />)}
        </div>
      ) : (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800 text-gray-500 text-xs uppercase tracking-wider">
                <th className="text-left px-4 py-3">VM</th>
                <th className="text-left px-4 py-3">Node / VMID</th>
                <th className="text-left px-4 py-3">Status</th>
                <th className="text-left px-4 py-3">Assigned To</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {groups.map(group => (
                <Fragment key={group.label}>
                  <tr className="border-b border-gray-800 bg-gray-950/60">
                    <td colSpan={5} className="px-4 py-2">
                      <span className={`text-xs uppercase tracking-wider font-medium ${group.unassigned ? 'text-amber-500' : 'text-blue-400'}`}>
                        {group.label}
                      </span>
                      <span className="text-xs text-gray-600 ml-2 font-mono">{group.count}</span>
                    </td>
                  </tr>
                  {group.vms.map(vm => (
                    <tr key={vmIdentityKey(vm)} className="border-b border-gray-800 last:border-0 hover:bg-gray-800/50 transition-colors">
                      <td className="px-4 py-3 text-white font-medium">{vm.name || `VM ${vm.vmid}`}</td>
                      <td className="px-4 py-3 text-gray-500 text-xs font-mono">{displayNode(vm.node)} / {vm.vmid}</td>
                      <td className="px-4 py-3"><StatusBadge status={vm.status} /></td>
                      <td className="px-4 py-3">
                        {vm.assignment
                          ? <span className="text-blue-400">{vm.assignment.username}</span>
                          : <span className="text-gray-600 italic">Unassigned</span>
                        }
                      </td>
                      <td className="px-4 py-3 text-right whitespace-nowrap">
                        {user?.isAdmin && multiHost && (
                          <button
                            onClick={() => setMigrateVm(vm)}
                            disabled={migrations.some(m => m.status === 'running' && m.vmid === vm.vmid)}
                            title="Move this VM to a different Proxmox host"
                            className="text-xs text-gray-400 hover:text-white disabled:opacity-40 px-2 py-1 rounded hover:bg-gray-700 transition-colors mr-1"
                          >
                            Migrate
                          </button>
                        )}
                        {vm.assignment ? (
                          <button
                            onClick={() => unassign(vm.assignment)}
                            className="text-xs text-red-500 hover:text-red-400 px-2 py-1 rounded hover:bg-gray-700 transition-colors"
                          >
                            Unassign
                          </button>
                        ) : (
                          <button
                            onClick={() => claim(vm)}
                            disabled={claiming}
                            title={`Assign this VM to ${user?.username}`}
                            className="text-xs text-blue-500 hover:text-blue-400 disabled:opacity-40 px-2 py-1 rounded hover:bg-gray-700 transition-colors"
                          >
                            Claim
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {migrateVm && (
        <MigrateVMModal
          vm={migrateVm}
          onClose={() => { setMigrateVm(null); loadMigrations(); load(); }}
          onDone={() => { loadMigrations(); load(); }}
        />
      )}
    </div>
  );
}
