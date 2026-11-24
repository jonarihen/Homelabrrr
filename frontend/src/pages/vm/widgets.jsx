import { useEffect, useRef } from 'react';
import { fmt } from './format.js';

// ── Chart ────────────────────────────────────────────────────────────────────

export function MiniChart({ data, token, label, formatValue, height = 64 }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !data || data.length === 0) return;
    const ctx = canvas.getContext('2d');
    // Canvas can't resolve var(); read the token's hex so the alpha suffixes below work.
    const color = getComputedStyle(canvas).getPropertyValue(token).trim();
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
  }, [data, token]);

  const lastVal = data?.filter(v => v != null).slice(-1)[0];

  return (
    <div className="bg-gray-800/50 border border-gray-700/30 rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs text-gray-400 font-medium">{label}</span>
        <span className="text-xs font-mono font-semibold" style={{ color: `var(${token})` }}>
          {formatValue ? formatValue(lastVal) : lastVal?.toFixed(1) ?? '—'}
        </span>
      </div>
      <canvas ref={canvasRef} className="w-full" style={{ height: `${height}px` }} />
    </div>
  );
}

// ── Progress Bar ─────────────────────────────────────────────────────────────

export function ProgressBar({ label, icon, value, max, color = 'blue' }) {
  const pct = max ? ((value / max) * 100) : 0;
  const clampedPct = Math.min(pct, 100).toFixed(1);
  const barColors = { blue: 'bg-orange-600', purple: 'bg-orange-400' };
  const barColor = pct > 90 ? 'bg-red-500' : pct > 70 ? 'bg-yellow-500' : barColors[color];

  return (
    <div className="bg-gray-800/50 border border-gray-700/30 p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.1em] text-gray-400">
          {icon}
          {label}
        </span>
        <span className="text-xs text-gray-300 font-mono">{fmt(value)} / {fmt(max)}</span>
      </div>
      <div className="w-full bg-gray-700/50 h-2 overflow-hidden">
        <div className={`${barColor} h-full transition-all duration-700`} style={{ width: `${clampedPct}%` }} />
      </div>
      <p className="text-xs text-gray-500 mt-1.5 text-right font-mono">{clampedPct}%</p>
    </div>
  );
}

// ── Sub-components ───────────────────────────────────────────────────────────

export function StatCard({ label, value, icon, accent = 'blue' }) {
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

export function MiniStat({ label, value, icon, color }) {
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

export function SectionLabel({ icon, text }) {
  return (
    <span className="flex items-center gap-1.5 text-xs text-gray-500 uppercase tracking-wider font-medium mr-1">
      {icon}{text}
    </span>
  );
}

export function Divider() {
  return <div className="w-px h-7 bg-gray-700/50 mx-1" />;
}

export function ActionBtn({ children, color, onClick, disabled, icon, title }) {
  const styles = {
    green:  'bg-green-600/15 text-green-400 hover:bg-green-600/25 ring-green-500/20',
    red:    'bg-red-600/15 text-red-400 hover:bg-red-600/25 ring-red-500/20',
    yellow: 'bg-yellow-600/15 text-yellow-400 hover:bg-yellow-600/25 ring-yellow-500/20',
    orange: 'bg-orange-600/15 text-orange-400 hover:bg-orange-600/25 ring-orange-500/20',
    blue:   'bg-blue-600/15 text-blue-400 hover:bg-blue-600/25 ring-blue-500/20',
    gray:   'bg-gray-600/15 text-gray-300 hover:bg-gray-600/25 ring-gray-500/20',
  };
  const btn = (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-medium ring-1 transition-all disabled:opacity-40 ${styles[color] || styles.gray}`}
    >
      {icon}{children}
    </button>
  );
  // Disabled buttons don't fire hover, so the tooltip lives on a wrapper.
  return title ? <span title={title} className="inline-flex">{btn}<span className="sr-only">{title}</span></span> : btn;
}

export function InputField({ label, value, onChange, placeholder, type = 'text' }) {
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
