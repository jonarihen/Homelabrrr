import { useState, useEffect } from 'react';
import api from '../../api.js';
import StatusBadge from '../../components/StatusBadge.jsx';
import useDocumentTitle from '../../hooks/useDocumentTitle.js';

export default function AssignmentsPage() {
  useDocumentTitle('Assignments');
  const [vms, setVms]       = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState('');

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

  const assigned   = vms.filter(v => v.assignment);
  const unassigned = vms.filter(v => !v.assignment);

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-white">VM Assignments</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {assigned.length} assigned · {unassigned.length} unassigned
          </p>
        </div>
        <button
          onClick={load}
          className="text-sm text-gray-400 hover:text-white bg-gray-800 hover:bg-gray-700 px-3 py-2 rounded-lg transition-colors"
        >
          Refresh
        </button>
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
              {vms.map(vm => (
                <tr key={`${vm.node}-${vm.vmid}`} className="border-b border-gray-800 last:border-0 hover:bg-gray-800/50 transition-colors">
                  <td className="px-4 py-3 text-white font-medium">{vm.name || `VM ${vm.vmid}`}</td>
                  <td className="px-4 py-3 text-gray-500 text-xs font-mono">{vm.node} / {vm.vmid}</td>
                  <td className="px-4 py-3"><StatusBadge status={vm.status} /></td>
                  <td className="px-4 py-3">
                    {vm.assignment
                      ? <span className="text-blue-400">{vm.assignment.username}</span>
                      : <span className="text-gray-600 italic">Unassigned</span>
                    }
                  </td>
                  <td className="px-4 py-3 text-right">
                    {vm.assignment && (
                      <button
                        onClick={() => unassign(vm.assignment)}
                        className="text-xs text-red-500 hover:text-red-400 px-2 py-1 rounded hover:bg-gray-700 transition-colors"
                      >
                        Unassign
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
