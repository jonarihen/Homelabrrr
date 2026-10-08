import { useCallback, useEffect, useState } from 'react';
import api from '../../api.js';
import { manualPowerDurationRequest } from '../../utils/manualPowerDuration.js';

const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const modes = [['low', 'Static Low Power'], ['dynamic', 'Dynamic / Balanced'], ['high', 'Static High Performance']];
const preset = () => [
  { days: 0b0111110, start: '16:00', end: '02:00', mode: 'high' },
  { days: 0b1000001, start: '12:00', end: '22:00', mode: 'high' },
];
const modeLabel = (mode) => modes.find(([value]) => value === mode)?.[1] || 'No automatic change';
const copenhagenTime = (value) => value ? new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Copenhagen', weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  timeZoneName: 'shortOffset',
}).format(new Date(value)) : 'Not known';

function PowerPreviewTimeline({ preview }) {
  const [showAll, setShowAll] = useState(false);
  const timeline = preview.sevenDayPreview;
  const segments = timeline?.segments || [];
  const visible = showAll ? segments : segments.slice(0, 48);
  return <section className="mt-3 border border-gray-700 bg-gray-900/60 p-3" aria-label="Seven-day power mode preview">
    <h3 className="uppercase tracking-wider text-orange-400">Saved policy · next seven days</h3>
    <p className="mt-2 text-gray-300">At {copenhagenTime(preview.at)} · observed {preview.observedMode === 'unknown' ? 'Unknown' : modeLabel(preview.observedMode)} · selected {preview.selectedMode ? modeLabel(preview.selectedMode) : 'No automatic change'} · reason {preview.reason.replaceAll('_', ' ')}.</p>
    <p className="mt-1 text-gray-400">Next schedule change: {copenhagenTime(timeline?.nextScheduleTransition)} · next known selected-mode change: {copenhagenTime(timeline?.nextKnownTransition)}.</p>
    <p className="mt-1 text-amber-400">Future selections after published price coverage are unknown. This preview is read-only and uses the saved policy.</p>
    <div className="mt-3 max-h-80 overflow-auto border border-gray-700">
      <table className="w-full min-w-[760px] border-collapse text-left"><caption className="sr-only">Copenhagen time, baseline, selected mode, reason and applicable price for each policy interval</caption>
        <thead className="sticky top-0 bg-gray-950 text-gray-400"><tr><th className="p-2">From</th><th className="p-2">Until</th><th className="p-2">Baseline</th><th className="p-2">Selected mode</th><th className="p-2">Reason</th><th className="p-2">Price</th></tr></thead>
        <tbody>{visible.map((segment) => <tr key={segment.startUtc} className="border-t border-gray-800 align-top">
          <td className="p-2">{copenhagenTime(segment.startUtc)}</td><td className="p-2">{copenhagenTime(segment.endUtc)}</td><td className="p-2">{modeLabel(segment.baseMode)}</td>
          <td className={`p-2 ${segment.futurePriceUnknown ? 'text-amber-400' : 'text-gray-100'}`}>{segment.futurePriceUnknown ? 'Unknown after published prices' : modeLabel(segment.selectedMode)}</td>
          <td className="p-2">{segment.reason.replaceAll('_', ' ')}</td><td className="p-2">{segment.priceDkkPerKwh == null ? 'Unavailable' : `${segment.priceDkkPerKwh} kr./kWh`}</td>
        </tr>)}</tbody>
      </table>
    </div>
    {segments.length > 48 && <button type="button" onClick={() => setShowAll((value) => !value)} className="mt-2 border border-gray-600 px-2 py-1 text-orange-400">{showAll ? 'Show first 48 intervals' : `Show all ${segments.length} intervals`}</button>}
  </section>;
}

function ModeSelect({ value, onChange, omitHigh = false }) {
  return <select value={value} onChange={(event) => onChange(event.target.value)} className="border border-gray-700 bg-gray-900 px-2 py-1 text-gray-100">
    {modes.filter(([mode]) => !omitHigh || mode !== 'high').map(([mode, label]) => <option key={mode} value={mode}>{label}</option>)}
  </select>;
}

