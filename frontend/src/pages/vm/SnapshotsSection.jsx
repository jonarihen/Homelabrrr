import { useState, useEffect, useCallback } from 'react';
import api from '../../api.js';

export default function SnapshotsSection({ node, vmid }) {
  const [snapshots, setSnapshots] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [form, setForm] = useState({ name: '', description: '', vmstate: false });
  const [rollbackConfirm, setRollbackConfirm] = useState(null);
  const [deleting, setDeleting] = useState(null);

  const loadSnapshots = useCallback(async () => {
    try {
      const r = await api.get(`/vms/${node}/${vmid}/snapshots`);
      setSnapshots(r.data);
    } catch { setSnapshots([]); }
    finally { setLoading(false); }
  }, [node, vmid]);

  useEffect(() => { loadSnapshots(); }, [loadSnapshots]);

  const create = async () => {
    if (!form.name) return setError('Snapshot name is required');
    setCreating(true); setError(''); setSuccess('');
    try {
      await api.post(`/vms/${node}/${vmid}/snapshots`, form);
      setSuccess('Snapshot created');
      setShowForm(false);
      setForm({ name: '', description: '', vmstate: false });
      setTimeout(() => { setSuccess(''); loadSnapshots(); }, 2000);
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to create snapshot');
    } finally { setCreating(false); }
  };

  const rollback = async (snapname) => {
    setError(''); setSuccess('');
    try {
      await api.post(`/vms/${node}/${vmid}/snapshots/${encodeURIComponent(snapname)}/rollback`);
      setSuccess(`Rolling back to "${snapname}" — this may take a moment`);
      setRollbackConfirm(null);
      setTimeout(() => { setSuccess(''); loadSnapshots(); }, 5000);
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to rollback');
    }
  };

  const remove = async (snapname) => {
    setDeleting(snapname); setError(''); setSuccess('');
    try {
      await api.delete(`/vms/${node}/${vmid}/snapshots/${encodeURIComponent(snapname)}`);
      setSuccess('Snapshot deleted');
      setTimeout(() => { setSuccess(''); loadSnapshots(); }, 2000);
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to delete snapshot');
    } finally { setDeleting(null); }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="aaris-display text-sm text-gray-100">Snapshots</h2>
        <button onClick={() => setShowForm(!showForm)} className="text-xs text-blue-400 hover:text-blue-300 transition-colors">
          {showForm ? 'Cancel' : '+ New Snapshot'}
        </button>
      </div>

      {error && <div className="bg-red-900/20 border border-red-800/50 rounded-xl p-3 text-red-400 text-xs">{error}</div>}
      {success && <div className="bg-green-900/20 border border-green-800/50 rounded-xl p-3 text-green-400 text-xs">{success}</div>}

      {showForm && (
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-gray-500 mb-1.5 font-medium">Name</label>
              <input
                value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="pre-update" className="w-full bg-gray-800 border border-gray-700/50 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/20"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1.5 font-medium">Description (optional)</label>
              <input
                value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                placeholder="Before applying updates" className="w-full bg-gray-800 border border-gray-700/50 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/20"
              />
            </div>
          </div>
          <div className="flex items-center justify-between">
            <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer">
              <input type="checkbox" checked={form.vmstate} onChange={e => setForm(f => ({ ...f, vmstate: e.target.checked }))}
                className="rounded border-gray-600 bg-gray-800 text-blue-500 focus:ring-blue-500/20" />
              Include RAM state (VM must be running)
            </label>
            <button onClick={create} disabled={creating}
              className="px-4 py-2 btn-primary text-xs font-medium rounded-lg">
              {creating ? 'Creating...' : 'Create Snapshot'}
            </button>
          </div>
        </div>
      )}

      <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-x-auto">
        {loading ? (
          <div className="p-6 text-center text-gray-500 text-sm">Loading snapshots...</div>
        ) : snapshots.length === 0 ? (
          <div className="p-6 text-center text-gray-500 text-sm">No snapshots</div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="bg-gray-800/50 text-xs text-gray-400">
                <th className="text-left px-4 py-3 font-medium">Name</th>
                <th className="text-left px-4 py-3 font-medium">Description</th>
                <th className="text-left px-4 py-3 font-medium">Date</th>
                <th className="text-right px-4 py-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {snapshots.map(snap => (
                <tr key={snap.name} className="border-t border-gray-800/50 hover:bg-gray-800/30">
                  <td className="px-4 py-3 text-sm text-white font-medium">{snap.name}</td>
                  <td className="px-4 py-3 text-sm text-gray-400">{snap.description || '—'}</td>
                  <td className="px-4 py-3 text-xs text-gray-500 font-mono">
                    {snap.snaptime ? new Date(snap.snaptime * 1000).toLocaleString() : '—'}
                  </td>
                  <td className="px-4 py-3 text-right space-x-2">
                    {rollbackConfirm === snap.name ? (
                      <span className="inline-flex items-center gap-2">
                        <span className="text-xs text-yellow-400">Rollback to this snapshot?</span>
                        <button onClick={() => rollback(snap.name)} className="text-xs text-yellow-400 hover:text-yellow-300 font-medium">Yes</button>
                        <button onClick={() => setRollbackConfirm(null)} className="text-xs text-gray-500 hover:text-gray-300">No</button>
                      </span>
                    ) : (
                      <>
                        <button onClick={() => setRollbackConfirm(snap.name)} className="text-xs text-yellow-400 hover:text-yellow-300 transition-colors">Rollback</button>
                        <button onClick={() => remove(snap.name)} disabled={deleting === snap.name}
                          className="text-xs text-red-400 hover:text-red-300 transition-colors disabled:opacity-50">
                          {deleting === snap.name ? 'Deleting...' : 'Delete'}
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
