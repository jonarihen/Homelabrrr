import { useCallback, useEffect, useState } from 'react';
import api from '../../api.js';
import { manualPowerDurationRequest } from '../../utils/manualPowerDuration.js';
import { POWER_MODES as modes, controlStatusLines, modeLabel, outcomeLabel, policyRequest } from '../../utils/powerPolicyView.js';

const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const toneClass = { warning: 'text-amber-400', error: 'text-red-400', info: 'text-gray-400' };
const BTN = 'shrink-0 border border-gray-700 px-3 py-1.5 text-xs font-medium text-gray-300 transition-colors hover:border-gray-600 hover:text-white disabled:cursor-not-allowed disabled:opacity-50';
const BTN_ACCENT = 'shrink-0 border border-orange-500/40 px-3 py-1.5 text-xs font-medium text-orange-400 transition-colors hover:bg-orange-500/10 disabled:cursor-not-allowed disabled:opacity-50';
const BTN_DANGER = 'shrink-0 border border-red-500/40 px-3 py-1.5 text-xs font-medium text-red-400 transition-colors hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-50';
const SUBPANEL = 'space-y-4 border border-gray-800 bg-gray-800/40 p-4';
const SUBHEAD = 'text-sm font-semibold text-gray-100';
const CHIP = 'border px-2 py-1 text-xs';
const TH = 'px-3 py-2 text-left font-medium';
const TD = 'px-3 py-2';
const preset = () => [
  { days: 0b0111110, start: '16:00', end: '02:00', mode: 'high' },
  { days: 0b1000001, start: '12:00', end: '22:00', mode: 'high' },
];
const copenhagenTime = (value) => value ? new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Copenhagen', weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  timeZoneName: 'shortOffset',
}).format(new Date(value)) : 'Not known';

// Label wrapping a control (including ModeSelect, which Field cannot tag by id).
function Lbl({ text, className = '', children }) {
  return <label className={`block ${className}`}><span className="mb-1.5 block text-xs text-gray-400">{text}</span>{children}</label>;
}
function Check({ checked, onChange, children }) {
  return <label className="flex items-center gap-2 text-sm text-gray-200"><input type="checkbox" checked={checked} onChange={onChange} className="h-4 w-4 accent-orange-500" /> {children}</label>;
}

