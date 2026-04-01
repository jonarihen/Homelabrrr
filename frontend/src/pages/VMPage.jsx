import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import Layout from '../components/Layout.jsx';
import StatusBadge from '../components/StatusBadge.jsx';
import VLANModal from '../components/VLANModal.jsx';
import VMIPManagementPanel from '../components/VMIPManagementPanel.jsx';
import useDocumentTitle from '../hooks/useDocumentTitle.js';
import useSSHConfig from '../hooks/useSSHConfig.js';
import { useConsoleSessions } from '../contexts/ConsoleSessionsContext.jsx';
import api from '../api.js';
import { displayNode, routeNode } from '../utils/nodeRef.js';

// ── Formatters ───────────────────────────────────────────────────────────────

function fmt(bytes) {
  if (bytes === undefined || bytes === null) return '—';
  const gb = bytes / 1024 / 1024 / 1024;
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  const mb = bytes / 1024 / 1024;
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

function fmtRate(v) {
  if (!v) return '0 B/s';
  if (v >= 1048576) return `${(v / 1048576).toFixed(1)} MB/s`;
  if (v >= 1024) return `${(v / 1024).toFixed(1)} KB/s`;
  return `${v.toFixed(0)} B/s`;
}

function fmtUptime(s) {
  if (!s) return '—';
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// ── Chart ────────────────────────────────────────────────────────────────────

function MiniChart({ data, color, label, formatValue, height = 64 }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !data || data.length === 0) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    canvas.width = w * dpr; canvas.height = h * dpr;
    ctx.scale(dpr, dpr);

    const filtered = data.filter(v => v != null && !isNaN(v));
    if (!filtered.length) return;
    const max = Math.max(...filtered, 0.001);
    const step = w / (data.length - 1 || 1);

    // Gradient fill
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, color + '25');
    grad.addColorStop(1, color + '00');
    ctx.beginPath();
    ctx.moveTo(0, h);
    data.forEach((v, i) => ctx.lineTo(i * step, h - ((v ?? 0) / max) * (h - 4)));
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // Line
    ctx.beginPath();
    data.forEach((v, i) => {
      const x = i * step, y = h - ((v ?? 0) / max) * (h - 4);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }, [data, color]);

  const lastVal = data?.filter(v => v != null).slice(-1)[0];

  return (
    <div className="bg-gray-800/50 border border-gray-700/30 rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs text-gray-400 font-medium">{label}</span>
        <span className="text-xs font-mono font-semibold" style={{ color }}>
          {formatValue ? formatValue(lastVal) : lastVal?.toFixed(1) ?? '—'}
        </span>
      </div>
      <canvas ref={canvasRef} className="w-full" style={{ height: `${height}px` }} />
    </div>
  );
}

// ── Progress Bar ─────────────────────────────────────────────────────────────