export default function HardwarePowerPolicy({ connection, onConnectionChange }) {
  const [record, setRecord] = useState(null);
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [manualMode, setManualMode] = useState('low');
  const [durationKind, setDurationKind] = useState('minutes');
  const [duration, setDuration] = useState(180);
  const [preview, setPreview] = useState(null);
  const refresh = useCallback(async () => {
    const { data } = await api.get(`/admin/power-control/${connection.id}`);
    setRecord(data);
    setDraft({ ...data.policy, schedule: structuredClone(data.policy.schedule), pricePolicy: structuredClone(data.policy.pricePolicy) });
  }, [connection.id]);
  useEffect(() => { refresh().catch(() => setError('Could not load power policy')); }, [refresh]);
  const change = (section, patch) => setDraft((current) => ({ ...current, [section]: { ...current[section], ...patch } }));
  const priceRule = (name, patch) => setDraft((current) => ({ ...current, pricePolicy: {
    ...current.pricePolicy, [name]: { ...current.pricePolicy[name], ...patch },
  } }));
  const action = async (fn) => {
    setBusy(true); setError(''); setNotice('');
    try { await fn(); await refresh(); }
    catch (err) { setError(err.response?.data?.error || 'Power policy request failed'); }
    finally { setBusy(false); }
  };
  const save = () => action(async () => {
    await api.put(`/admin/power-control/${connection.id}`, {
      version: draft.version, automationEnabled: draft.automationEnabled,
      schedule: draft.schedule, pricePolicy: draft.pricePolicy,
    });
    setNotice('Power policy saved. Hardware changes still require separate enablement.');
    setPreview(null);
  });
  const control = (enable) => action(async () => {
    if (enable && !window.confirm('Enable live iLO Power Regulator changes for this physical server? The server and VMs stay running.')) return;
    await api.post(`/admin/power-control/${connection.id}/${enable ? 'enable' : 'disable'}`, enable ? { acknowledgeLiveControl: true } : {});
    onConnectionChange({ ...connection, control_enabled: enable });
    setNotice(enable ? 'Live mode control enabled.' : 'Live mode control disabled. In-flight commands cannot be recalled.');
  });
  const mutateVersion = (path, body) => action(async () => {
    await api.post(`/admin/power-control/${connection.id}/${path}`, { version: record.policy.version, ...body });
    setNotice('Power control state updated.');
  });
  if (!draft || !record) return <p className="mt-3 text-gray-500">Loading power policy…</p>;
  const schedule = draft.schedule;
  const policy = draft.pricePolicy;
  return <section className="mt-3 border-t border-gray-700/50 pt-3 text-xs font-mono text-gray-300">
    <div className="flex flex-wrap items-center gap-3">
      <span className="uppercase tracking-widest text-orange-400">Power policy</span>
      <span>Actual last verified: {record.policy.lastVerifiedMode || 'unknown'}</span>
      <span>Last outcome: {record.policy.lastOutcome || 'none'}</span>
      <span>Control: {record.controlEnabled ? 'enabled' : 'disabled'}</span>
      <span>Global automation: {record.globalPaused ? 'paused' : 'running'}</span>
    </div>
    {error && <p role="alert" className="mt-2 text-red-400">{error}</p>}
    {notice && <p role="status" className="mt-2 text-green-400">{notice}</p>}
    <div className="mt-3 flex flex-wrap gap-2">
      <button disabled={busy || record.controlEnabled || record.capability !== 'supported'} onClick={() => control(true)} className="border border-orange-600 px-2 py-1 text-orange-400 disabled:opacity-40">Enable live control</button>
      <button disabled={busy || !record.controlEnabled} onClick={() => control(false)} className="border border-red-700 px-2 py-1 text-red-400 disabled:opacity-40">Disable live control</button>
      <button disabled={busy} onClick={() => mutateVersion('pause', { paused: !record.policy.paused })} className="border border-gray-600 px-2 py-1">{record.policy.paused ? 'Resume node automation' : 'Pause node automation'}</button>
      {record.policy.driftHold && <button disabled={busy} onClick={() => mutateVersion('resume-drift', {})} className="border border-amber-600 px-2 py-1 text-amber-400">Resume after external mode change</button>}
      <button disabled={busy} onClick={() => action(async () => { await api.post('/admin/power-control/global/pause', { paused: !record.globalPaused }); setNotice(record.globalPaused ? 'All automatic power changes resumed.' : 'All automatic power changes paused.'); })} className="border border-gray-600 px-2 py-1">{record.globalPaused ? 'Resume all automation' : 'Pause all automation'}</button>
    </div>
    <div className="mt-4 grid gap-4 xl:grid-cols-2">
      <div className="border border-gray-700 bg-gray-900/40 p-3">
        <h3 className="mb-3 uppercase tracking-wider text-gray-100">Weekly schedule</h3>
        <label className="block"><input type="checkbox" checked={schedule.enabled} onChange={(event) => change('schedule', { enabled: event.target.checked })} /> Enable weekly schedule</label>
        <div className="mt-2 flex flex-wrap items-center gap-2"><label>Time zone <input value={schedule.timezone} onChange={(event) => change('schedule', { timezone: event.target.value })} className="w-40 border border-gray-700 bg-gray-900 px-2 py-1" /></label><label>Outside windows <ModeSelect value={schedule.defaultMode} onChange={(mode) => change('schedule', { defaultMode: mode })} /></label></div>
        <div className="mt-2 flex gap-2"><button onClick={() => change('schedule', { windows: preset(), timezone: 'Europe/Copenhagen', defaultMode: 'low' })} className="border border-orange-700 px-2 py-1 text-orange-400">Load requested preset</button><button onClick={() => change('schedule', { windows: [...schedule.windows, { days: 2, start: '16:00', end: '22:00', mode: 'high' }] })} className="border border-gray-600 px-2 py-1">Add window</button></div>
        <p className="mt-2 text-gray-500">Overnight windows belong to their start day. Monday–Friday 16:00–02:00, Saturday–Sunday 12:00–22:00.</p>
        {schedule.windows.map((window, index) => <div key={index} className="mt-3 border-t border-gray-700 pt-2">
          <div className="flex flex-wrap gap-1">{days.map((day, number) => <label key={day} className="border border-gray-700 px-1"><input type="checkbox" checked={Boolean(window.days & (1 << number))} onChange={(event) => change('schedule', { windows: schedule.windows.map((item, i) => i === index ? { ...item, days: event.target.checked ? item.days | (1 << number) : item.days & ~(1 << number) } : item) })} /> {day}</label>)}</div>
          <div className="mt-2 flex flex-wrap items-center gap-2"><input aria-label="Window start" type="time" value={window.start} onChange={(event) => change('schedule', { windows: schedule.windows.map((item, i) => i === index ? { ...item, start: event.target.value } : item) })} className="border border-gray-700 bg-gray-900 px-2 py-1" /><span>to</span><input aria-label="Window end" type="time" value={window.end} onChange={(event) => change('schedule', { windows: schedule.windows.map((item, i) => i === index ? { ...item, end: event.target.value } : item) })} className="border border-gray-700 bg-gray-900 px-2 py-1" /><ModeSelect value={window.mode} onChange={(mode) => change('schedule', { windows: schedule.windows.map((item, i) => i === index ? { ...item, mode } : item) })} /><button onClick={() => change('schedule', { windows: schedule.windows.filter((_, i) => i !== index) })} className="text-red-400">Remove</button></div>
        </div>)}
      </div>
      <div className="border border-gray-700 bg-gray-900/40 p-3">
        <h3 className="mb-3 uppercase tracking-wider text-gray-100">Electricity price rules</h3>
        <label className="block"><input type="checkbox" checked={policy.enabled} onChange={(event) => change('pricePolicy', { enabled: event.target.checked })} /> Enable price-aware selection</label>
        <div className="mt-2 grid gap-2 sm:grid-cols-2"><label>Price basis<select value={policy.basis} onChange={(event) => change('pricePolicy', { basis: event.target.value })} className="block w-full border border-gray-700 bg-gray-900 px-2 py-1"><option value="variable_retail_including_vat">Variable retail incl. VAT</option><option value="spot_only_excluding_retail_additions">Spot only (excludes retail charges)</option></select></label><label>Area<input value={policy.area} onChange={(event) => change('pricePolicy', { area: event.target.value })} placeholder="Configured contract area" className="block w-full border border-gray-700 bg-gray-900 px-2 py-1" /></label><label>Contract reference<input value={policy.contractRef} onChange={(event) => change('pricePolicy', { contractRef: event.target.value })} className="block w-full border border-gray-700 bg-gray-900 px-2 py-1" /></label><label>Price-only default<ModeSelect value={policy.priceOnlyDefault || 'low'} onChange={(mode) => change('pricePolicy', { priceOnlyDefault: mode })} /></label><label>Minimum automatic upshift minutes<input type="number" min="0" max="1440" value={policy.minAutomaticUpshiftMinutes ?? 5} onChange={(event) => change('pricePolicy', { minAutomaticUpshiftMinutes: Number(event.target.value) })} className="ml-2 w-20 border border-gray-700 bg-gray-900 px-2 py-1" /></label></div>
        <div className="mt-3 border-t border-gray-700 pt-2"><label><input type="checkbox" checked={policy.expensive.enabled} onChange={(event) => priceRule('expensive', { enabled: event.target.checked })} /> Above upper price, cap performance</label><div className="mt-2 flex flex-wrap items-center gap-2"><label>Upper kr./kWh<input inputMode="decimal" value={policy.expensive.threshold} onChange={(event) => priceRule('expensive', { threshold: event.target.value })} className="ml-2 w-20 border border-gray-700 bg-gray-900 px-2 py-1" /></label><label>Hysteresis<input inputMode="decimal" value={policy.expensive.hysteresis} onChange={(event) => priceRule('expensive', { hysteresis: event.target.value })} className="ml-2 w-20 border border-gray-700 bg-gray-900 px-2 py-1" /></label><ModeSelect value={policy.expensive.capMode} omitHigh onChange={(capMode) => priceRule('expensive', { capMode })} /></div></div>
        <div className="mt-3 border-t border-gray-700 pt-2"><label><input type="checkbox" checked={policy.cheap.enabled} onChange={(event) => priceRule('cheap', { enabled: event.target.checked })} /> Below lower price, boost to High</label><div className="mt-2 flex flex-wrap items-center gap-2"><label>Lower kr./kWh<input inputMode="decimal" value={policy.cheap.threshold} onChange={(event) => priceRule('cheap', { threshold: event.target.value })} className="ml-2 w-20 border border-gray-700 bg-gray-900 px-2 py-1" /></label><label>Hysteresis<input inputMode="decimal" value={policy.cheap.hysteresis} onChange={(event) => priceRule('cheap', { hysteresis: event.target.value })} className="ml-2 w-20 border border-gray-700 bg-gray-900 px-2 py-1" /></label></div></div>
        <p className="mt-3 text-gray-500">Price rules use valid current DKK/kWh intervals only. Missing or incomplete prices fall back to the weekly schedule or chosen default.</p>
      </div>
    </div>
    <div className="mt-3 flex items-center gap-3"><label><input type="checkbox" checked={draft.automationEnabled} onChange={(event) => setDraft((current) => ({ ...current, automationEnabled: event.target.checked }))} /> Allow automatic changes</label><button disabled={busy} onClick={save} className="border border-orange-600 px-3 py-2 uppercase text-orange-400 disabled:opacity-50">Save policy</button><button disabled={busy || !record.policy.version} onClick={() => action(async () => { setPreview((await api.get(`/admin/power-control/${connection.id}/preview`)).data); })} className="border border-gray-600 px-3 py-2 uppercase disabled:opacity-50">Preview saved policy</button></div>
    {preview && <PowerPreviewTimeline preview={preview} />}
    <div className="mt-4 border-t border-gray-700 pt-3">
      <h3 className="mb-2 uppercase text-gray-100">Manual mode override</h3>
      <div className="flex flex-wrap items-center gap-2">
        <ModeSelect value={manualMode} onChange={setManualMode} />
        <label>Duration
          <select aria-label="Override duration" value={durationKind} onChange={(event) => setDurationKind(event.target.value)} className="ml-2 border border-gray-700 bg-gray-900 px-2 py-1">
            <option value="minutes">Fixed minutes</option>
            <option value="next_schedule_boundary" disabled={!record.policy.schedule.enabled}>Until next weekly boundary</option>
            <option value="until_cleared">Until I clear it</option>
          </select>
        </label>
        {durationKind === 'minutes' && <label>Minutes<input type="number" min="1" max="1440" value={duration} onChange={(event) => setDuration(Number(event.target.value))} className="ml-2 w-20 border border-gray-700 bg-gray-900 px-2 py-1" /></label>}
        <button disabled={busy || !record.controlEnabled || (durationKind === 'next_schedule_boundary' && !record.policy.schedule.enabled)} onClick={() => mutateVersion('manual', manualPowerDurationRequest(manualMode, durationKind, duration))} className="border border-orange-600 px-2 py-1 text-orange-400 disabled:opacity-40">Apply now</button>
        {record.policy.manualMode && <>
          <span>Override: {record.policy.manualMode} until {record.policy.manualExpiresAt ? new Date(record.policy.manualExpiresAt).toLocaleString() : 'cleared manually'}</span>
          <button disabled={busy} onClick={() => action(async () => { await api.delete(`/admin/power-control/${connection.id}/manual`, { data: { version: record.policy.version } }); setNotice('Manual override cleared.'); })} className="border border-gray-600 px-2 py-1">Clear override</button>
        </>}
      </div>
      {!record.policy.schedule.enabled && <p className="mt-2 text-gray-500">Save an enabled weekly schedule to use its next boundary.</p>}
      <p className="mt-2 text-amber-400">An explicit manual High selection can bypass the expensive-price cap. It never reboots a server or VM.</p>
    </div>
  </section>;
}
