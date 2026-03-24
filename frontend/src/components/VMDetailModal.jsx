import { useEffect, useState, useRef } from 'react';
import Modal from './Modal.jsx';
import useSSHConfig from '../hooks/useSSHConfig.js';
import api from '../api.js';
import { displayNode, routeNode } from '../utils/nodeRef.js';

function fmt(bytes) {
  if (bytes === undefined || bytes === null) return '—';
  const gb = bytes / 1024 / 1024 / 1024;
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  const mb = bytes / 1024 / 1024;
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

function fmtRate(bytesPerSec) {
  if (!bytesPerSec) return '0 B/s';
  if (bytesPerSec >= 1024 * 1024) return `${(bytesPerSec / 1024 / 1024).toFixed(1)} MB/s`;
  if (bytesPerSec >= 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
  return `${bytesPerSec.toFixed(0)} B/s`;
}

function fmtUptime(seconds) {
  if (!seconds) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// Simple sparkline chart using canvas
function MiniChart({ data, color, label, formatValue, height = 60 }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !data || data.length === 0) return;

    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.scale(dpr, dpr);

    const filtered = data.filter(v => v !== null && v !== undefined && !isNaN(v));
    if (filtered.length === 0) return;

    const max = Math.max(...filtered, 0.001);
    const step = w / (data.length - 1 || 1);

    // Fill
    ctx.beginPath();
    ctx.moveTo(0, h);
    data.forEach((v, i) => {
      const val = v ?? 0;
      const x = i * step;
      const y = h - (val / max) * (h - 4);
      if (i === 0) ctx.lineTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fillStyle = color + '15';
    ctx.fill();

    // Line
    ctx.beginPath();
    data.forEach((v, i) => {
      const val = v ?? 0;
      const x = i * step;
      const y = h - (val / max) * (h - 4);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }, [data, color]);

  const lastVal = data?.filter(v => v !== null && v !== undefined).slice(-1)[0];

  return (
    <div className="bg-gray-800 rounded-lg p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-gray-400">{label}</span>
        <span className="text-xs font-medium" style={{ color }}>
          {formatValue ? formatValue(lastVal) : lastVal?.toFixed(1) ?? '—'}
        </span>
      </div>
      <canvas
        ref={canvasRef}
        className="w-full"
        style={{ height: `${height}px` }}
      />
    </div>
  );
}

function StatBox({ label, value, sub }) {
  return (
    <div className="bg-gray-800 rounded-lg p-3 text-center">
      <p className="text-xs text-gray-500">{label}</p>
      <p className="text-sm text-white font-semibold mt-0.5">{value}</p>
      {sub && <p className="text-xs text-gray-500 mt-0.5">{sub}</p>}
    </div>
  );
}

function ProgressBar({ label, value, max, color = 'blue' }) {
  const pct = max ? ((value / max) * 100).toFixed(1) : 0;
  const colors = {
    blue: 'bg-blue-500',
    green: 'bg-green-500',
    yellow: 'bg-yellow-500',
    red: 'bg-red-500',
    purple: 'bg-purple-500',
  };
  const barColor = pct > 90 ? colors.red : pct > 70 ? colors.yellow : colors[color];

  return (
    <div className="bg-gray-800 rounded-lg p-3">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs text-gray-400">{label}</span>
        <span className="text-xs text-gray-300">{fmt(value)} / {fmt(max)}</span>
      </div>
      <div className="w-full bg-gray-700 rounded-full h-2">
        <div className={`${barColor} h-2 rounded-full transition-all`} style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
      <p className="text-xs text-gray-500 mt-1 text-right">{pct}%</p>
    </div>
  );
}

export default function VMDetailModal({ vm, onClose }) {
  const [rrd, setRrd] = useState(null);
  const [timeframe, setTimeframe] = useState('hour');
  const [loading, setLoading] = useState(true);
  const vmNode = routeNode(vm);
  const { sshCfg, setSshCfg, sshSaved, sshSavingError, scanningFingerprint, saveSshConfig, scanSshFingerprint } = useSSHConfig(vmNode, vm.vmid);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.get(`/vms/${vmNode}/${vm.vmid}/rrddata?timeframe=${timeframe}`)
      .then(r => { if (!cancelled) setRrd(r.data); })
      .catch(() => { if (!cancelled) setRrd([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [vmNode, vm.vmid, timeframe]);

  const cpuData = rrd?.map(d => d.cpu != null ? d.cpu * 100 : null) || [];
  const memData = rrd?.map(d => d.mem != null && d.maxmem ? (d.mem / d.maxmem) * 100 : null) || [];
  const netInData = rrd?.map(d => d.netin ?? null) || [];
  const netOutData = rrd?.map(d => d.netout ?? null) || [];
  const diskReadData = rrd?.map(d => d.diskread ?? null) || [];
  const diskWriteData = rrd?.map(d => d.diskwrite ?? null) || [];

  const isRunning = vm.status === 'running';

  return (
    <Modal title={`${vm.name || `VM ${vm.vmid}`}`} onClose={onClose} size="xl">
      <div className="p-5 space-y-5">
        {/* Overview stats */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatBox label="Status" value={
            <span className={isRunning ? 'text-green-400' : 'text-red-400'}>
              {vm.status}
            </span>
          } />
          <StatBox label="VMID" value={vm.vmid} sub={displayNode(vm.node)} />
          <StatBox label="vCPUs" value={vm.maxcpu || vm.cpus || '—'} />
          <StatBox label="Uptime" value={fmtUptime(vm.uptime)} />
        </div>

        {/* Resource bars */}
        {isRunning && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <ProgressBar label="Memory" value={vm.mem} max={vm.maxmem} color="purple" />
            <ProgressBar label="Disk" value={vm.disk} max={vm.maxdisk} color="blue" />
          </div>
        )}

        {/* Network stats */}
        {isRunning && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatBox label="Network In" value={fmt(vm.netin)} />
            <StatBox label="Network Out" value={fmt(vm.netout)} />
            <StatBox label="Disk Read" value={fmt(vm.diskread)} />
            <StatBox label="Disk Write" value={fmt(vm.diskwrite)} />
          </div>
        )}

        {/* Timeframe selector */}
        {isRunning && (
          <>
            <div className="flex items-center justify-between">
              <h3 className="text-sm text-gray-300 font-medium">Performance History</h3>
              <div className="flex gap-1">
                {[
                  { key: 'hour', label: '1h' },
                  { key: 'day', label: '24h' },
                  { key: 'week', label: '7d' },
                ].map(tf => (
                  <button
                    key={tf.key}
                    onClick={() => setTimeframe(tf.key)}
                    className={`text-xs px-2.5 py-1 rounded transition-colors ${
                      timeframe === tf.key
                        ? 'bg-blue-600 text-white'
                        : 'bg-gray-800 text-gray-400 hover:text-white'
                    }`}
                  >
                    {tf.label}
                  </button>
                ))}
              </div>
            </div>

            {loading ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {[1, 2, 3, 4].map(i => (
                  <div key={i} className="bg-gray-800 rounded-lg h-24 animate-pulse" />
                ))}
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <MiniChart
                  data={cpuData}
                  color="#3b82f6"
                  label="CPU Usage"
                  formatValue={v => v != null ? `${v.toFixed(1)}%` : '—'}
                />
                <MiniChart
                  data={memData}
                  color="#a855f7"
                  label="Memory Usage"
                  formatValue={v => v != null ? `${v.toFixed(1)}%` : '—'}
                />
                <MiniChart
                  data={netInData}
                  color="#22c55e"
                  label="Network In"
                  formatValue={v => fmtRate(v)}
                />
                <MiniChart
                  data={netOutData}
                  color="#f97316"
                  label="Network Out"
                  formatValue={v => fmtRate(v)}
                />
                <MiniChart
                  data={diskReadData}
                  color="#06b6d4"
                  label="Disk Read"
                  formatValue={v => fmtRate(v)}
                />
                <MiniChart
                  data={diskWriteData}
                  color="#eab308"
                  label="Disk Write"
                  formatValue={v => fmtRate(v)}
                />
              </div>
            )}
          </>
        )}

        {/* SSH Config */}
        <div>
          <h3 className="text-sm text-gray-300 font-medium mb-3">SSH Configuration</h3>
          <div className="bg-gray-800 rounded-lg p-4">
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Host / IP</label>
                <input
                  type="text"
                  value={sshCfg.host}
                  onChange={e => setSshCfg(c => ({ ...c, host: e.target.value }))}
                  placeholder="192.168.1.100"
                  className="w-full bg-gray-900 border border-gray-700 rounded px-2.5 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500 transition-colors"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Port</label>
                <input
                  type="number"
                  value={sshCfg.port}
                  onChange={e => setSshCfg(c => ({ ...c, port: parseInt(e.target.value) || 22 }))}
                  className="w-full bg-gray-900 border border-gray-700 rounded px-2.5 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500 transition-colors"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Username</label>
                <input
                  type="text"
                  value={sshCfg.username}
                  onChange={e => setSshCfg(c => ({ ...c, username: e.target.value }))}
                  className="w-full bg-gray-900 border border-gray-700 rounded px-2.5 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500 transition-colors"
                />
              </div>
            </div>
            <div className="mt-3">
              <div className="flex items-center justify-between mb-1">
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
                className="w-full bg-gray-900 border border-gray-700 rounded px-2.5 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500 transition-colors"
              />
              <p className="text-xs text-gray-500 mt-1.5">
                Save a pinned fingerprint so SSH connections can verify the server identity.
              </p>
            </div>
            <div className="flex items-center gap-3 mt-3">
              <button
                onClick={saveSshConfig}
                disabled={!sshCfg.host || !sshCfg.hostFingerprint}
                className="text-xs px-4 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded transition-colors"
              >
                Save
              </button>
              {sshSaved && <span className="text-xs text-green-400">Saved</span>}
            </div>
            {sshSavingError && <p className="mt-3 text-xs text-red-400 bg-red-900/20 rounded p-2">{sshSavingError}</p>}
          </div>
        </div>
      </div>
    </Modal>
  );
}