function ProgressBar({ label, icon, value, max, color = 'blue' }) {
  const pct = max ? ((value / max) * 100) : 0;
  const clampedPct = Math.min(pct, 100).toFixed(1);
  const barColors = { blue: 'from-blue-600 to-blue-400', purple: 'from-purple-600 to-purple-400' };
  const barColor = pct > 90 ? 'from-red-600 to-red-400' : pct > 70 ? 'from-yellow-600 to-yellow-400' : barColors[color];

  return (
    <div className="bg-gray-800/50 border border-gray-700/30 rounded-xl p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="flex items-center gap-2 text-xs text-gray-400 font-medium">
          {icon}
          {label}
        </span>
        <span className="text-xs text-gray-300 font-mono">{fmt(value)} / {fmt(max)}</span>
      </div>
      <div className="w-full bg-gray-700/50 rounded-full h-2 overflow-hidden">
        <div className={`bg-gradient-to-r ${barColor} h-full rounded-full transition-all duration-700`} style={{ width: `${clampedPct}%` }} />
      </div>
      <p className="text-xs text-gray-500 mt-1.5 text-right font-mono">{clampedPct}%</p>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function VMPage() {
  const { node, vmid } = useParams();
  const navigate = useNavigate();

  const [vm, setVm] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState('');

  const [rrd, setRrd] = useState(null);
  const [rrdLoading, setRrdLoading] = useState(true);
  const [timeframe, setTimeframe] = useState('hour');
  const { openSshSession, openVncSession } = useConsoleSessions();

  const { sshCfg, setSshCfg, sshSaved, sshSavingError, scanningFingerprint, saveSshConfig, scanSshFingerprint } = useSSHConfig(node, vmid);

  const [disks, setDisks] = useState([]);
  const [vlanModal, setVlanModal] = useState(false);

  useDocumentTitle(vm ? (vm.name || `VM ${vm.vmid}`) : 'VM Details');

  const loadVm = useCallback(async () => {
    try {
      const r = await api.get(`/vms/${node}/${vmid}/status`);
      setVm({
        ...r.data,
        nodeRef: r.data.nodeRef || node,
        node: r.data.node || displayNode(node),
        vmid: parseInt(vmid, 10),
      });
      setError('');
    } catch (e) {
      if (e.response?.status === 403) setError('VM not found or not assigned to you');
      else setError(e.response?.data?.error || 'Failed to load VM');
    } finally { setLoading(false); }
  }, [node, vmid]);

  useEffect(() => {
    loadVm();
    const interval = setInterval(loadVm, 15000);
    return () => clearInterval(interval);
  }, [loadVm]);


  useEffect(() => {
    api.get(`/vms/${node}/${vmid}/config`).then(r => {
      const cfg = r.data;
      const diskKeys = Object.keys(cfg).filter(k =>
        /^(scsi|virtio|sata|ide|efidisk|tpmstate)\d+$/.test(k) && !cfg[k].includes('media=cdrom') && cfg[k] !== 'none'
      );
      setDisks(diskKeys.map(k => {
        const val = cfg[k];
        const sizeMatch = val.match(/size=(\d+[A-Z]?)/i);
        const storageMatch = val.match(/^([^,]+)/);
        return { name: k, storage: storageMatch?.[1] || val, size: sizeMatch?.[1] || '—' };
      }));
    }).catch(() => {});
  }, [node, vmid]);

  useEffect(() => {
    let cancelled = false;
    setRrdLoading(true);
    api.get(`/vms/${node}/${vmid}/rrddata?timeframe=${timeframe}`)
      .then(r => { if (!cancelled) setRrd(r.data); })
      .catch(() => { if (!cancelled) setRrd([]); })
      .finally(() => { if (!cancelled) setRrdLoading(false); });
    return () => { cancelled = true; };
  }, [node, vmid, timeframe]);

  const action = async (act) => {
    setActionLoading(true); setActionError('');
    try {
      await api.post(`/vms/${node}/${vmid}/action`, { action: act });
      setTimeout(loadVm, 1500);
    } catch (e) {
      setActionError(e.response?.data?.error || 'Action failed');
    } finally { setActionLoading(false); }
  };

  const isRunning = vm?.status === 'running';
  const cpuData = rrd?.map(d => d.cpu != null ? d.cpu * 100 : null) || [];
  const memData = rrd?.map(d => d.mem != null && d.maxmem ? (d.mem / d.maxmem) * 100 : null) || [];
  const netInData = rrd?.map(d => d.netin ?? null) || [];
  const netOutData = rrd?.map(d => d.netout ?? null) || [];
  const diskReadData = rrd?.map(d => d.diskread ?? null) || [];
  const diskWriteData = rrd?.map(d => d.diskwrite ?? null) || [];

  // ── Loading state ──
  if (loading) {
    return (
      <Layout>
        <div className="p-6 lg:p-8 max-w-6xl mx-auto">
          <div className="animate-pulse space-y-6">
            <div className="h-10 bg-gray-800 rounded-xl w-64" />
            <div className="h-20 bg-gray-800 rounded-2xl" />
            <div className="grid grid-cols-4 gap-4">
              {[1,2,3,4].map(i => <div key={i} className="h-24 bg-gray-800 rounded-2xl" />)}
            </div>
          </div>
        </div>
      </Layout>
    );
  }

  // ── Error state ──
  if (error && !vm) {
    return (
      <Layout>
        <div className="p-6 lg:p-8 max-w-6xl mx-auto">
          <button onClick={() => navigate('/dashboard')} className="text-sm text-gray-400 hover:text-white mb-6 flex items-center gap-1.5 transition-colors">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" /></svg>
            Back to VMs
          </button>
          <div className="bg-red-900/20 border border-red-800/50 rounded-2xl p-6 text-red-400 text-sm">{error}</div>
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="p-6 lg:p-8 max-w-6xl mx-auto space-y-6">

        {/* ── Header ── */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <button onClick={() => navigate('/dashboard')} className="text-gray-500 hover:text-white transition-colors p-2 rounded-xl hover:bg-gray-800">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" /></svg>
            </button>
            <div>
              <h1 className="text-2xl font-bold text-white tracking-tight">{vm.name || `VM ${vm.vmid}`}</h1>
              <p className="text-sm text-gray-500 font-mono mt-0.5">VMID {vm.vmid} / {displayNode(vm.node)}</p>
            </div>
          </div>
          <StatusBadge status={vm.status} />
        </div>

        {/* ── Action Bar ── */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
          <div className="flex flex-wrap items-center gap-2.5">
            {/* Power */}
            <SectionLabel icon={
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M5.636 5.636a9 9 0 1012.728 0M12 3v9" /></svg>
            } text="Power" />
            {!isRunning && (
              <ActionBtn color="green" onClick={() => action('start')} disabled={actionLoading} icon={
                <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
              }>Start</ActionBtn>
            )}
            {isRunning && (
              <>
                <ActionBtn color="yellow" onClick={() => action('reboot')} disabled={actionLoading} icon={
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                }>Reboot</ActionBtn>
                <ActionBtn color="orange" onClick={() => action('shutdown')} disabled={actionLoading} icon={
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M5.636 5.636a9 9 0 1012.728 0M12 3v9" /></svg>
                }>Shutdown</ActionBtn>
                <ActionBtn color="red" onClick={() => action('stop')} disabled={actionLoading} icon={
                  <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="1" /></svg>
                }>Stop</ActionBtn>
              </>
            )}

            <Divider />

            {/* Connect */}
              <SectionLabel icon={
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m9.86-2.54a4.5 4.5 0 00-6.364-6.364L4.5 8.257" /></svg>
            } text="Connect" />
            {isRunning ? (
              <>
                <ActionBtn color="blue" onClick={() => openVncSession(vm)} icon={
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" strokeLinecap="round" /></svg>
                }>VNC</ActionBtn>
                <ActionBtn color="blue" onClick={() => window.open(`/vnc/${routeNode(vm)}/${vm.vmid}`, '_blank', 'noopener')} icon={
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
                }>VNC Tab</ActionBtn>
                <ActionBtn color="blue" onClick={() => openSshSession(vm)} icon={
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6.75 7.5l3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0021 18V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v12a2.25 2.25 0 002.25 2.25z" /></svg>
                }>SSH</ActionBtn>
                <ActionBtn color="blue" onClick={() => window.open(`/ssh/${routeNode(vm)}/${vm.vmid}`, '_blank', 'noopener')} icon={
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" /></svg>
                }>SSH Tab</ActionBtn>
              </>
            ) : (
              <span className="text-xs text-gray-600 italic">Start VM to connect</span>
            )}

            <Divider />

            {/* Network */}
            <ActionBtn color="gray" onClick={() => setVlanModal(true)} icon={
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0112 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 013 12c0-1.605.42-3.113 1.157-4.418" /></svg>
            }>VLAN</ActionBtn>
          </div>
          {actionError && <p className="text-xs text-red-400 bg-red-900/20 rounded-lg p-2.5 mt-3">{actionError}</p>}
        </div>

        {/* ── Stats Grid ── */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <StatCard
            label="vCPUs" value={vm.maxcpu || vm.cpus || '—'}
            icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M8.25 3v1.5M4.5 8.25H3m18 0h-1.5M4.5 12H3m18 0h-1.5m-15 3.75H3m18 0h-1.5M8.25 19.5V21M12 3v1.5m0 15V21m3.75-18v1.5m0 15V21m-9-1.5h10.5a2.25 2.25 0 002.25-2.25V6.75a2.25 2.25 0 00-2.25-2.25H6.75A2.25 2.25 0 004.5 6.75v10.5a2.25 2.25 0 002.25 2.25z" /></svg>}
            accent="blue"
          />
          <StatCard
            label="CPU Usage" value={vm.cpu !== undefined ? `${(vm.cpu * 100).toFixed(1)}%` : '—'}
            icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" /></svg>}
            accent="cyan"
          />
          <StatCard
            label="Uptime" value={fmtUptime(vm.uptime)}
            icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>}
            accent="green"
          />
          <StatCard
            label="Status" value={vm.status}
            icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M9.348 14.651a3.75 3.75 0 010-5.303m5.304 0a3.75 3.75 0 010 5.303m-7.425 2.122a6.75 6.75 0 010-9.546m9.546 0a6.75 6.75 0 010 9.546M5.106 18.894c-3.808-3.808-3.808-9.98 0-13.789m13.788 0c3.808 3.808 3.808 9.981 0 13.79M12 12h.008v.007H12V12zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" /></svg>}
            accent={isRunning ? 'green' : 'red'}
          />
        </div>

        {/* ── Memory + Disks ── */}
        {isRunning && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <ProgressBar label="Memory" value={vm.mem} max={vm.maxmem} color="purple" icon={
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 3h12l3 6-3 6H6L3 9l3-6z" /></svg>
            } />
            {disks.length > 0 && (
              <div className="bg-gray-800/50 border border-gray-700/30 rounded-xl p-4">
                <span className="flex items-center gap-2 text-xs text-gray-400 font-medium mb-3">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 0v3.75m-16.5-3.75v3.75m16.5 0v3.75C20.25 16.153 16.556 18 12 18s-8.25-1.847-8.25-4.125v-3.75m16.5 0c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125" /></svg>
                  Disks
                </span>
                <div className="space-y-2">
                  {disks.map(d => (
                    <div key={d.name} className="flex items-center justify-between bg-gray-900/50 rounded-lg px-3 py-2">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <span className="text-xs font-mono text-blue-400 font-semibold shrink-0">{d.name}</span>
                        <span className="text-xs text-gray-500 truncate" title={d.storage}>{d.storage}</span>
                      </div>
                      <span className="text-xs font-mono text-white font-semibold shrink-0 ml-3">{d.size}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Disks (when stopped) ── */}
        {!isRunning && disks.length > 0 && (
          <div className="bg-gray-800/50 border border-gray-700/30 rounded-xl p-4">
            <span className="flex items-center gap-2 text-xs text-gray-400 font-medium mb-3">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 0v3.75m-16.5-3.75v3.75m16.5 0v3.75C20.25 16.153 16.556 18 12 18s-8.25-1.847-8.25-4.125v-3.75m16.5 0c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125" /></svg>
              Disks
            </span>
            <div className="space-y-2">
              {disks.map(d => (
                <div key={d.name} className="flex items-center justify-between bg-gray-900/50 rounded-lg px-3 py-2">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span className="text-xs font-mono text-blue-400 font-semibold shrink-0">{d.name}</span>
                    <span className="text-xs text-gray-500 truncate" title={d.storage}>{d.storage}</span>
                  </div>
                  <span className="text-xs font-mono text-white font-semibold shrink-0 ml-3">{d.size}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── I/O Stats ── */}
        {isRunning && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <MiniStat label="Net In" value={fmt(vm.netin)} icon="↓" color="text-green-400" />
            <MiniStat label="Net Out" value={fmt(vm.netout)} icon="↑" color="text-orange-400" />
            <MiniStat label="Disk Read" value={fmt(vm.diskread)} icon="↓" color="text-cyan-400" />
            <MiniStat label="Disk Write" value={fmt(vm.diskwrite)} icon="↑" color="text-yellow-400" />
          </div>
        )}

        {/* ── Performance Charts ── */}
        {isRunning && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-white">Performance</h2>
              <div className="flex gap-1 bg-gray-800/50 rounded-lg p-0.5">
                {[
                  { key: 'hour', label: '1h' },
                  { key: 'day', label: '24h' },
                  { key: 'week', label: '7d' },
                ].map(tf => (
                  <button
                    key={tf.key}
                    onClick={() => setTimeframe(tf.key)}
                    className={`text-xs px-3 py-1.5 rounded-md transition-all ${
                      timeframe === tf.key
                        ? 'bg-blue-600 text-white shadow-sm'
                        : 'text-gray-400 hover:text-white'
                    }`}
                  >
                    {tf.label}
                  </button>
                ))}
              </div>
            </div>

            {rrdLoading ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {[1,2,3,4].map(i => <div key={i} className="bg-gray-800/50 rounded-xl h-28 animate-pulse" />)}
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <MiniChart data={cpuData}       color="#3b82f6" label="CPU"         formatValue={v => v != null ? `${v.toFixed(1)}%` : '—'} />
                <MiniChart data={memData}        color="#a855f7" label="Memory"      formatValue={v => v != null ? `${v.toFixed(1)}%` : '—'} />
                <MiniChart data={netInData}      color="#22c55e" label="Network In"  formatValue={fmtRate} />
                <MiniChart data={netOutData}     color="#f97316" label="Network Out" formatValue={fmtRate} />
                <MiniChart data={diskReadData}   color="#06b6d4" label="Disk Read"   formatValue={fmtRate} />
                <MiniChart data={diskWriteData}  color="#eab308" label="Disk Write"  formatValue={fmtRate} />
              </div>
            )}
          </div>
        )}

        {/* ── Snapshots ── */}
        <SnapshotsSection node={node} vmid={vmid} />

        {/* ── Backups ── */}
        <BackupsSection node={node} vmid={vmid} />

        {/* ── IP Management ── */}
        <VMIPManagementPanel
          node={node}
          vmid={vmid}
          currentSshHost={sshCfg.host}
          onSshHostUpdate={(host) => setSshCfg((current) => ({ ...current, host }))}
        />

        {/* ── SSH Config ── */}
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-white">SSH Configuration</h2>
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <InputField label="Host / IP" value={sshCfg.host} onChange={v => setSshCfg(c => ({ ...c, host: v }))} placeholder="192.168.1.100" />
              <InputField label="Port" type="number" value={sshCfg.port} onChange={v => setSshCfg(c => ({ ...c, port: parseInt(v) || 22 }))} />
              <InputField label="Username" value={sshCfg.username} onChange={v => setSshCfg(c => ({ ...c, username: v }))} />
            </div>
            <div className="mt-4">
              <div className="flex items-center justify-between mb-1.5">
                <label className="block text-xs text-gray-500">Host Key Fingerprint</label>
                <button
                  onClick={scanSshFingerprint}
                  disabled={scanningFingerprint}
                  className="text-xs text-blue-400 hover:text-blue-300 disabled:opacity-50 transition-colors"
                >
                  {scanningFingerprint ? 'Scanning...' : 'Scan fingerprint'}
                </button>
              </div>
              <input
                type="text"
                value={sshCfg.hostFingerprint}
                onChange={e => setSshCfg(c => ({ ...c, hostFingerprint: e.target.value }))}
                placeholder="SHA256:..."
                className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 transition-colors"
              />
              <p className="mt-1.5 text-xs text-gray-500">
                This pinned fingerprint is required so the backend can verify the SSH server identity before connecting.
              </p>
            </div>
            <div className="flex items-center gap-3 mt-4">
              <button
                onClick={saveSshConfig}
                disabled={!sshCfg.host || !sshCfg.hostFingerprint}
                className="text-xs px-5 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded-lg font-medium transition-colors"
              >
                Save Config
              </button>
              {sshSaved && (
                <span className="text-xs text-green-400 flex items-center gap-1">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>
                  Saved
                </span>
              )}
            </div>
            {sshSavingError && (
              <p className="mt-3 text-xs text-red-400 bg-red-900/20 rounded-lg p-3">{sshSavingError}</p>
            )}
          </div>
        </div>
      </div>

      {vlanModal && <VLANModal vm={vm} onClose={() => setVlanModal(false)} onSaved={loadVm} />}
    </Layout>
  );
}

// ── Sub-components ───────────────────────────────────────────────────────────

function StatCard({ label, value, icon, accent = 'blue' }) {
  const accents = {
    blue: 'text-blue-400', cyan: 'text-cyan-400', green: 'text-green-400',
    red: 'text-red-400', purple: 'text-purple-400', yellow: 'text-yellow-400',
  };
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl p-4">
      <div className={`${accents[accent]} mb-2 opacity-60`}>{icon}</div>
      <p className="text-xs text-gray-500">{label}</p>
      <p className="text-lg text-white font-bold mt-0.5 font-mono">{value}</p>
    </div>
  );
}

function MiniStat({ label, value, icon, color }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl px-4 py-3 flex items-center gap-3">
      <span className={`text-sm font-mono ${color}`}>{icon}</span>
      <div>
        <p className="text-xs text-gray-500">{label}</p>
        <p className="text-sm text-white font-semibold font-mono">{value}</p>
      </div>
    </div>
  );
}

function SectionLabel({ icon, text }) {
  return (
    <span className="flex items-center gap-1.5 text-xs text-gray-500 uppercase tracking-wider font-medium mr-1">
      {icon}{text}
    </span>
  );
}

function Divider() {
  return <div className="w-px h-7 bg-gray-700/50 mx-1" />;
}

function ActionBtn({ children, color, onClick, disabled, icon }) {
  const styles = {
    green:  'bg-green-600/15 text-green-400 hover:bg-green-600/25 ring-green-500/20',
    red:    'bg-red-600/15 text-red-400 hover:bg-red-600/25 ring-red-500/20',
    yellow: 'bg-yellow-600/15 text-yellow-400 hover:bg-yellow-600/25 ring-yellow-500/20',
    orange: 'bg-orange-600/15 text-orange-400 hover:bg-orange-600/25 ring-orange-500/20',
    blue:   'bg-blue-600/15 text-blue-400 hover:bg-blue-600/25 ring-blue-500/20',
    gray:   'bg-gray-600/15 text-gray-300 hover:bg-gray-600/25 ring-gray-500/20',
  };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-medium ring-1 transition-all disabled:opacity-40 ${styles[color] || styles.gray}`}
    >
      {icon}{children}
    </button>
  );
}

// ── Backups Section ─────────────────────────────────────────────────────────

function SnapshotsSection({ node, vmid }) {
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
        <h2 className="text-sm font-semibold text-white">Snapshots</h2>
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
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium rounded-lg transition-colors disabled:opacity-50">
              {creating ? 'Creating...' : 'Create Snapshot'}
            </button>
          </div>
        </div>
      )}

      <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
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

function BackupsSection({ node, vmid }) {
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

  const loadBackups = useCallback(async () => {
    try {
      const r = await api.get(`/vms/${node}/${vmid}/backups`);
      setBackups(r.data);
    } catch { setBackups([]); }
    finally { setLoading(false); }
  }, [node, vmid]);

  useEffect(() => { loadBackups(); }, [loadBackups]);

  useEffect(() => {
    api.get(`/vms/${node}/${vmid}/backup-storages`)
      .then(r => {
        setStorages(r.data);
        if (r.data.length > 0 && !form.storage) setForm(f => ({ ...f, storage: r.data[0].storage }));
      })
      .catch(() => {});
  }, [node, vmid]);

  const createBackup = async () => {
    setCreating(true); setError(''); setSuccess('');
    try {
      await api.post(`/vms/${node}/${vmid}/backup`, form);
      setSuccess('Backup started — this may take a few minutes');
      setShowForm(false);
      setTimeout(() => { setSuccess(''); loadBackups(); }, 5000);
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
    if (!confirm('Delete this backup? This cannot be undone.')) return;
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
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-white flex items-center gap-2">
          <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5m8.25 3v6.75m0 0l-3-3m3 3l3-3M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z" /></svg>
          Backups
        </h2>
        <button
          onClick={() => setShowForm(!showForm)}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-medium ring-1 bg-blue-600/15 text-blue-400 hover:bg-blue-600/25 ring-blue-500/20 transition-all"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" /></svg>
          New Backup
        </button>
      </div>

      {error && <p className="text-xs text-red-400 bg-red-900/20 rounded-lg p-2.5">{error}</p>}
      {success && <p className="text-xs text-green-400 bg-green-900/20 rounded-lg p-2.5">{success}</p>}

      {/* Create form */}
      {showForm && (
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
              className="text-xs px-5 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded-lg font-medium transition-colors">
              {creating ? 'Starting...' : 'Start Backup'}
            </button>
            <button onClick={() => setShowForm(false)} className="text-xs px-4 py-2 text-gray-400 hover:text-white transition-colors">Cancel</button>
          </div>
        </div>
      )}

      {/* Restore confirmation modal */}
      {restoreConfirm && (
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
      {browseBackup && (
        <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
          <div className="flex items-center justify-between px-5 py-3 border-b border-gray-800">
            <div>
              <h3 className="text-sm font-semibold text-white flex items-center gap-2">
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
                      {f.type === 'v' && <span className="text-xs text-gray-600 italic ml-1">volume</span>}
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

      {/* Backups list */}
      <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
        {loading ? (
          <div className="p-6 space-y-3">
            {[1,2].map(i => <div key={i} className="h-10 bg-gray-800 rounded-lg animate-pulse" />)}
          </div>
        ) : backups.length === 0 ? (
          <div className="p-8 text-center">
            <svg className="w-8 h-8 text-gray-700 mx-auto mb-2" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5m8.25 3v6.75m0 0l-3-3m3 3l3-3M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z" /></svg>
            <p className="text-sm text-gray-500">No backups found</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-800">
            {backups.map(b => (
              <div key={b.volid} className="px-5 py-3.5 hover:bg-gray-800/30 transition-colors">
                <div className="flex items-center justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2.5">
                      <svg className="w-4 h-4 text-blue-400 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5M10 11.25h4M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z" /></svg>
                      <span className="text-sm text-white font-mono truncate" title={b.volid}>{b.volid?.split('/').pop() || b.volid}</span>
                    </div>
                    <div className="flex items-center gap-4 mt-1 ml-6.5">
                      <span className="text-xs text-gray-500">{fmtDate(b.ctime)}</span>
                      <span className="text-xs text-gray-500">{fmtSize(b.size)}</span>
                      <span className="text-xs text-gray-600 font-mono">{b.storage}</span>
                      {b.format && <span className="text-xs text-gray-600">{b.format}</span>}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0 ml-3">
                    {/* Browse files */}
                    <button
                      onClick={() => openFileBrowser(b)}
                      className="text-gray-600 hover:text-cyan-400 transition-colors p-2 rounded-lg hover:bg-cyan-900/20"
                      title="Browse files (file-level restore)"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" /></svg>
                    </button>
                    {/* Restore */}
                    <button
                      onClick={() => setRestoreConfirm(b)}
                      disabled={restoring === b.volid}
                      className="text-gray-600 hover:text-yellow-400 transition-colors p-2 rounded-lg hover:bg-yellow-900/20 disabled:opacity-40"
                      title="Full VM restore"
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
                      disabled={deleting === b.volid}
                      className="text-gray-600 hover:text-red-400 transition-colors p-2 rounded-lg hover:bg-red-900/20 disabled:opacity-40"
                      title="Delete backup"
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
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function InputField({ label, value, onChange, placeholder, type = 'text' }) {
  return (
    <div>
      <label className="block text-xs text-gray-500 mb-1.5 font-medium">{label}</label>
      <input
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-gray-800 border border-gray-700/50 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/20 transition-all"
      />
    </div>
  );
}
