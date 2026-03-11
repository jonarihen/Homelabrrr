import { useState, useEffect, useCallback } from 'react';
import api from '../../api.js';
import useDocumentTitle from '../../hooks/useDocumentTitle.js';

const ACTION_TYPES = [
  'login', 'login_failed', 'vm_action', 'backup_create', 'backup_delete',
  'vm_restore', 'vlan_change', 'vm_clone', 'vm_create',
  'admin_create_user', 'admin_delete_user', 'admin_reset_2fa',
  'admin_unlock_user', 'admin_reset_password',
  'admin_create_firewall', 'admin_update_firewall', 'admin_delete_firewall',
  'admin_sync_vlan_firewall', 'admin_unsync_vlan_firewall', 'admin_delete_vlan',
];

function actionBadgeClass(action) {
  if (action === 'login') return 'bg-green-500/15 text-green-400 border-green-500/20';
  if (/failed|delete/.test(action)) return 'bg-red-500/15 text-red-400 border-red-500/20';
  if (/^vm_|^backup_|^vlan_/.test(action)) return 'bg-blue-500/15 text-blue-400 border-blue-500/20';
  if (/^admin_/.test(action)) return 'bg-yellow-500/15 text-yellow-400 border-yellow-500/20';
  return 'bg-gray-500/15 text-gray-400 border-gray-500/20';
}

export default function AuditLogPage() {
  useDocumentTitle('Audit Log');

  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [limit] = useState(50);
  const [actionFilter, setActionFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const totalPages = Math.max(1, Math.ceil(total / limit));

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = { page, limit };
      if (actionFilter) params.action = actionFilter;
      const res = await api.get('/admin/audit-log', { params });
      setRows(res.data.rows);
      setTotal(res.data.total);
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to load audit log');
    } finally {
      setLoading(false);
    }
  }, [page, limit, actionFilter]);

  useEffect(() => { load(); }, [load]);

  const handleFilterChange = (e) => {
    setActionFilter(e.target.value);
    setPage(1);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Audit Log</h1>
          <p className="text-sm text-gray-500 mt-1">{total} total entries</p>
        </div>
        <div>
          <select
            value={actionFilter}
            onChange={handleFilterChange}
            className="bg-gray-800 border border-gray-700 text-gray-300 text-sm rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
          >
            <option value="">All actions</option>
            {ACTION_TYPES.map(a => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>
        </div>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="bg-gray-800/50">
              <th className="text-left text-xs font-medium text-gray-400 uppercase tracking-wider px-4 py-3">Time</th>
              <th className="text-left text-xs font-medium text-gray-400 uppercase tracking-wider px-4 py-3">User</th>
              <th className="text-left text-xs font-medium text-gray-400 uppercase tracking-wider px-4 py-3">Action</th>
              <th className="text-left text-xs font-medium text-gray-400 uppercase tracking-wider px-4 py-3">Target</th>
              <th className="text-left text-xs font-medium text-gray-400 uppercase tracking-wider px-4 py-3">Detail</th>
              <th className="text-left text-xs font-medium text-gray-400 uppercase tracking-wider px-4 py-3">IP</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan="6" className="px-4 py-8 text-center text-gray-500 text-sm">Loading...</td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan="6" className="px-4 py-8 text-center text-gray-500 text-sm">No audit log entries found.</td>
              </tr>
            ) : (
              rows.map(row => (
                <tr key={row.id} className="border-b border-gray-800/50 hover:bg-gray-800/20 transition-colors">
                  <td className="px-4 py-3 text-xs text-gray-500 font-mono whitespace-nowrap">{row.created_at}</td>
                  <td className="px-4 py-3 text-sm text-gray-300">{row.username}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-block text-xs font-medium px-2 py-0.5 rounded-full border ${actionBadgeClass(row.action)}`}>
                      {row.action}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-300">{row.target}</td>
                  <td className="px-4 py-3 text-sm text-gray-300 max-w-xs truncate">{row.detail}</td>
                  <td className="px-4 py-3 text-xs text-gray-500 font-mono">{row.ip}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <button
            onClick={() => setPage(p => Math.max(1, p - 1))}
            disabled={page <= 1}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-gray-800 text-gray-300 hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            Previous
          </button>
          <span className="text-sm text-gray-400">
            Page {page} of {totalPages}
          </span>
          <button
            onClick={() => setPage(p => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-gray-800 text-gray-300 hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
