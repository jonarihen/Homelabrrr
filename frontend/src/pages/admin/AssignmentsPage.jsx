import { Fragment, useState, useEffect } from 'react';
import api from '../../api.js';
import StatusBadge from '../../components/StatusBadge.jsx';
import useDocumentTitle from '../../hooks/useDocumentTitle.js';
import { displayNode, routeNode, vmIdentityKey } from '../../utils/nodeRef.js';
import { useAuth } from '../../contexts/AuthContext.jsx';

export default function AssignmentsPage() {
  useDocumentTitle('Assignments');
  const { user } = useAuth();
  const [vms, setVms]       = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState('');
  const [tagSync, setTagSync] = useState({ running: false, msg: '' });
  const [claiming, setClaiming] = useState(false);
  const [claimMsg, setClaimMsg] = useState('');

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

  useEffect(() => { load(); }, []);

  const unassign = async (assignment) => {
    if (!confirm('Remove this VM assignment?')) return;
    try {
      await api.delete(`/admin/assignments/${assignment.id}`);
      load();
    } catch (e) {
      alert(e.response?.data?.error || 'Failed');
    }
  };

  const syncTags = async () => {
    setTagSync({ running: true, msg: '' });
    try {
      const { data } = await api.post('/admin/sync-vm-tags');
      setTagSync({ running: false, msg: `${data.checked} VMs checked, ${data.updated} retagged${data.failed ? `, ${data.failed} failed` : ''}` });
    } catch (e) {
      setTagSync({ running: false, msg: 'Failed: ' + (e.response?.data?.error || e.message) });
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
          {tagSync.msg && (
            <span className={`text-xs font-mono ${tagSync.msg.startsWith('Failed') ? 'text-red-400' : 'text-gray-500'}`}>
              {tagSync.msg}
            </span>
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
            onClick={syncTags}
            disabled={tagSync.running}
            title="Rewrite the owner + VLAN tags shown on VMs in the Proxmox UI"
            className="text-sm text-gray-400 hover:text-white bg-gray-800 hover:bg-gray-700 disabled:opacity-40 px-3 py-2 rounded-lg transition-colors"
          >
            {tagSync.running ? 'Syncing tags…' : 'Sync PVE Tags'}
          </button>
          <button
            onClick={load}
            className="text-sm text-gray-400 hover:text-white bg-gray-800 hover:bg-gray-700 px-3 py-2 rounded-lg transition-colors"
          >
            Refresh
          </button>
        </div>
      </div>

      {error && <p className="text-red-400 text-sm mb-4 bg-red-900/20 rounded p-3">{error}</p>}

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
                      <td className="px-4 py-3 text-right">
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
    </div>
  );
}