function PowerPreviewTimeline({ preview }) {
  const [showAll, setShowAll] = useState(false);
  const timeline = preview.sevenDayPreview;
  const segments = timeline?.segments || [];
  const visible = showAll ? segments : segments.slice(0, 48);
  return <section className={SUBPANEL} aria-label="Seven-day power mode preview">
    <h4 className={SUBHEAD}>{preview.draft ? 'Unsaved draft' : 'Saved policy'} · next seven days</h4>
    <div className="space-y-1 text-sm">
      <p className="text-gray-300">At {copenhagenTime(preview.at)} · observed {preview.observedMode === 'unknown' ? 'Unknown' : preview.observedMode === 'os_control' ? 'OS Control' : modeLabel(preview.observedMode)} · selected {preview.selectedMode ? modeLabel(preview.selectedMode) : 'No automatic change'} · reason {preview.reason.replaceAll('_', ' ')}.</p>
      <p className="text-gray-400">Next schedule change: {copenhagenTime(timeline?.nextScheduleTransition)} · next known selected-mode change: {copenhagenTime(timeline?.nextKnownTransition)}.</p>
      {preview.policyError && <p className="text-red-400">Stored policy invalid: {preview.policyError}. Automation only restricts until it is fixed.</p>}
      {preview.ifEnabled && preview.reason === 'disabled' && <p className="text-gray-400">If control and automation were enabled: {modeLabel(preview.ifEnabled.selectedMode)} ({preview.ifEnabled.reason.replaceAll('_', ' ')}).</p>}
    </div>
    <p className="border-l-2 border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-400">Future selections after published price coverage are unknown. This preview is read-only and matches what the worker would do{preview.draft ? '; the draft is not saved' : ''}.</p>
    {segments.length === 0
      ? <p className="text-sm text-gray-500">No intervals in this preview.</p>
      : <div className="max-h-80 overflow-auto border border-gray-800 bg-gray-900">
        <table className="w-full min-w-[760px] border-collapse text-left text-sm"><caption className="sr-only">Copenhagen time, baseline, selected mode, reason and applicable price for each policy interval</caption>
          <thead className="sticky top-0 bg-gray-900"><tr className="border-b border-gray-800 text-xs uppercase tracking-wider text-gray-500"><th className={TH}>From</th><th className={TH}>Until</th><th className={TH}>Baseline</th><th className={TH}>Selected mode</th><th className={TH}>Reason</th><th className={TH}>Price</th></tr></thead>
          <tbody>{visible.map((segment) => <tr key={segment.startUtc} className="border-t border-gray-800 align-top hover:bg-gray-800/30">
            <td className={TD}>{copenhagenTime(segment.startUtc)}</td><td className={TD}>{copenhagenTime(segment.endUtc)}</td><td className={TD}>{modeLabel(segment.baseMode)}</td>
            <td className={`${TD} ${segment.futurePriceUnknown ? 'text-amber-400' : 'text-gray-100'}`}>{segment.futurePriceUnknown ? 'Unknown after published prices' : modeLabel(segment.selectedMode)}</td>
            <td className={TD}>{segment.reason.replaceAll('_', ' ')}</td><td className={`${TD} font-mono`}>{segment.priceDkkPerKwh == null ? 'Unavailable' : `${segment.priceDkkPerKwh} kr./kWh`}</td>
          </tr>)}</tbody>
        </table>
      </div>}
    {segments.length > 48 && <div><button type="button" onClick={() => setShowAll((value) => !value)} className={BTN_ACCENT}>{showAll ? 'Show first 48 intervals' : `Show all ${segments.length} intervals`}</button></div>}
  </section>;
}

