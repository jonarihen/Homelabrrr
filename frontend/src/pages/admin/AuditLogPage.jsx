import { useState, useEffect, useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../../api.js';
import useDocumentTitle from '../../hooks/useDocumentTitle.js';

function actionBadgeClass(action) {
  if (action === 'login') return 'bg-green-500/15 text-green-400 border-green-500/20';
  if (/failed|delete/.test(action)) return 'bg-red-500/15 text-red-400 border-red-500/20';
  if (/^vm_|^backup_|^vlan_/.test(action)) return 'bg-blue-500/15 text-blue-400 border-blue-500/20';
  if (/^admin_/.test(action)) return 'bg-yellow-500/15 text-yellow-400 border-yellow-500/20';
  return 'bg-gray-500/15 text-gray-400 border-gray-500/20';
}

export default function AuditLogPage() {
  useDocumentTitle('Audit Log');

  const [searchParams, setSearchParams] = useSearchParams();
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [limit] = useState(50);
  const [actionFilter, setActionFilter] = useState(() => searchParams.get('action') || '');
  const [actionTypes, setActionTypes] = useState([]);
  const [userFilter, setUserFilter] = useState('');
  const [userDraft, setUserDraft] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const targetFilter = searchParams.get('target') || '';
  const targetRefFilter = searchParams.get('targetRef') || '';
  const legacyFilter = searchParams.get('legacy') === 'true';
  const filterLabel = searchParams.get('label') || targetRefFilter || targetFilter;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const totalPages = Math.max(1, Math.ceil(total / limit));

  // Shared by the page query and the CSV export link so both apply the same filters.
  const filterParams = useMemo(() => {
    const params = {};
    if (actionFilter) params.action = actionFilter;
    if (userFilter) params.user = userFilter;
    if (fromDate) params.from = fromDate;
    if (toDate) params.to = toDate;
    if (targetFilter) params.target = targetFilter;
    if (targetRefFilter) params.targetRef = targetRefFilter;
    if (legacyFilter) params.legacy = 'true';
    return params;
  }, [actionFilter, userFilter, fromDate, toDate, targetFilter, targetRefFilter, legacyFilter]);
  const exportCsv = async () => {
    setError('');
    try {
      // Through the api module so a 401 redirects to login and failures are shown, not saved as a file.
      const { data } = await api.get('/admin/audit-log.csv', { params: filterParams, responseType: 'blob' });
      const url = URL.createObjectURL(data);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'audit-log.csv';
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e.response?.data instanceof Blob ? 'Export failed' : (e.response?.data?.error || 'Export failed'));
    }
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.get('/admin/audit-log', { params: { page, limit, ...filterParams } });
      setRows(res.data.rows);
      setTotal(res.data.total);
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to load audit log');
    } finally {
      setLoading(false);
    }
  }, [page, limit, filterParams]);

  useEffect(() => { load(); }, [load]);

  // The dropdown lists every action actually recorded, not a hand-kept subset.
  useEffect(() => {
    api.get('/admin/audit-log/actions').then((r) => setActionTypes(Array.isArray(r.data) ? r.data : [])).catch(() => {});
  }, []);

  const handleFilterChange = (e) => {
    setActionFilter(e.target.value);
    setPage(1);
  };

  const clearTarget = () => {
    const next = new URLSearchParams(searchParams);
    next.delete('target');
    next.delete('targetRef');
    next.delete('label');
    next.delete('legacy');
    setSearchParams(next);
    setPage(1);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="aaris-display text-xl text-gray-100">Audit Log</h1>
          <p className="text-sm text-gray-500 mt-1">{total} total entries</p>
        </div>
        <div className="flex items-center gap-2">
          {(targetFilter || targetRefFilter) && (
            <button
              onClick={clearTarget}
              className="text-xs bg-gray-800 border border-gray-700 text-gray-300 rounded-lg px-3 py-2 hover:bg-gray-700 transition-colors"
              title="Clear target filter"
            >
              {legacyFilter ? 'Legacy name match' : 'Target'}: <span className="font-mono text-white">{filterLabel}</span> ✕
            </button>
          )}
          <select
            value={actionFilter}
            onChange={handleFilterChange}
            className="bg-gray-800 border border-gray-700 text-gray-300 text-sm rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
          >
            <option value="">All actions</option>
            {/* Keep a deep-linked action selectable even before the list loads. */}
            {[...new Set([...(actionFilter ? [actionFilter] : []), ...actionTypes])].map(a => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>
          <button
            type="button"
            onClick={exportCsv}
            className="text-sm bg-gray-800 border border-gray-700 text-gray-300 rounded-lg px-3 py-2 hover:bg-gray-700 transition-colors"
          >
            Export CSV
          </button>
        </div>
      </div>

      <form
        onSubmit={(e) => { e.preventDefault(); setUserFilter(userDraft.trim()); setPage(1); }}
        className="flex flex-wrap items-end gap-3"
      >
        <label className="text-xs text-gray-400">
          <span className="block mb-1">User</span>
          <input
            type="text"
            value={userDraft}
            onChange={(e) => setUserDraft(e.target.value)}
            onBlur={() => { if (userDraft.trim() !== userFilter) { setUserFilter(userDraft.trim()); setPage(1); } }}
            placeholder="exact username"
            className="bg-gray-800 border border-gray-700 text-gray-200 text-sm rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
          />
        </label>
        <label className="text-xs text-gray-400">
          <span className="block mb-1">From</span>
          <input type="date" value={fromDate} max={toDate || undefined} onChange={(e) => { setFromDate(e.target.value); setPage(1); }}
            className="bg-gray-800 border border-gray-700 text-gray-200 text-sm rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500/40" />
        </label>
        <label className="text-xs text-gray-400">
          <span className="block mb-1">To (inclusive)</span>
          <input type="date" value={toDate} min={fromDate || undefined} onChange={(e) => { setToDate(e.target.value); setPage(1); }}
            className="bg-gray-800 border border-gray-700 text-gray-200 text-sm rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500/40" />
        </label>
        {(userFilter || fromDate || toDate) && (
          <button
            type="button"
            onClick={() => { setUserDraft(''); setUserFilter(''); setFromDate(''); setToDate(''); setPage(1); }}
            className="text-xs text-gray-400 hover:text-white px-2 py-2"
          >
            Clear filters
          </button>
        )}
      </form>

      {legacyFilter && (
        <p className="text-xs text-amber-300 bg-amber-900/20 border border-amber-800/40 rounded-lg px-3 py-2">
          Legacy role events were recorded by name, not ID. These entries may include a different role that once used this name; verify dates before relying on them.
        </p>
      )}

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
