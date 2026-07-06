import { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import Layout from '../components/Layout.jsx';
import VMCard from '../components/VMCard.jsx';
import useDocumentTitle from '../hooks/useDocumentTitle.js';
import { useAuth } from '../contexts/AuthContext.jsx';
import { useConfirm } from '../contexts/ConfirmContext.jsx';
import api from '../api.js';
import { routeNode, vmIdentityKey } from '../utils/nodeRef.js';

const STATUS_FILTERS = ['All', 'Running', 'Stopped'];
const TYPE_FILTERS = ['All', 'VM', 'LXC'];
const SORT_OPTIONS = [
  { value: 'name', label: 'Name' },
  { value: 'vmid', label: 'VMID' },
  { value: 'status', label: 'Status' },
  { value: 'cpu', label: 'CPU Usage' },
  { value: 'mem', label: 'Memory Usage' },
];

export default function Dashboard() {
  useDocumentTitle('My VMs');
  const { user } = useAuth();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const [vms, setVms] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  // Filter/sort state
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('All');
  const [typeFilter, setTypeFilter] = useState('All');
  const [sortBy, setSortBy] = useState('name');

  // Bulk selection state
  const [selected, setSelected] = useState(new Set());
  const [bulkLoading, setBulkLoading] = useState(false);
  const [bulkError, setBulkError] = useState('');

  const load = useCallback(async () => {
    try {
      const r = await api.get('/vms');
      setVms(r.data);
      setError('');
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to load VMs');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 15000);
    return () => clearInterval(interval);
  }, [load]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }, [load]);

  // Filtered and sorted VMs
  const filteredVms = useMemo(() => {
    let result = [...vms];

    // Search filter
    if (search.trim()) {
      const q = search.toLowerCase().trim();
      result = result.filter(vm =>
        (vm.name || '').toLowerCase().includes(q) ||
        String(vm.vmid).includes(q)
      );
    }

    // Status filter
    if (statusFilter === 'Running') {
      result = result.filter(vm => vm.status === 'running');
    } else if (statusFilter === 'Stopped') {
      result = result.filter(vm => vm.status !== 'running');
    }

    // Type filter
    if (typeFilter === 'VM') {
      result = result.filter(vm => vm.type !== 'lxc');
    } else if (typeFilter === 'LXC') {
      result = result.filter(vm => vm.type === 'lxc');
    }

    // Sort
    result.sort((a, b) => {
      switch (sortBy) {
        case 'name':
          return (a.name || '').localeCompare(b.name || '');
        case 'vmid':
          return a.vmid - b.vmid;
        case 'status':
          return (a.status || '').localeCompare(b.status || '');
        case 'cpu': {
          const aCpu = a.cpu || 0;
          const bCpu = b.cpu || 0;
          return bCpu - aCpu;
        }
        case 'mem': {
          const aMem = a.mem && a.maxmem ? a.mem / a.maxmem : 0;
          const bMem = b.mem && b.maxmem ? b.mem / b.maxmem : 0;
          return bMem - aMem;
        }
        default:
          return 0;
      }
    });

    return result;
  }, [vms, search, statusFilter, typeFilter, sortBy]);

  // Summary stats
  const running = vms.filter(v => v.status === 'running').length;
  const stopped = vms.length - running;
  const totalCpu = vms.reduce((sum, v) => v.status === 'running' && v.cpu ? sum + v.cpu * 100 : sum, 0);
  const totalMem = vms.reduce((sum, v) => v.status === 'running' && v.mem ? sum + v.mem : sum, 0);
  const totalMaxMem = vms.reduce((sum, v) => v.status === 'running' && v.maxmem ? sum + v.maxmem : sum, 0);
  const avgCpu = running > 0 ? totalCpu / running : 0;
  const memPct = totalMaxMem > 0 ? (totalMem / totalMaxMem * 100) : 0;

  // Bulk selection helpers
  const vmKey = (vm) => vmIdentityKey(vm);

  const toggleSelect = useCallback((vm) => {
    setSelected(prev => {
      const next = new Set(prev);
      const key = vmKey(vm);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    if (selected.size === filteredVms.length && filteredVms.length > 0) {
      setSelected(new Set());
    } else {
      setSelected(new Set(filteredVms.map(vmKey)));
    }
  }, [filteredVms, selected.size]);

  const clearSelection = useCallback(() => setSelected(new Set()), []);

  const selectedVms = useMemo(() =>
    filteredVms.filter(vm => selected.has(vmKey(vm))),
    [filteredVms, selected]
  );

  const executeBulkAction = useCallback(async (action) => {
    if (selectedVms.length === 0) return;
    const label = action === 'start' ? 'Starting' : action === 'stop' ? 'Stopping' : 'Shutting down';
    const count = `${selectedVms.length} VM${selectedVms.length > 1 ? 's' : ''}`;
    if (!(await confirm({
      title: `${label} ${count}`,
      message: `${label} ${count}. Continue?`,
      confirmLabel: action === 'start' ? 'Start' : action === 'stop' ? 'Force Stop' : 'Shutdown',
      danger: action !== 'start',
    }))) return;

    setBulkLoading(true);
    setBulkError('');
    try {
      const results = await Promise.allSettled(
        selectedVms.map(vm =>
          api.post(`/vms/${routeNode(vm)}/${vm.vmid}/action`, { action })
            .catch(e => { throw { vmName: vm.name || `VM ${vm.vmid}`, message: e.response?.data?.error || e.message }; })
        )
      );
      const failed = results
        .filter(r => r.status === 'rejected')
        .map(r => r.reason);
      if (failed.length > 0) {
        const detail = failed.map(f => `${f.vmName}: ${f.message}`).join('; ');
        setBulkError(`${failed.length} of ${selectedVms.length} failed — ${detail}`);
      }
      setSelected(new Set());
      // Reload after a brief delay to let Proxmox process
      setTimeout(load, 2000);
    } catch (e) {
      setBulkError('Bulk action failed unexpectedly.');
    } finally {
      setBulkLoading(false);
    }
  }, [selectedVms, load, confirm]);

  function fmtBytes(bytes) {
    if (!bytes) return '0';
    const gb = bytes / 1024 / 1024 / 1024;
    return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / 1024 / 1024).toFixed(0)} MB`;
  }

  const allSelected = filteredVms.length > 0 && selected.size === filteredVms.length;

  return (
    <Layout>
      <div className="p-6 lg:p-8">
        {/* Header */}
        <div className="flex items-start justify-between mb-6">
          <div>
            <div className="flex items-baseline gap-3">
              <span className="font-mono text-xs font-semibold text-orange-600 tracking-[0.12em]">01</span>
              <h1 className="aaris-display text-xl text-gray-100">My Virtual Machines</h1>
            </div>
            <div className="flex items-center gap-4 mt-2 font-mono text-[11px] uppercase tracking-[0.1em]">
              <span className="text-gray-500">{vms.length} total</span>
              {running > 0 && (
                <span className="flex items-center gap-1.5 text-green-400">
                  <span className="aaris-led aaris-led--ok aaris-led--pulse" />
                  {running} running
                </span>
              )}
              {stopped > 0 && (
                <span className="flex items-center gap-1.5 text-gray-500">
                  <span className="aaris-led aaris-led--off" />
                  {stopped} stopped
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {(user?.isAdmin || user?.canProvision) && (
              <button
                onClick={() => navigate('/provision')}
                className="flex items-center gap-2 font-mono text-xs font-semibold uppercase tracking-[0.12em] text-gray-950 bg-orange-600 hover:bg-orange-500 border border-orange-600 hover:border-orange-500 px-4 py-2 transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                </svg>
                New VM
              </button>
            )}
            <button
              onClick={handleRefresh}
              disabled={refreshing}
              className="flex items-center gap-2 font-mono text-xs uppercase tracking-[0.12em] text-gray-400 hover:text-gray-100 bg-transparent hover:bg-gray-800 border border-gray-700 px-4 py-2 transition-colors disabled:opacity-50"
            >
              <svg className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              Refresh
            </button>
          </div>
        </div>

        {/* Summary stats bar */}
        {running > 0 && !loading && (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 bg-gray-900/60 border border-gray-800/50 rounded-xl px-5 py-3 mb-5">
            <div className="flex items-center gap-2">
              <svg className="w-4 h-4 text-blue-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
              <span className="text-xs text-gray-400">Avg CPU</span>
              <span className="text-sm font-mono text-blue-400 font-medium">{avgCpu.toFixed(1)}%</span>
            </div>
            <div className="w-px h-4 bg-gray-700" />
            <div className="flex items-center gap-2">
              <svg className="w-4 h-4 text-purple-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
              </svg>
              <span className="text-xs text-gray-400">Total RAM</span>
              <span className="text-sm font-mono text-purple-400 font-medium">{fmtBytes(totalMem)} / {fmtBytes(totalMaxMem)}</span>
              <span className="text-xs text-gray-500">({memPct.toFixed(1)}%)</span>
            </div>
            <div className="w-px h-4 bg-gray-700" />
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-400">Running VMs</span>
              <span className="text-sm font-mono text-green-400 font-medium">{running}</span>
            </div>
          </div>
        )}

        {error && (
          <div role="alert" className="bg-red-900/20 border border-red-800/50 rounded-xl p-4 text-red-400 text-sm mb-5">
            {error}
          </div>
        )}

        {/* Search / Filter / Sort bar */}
        {!loading && vms.length > 0 && (
          <div className="flex flex-wrap items-center gap-3 mb-5">
            {/* Search */}
            <div className="relative flex-1 min-w-[200px] max-w-sm">
              <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by name or VMID..."
                aria-label="Search VMs by name or VMID"
                className="w-full bg-gray-900 border border-gray-700/50 rounded-lg pl-9 pr-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/20 transition-colors"
              />
              {search && (
                <button
                  onClick={() => setSearch('')}
                  aria-label="Clear search"
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 p-0.5"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
            </div>

            {/* Status filter pills */}
            <div className="flex items-center gap-1 bg-gray-900/60 border border-gray-800/50 rounded-lg p-0.5">
              {STATUS_FILTERS.map(f => (
                <button
                  key={f}
                  onClick={() => setStatusFilter(f)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
                    statusFilter === f
                      ? 'bg-gray-700 text-white shadow-sm'
                      : 'text-gray-400 hover:text-gray-200'
                  }`}
                >
                  {f}
                </button>
              ))}
            </div>

            {/* Type filter pills */}
            <div className="flex items-center gap-1 bg-gray-900/60 border border-gray-800/50 rounded-lg p-0.5">
              {TYPE_FILTERS.map(f => (
                <button
                  key={f}
                  onClick={() => setTypeFilter(f)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
                    typeFilter === f
                      ? 'bg-gray-700 text-white shadow-sm'
                      : 'text-gray-400 hover:text-gray-200'
                  }`}
                >
                  {f}
                </button>
              ))}
            </div>

            {/* Sort dropdown */}
            <div className="relative">
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value)}
                className="appearance-none bg-gray-900 border border-gray-700/50 rounded-lg pl-3 pr-8 py-2 text-xs text-gray-300 focus:outline-none focus:border-blue-500/50 cursor-pointer"
              >
                {SORT_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>Sort: {opt.label}</option>
                ))}
              </select>
              <svg className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-500 pointer-events-none" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </div>

            {/* Select all checkbox */}
            <label className="flex items-center gap-2 text-xs text-gray-400 hover:text-gray-200 cursor-pointer ml-auto select-none">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={toggleSelectAll}
                className="w-3.5 h-3.5 rounded border-gray-600 bg-gray-800 text-blue-500 focus:ring-blue-500 focus:ring-offset-0 cursor-pointer"
              />
              Select all
            </label>
          </div>
        )}

        {/* Bulk action bar */}
        {selected.size > 0 && (
          <div className="flex items-center gap-3 bg-blue-950/30 border border-blue-800/40 rounded-xl px-5 py-3 mb-5 animate-in">
            <span className="text-sm text-blue-300 font-medium">
              {selected.size} selected
            </span>
            <div className="w-px h-4 bg-blue-800/40" />
            <button
              onClick={() => executeBulkAction('start')}
              disabled={bulkLoading}
              className="flex items-center gap-1.5 text-xs font-medium text-green-400 hover:text-green-300 bg-green-500/10 hover:bg-green-500/20 border border-green-500/20 px-3 py-1.5 rounded-lg transition-all disabled:opacity-50"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 3l14 9-14 9V3z" />
              </svg>
              Start
            </button>
            <button
              onClick={() => executeBulkAction('shutdown')}
              disabled={bulkLoading}
              className="flex items-center gap-1.5 text-xs font-medium text-yellow-400 hover:text-yellow-300 bg-yellow-500/10 hover:bg-yellow-500/20 border border-yellow-500/20 px-3 py-1.5 rounded-lg transition-all disabled:opacity-50"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 10a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z" />
              </svg>
              Shutdown
            </button>
            <button
              onClick={() => executeBulkAction('stop')}
              disabled={bulkLoading}
              className="flex items-center gap-1.5 text-xs font-medium text-red-400 hover:text-red-300 bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 px-3 py-1.5 rounded-lg transition-all disabled:opacity-50"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728L5.636 5.636" />
              </svg>
              Force Stop
            </button>
            <button
              onClick={clearSelection}
              className="text-xs text-gray-400 hover:text-gray-200 ml-auto transition-colors"
            >
              Clear
            </button>
            {bulkLoading && (
              <svg className="w-4 h-4 text-blue-400 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
              </svg>
            )}
          </div>
        )}

        {bulkError && (
          <div role="alert" className="bg-red-900/20 border border-red-800/50 rounded-xl p-4 text-red-400 text-sm mb-5">
            {bulkError}
          </div>
        )}

        {loading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
            {[1, 2, 3].map(i => (
              <div key={i} className="bg-gray-900 border border-gray-800 rounded-2xl p-5 h-44 animate-pulse" />
            ))}
          </div>
        ) : vms.length === 0 ? (
          <div className="text-center py-24">
            <div className="w-16 h-16 rounded-2xl bg-gray-800/50 flex items-center justify-center mx-auto mb-4">
              <svg className="w-8 h-8 text-gray-600" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
                <rect x="2" y="3" width="20" height="14" rx="2" />
                <path d="M8 21h8M12 17v4" strokeLinecap="round" />
              </svg>
            </div>
            <p className="text-gray-400 font-medium">No VMs assigned</p>
            <p className="text-sm text-gray-600 mt-1">Contact an admin to get access to virtual machines.</p>
          </div>
        ) : filteredVms.length === 0 ? (
          <div className="text-center py-16">
            <svg className="w-10 h-10 text-gray-700 mx-auto mb-3" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <p className="text-gray-400 font-medium">No VMs match your filters</p>
            <button
              onClick={() => { setSearch(''); setStatusFilter('All'); setTypeFilter('All'); }}
              className="text-sm text-blue-400 hover:text-blue-300 mt-2 transition-colors"
            >
              Clear all filters
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
            {filteredVms.map(vm => (
              <VMCard
                key={`${vm.node}-${vm.vmid}`}
                vm={vm}
                selected={selected.has(vmKey(vm))}
                onSelect={toggleSelect}
              />
            ))}
          </div>
        )}
      </div>
    </Layout>
  );
}
