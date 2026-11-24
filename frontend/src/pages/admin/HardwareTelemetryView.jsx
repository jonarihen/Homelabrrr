import { useEffect, useState } from 'react';
import api from '../../api.js';
import { formatFan, formatTemperature, healthAvailability } from '../../utils/hardwareHealth.js';
import { buildPowerChart, formatAge, formatWatts, telemetryState } from '../../utils/hardwareView.js';

const STATE_CLASS = { online: 'text-green-400', degraded: 'text-yellow-300', stale: 'text-yellow-300', offline: 'text-red-400', unsupported: 'text-gray-400', disabled: 'text-gray-400', no_data: 'text-gray-400', loading: 'text-gray-500' };
const STATE_LED = { online: 'aaris-led--ok', degraded: 'aaris-led--warning', stale: 'aaris-led--warning', offline: 'aaris-led--error', unsupported: 'aaris-led--off', disabled: 'aaris-led--off', no_data: 'aaris-led--off', loading: 'aaris-led--off' };
const MODE_COLOR = { high: '#f87171', dynamic: '#facc15', low: '#60a5fa' };
const CHART = { width: 300, height: 85 };
const BTN = 'shrink-0 border border-gray-700 px-3 py-1.5 text-xs font-medium text-gray-300 transition-colors hover:border-gray-600 hover:text-white disabled:cursor-not-allowed disabled:opacity-50';
const LABEL = 'text-[11px] uppercase tracking-wider text-gray-500';
const clock = (value) => new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export default function HardwareTelemetryView({ connection, onConnectionChange }) {
  const [telemetry, setTelemetry] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!connection) return;
    let live = true;
    const load = () => api.get(`/admin/hardware-connections/${connection.id}/telemetry?hours=24`)
      .then(({ data }) => { if (live) { setTelemetry(data); setError(''); } })
      .catch(() => { if (live) setError('Hardware history unavailable'); });
    load();
    const timer = setInterval(load, 60_000);
    return () => { live = false; clearInterval(timer); };
  }, [connection]);
  async function toggle() {
    setBusy(true); setError('');
    try {
      const { data } = await api.put(`/admin/hardware-connections/${connection.id}/collection`, { enabled: !connection.collection_enabled, configVersion: connection.config_version });
      onConnectionChange(data);
    } catch (err) { setError(err.response?.data?.error || 'Could not change collection'); }
    finally { setBusy(false); }
  }
  const chart = buildPowerChart(telemetry, CHART);
  const panel = telemetryState(connection, telemetry);
  const stats = telemetry?.stats;
  const summary = telemetry?.summary;
  const latest = telemetry?.latest;
  const health = latest?.health;
  const capabilities = connection.capabilities || {};
  const formatKwh = (value, covered, expected) => value == null ? 'No covered interval' : `${Number(value).toFixed(3)} kWh · ${Math.round(100 * Number(covered || 0) / Math.max(1, Number(expected || 1)))}% coverage`;
  const listItems = (items, format, more) => <>
    {items?.slice(0, 4).map((item, index) => <div key={`${item.name}-${index}`} className="text-gray-300">{item.name}: {format(item)}</div>)}
    {items?.length > 4 && <div className="text-gray-500">+{items.length - 4} {more}</div>}
  </>;
  return <section className="space-y-4 border border-gray-800 bg-gray-900 p-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <h3 className="font-mono text-xs uppercase tracking-widest text-orange-400">Power telemetry</h3>
        {!connection.system_uuid && <span className="text-xs text-gray-500">Test the connection before enabling</span>}
        {connection.system_uuid && connection.capabilities?.monitoring !== 'supported' && <span className="text-xs text-gray-500">Actual input watt metric unavailable</span>}
      </div>
      <button disabled={busy || (!connection.collection_enabled && (!connection.system_uuid || connection.last_status !== 'online' || connection.capabilities?.monitoring !== 'supported'))} onClick={toggle} className={BTN}>{connection.collection_enabled ? 'Stop collection' : 'Enable collection'}</button>
    </div>
    {error && <p role="alert" className="bg-red-900/20 p-2 text-xs text-red-400">{error}</p>}
    {(telemetry || !error) && <div className="flex items-center gap-2 text-sm"><span className={`aaris-led ${STATE_LED[panel.state]}`} aria-hidden="true" /><p className={STATE_CLASS[panel.state]} data-state={panel.state}>{panel.text}</p></div>}
    {!telemetry && !error && <div aria-hidden="true" className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">{[0, 1, 2].map((i) => <div key={i} className="h-20 animate-pulse border border-gray-800 bg-gray-800/40" />)}</div>
      <div className="h-24 animate-pulse border border-gray-800 bg-gray-800/40" />
    </div>}
    {telemetry && <>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="border border-gray-800 bg-gray-800/40 p-3"><span className={LABEL}>Current input</span><div className="mt-1 font-mono text-lg text-gray-100">{telemetry.latest ? `${Number(telemetry.latest.watts).toFixed(0)} W` : 'No measurement'}</div><span className="text-xs text-gray-500">{telemetry.latest ? `${telemetry.latest.stale ? 'Stale · ' : ''}${formatAge(telemetry.latest.ageSeconds)} old` : 'Unknown, not zero'}</span></div>
        <div className="border border-gray-800 bg-gray-800/40 p-3"><span className={LABEL}>Actual regulator</span><div className="mt-1 font-mono text-lg text-gray-100">{telemetry.latest?.mode || 'Unknown'}</div><span className="text-xs text-gray-500">Observed mode</span></div>
        <div className="border border-gray-800 bg-gray-800/40 p-3"><span className={LABEL}>Collection</span><div className="mt-1 font-mono text-lg text-gray-100">{connection.collection_enabled ? telemetry.lastErrorCode ? 'Degraded' : 'Enabled' : 'Disabled'}</div><span className="text-xs text-gray-500">{telemetry.lastErrorCode || 'No reported error'}</span></div>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="border border-gray-800 bg-gray-800/40 p-3"><span className={LABEL}>Last 24 hours · input watts</span>{stats?.samples ? <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 font-mono text-sm text-gray-100"><span>min {formatWatts(stats.min_watts)}</span><span>mean {formatWatts(stats.mean_watts)}</span><span>max {formatWatts(stats.max_watts)}</span><span className="text-gray-500">{stats.samples} readings</span></div> : <div className="mt-1 text-sm text-gray-500">No readings in range</div>}</div>
        <div className="border border-gray-800 bg-gray-800/40 p-3 text-sm text-gray-200"><span className={LABEL}>Today</span><div className="mt-1">{formatKwh(summary?.today_kwh, summary?.today_covered_seconds, summary?.today_expected_seconds)}</div></div>
        <div className="border border-gray-800 bg-gray-800/40 p-3 text-sm text-gray-200"><span className={LABEL}>Month</span><div className="mt-1">{formatKwh(summary?.month_kwh, summary?.month_covered_seconds, summary?.month_expected_seconds)}</div></div>
      </div>
      <div className="border border-gray-800 bg-gray-800/40 p-3">
        <div className="mb-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-gray-400"><span className={LABEL}>Thermal / cooling / power supplies</span>{latest && <span>· {latest.stale ? 'Stale' : 'Observed'} {latest.ageSeconds}s ago</span>}{health?.limited && <span>· Sensor list limited</span>}</div>
        <div className="grid gap-4 text-xs sm:grid-cols-3">
          <div className="space-y-0.5"><div className="mb-1 text-orange-400">Temperatures · {healthAvailability(latest, capabilities.temperatures, health?.temperatures)}</div>{listItems(health?.temperatures, (item) => <>{formatTemperature(item)}{item.health && ` · ${item.health}`}</>, 'more sensors')}</div>
          <div className="space-y-0.5"><div className="mb-1 text-orange-400">Fans · {healthAvailability(latest, capabilities.fans, health?.fans)}</div>{listItems(health?.fans, (item) => <>{formatFan(item)}{item.health && ` · ${item.health}`}</>, 'more fans')}</div>
          <div className="space-y-0.5"><div className="mb-1 text-orange-400">Power supplies · {healthAvailability(latest, capabilities.powerSupplies, health?.powerSupplies)}</div>{listItems(health?.powerSupplies, (item) => item.health || item.state || 'Status unavailable', 'more supplies')}<div className="pt-1 text-gray-400">Redundancy: {health?.powerRedundancy?.health || health?.powerRedundancy?.state || (capabilities.powerRedundancy === 'unsupported' ? 'Unsupported' : 'Unavailable')}</div></div>
        </div>
      </div>
      <div className="border border-gray-800 bg-gray-800/40 p-3">
        <div className="mb-2 flex flex-wrap justify-between gap-2 text-xs text-gray-500"><span>Input power · last 24 hours · watts (line = mean, band = min–max, gaps = no readings)</span>{chart.yMax != null && <span className="font-mono">peak {formatWatts(chart.yMax)}</span>}</div>
        {chart.segments.length ? <>
          <svg viewBox={`0 0 ${CHART.width} ${CHART.height}`} role="img" aria-label="Server power history in watts with regulator mode changes" className="h-24 w-full" preserveAspectRatio="none">
            {chart.bands.map((d, i) => <path key={`band-${i}`} d={d} fill="var(--accent, #ff5a1f)" fillOpacity="0.15" stroke="none" />)}
            {chart.markers.map((m) => <line key={`mode-${m.at}`} x1={m.x} x2={m.x} y1="0" y2={CHART.height} stroke={MODE_COLOR[m.mode] || '#9ca3af'} strokeDasharray="2 2" vectorEffect="non-scaling-stroke"><title>{`${m.previousMode} → ${m.mode} at ${new Date(m.at).toLocaleString()}`}</title></line>)}
            {chart.segments.map((d, i) => <path key={`line-${i}`} d={d} fill="none" stroke="var(--accent, #ff5a1f)" strokeWidth="2" vectorEffect="non-scaling-stroke" />)}
          </svg>
          <div className="mt-1 flex justify-between font-mono text-xs text-gray-500"><span>{clock(telemetry.range.start)}</span><span>{clock(telemetry.range.end)}</span></div>
          {chart.markers.length > 0 && <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-400">{chart.markers.slice(-6).map((m) => <span key={`label-${m.at}`}><span style={{ color: MODE_COLOR[m.mode] || '#9ca3af' }}>▏</span>{clock(m.at)} {m.previousMode} → {m.mode}</span>)}</div>}
        </> : <p className="text-sm text-gray-500">{panel.state === 'unsupported' ? 'Watt history unavailable on this iLO' : 'No readings in range'}</p>}
      </div>
    </>}
  </section>;
}
