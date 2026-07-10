import { useNavigate } from 'react-router-dom';
import StatusBadge from './StatusBadge.jsx';
import LeaseBadge from './LeaseBadge.jsx';
import { displayNode, routeNode } from '../utils/nodeRef.js';
import { sleepLabel } from '../utils/schedule.js';

function fmt(bytes) {
  if (!bytes) return '—';
  const gb = bytes / 1024 / 1024 / 1024;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

export default function VMCard({ vm, selected, onSelect }) {
  const navigate = useNavigate();
  const isRunning = vm.status === 'running';
  const cpuPct = vm.cpu !== undefined ? (vm.cpu * 100) : 0;
  const memPct = vm.mem && vm.maxmem ? (vm.mem / vm.maxmem * 100) : 0;
  const isLxc = vm.type === 'lxc';

  return (
    <div
      onClick={() => navigate(`/vm/${routeNode(vm)}/${vm.vmid}`)}
      className={`relative bg-gray-900 border p-5 flex flex-col gap-4 hover:border-gray-600 transition-colors duration-200 cursor-pointer group overflow-hidden ${selected ? 'border-orange-600/60 bg-orange-950/20' : 'border-gray-800'}`}
    >
      {/* Status strip at top — solid, status color only */}
      <div className={`absolute inset-x-0 top-0 h-0.5 ${isRunning ? 'bg-green-500' : 'bg-gray-700'}`} />

      {/* Selection indicator — visible on hover or when selected */}
      {onSelect && (
        <button
          onClick={(e) => { e.stopPropagation(); onSelect(vm); }}
          className={`absolute top-2.5 left-2.5 z-10 w-4 h-4 border-[1.5px] flex items-center justify-center transition-all duration-150 ${
            selected
              ? 'bg-orange-600 border-orange-600 scale-100 opacity-100'
              : 'border-gray-600 bg-gray-800/80 scale-90 opacity-0 group-hover:opacity-100 group-hover:scale-100'
          }`}
        >
          {selected && (
            <svg className="w-2.5 h-2.5 text-white" fill="none" stroke="currentColor" strokeWidth="3" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          )}
        </button>
      )}

      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-white font-semibold truncate group-hover:text-blue-400 transition-colors flex items-center gap-2" title={vm.name}>
            {vm.name || `VM ${vm.vmid}`}
            {isLxc && (
              <span className="shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded bg-orange-500/15 text-orange-400 border border-orange-500/20 uppercase tracking-wide">
                LXC
              </span>
            )}
          </h3>
          <p className="text-[10px] text-gray-500 mt-1 font-mono uppercase tracking-[0.1em]">ID {vm.vmid} / {displayNode(vm.node)}</p>
          {vm.lease && <LeaseBadge lease={vm.lease} className="mt-1.5" />}
          {vm.schedule?.enabled && (
            <span
              title={`Power schedule — ${sleepLabel(vm.schedule)}${vm.schedule.skipActive ? ' (skipping next shutdown)' : ''}`}
              className="mt-1.5 inline-flex items-center gap-1 px-1.5 py-0.5 border border-indigo-500/30 bg-indigo-500/10 font-mono text-[9px] uppercase tracking-wide text-indigo-300 whitespace-nowrap"
            >
              <svg className="w-2.5 h-2.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M21.752 15.002A9.718 9.718 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 003 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 009.002-5.998z" /></svg>
              {sleepLabel(vm.schedule)}
              {vm.schedule.skipActive && <span className="text-yellow-300">· skip</span>}
            </span>
          )}
        </div>
        <StatusBadge status={vm.status} />
      </div>

      {/* Mini resource bars */}
      {isRunning ? (
        <div className="space-y-2.5">
          <MiniBar label="CPU" value={cpuPct} color="blue" />
          <MiniBar label="RAM" value={memPct} color="purple" />
        </div>
      ) : (
        <div className="flex items-center justify-center py-3 text-gray-600 text-xs">
          {isLxc ? 'Container' : 'VM'} is offline
        </div>
      )}

      {/* Arrow hint */}
      <div className="flex items-center justify-end">
        <span className="text-xs text-gray-600 group-hover:text-gray-400 transition-colors flex items-center gap-1">
          View details
          <svg className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
        </span>
      </div>
    </div>
  );
}

function MiniBar({ label, value, color }) {
  const pct = Math.min(value, 100);
  const colors = {
    blue: { bar: 'bg-blue-500', bg: 'bg-blue-500/10', text: 'text-blue-400' },
    purple: { bar: 'bg-purple-500', bg: 'bg-purple-500/10', text: 'text-purple-400' },
  };
  const c = colors[color] || colors.blue;
  const barColor = pct > 90 ? 'bg-red-500' : pct > 70 ? 'bg-yellow-500' : c.bar;

  return (
    <div className="flex items-center gap-3">
      <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-gray-500 w-8 shrink-0">{label}</span>
      <div className="flex-1 bg-gray-800 h-1.5 overflow-hidden">
        <div className={`${barColor} h-full transition-all duration-500`} style={{ width: `${pct}%` }} />
      </div>
      <span className={`text-xs font-mono w-10 text-right ${c.text}`}>{pct.toFixed(0)}%</span>
    </div>
  );
}
