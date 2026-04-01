import { useState } from 'react';
import api from '../api.js';
import { routeNode } from '../utils/nodeRef.js';

const inputCls = 'w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 transition-colors';

export default function VMHardwareModal({ vm, disks, onClose, onSaved }) {
  const vmNode = routeNode(vm);
  const [tab, setTab] = useState('cpu-mem');
  const [cores, setCores] = useState(vm.maxcpu || vm.cpus || 2);
  const [memory, setMemory] = useState(vm.maxmem ? Math.round(vm.maxmem / 1024 / 1024) : 2048);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Disk resize state
  const [selectedDisk, setSelectedDisk] = useState(disks[0]?.name || '');
  const [diskAddGb, setDiskAddGb] = useState(10);
  const [diskSaving, setDiskSaving] = useState(false);

  const isRunning = vm.status === 'running';

  const saveCpuMem = async () => {
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const body = {};
      const currentCores = vm.maxcpu || vm.cpus;
      const currentMemMb = vm.maxmem ? Math.round(vm.maxmem / 1024 / 1024) : null;

      if (parseInt(cores) !== currentCores) body.cores = parseInt(cores);
      if (parseInt(memory) !== currentMemMb) body.memory = parseInt(memory);

      if (!body.cores && !body.memory) {
        setError('No changes to save');
        setSaving(false);
        return;
      }

      await api.put(`/vms/${vmNode}/${vm.vmid}/hardware`, body);
      setSuccess(isRunning ? 'Saved. Changes take effect after VM reboot.' : 'Hardware updated successfully.');
      onSaved?.();
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to update hardware');
    } finally {
      setSaving(false);
    }
  };

  const resizeDisk = async () => {
    if (!selectedDisk || !diskAddGb || diskAddGb < 1) {
      setError('Select a disk and enter a valid size');
      return;
    }
    setDiskSaving(true);
    setError('');
    setSuccess('');
    try {
      await api.put(`/vms/${vmNode}/${vm.vmid}/resize-disk`, {
        disk: selectedDisk,
        size: `+${parseInt(diskAddGb)}G`,
      });
      setSuccess(`Disk ${selectedDisk} expanded by +${diskAddGb}G`);
      onSaved?.();
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to resize disk');
    } finally {
      setDiskSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl w-full max-w-lg mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <h2 className="text-white font-semibold text-sm">Edit Hardware — {vm.name || `VM ${vm.vmid}`}</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-white transition-colors">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 px-5 pt-4">
          <button
            onClick={() => setTab('cpu-mem')}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              tab === 'cpu-mem' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-800'
            }`}
          >CPU &amp; Memory</button>
          <button
            onClick={() => setTab('disk')}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              tab === 'disk' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-800'
            }`}
          >Disk Resize</button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-4">
          {tab === 'cpu-mem' && (
            <>
              {isRunning && (
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-yellow-900/20 border border-yellow-700/30">
                  <svg className="w-4 h-4 text-yellow-500 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
                  </svg>
                  <p className="text-xs text-yellow-400">VM is running. CPU/memory changes apply on next reboot.</p>
                </div>
              )}

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-gray-400 mb-1.5">CPU Cores</label>
                  <input
                    type="number"
                    min="1"
                    max="128"
                    value={cores}
                    onChange={(e) => setCores(e.target.value)}
                    className={inputCls}
                  />
                  <p className="text-[11px] text-gray-500 mt-1">Topology auto-calculated to match host</p>
                </div>
                <div>
                  <label className="block text-xs text-gray-400 mb-1.5">Memory (MB)</label>
                  <input
                    type="number"
                    min="128"
                    step="128"
                    value={memory}
                    onChange={(e) => setMemory(e.target.value)}
                    className={inputCls}
                  />
                  <p className="text-[11px] text-gray-500 mt-1">
                    {memory >= 1024 ? `${(memory / 1024).toFixed(1)} GB` : `${memory} MB`}
                  </p>
                </div>
              </div>

              {/* Quick memory presets */}
              <div className="flex flex-wrap gap-1.5">
                {[512, 1024, 2048, 4096, 8192, 16384, 32768].map((mb) => (
                  <button
                    key={mb}
                    type="button"
                    onClick={() => setMemory(mb)}
                    className={`text-[11px] px-2 py-1 rounded-md border transition-colors ${
                      parseInt(memory) === mb
                        ? 'border-blue-500 bg-blue-500/15 text-blue-300'
                        : 'border-gray-700 text-gray-500 hover:text-white hover:border-gray-600'
                    }`}
                  >
                    {mb >= 1024 ? `${mb / 1024}G` : `${mb}M`}
                  </button>
                ))}
              </div>

              <button
                onClick={saveCpuMem}
                disabled={saving}
                className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg py-2.5 text-sm font-medium transition-colors"
              >
                {saving ? 'Saving...' : 'Save CPU & Memory'}
              </button>
            </>
          )}

          {tab === 'disk' && (
            <>
              {disks.length === 0 ? (
                <p className="text-gray-500 text-sm text-center py-4">No disks found</p>
              ) : (
                <>
                  <div>
                    <label className="block text-xs text-gray-400 mb-1.5">Disk</label>
                    <select
                      value={selectedDisk}
                      onChange={(e) => setSelectedDisk(e.target.value)}
                      className={inputCls}
                    >
                      {disks.map((d) => (
                        <option key={d.name} value={d.name}>
                          {d.name} — {d.size} ({d.storage})
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs text-gray-400 mb-1.5">Expand by (GB)</label>
                    <input
                      type="number"
                      min="1"
                      value={diskAddGb}
                      onChange={(e) => setDiskAddGb(e.target.value)}
                      className={inputCls}
                    />
                    <p className="text-[11px] text-gray-500 mt-1">Disk resize is incremental and cannot be undone</p>
                  </div>

                  <button
                    onClick={resizeDisk}
                    disabled={diskSaving}
                    className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg py-2.5 text-sm font-medium transition-colors"
                  >
                    {diskSaving ? 'Resizing...' : `Expand ${selectedDisk} by +${diskAddGb}G`}
                  </button>
                </>
              )}
            </>
          )}

          {error && <p className="text-xs text-red-400 bg-red-900/20 rounded-lg p-2.5">{error}</p>}
          {success && <p className="text-xs text-green-400 bg-green-900/20 rounded-lg p-2.5">{success}</p>}
        </div>
      </div>
    </div>
  );
}