function ModeSelect({ value, onChange, omitHigh = false, placeholder = null }) {
  return <select value={value || ''} onChange={(event) => onChange(event.target.value || undefined)} className="input">
    {placeholder && <option value="">{placeholder}</option>}
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
  const [operations, setOperations] = useState(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const refresh = useCallback(async () => {
    const { data } = await api.get(`/admin/power-control/${connection.id}`);
    setRecord(data);
    setOperations(null);
    setDraft({ ...data.policy, schedule: structuredClone(data.policy.schedule), pricePolicy: structuredClone(data.policy.pricePolicy) });
  }, [connection.id]);
  useEffect(() => { setLoadFailed(false); refresh().catch(() => { setLoadFailed(true); setError('Could not load power policy'); }); }, [refresh]);
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
    await api.put(`/admin/power-control/${connection.id}`, policyRequest(draft));
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
    const { data } = await api.post(`/admin/power-control/${connection.id}/${path}`, { version: record.policy.version, ...body });
    setNotice(data?.adoptedMode ? `Resumed. Current iLO mode ${modeLabel(data.adoptedMode)} is now the verified baseline.` : 'Power control state updated.');
  });
  const previewDraft = () => action(async () => {
    setPreview((await api.post(`/admin/power-control/${connection.id}/preview`, policyRequest(draft))).data);
  });
  const loadOperations = () => action(async () => {
    const { data } = await api.get(`/admin/power-control/${connection.id}/operations`);
    setOperations(data.operations);
  });
  if (!draft || !record) {
    if (loadFailed) return <section className="space-y-3 border border-gray-800 bg-gray-900 p-4">
      <h3 className="font-mono text-xs uppercase tracking-widest text-orange-400">Power policy</h3>
      <p role="alert" className="bg-red-900/20 p-2 text-xs text-red-400">{error}</p>
      <button type="button" onClick={() => { setError(''); setLoadFailed(false); refresh().catch(() => { setLoadFailed(true); setError('Could not load power policy'); }); }} className={BTN}>Retry</button>
    </section>;
    return <section role="status" aria-label="Loading power policy" className="space-y-3 border border-gray-800 bg-gray-900 p-4">
      <h3 className="font-mono text-xs uppercase tracking-widest text-orange-400">Power policy</h3>
      <div className="h-6 w-2/3 animate-pulse bg-gray-800/60" />
      <div className="h-24 animate-pulse border border-gray-800 bg-gray-800/40" />
      <p className="text-xs text-gray-500">Loading power policy…</p>
    </section>;
  }
  const schedule = draft.schedule;
  const policy = draft.pricePolicy;
  const setWindow = (index, patch) => change('schedule', { windows: schedule.windows.map((item, i) => i === index ? { ...item, ...patch } : item) });
  return <section className="space-y-5 border border-gray-800 bg-gray-900 p-4 text-sm text-gray-300">
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h3 className="font-mono text-xs uppercase tracking-widest text-orange-400">Power policy</h3>
        <div className="flex flex-wrap gap-2">
          <span className={`${CHIP} border-gray-700 text-gray-300`}>Actual last verified: {record.policy.lastVerifiedMode ? modeLabel(record.policy.lastVerifiedMode) : 'unknown'}</span>
          <span className={`${CHIP} border-gray-700 text-gray-300`}>Last outcome: {outcomeLabel(record.policy.lastOutcome)}</span>
          <span className={`${CHIP} ${record.controlEnabled ? 'border-amber-500/40 text-amber-400' : 'border-gray-700 text-gray-300'}`}>Control: {record.controlEnabled ? 'enabled' : 'disabled'}</span>
          <span className={`${CHIP} ${record.globalPaused ? 'border-amber-500/40 text-amber-400' : 'border-gray-700 text-gray-300'}`}>Global automation: {record.globalPaused ? 'paused' : 'running'}</span>
        </div>
      </div>
      {controlStatusLines(record.policy).map((line) => <p key={line.text} className={`text-xs ${toneClass[line.tone]}`}>{line.text}</p>)}
      {error && <p role="alert" className="bg-red-900/20 p-2 text-xs text-red-400">{error}</p>}
      {notice && <p role="status" className="bg-green-900/20 p-2 text-xs text-green-400">{notice}</p>}
    </div>

    <div className={SUBPANEL}>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <h4 className={SUBHEAD}>Live control</h4>
          <div className="flex flex-wrap gap-2">
            <button disabled={busy || record.controlEnabled || record.capability !== 'supported'} onClick={() => control(true)} className={BTN_ACCENT}>Enable live control</button>
            <button disabled={busy || !record.controlEnabled} onClick={() => control(false)} className={BTN_DANGER}>Disable live control</button>
          </div>
        </div>
        <div className="space-y-2">
          <h4 className={SUBHEAD}>Automation</h4>
          <div className="flex flex-wrap gap-2">
            <button disabled={busy} onClick={() => mutateVersion('pause', { paused: !record.policy.paused })} className={BTN}>{record.policy.paused ? 'Resume node automation' : 'Pause node automation'}</button>
            {record.policy.driftHold && <button disabled={busy} onClick={() => mutateVersion('resume-drift', {})} className="shrink-0 border border-amber-500/40 px-3 py-1.5 text-xs font-medium text-amber-400 transition-colors hover:bg-amber-500/10 disabled:cursor-not-allowed disabled:opacity-50">Resume after external mode change</button>}
            <button disabled={busy} onClick={() => action(async () => { await api.post('/admin/power-control/global/pause', { paused: !record.globalPaused }); setNotice(record.globalPaused ? 'All automatic power changes resumed.' : 'All automatic power changes paused.'); })} className={BTN}>{record.globalPaused ? 'Resume all automation' : 'Pause all automation'}</button>
          </div>
        </div>
      </div>
      <p className="text-xs text-gray-500">Pause stops all automatic changes (weekly and price) and leaves the hardware as it is. Disabling only the weekly schedule keeps an explicitly enabled price-only policy running. Disabling live control stops all writes; an already-sent request cannot be recalled.</p>
    </div>

    <div className="grid gap-5 xl:grid-cols-2">
      <div className={SUBPANEL}>
        <h4 className={SUBHEAD}>Weekly schedule</h4>
        <Check checked={schedule.enabled} onChange={(event) => change('schedule', { enabled: event.target.checked })}>Enable weekly schedule</Check>
        <div className="grid gap-4 sm:grid-cols-2">
          <Lbl text="Time zone"><input value={schedule.timezone} onChange={(event) => change('schedule', { timezone: event.target.value })} className="input" /></Lbl>
          <Lbl text="Outside windows"><ModeSelect value={schedule.defaultMode} onChange={(mode) => change('schedule', { defaultMode: mode })} /></Lbl>
        </div>
        <div className="flex flex-wrap gap-2">
          <button onClick={() => change('schedule', { windows: preset(), timezone: 'Europe/Copenhagen', defaultMode: 'low' })} className={BTN_ACCENT}>Load requested preset</button>
          <button onClick={() => change('schedule', { windows: [...schedule.windows, { days: 2, start: '16:00', end: '22:00', mode: 'high' }] })} className={BTN}>Add window</button>
        </div>
        <p className="text-xs text-gray-500">Overnight windows belong to their start day. Monday–Friday 16:00–02:00, Saturday–Sunday 12:00–22:00.</p>
        {schedule.windows.length === 0 && <p className="border border-dashed border-gray-700 p-3 text-center text-xs text-gray-500">No windows yet. Add one or load the requested preset.</p>}
        {schedule.windows.map((window, index) => <div key={index} className="space-y-3 border border-gray-800 bg-gray-900 p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs uppercase tracking-wider text-gray-500">Window {index + 1}</span>
            <button onClick={() => change('schedule', { windows: schedule.windows.filter((_, i) => i !== index) })} aria-label={`Remove window ${index + 1}`} className={BTN_DANGER}>Remove</button>
          </div>
          <div className="flex flex-wrap gap-2">{days.map((day, number) => <label key={day} className={`${CHIP} flex cursor-pointer items-center gap-1.5 border-gray-700 text-gray-300 has-[:checked]:border-orange-500/60 has-[:checked]:text-orange-400`}><input type="checkbox" checked={Boolean(window.days & (1 << number))} onChange={(event) => setWindow(index, { days: event.target.checked ? window.days | (1 << number) : window.days & ~(1 << number) })} className="accent-orange-500" /> {day}</label>)}</div>
          <div className="grid gap-3 sm:grid-cols-3">
            <Lbl text="Start"><input aria-label="Window start" type="time" value={window.start} onChange={(event) => setWindow(index, { start: event.target.value })} className="input" /></Lbl>
            <Lbl text="End"><input aria-label="Window end" type="time" value={window.end} onChange={(event) => setWindow(index, { end: event.target.value })} className="input" /></Lbl>
            <Lbl text="Mode"><ModeSelect value={window.mode} onChange={(mode) => setWindow(index, { mode })} /></Lbl>
          </div>
        </div>)}
      </div>

      <div className={SUBPANEL}>
        <h4 className={SUBHEAD}>Electricity price rules</h4>
        <Check checked={policy.enabled} onChange={(event) => change('pricePolicy', { enabled: event.target.checked })}>Enable price-aware selection</Check>
        <div className="grid gap-4 sm:grid-cols-2">
          <Lbl text="Price basis"><select value={policy.basis} onChange={(event) => change('pricePolicy', { basis: event.target.value })} className="input"><option value="variable_retail_including_vat">Variable retail incl. VAT</option><option value="spot_only_excluding_retail_additions">Spot only (excludes retail charges)</option></select></Lbl>
          <Lbl text="Area"><input value={policy.area} onChange={(event) => change('pricePolicy', { area: event.target.value })} placeholder="Configured contract area" className="input" /></Lbl>
          <Lbl text="Contract reference"><input value={policy.contractRef} onChange={(event) => change('pricePolicy', { contractRef: event.target.value })} className="input" /></Lbl>
          <Lbl text="Price-only default"><ModeSelect value={policy.priceOnlyDefault} placeholder="Choose a mode…" onChange={(mode) => change('pricePolicy', { priceOnlyDefault: mode })} /></Lbl>
          <Lbl text="Minimum automatic upshift minutes"><input type="number" min="0" max="1440" value={policy.minAutomaticUpshiftMinutes ?? 5} onChange={(event) => change('pricePolicy', { minAutomaticUpshiftMinutes: Number(event.target.value) })} className="input" /></Lbl>
        </div>
        <div className="space-y-3 border-t border-gray-800 pt-4">
          <Check checked={policy.expensive.enabled} onChange={(event) => priceRule('expensive', { enabled: event.target.checked })}>Above upper price, cap performance</Check>
          <div className="grid gap-4 sm:grid-cols-3">
            <Lbl text="Upper kr./kWh"><input inputMode="decimal" value={policy.expensive.threshold} onChange={(event) => priceRule('expensive', { threshold: event.target.value })} className="input" /></Lbl>
            <Lbl text="Hysteresis"><input inputMode="decimal" value={policy.expensive.hysteresis} onChange={(event) => priceRule('expensive', { hysteresis: event.target.value })} className="input" /></Lbl>
            <Lbl text="Cap mode"><ModeSelect value={policy.expensive.capMode} omitHigh onChange={(capMode) => priceRule('expensive', { capMode })} /></Lbl>
          </div>
        </div>
        <div className="space-y-3 border-t border-gray-800 pt-4">
          <Check checked={policy.cheap.enabled} onChange={(event) => priceRule('cheap', { enabled: event.target.checked })}>Below lower price, boost to High</Check>
          <div className="grid gap-4 sm:grid-cols-3">
            <Lbl text="Lower kr./kWh"><input inputMode="decimal" value={policy.cheap.threshold} onChange={(event) => priceRule('cheap', { threshold: event.target.value })} className="input" /></Lbl>
            <Lbl text="Hysteresis"><input inputMode="decimal" value={policy.cheap.hysteresis} onChange={(event) => priceRule('cheap', { hysteresis: event.target.value })} className="input" /></Lbl>
          </div>
        </div>
        <div className="space-y-1 text-xs text-gray-500">
          <p>Price rules use valid current DKK/kWh intervals only. Missing or incomplete prices fall back to the weekly schedule or chosen default. Comma decimals are accepted and stored as exact values.</p>
          <p>This price cap only limits the selected Power Regulator mode. It is not an iLO watt cap and never shuts a server down.</p>
        </div>
      </div>
    </div>

    <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-t border-gray-800 pt-4">
      <Check checked={draft.automationEnabled} onChange={(event) => setDraft((current) => ({ ...current, automationEnabled: event.target.checked }))}>Allow automatic changes</Check>
      <div className="flex flex-wrap items-center gap-2">
        <button disabled={busy} onClick={save} className="btn-primary px-4 py-2 text-sm font-medium">Save policy</button>
        <button disabled={busy || !record.policy.version} onClick={() => action(async () => { setPreview((await api.get(`/admin/power-control/${connection.id}/preview`)).data); })} className={`${BTN} py-2 text-sm`}>Preview saved policy</button>
        <button disabled={busy} onClick={previewDraft} className={`${BTN} py-2 text-sm`}>Preview draft</button>
      </div>
    </div>
    {preview && <PowerPreviewTimeline preview={preview} />}

    <div className={SUBPANEL}>
      <h4 className={SUBHEAD}>Manual mode override</h4>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Lbl text="Mode"><ModeSelect value={manualMode} onChange={setManualMode} /></Lbl>
        <Lbl text="Duration">
          <select aria-label="Override duration" value={durationKind} onChange={(event) => setDurationKind(event.target.value)} className="input">
            <option value="minutes">Fixed minutes</option>
            <option value="next_schedule_boundary" disabled={!record.policy.schedule.enabled}>Until next weekly boundary</option>
            <option value="until_cleared">Until I clear it</option>
          </select>
        </Lbl>
        {durationKind === 'minutes' && <Lbl text="Minutes"><input type="number" min="1" max="1440" value={duration} onChange={(event) => setDuration(Number(event.target.value))} className="input" /></Lbl>}
        <div className="flex items-end"><button disabled={busy || !record.controlEnabled || (durationKind === 'next_schedule_boundary' && !record.policy.schedule.enabled)} onClick={() => mutateVersion('manual', manualPowerDurationRequest(manualMode, durationKind, duration))} className={`${BTN_ACCENT} py-2 text-sm`}>Apply now</button></div>
      </div>
      {record.policy.manualMode && <div className="flex flex-wrap items-center justify-between gap-2 border-l-2 border-amber-500/40 bg-amber-500/5 px-3 py-2">
        <span className="text-xs text-amber-400">Override: {record.policy.manualMode} until {record.policy.manualExpiresAt ? new Date(record.policy.manualExpiresAt).toLocaleString() : 'cleared manually'}</span>
        <button disabled={busy} onClick={() => action(async () => { await api.delete(`/admin/power-control/${connection.id}/manual`, { data: { version: record.policy.version } }); setNotice('Manual override cleared.'); })} className={BTN}>Clear override</button>
      </div>}
      {!record.policy.schedule.enabled && <p className="text-xs text-gray-500">Save an enabled weekly schedule to use its next boundary.</p>}
      <p className="text-xs text-amber-400">An explicit manual High selection can bypass the expensive-price cap. It never reboots a server or VM.</p>
    </div>

    <div className={SUBPANEL}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h4 className={SUBHEAD}>Mode change history</h4>
        <button disabled={busy} onClick={loadOperations} className={BTN}>{busy && !operations ? 'Loading…' : operations ? 'Refresh' : 'Show last 50'}</button>
      </div>
      {operations && (operations.length === 0 ? <p className="border border-dashed border-gray-700 p-3 text-center text-xs text-gray-500">No mode operations recorded.</p>
        : <div className="max-h-64 overflow-auto border border-gray-800 bg-gray-900"><table className="w-full min-w-[720px] text-left text-sm"><thead className="sticky top-0 bg-gray-900"><tr className="border-b border-gray-800 text-xs uppercase tracking-wider text-gray-500"><th className={TH}>When</th><th className={TH}>Actor</th><th className={TH}>Change</th><th className={TH}>Reason</th><th className={TH}>Outcome</th><th className={TH}>Price</th></tr></thead>
          <tbody>{operations.map((op) => <tr key={op.id} className="border-t border-gray-800 hover:bg-gray-800/30">
            <td className={TD}>{copenhagenTime(op.occurred_at)}</td><td className={TD}>{op.actor}{op.actor_user_id ? ` #${op.actor_user_id}` : ''}</td>
            <td className={TD}>{op.prior_mode || '?'} → {op.target_mode || '?'}</td><td className={TD}>{op.reason.replaceAll('_', ' ')}</td>
            <td className={TD}>{outcomeLabel(op.outcome)}{op.error_category ? ` (${op.error_category.replaceAll('_', ' ')})` : ''}</td>
            <td className={`${TD} font-mono`}>{op.price_dkk_per_kwh == null ? '—' : `${op.price_dkk_per_kwh} kr./kWh`}</td>
          </tr>)}</tbody></table></div>)}
    </div>
  </section>;
}
