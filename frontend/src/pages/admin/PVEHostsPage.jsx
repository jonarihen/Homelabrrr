import { useState, useEffect } from 'react';
import api from '../../api.js';
import useDocumentTitle from '../../hooks/useDocumentTitle.js';

export default function PVEHostsPage() {
  useDocumentTitle('PVE Hosts');
  const [hosts, setHosts] = useState([]);
  const [statuses, setStatuses] = useState({});
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState({ name: '', host: '', port: 8006, tokenId: '', tokenSecret: '', verifyTls: true });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const load = () => {
    api.get('/admin/pve-hosts').then(r => {
      setHosts(r.data);
      setLoading(false);
      // Fetch status for each host
      r.data.forEach(h => {
        setStatuses(prev => ({ ...prev, [h.id]: { loading: true } }));
        api.get(`/admin/pve-hosts/${h.id}/status`).then(sr => {
          setStatuses(prev => ({ ...prev, [h.id]: { ...sr.data, loading: false } }));
        }).catch(() => {
          setStatuses(prev => ({ ...prev, [h.id]: { online: false, loading: false, error: 'Failed to check' } }));
        });
      });
    }).catch(() => setLoading(false));
  };

  useEffect(load, []);

  const openAdd = () => {
    setEditId(null);
    setForm({ name: '', host: '', port: 8006, tokenId: '', tokenSecret: '', verifyTls: true });
    setError('');
    setShowForm(true);
  };

  const openEdit = (h) => {
    setEditId(h.id);
    setForm({ name: h.name, host: h.host, port: h.port, tokenId: h.token_id, tokenSecret: '', verifyTls: !!h.verify_tls });
    setError('');
    setShowForm(true);
  };

  const save = async (e) => {
    e.preventDefault();
    setSaving(true); setError('');
    try {
      if (editId) {
        await api.put(`/admin/pve-hosts/${editId}`, form);
      } else {
        await api.post('/admin/pve-hosts', form);
      }
      setShowForm(false);
      load();
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to save');
    } finally { setSaving(false); }
  };

  const remove = async (id) => {
    if (!confirm('Delete this PVE host?')) return;
    try {
      await api.delete(`/admin/pve-hosts/${id}`);
      load();
    } catch (e) {
      alert(e.response?.data?.error || 'Failed to delete');
    }
  };

  const fmtMem = (bytes) => {
    if (!bytes) return '—';
    return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  };

  const fmtUptime = (s) => {
    if (!s) return '—';
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600);
    return d > 0 ? `${d}d ${h}h` : `${h}h`;
  };

  return (
    <div className="p-6 lg:p-8 max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">PVE Hosts</h1>
          <p className="text-sm text-gray-500 mt-1">Manage your Proxmox VE servers</p>
        </div>
        <button
          onClick={openAdd}
          className="flex items-center gap-2 text-sm bg-blue-600 hover:bg-blue-500 text-white px-4 py-2.5 rounded-xl font-medium transition-colors shadow-lg shadow-blue-600/20"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          Add Host
        </button>
      </div>

      {/* Host cards */}
      {loading ? (
        <div className="space-y-4">
          {[1, 2].map(i => <div key={i} className="bg-gray-900 border border-gray-800 rounded-2xl h-48 animate-pulse" />)}
        </div>
      ) : hosts.length === 0 ? (
        <div className="text-center py-20">
          <div className="w-16 h-16 bg-gray-800/50 rounded-2xl flex items-center justify-center mx-auto mb-4">
            <svg className="w-8 h-8 text-gray-600" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 14.25h13.5m-13.5 0a3 3 0 01-3-3m3 3a3 3 0 100 6h13.5a3 3 0 100-6m-16.5-3a3 3 0 013-3h13.5a3 3 0 013 3m-19.5 0a4.5 4.5 0 01.9-2.7L5.737 5.1a3.375 3.375 0 012.7-1.35h7.126c1.062 0 2.062.5 2.7 1.35l2.587 3.45a4.5 4.5 0 01.9 2.7m0 0a3 3 0 01-3 3m0 3h.008v.008h-.008v-.008zm0-6h.008v.008h-.008v-.008zm-3 6h.008v.008h-.008v-.008zm0-6h.008v.008h-.008v-.008z" />
            </svg>
          </div>
          <p className="text-gray-400 font-medium">No PVE hosts configured</p>
          <p className="text-sm text-gray-600 mt-1">Add a Proxmox VE server to get started.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {hosts.map(h => {
            const s = statuses[h.id] || {};
            return (
              <div key={h.id} className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
                {/* Top accent */}
                <div className={`h-0.5 ${s.online ? 'bg-gradient-to-r from-green-500 via-emerald-500 to-teal-500' : s.loading ? 'bg-gray-700 animate-pulse' : 'bg-red-500'}`} />

                <div className="p-5">
                  {/* Header row */}
                  <div className="flex items-start justify-between mb-4">
                    <div className="flex items-center gap-3">
                      <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${s.online ? 'bg-green-500/10' : 'bg-gray-800'}`}>
                        <svg className={`w-5 h-5 ${s.online ? 'text-green-400' : 'text-gray-500'}`} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 14.25h13.5m-13.5 0a3 3 0 01-3-3m3 3a3 3 0 100 6h13.5a3 3 0 100-6m-16.5-3a3 3 0 013-3h13.5a3 3 0 013 3m-19.5 0a4.5 4.5 0 01.9-2.7L5.737 5.1a3.375 3.375 0 012.7-1.35h7.126c1.062 0 2.062.5 2.7 1.35l2.587 3.45a4.5 4.5 0 01.9 2.7" />
                        </svg>
                      </div>
                      <div>
                        <h3 className="text-white font-semibold">{h.name}</h3>
                        <p className="text-xs text-gray-500 font-mono">{h.host}:{h.port}</p>
                        <p className="text-[10px] text-gray-600 mt-0.5">{h.verify_tls ? 'TLS verification on' : 'TLS verification off'}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {/* Status badge */}
                      {s.loading ? (
                        <span className="text-xs text-gray-500 bg-gray-800 px-2.5 py-1 rounded-full">Checking...</span>
                      ) : s.online ? (
                        <span className="text-xs text-green-400 bg-green-500/10 ring-1 ring-green-500/20 px-2.5 py-1 rounded-full flex items-center gap-1.5">
                          <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                          Online
                        </span>
                      ) : (
                        <span className="text-xs text-red-400 bg-red-500/10 ring-1 ring-red-500/20 px-2.5 py-1 rounded-full flex items-center gap-1.5">
                          <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
                          Offline
                        </span>
                      )}
                      <button onClick={() => openEdit(h)} className="text-gray-500 hover:text-white p-1.5 rounded-lg hover:bg-gray-800 transition-colors">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" /></svg>
                      </button>
                      <button onClick={() => remove(h.id)} className="text-gray-500 hover:text-red-400 p-1.5 rounded-lg hover:bg-red-500/10 transition-colors">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" /></svg>
                      </button>
                    </div>
                  </div>

                  {/* Info when online */}
                  {s.online && !s.loading && (
                    <>
                      {/* Version + summary */}
                      <div className="flex items-center gap-4 mb-4 text-xs text-gray-500">
                        <span className="flex items-center gap-1.5">
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0112 15a9.065 9.065 0 00-6.23.693L5 14.5m14.8.8l1.402 1.402c1.232 1.232.65 3.318-1.067 3.611A48.309 48.309 0 0112 21c-2.773 0-5.491-.235-8.135-.687-1.718-.293-2.3-2.379-1.067-3.61L5 14.5" /></svg>
                          PVE {s.version}
                        </span>
                        <span>{s.nodes?.length || 0} node{s.nodes?.length !== 1 ? 's' : ''}</span>
                        <span>{s.vmCount || 0} VMs ({s.runningVms || 0} running)</span>
                        <span className="font-mono text-gray-600">API: {h.token_id}</span>
                      </div>

                      {/* Nodes */}
                      {s.nodes?.length > 0 && (
                        <div className="space-y-2">
                          {s.nodes.map(n => {
                            const memPct = n.maxmem ? (n.mem / n.maxmem * 100).toFixed(0) : 0;
                            const cpuPct = n.cpu ? (n.cpu * 100).toFixed(1) : 0;
                            return (
                              <div key={n.node} className="bg-gray-800/50 border border-gray-700/30 rounded-xl px-4 py-3 flex items-center justify-between">
                                <div className="flex items-center gap-3">
                                  <span className={`w-2 h-2 rounded-full shrink-0 ${n.status === 'online' ? 'bg-green-400' : 'bg-red-500'}`} />
                                  <div>
                                    <span className="text-sm text-white font-medium">{n.node}</span>
                                    <span className="text-xs text-gray-500 ml-2">up {fmtUptime(n.uptime)}</span>
                                  </div>
                                </div>
                                <div className="flex items-center gap-6 text-xs">
                                  <div className="flex items-center gap-2">
                                    <span className="text-gray-500">CPU</span>
                                    <div className="w-20 bg-gray-700/50 rounded-full h-1.5 overflow-hidden">
                                      <div className={`h-full rounded-full transition-all ${cpuPct > 80 ? 'bg-red-500' : cpuPct > 50 ? 'bg-yellow-500' : 'bg-blue-500'}`} style={{ width: `${cpuPct}%` }} />
                                    </div>
                                    <span className="text-gray-300 font-mono w-10 text-right">{cpuPct}%</span>
                                  </div>
                                  <div className="flex items-center gap-2">
                                    <span className="text-gray-500">RAM</span>
                                    <div className="w-20 bg-gray-700/50 rounded-full h-1.5 overflow-hidden">
                                      <div className={`h-full rounded-full transition-all ${memPct > 80 ? 'bg-red-500' : memPct > 50 ? 'bg-yellow-500' : 'bg-purple-500'}`} style={{ width: `${memPct}%` }} />
                                    </div>
                                    <span className="text-gray-300 font-mono w-10 text-right">{memPct}%</span>
                                  </div>
                                  <span className="text-gray-500">{fmtMem(n.maxmem)} total</span>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </>
                  )}

                  {/* Error info */}
                  {!s.online && !s.loading && s.error && (
                    <p className="text-xs text-red-400/70 bg-red-900/10 rounded-lg px-3 py-2 mt-1">{s.error}</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Add/Edit form modal */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" onClick={e => { if (e.target === e.currentTarget) setShowForm(false); }}>
          <form onSubmit={save} className="w-full max-w-lg bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-700">
              <h2 className="text-white font-semibold">{editId ? 'Edit Host' : 'Add PVE Host'}</h2>
              <button type="button" onClick={() => setShowForm(false)} className="text-gray-500 hover:text-white p-1 rounded hover:bg-gray-700 transition-colors">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
            <div className="p-5 space-y-4">
              <div>
                <label className="block text-xs text-gray-400 mb-1.5 font-medium">Name</label>
                <input
                  type="text" required value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  className={inputCls} placeholder="My Proxmox Server"
                />
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2">
                  <label className="block text-xs text-gray-400 mb-1.5 font-medium">Host / IP</label>
                  <input
                    type="text" required value={form.host}
                    onChange={e => setForm(f => ({ ...f, host: e.target.value }))}
                    className={inputCls} placeholder="192.168.1.10"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-400 mb-1.5 font-medium">Port</label>
                  <input
                    type="number" value={form.port}
                    onChange={e => setForm(f => ({ ...f, port: parseInt(e.target.value) || 8006 }))}
                    className={inputCls}
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1.5 font-medium">API Token ID</label>
                <input
                  type="text" required value={form.tokenId}
                  onChange={e => setForm(f => ({ ...f, tokenId: e.target.value }))}
                  className={inputCls} placeholder="root@pam!my-token"
                />
                <p className="text-xs text-gray-600 mt-1">Format: user@realm!token-name</p>
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1.5 font-medium">
                  API Token Secret {editId && <span className="text-gray-600">(leave empty to keep current)</span>}
                </label>
                <input
                  type="password" required={!editId} value={form.tokenSecret}
                  onChange={e => setForm(f => ({ ...f, tokenSecret: e.target.value }))}
                  className={inputCls} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                />
              </div>
              <label className="flex items-start gap-3 cursor-pointer rounded-xl border border-gray-700/50 bg-gray-800/40 px-3 py-3">
                <input
                  type="checkbox"
                  checked={form.verifyTls}
                  onChange={e => setForm(f => ({ ...f, verifyTls: e.target.checked }))}
                  className="accent-blue-500 mt-0.5"
                />
                <div>
                  <p className="text-sm text-white">Verify TLS certificate</p>
                  <p className="text-xs text-gray-500 mt-0.5">Enable this if the Proxmox host uses a trusted certificate. Disable only for self-signed/internal lab certs.</p>
                </div>
              </label>
              {error && <p className="text-xs text-red-400 bg-red-900/20 border border-red-800/30 rounded-xl p-3">{error}</p>}
              <div className="flex gap-3 pt-1">
                <button type="button" onClick={() => setShowForm(false)} className="flex-1 bg-gray-700 hover:bg-gray-600 text-white rounded-xl py-2.5 text-sm transition-colors">
                  Cancel
                </button>
                <button type="submit" disabled={saving} className="flex-1 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-xl py-2.5 text-sm font-semibold transition-colors shadow-lg shadow-blue-600/20">
                  {saving ? 'Saving...' : editId ? 'Update' : 'Add Host'}
                </button>
              </div>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

const inputCls = 'w-full bg-gray-800 border border-gray-700/50 rounded-xl px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/20 transition-all';
