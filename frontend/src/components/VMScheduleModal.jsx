import { useState, useEffect } from 'react';
import Modal from './Modal.jsx';
import api from '../api.js';
import {
  ALL_DAYS, WEEKDAYS, WEEKENDS, DAY_LABELS,
  dayActive, toggleDay, describeDays, localTimezone,
} from '../utils/schedule.js';

const inputCls = 'w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 transition-colors';

// Curated IANA zones for the datalist — any valid zone can still be typed.
const COMMON_TIMEZONES = [
  'UTC', 'Europe/Copenhagen', 'Europe/London', 'Europe/Berlin', 'Europe/Paris',
  'Europe/Madrid', 'Europe/Oslo', 'Europe/Stockholm', 'America/New_York',
  'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Sao_Paulo',
  'Asia/Dubai', 'Asia/Kolkata', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney',
];

// Render order: Mon-first, Sunday last (bit indices stay Sun=0..Sat=6).
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

export default function VMScheduleModal({ vm, node, vmid, onClose, onSaved }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [existing, setExisting] = useState(null);
  const [form, setForm] = useState({
    enabled: true,
    stopTime: '23:00',
    startTime: '08:00',
    days: ALL_DAYS,
    timezone: localTimezone(),
  });

  useEffect(() => {
    let cancelled = false;
    api.get(`/vms/${node}/${vmid}/schedule`)
      .then((r) => {
        if (cancelled) return;
        const s = r.data?.schedule;
        setExisting(s || null);
        if (s) {
          setForm({
            enabled: s.enabled,
            stopTime: s.stopTime || '23:00',
            startTime: s.startTime || '08:00',
            days: s.days || ALL_DAYS,
            timezone: s.timezone || localTimezone(),
          });
        }
      })
      .catch((e) => { if (!cancelled) setError(e.response?.data?.error || 'Failed to load schedule'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [node, vmid]);

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  const save = async () => {
    if (!form.stopTime || !form.startTime) return setError('Both a stop time and a start time are required');
    if (form.stopTime === form.startTime) return setError('Stop and start times cannot be identical');
    if (!form.days) return setError('Select at least one active day');
    setSaving(true); setError('');
    try {
      const r = await api.put(`/vms/${node}/${vmid}/schedule`, {
        enabled: form.enabled,
        stopTime: form.stopTime,
        startTime: form.startTime,
        days: form.days,
        timezone: form.timezone,
      });
      onSaved?.(r.data?.schedule || null);
      onClose();
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to save schedule');
    } finally { setSaving(false); }
  };

  const remove = async () => {
    setSaving(true); setError('');
    try {
      await api.delete(`/vms/${node}/${vmid}/schedule`);
      onSaved?.(null);
      onClose();
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to remove schedule');
      setSaving(false);
    }
  };

  const skipTonight = async () => {
    setSaving(true); setError(''); setNotice('');
    try {
      const r = await api.post(`/vms/${node}/${vmid}/schedule/skip`);
      setExisting(r.data?.schedule || null);
      onSaved?.(r.data?.schedule || null);
      setNotice('Skipping the next scheduled shutdown.');
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to skip');
    } finally { setSaving(false); }
  };

  const cancelSkip = async () => {
    setSaving(true); setError(''); setNotice('');
    try {
      const r = await api.delete(`/vms/${node}/${vmid}/schedule/skip`);
      setExisting(r.data?.schedule || null);
      onSaved?.(r.data?.schedule || null);
      setNotice('Skip cancelled — the schedule resumes normally.');
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to cancel skip');
    } finally { setSaving(false); }
  };

  const skipActive = existing?.skipActive;
  const skipUntilText = existing?.skipUntil ? new Date(existing.skipUntil).toLocaleString() : '';

  return (
    <Modal title="Power Schedule" onClose={saving ? () => {} : onClose} size="md">
      <div className="p-5 space-y-5">
        <p className="text-xs text-gray-400">
          Automatically shut <span className="font-mono text-gray-200">{vm?.name || `VM ${vmid}`}</span> down
          and start it back up on a recurring window — e.g. stop at 23:00, start at 08:00 on weekdays.
          A graceful shutdown is attempted first, with a hard stop as fallback. Manually starting the VM
          during its off-window keeps it running until the next scheduled stop.
        </p>

        {loading ? (
          <div className="space-y-3 animate-pulse">
            <div className="h-9 bg-gray-800 rounded-lg" />
            <div className="h-9 bg-gray-800 rounded-lg" />
            <div className="h-9 bg-gray-800 rounded-lg" />
          </div>
        ) : (
          <>
            {/* Enabled toggle */}
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(e) => set({ enabled: e.target.checked })}
                className="rounded border-gray-600 bg-gray-800 text-blue-500 focus:ring-blue-500/20"
              />
              <span className="text-sm text-gray-200">Enable automatic power schedule</span>
            </label>

            {/* Times */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block font-mono text-[11px] uppercase tracking-[0.1em] text-gray-500 mb-1.5">Stop at</label>
                <input type="time" value={form.stopTime} onChange={(e) => set({ stopTime: e.target.value })} className={inputCls} />
              </div>
              <div>
                <label className="block font-mono text-[11px] uppercase tracking-[0.1em] text-gray-500 mb-1.5">Start at</label>
                <input type="time" value={form.startTime} onChange={(e) => set({ startTime: e.target.value })} className={inputCls} />
              </div>
            </div>

            {/* Days */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="block font-mono text-[11px] uppercase tracking-[0.1em] text-gray-500">Active days</label>
                <div className="flex gap-1.5">
                  {[
                    { label: 'All', mask: ALL_DAYS },
                    { label: 'Weekdays', mask: WEEKDAYS },
                    { label: 'Weekends', mask: WEEKENDS },
                  ].map((preset) => (
                    <button
                      key={preset.label}
                      type="button"
                      onClick={() => set({ days: preset.mask })}
                      className={`px-2 py-0.5 rounded font-mono text-[10px] uppercase tracking-wide border transition-colors ${
                        form.days === preset.mask
                          ? 'border-orange-600 text-orange-400 bg-orange-600/10'
                          : 'border-gray-700 text-gray-400 hover:text-gray-200'
                      }`}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex gap-1.5">
                {DAY_ORDER.map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => set({ days: toggleDay(form.days, d) })}
                    className={`flex-1 py-2 rounded-lg font-mono text-[11px] uppercase tracking-wide border transition-colors ${
                      dayActive(form.days, d)
                        ? 'border-blue-500/50 bg-blue-600/15 text-blue-300'
                        : 'border-gray-700 bg-gray-800/50 text-gray-500 hover:text-gray-300'
                    }`}
                  >
                    {DAY_LABELS[d]}
                  </button>
                ))}
              </div>
              <p className="mt-1.5 text-xs text-gray-500">{describeDays(form.days)}</p>
            </div>

            {/* Timezone */}
            <div>
              <label className="block font-mono text-[11px] uppercase tracking-[0.1em] text-gray-500 mb-1.5">Timezone</label>
              <input
                list="vm-schedule-timezones"
                value={form.timezone}
                onChange={(e) => set({ timezone: e.target.value })}
                placeholder="Europe/Copenhagen"
                className={inputCls}
              />
              <datalist id="vm-schedule-timezones">
                {COMMON_TIMEZONES.map((tz) => <option key={tz} value={tz} />)}
              </datalist>
              <p className="mt-1.5 text-xs text-gray-500">Times are evaluated in this IANA timezone (DST-aware).</p>
            </div>

            {/* Skip tonight */}
            {existing?.enabled && (
              <div className="flex items-center justify-between bg-gray-800/40 border border-gray-700/50 rounded-lg px-3 py-2.5">
                <div className="text-xs">
                  {skipActive ? (
                    <span className="text-yellow-300">Skipping until {skipUntilText}</span>
                  ) : (
                    <span className="text-gray-400">Skip the next scheduled shutdown (one-off)</span>
                  )}
                </div>
                {skipActive ? (
                  <button type="button" onClick={cancelSkip} disabled={saving}
                    className="text-xs px-3 py-1.5 rounded-lg border border-gray-600 text-gray-300 hover:text-white transition-colors disabled:opacity-40">
                    Cancel skip
                  </button>
                ) : (
                  <button type="button" onClick={skipTonight} disabled={saving}
                    className="text-xs px-3 py-1.5 rounded-lg border border-yellow-600/50 text-yellow-300 hover:bg-yellow-600/10 transition-colors disabled:opacity-40">
                    Skip tonight
                  </button>
                )}
              </div>
            )}

            {notice && <p className="text-xs text-green-400 bg-green-900/20 rounded-lg p-2.5">{notice}</p>}
            {error && <p className="text-xs text-red-400 bg-red-900/20 rounded-lg p-2.5">{error}</p>}

            {/* Actions */}
            <div className="flex items-center justify-between gap-3 pt-1">
              <div>
                {existing && (confirmRemove ? (
                  <span className="inline-flex items-center gap-2 text-xs">
                    <span className="text-red-300">Remove schedule?</span>
                    <button type="button" onClick={remove} disabled={saving}
                      className="text-red-400 hover:text-red-300 font-medium disabled:opacity-40">Yes</button>
                    <button type="button" onClick={() => setConfirmRemove(false)} disabled={saving}
                      className="text-gray-500 hover:text-gray-300 disabled:opacity-40">No</button>
                  </span>
                ) : (
                  <button type="button" onClick={() => setConfirmRemove(true)} disabled={saving}
                    className="text-xs px-4 py-2 text-red-400 hover:text-red-300 transition-colors disabled:opacity-40">
                    Remove schedule
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-3">
                <button type="button" onClick={onClose} disabled={saving}
                  className="text-xs px-4 py-2 text-gray-400 hover:text-white transition-colors disabled:opacity-40">
                  Cancel
                </button>
                <button type="button" onClick={save} disabled={saving}
                  className="text-xs px-5 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded-lg font-medium transition-colors">
                  {saving ? 'Saving…' : 'Save schedule'}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
