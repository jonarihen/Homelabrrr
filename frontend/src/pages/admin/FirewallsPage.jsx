import { useState, useEffect } from 'react';
import api from '../../api.js';
import useDocumentTitle from '../../hooks/useDocumentTitle.js';

export default function FirewallsPage() {
  useDocumentTitle('Firewalls');
  const [firewalls, setFirewalls] = useState([]);
  const [statuses, setStatuses] = useState({});
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState(defaultForm());
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [switches, setSwitches] = useState([]);
  const [switchesLoading, setSwitchesLoading] = useState(false);

  function defaultForm() {
    return { name: '', host: '', port: 443, apiKey: '', vdom: 'lab', parentInterface: 'fortilink', wanInterface: 'wan1', vlanRangeStart: 1001, vlanRangeEnd: 1999, labVdomLink: 'lab-root0', rootVdom: 'root', rootVdomLink: 'lab-root1', routeGateway: '10.255.254.2', trunkSwitchSerial: '', trunkSwitchPort: '', verifyTls: false };
  }

  const load = () => {
    api.get('/admin/firewalls').then(r => {
      setFirewalls(r.data);
      setLoading(false);
      r.data.forEach(fw => {
        setStatuses(prev => ({ ...prev, [fw.id]: { loading: true } }));
        api.get(`/admin/firewalls/${fw.id}/status`).then(sr => {
          setStatuses(prev => ({ ...prev, [fw.id]: { ...sr.data, loading: false } }));
        }).catch(() => {
          setStatuses(prev => ({ ...prev, [fw.id]: { online: false, loading: false, error: 'Failed to check' } }));
        });
      });
    }).catch(() => setLoading(false));
  };

  useEffect(load, []);

  const loadSwitches = (fwId) => {
    if (!fwId) { setSwitches([]); return; }
    setSwitchesLoading(true);
    api.get(`/admin/firewalls/${fwId}/switches`).then(r => {
      setSwitches(r.data || []);
    }).catch(err => {
      console.error('Failed to load switches:', err.response?.data?.error || err.message);
      setSwitches([]);
    }).finally(() => setSwitchesLoading(false));
  };

  const openAdd = () => { setEditId(null); setForm(defaultForm()); setError(''); setSwitches([]); setShowForm(true); };

  const openEdit = (fw) => {
    setEditId(fw.id);
    setForm({ name: fw.name, host: fw.host, port: fw.port, apiKey: '', vdom: fw.vdom, parentInterface: fw.parent_interface, wanInterface: fw.wan_interface, vlanRangeStart: fw.vlan_range_start || 1001, vlanRangeEnd: fw.vlan_range_end || 1999, labVdomLink: fw.lab_vdom_link || 'lab-root0', rootVdom: fw.root_vdom || 'root', rootVdomLink: fw.root_vdom_link || 'lab-root1', routeGateway: fw.route_gateway || '10.255.254.2', trunkSwitchSerial: fw.trunk_switch_serial || '', trunkSwitchPort: fw.trunk_switch_port || '', verifyTls: !!fw.verify_tls });
    setError('');
    setShowForm(true);
    loadSwitches(fw.id);
  };

  const save = async (e) => {
    e.preventDefault();
    setSaving(true); setError('');
    try {
      if (editId) {
        await api.put(`/admin/firewalls/${editId}`, form);
      } else {
        await api.post('/admin/firewalls', form);
      }
      setShowForm(false);
      load();
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to save');
    } finally { setSaving(false); }
  };

  const remove = async (id) => {
    if (!confirm('Delete this firewall? Any synced VLANs will lose their tracking.')) return;
    try {
      await api.delete(`/admin/firewalls/${id}`);
      load();
    } catch (e) {
      alert(e.response?.data?.error || 'Failed to delete');
    }
  };

  return (
    <div className="p-6 lg:p-8 max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Firewalls</h1>
          <p className="text-sm text-gray-500 mt-1">Manage FortiGate and other firewall appliances</p>
        </div>
        <button onClick={openAdd} className="flex items-center gap-2 text-sm bg-blue-600 hover:bg-blue-500 text-white px-4 py-2.5 rounded-xl font-medium transition-colors shadow-lg shadow-blue-600/20">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          Add Firewall
        </button>
      </div>

      {loading ? (
        <div className="space-y-4">
          {[1, 2].map(i => <div key={i} className="bg-gray-900 border border-gray-800 rounded-2xl h-40 animate-pulse" />)}
        </div>
      ) : firewalls.length === 0 ? (
        <div className="text-center py-20">
          <div className="w-16 h-16 bg-gray-800/50 rounded-2xl flex items-center justify-center mx-auto mb-4">
            <svg className="w-8 h-8 text-gray-600" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m0-10.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.75c0 5.592 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.249-8.25-3.286zm0 13.036h.008v.008H12v-.008z" />
            </svg>
          </div>
          <p className="text-gray-400 font-medium">No firewalls configured</p>
          <p className="text-sm text-gray-600 mt-1">Add a FortiGate to enable automatic VLAN provisioning.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {firewalls.map(fw => {
            const s = statuses[fw.id] || {};
            return (
              <div key={fw.id} className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
                <div className={`h-0.5 ${s.online ? 'bg-gradient-to-r from-orange-500 via-amber-500 to-yellow-500' : s.loading ? 'bg-gray-700 animate-pulse' : 'bg-red-500'}`} />
                <div className="p-5">
                  <div className="flex items-start justify-between mb-4">
                    <div className="flex items-center gap-3">
                      <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${s.online ? 'bg-orange-500/10' : 'bg-gray-800'}`}>
                        <svg className={`w-5 h-5 ${s.online ? 'text-orange-400' : 'text-gray-500'}`} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m0-10.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.75c0 5.592 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.249-8.25-3.286zm0 13.036h.008v.008H12v-.008z" />
                        </svg>
                      </div>
                      <div>
                        <h3 className="text-white font-semibold">{fw.name}</h3>
                        <p className="text-xs text-gray-500 font-mono">{fw.host}:{fw.port}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
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
                      <button onClick={() => openEdit(fw)} className="text-gray-500 hover:text-white p-1.5 rounded-lg hover:bg-gray-800 transition-colors">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" /></svg>
                      </button>
                      <button onClick={() => remove(fw.id)} className="text-gray-500 hover:text-red-400 p-1.5 rounded-lg hover:bg-red-500/10 transition-colors">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" /></svg>
                      </button>
                    </div>
                  </div>

                  {s.online && !s.loading && (
                    <div className="flex items-center gap-4 text-xs text-gray-500">
                      <span className="flex items-center gap-1.5">
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0112 15a9.065 9.065 0 00-6.23.693L5 14.5m14.8.8l1.402 1.402c1.232 1.232.65 3.318-1.067 3.611A48.309 48.309 0 0112 21c-2.773 0-5.491-.235-8.135-.687-1.718-.293-2.3-2.379-1.067-3.61L5 14.5" /></svg>
                        FortiOS {s.version}
                      </span>
                      {s.serial && <span className="font-mono text-gray-600">S/N: {s.serial}</span>}
                      <span>VDOM: <span className="text-orange-400">{fw.vdom}</span></span>
                      <span>{s.vlanCount} VLAN interfaces</span>
                      <span className="font-mono text-gray-600">Parent: {fw.parent_interface} | WAN: {fw.wan_interface}</span>
                      <span>VLAN range: <span className="text-orange-400">{fw.vlan_range_start}–{fw.vlan_range_end}</span></span>
                    </div>
                  )}

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
          <form onSubmit={save} className="w-full max-w-lg bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-700">
              <h2 className="text-white font-semibold">{editId ? 'Edit Firewall' : 'Add Firewall'}</h2>
              <button type="button" onClick={() => setShowForm(false)} className="text-gray-500 hover:text-white p-1 rounded hover:bg-gray-700 transition-colors">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
            <div className="p-5 space-y-4">
              <div>
                <label className="block text-xs text-gray-400 mb-1.5 font-medium">Name</label>
                <input type="text" required value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} className={inputCls} placeholder="FortiGate 71G" />
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2">
                  <label className="block text-xs text-gray-400 mb-1.5 font-medium">Host / IP</label>
                  <input type="text" required value={form.host} onChange={e => setForm(f => ({ ...f, host: e.target.value }))} className={inputCls} placeholder="192.168.1.1" />
                </div>
                <div>
                  <label className="block text-xs text-gray-400 mb-1.5 font-medium">Port</label>
                  <input type="number" value={form.port} onChange={e => setForm(f => ({ ...f, port: parseInt(e.target.value) || 443 }))} className={inputCls} />
                </div>
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1.5 font-medium">
                  API Key {editId && <span className="text-gray-600">(leave empty to keep current)</span>}
                </label>
                <input type="password" required={!editId} value={form.apiKey} onChange={e => setForm(f => ({ ...f, apiKey: e.target.value }))} className={inputCls} placeholder="REST API administrator token" />
                <p className="text-xs text-gray-600 mt-1">Create in FortiGate: System &gt; Administrators &gt; REST API</p>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs text-gray-400 mb-1.5 font-medium">VDOM</label>
                  <input type="text" required value={form.vdom} onChange={e => setForm(f => ({ ...f, vdom: e.target.value }))} className={inputCls} placeholder="lab" />
                </div>
                <div>
                  <label className="block text-xs text-gray-400 mb-1.5 font-medium">Parent Interface</label>
                  <input type="text" required value={form.parentInterface} onChange={e => setForm(f => ({ ...f, parentInterface: e.target.value }))} className={inputCls} placeholder="fortilink" />
                </div>
                <div>
                  <label className="block text-xs text-gray-400 mb-1.5 font-medium">WAN Interface</label>
                  <input type="text" required value={form.wanInterface} onChange={e => setForm(f => ({ ...f, wanInterface: e.target.value }))} className={inputCls} placeholder="wan1" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-400 mb-1.5 font-medium">VLAN Range Start</label>
                  <input type="number" min="1" max="4094" required value={form.vlanRangeStart} onChange={e => setForm(f => ({ ...f, vlanRangeStart: parseInt(e.target.value) || 1001 }))} className={inputCls} />
                </div>
                <div>
                  <label className="block text-xs text-gray-400 mb-1.5 font-medium">VLAN Range End</label>
                  <input type="number" min="1" max="4094" required value={form.vlanRangeEnd} onChange={e => setForm(f => ({ ...f, vlanRangeEnd: parseInt(e.target.value) || 1999 }))} className={inputCls} />
                </div>
              </div>
              <p className="text-xs text-gray-600">Only VLANs with tags in this range can be pushed to this firewall.</p>

              <div className="pt-1 border-t border-gray-700/50">
                <p className="text-xs text-gray-500 mb-2 font-medium uppercase tracking-wider">Routing (VDOM link)</p>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-gray-400 mb-1.5 font-medium">Lab VDOM link (dstintf)</label>
                    <input type="text" required value={form.labVdomLink} onChange={e => setForm(f => ({ ...f, labVdomLink: e.target.value }))} className={inputCls} placeholder="lab-root0" />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-400 mb-1.5 font-medium">Root VDOM link (device)</label>
                    <input type="text" required value={form.rootVdomLink} onChange={e => setForm(f => ({ ...f, rootVdomLink: e.target.value }))} className={inputCls} placeholder="lab-root1" />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-400 mb-1.5 font-medium">Root VDOM name</label>
                    <input type="text" required value={form.rootVdom} onChange={e => setForm(f => ({ ...f, rootVdom: e.target.value }))} className={inputCls} placeholder="root" />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-400 mb-1.5 font-medium">Route gateway</label>
                    <input type="text" required value={form.routeGateway} onChange={e => setForm(f => ({ ...f, routeGateway: e.target.value }))} className={inputCls} placeholder="10.255.254.2" />
                  </div>
                </div>
                <p className="text-xs text-gray-600 mt-1.5">Lab→internet: {form.labVdomLink} | Static route in {form.rootVdom}: via {form.routeGateway} on {form.rootVdomLink}</p>
              </div>

              <div className="pt-1 border-t border-gray-700/50">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-xs text-gray-500 font-medium uppercase tracking-wider">Trunk Switch Port</p>
                  {editId && (
                    <button type="button" onClick={() => loadSwitches(editId)} className="text-xs text-blue-400 hover:text-blue-300 transition-colors">
                      {switchesLoading ? 'Loading...' : 'Refresh'}
                    </button>
                  )}
                </div>
                {!editId && (
                  <p className="text-xs text-gray-600 mb-3">Save the firewall first, then edit it to select a switch and port.</p>
                )}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-gray-400 mb-1.5 font-medium">Managed Switch</label>
                    {switches.length > 0 ? (
                      <select value={form.trunkSwitchSerial} onChange={e => setForm(f => ({ ...f, trunkSwitchSerial: e.target.value, trunkSwitchPort: '' }))} className={selectCls}>
                        <option value="">None</option>
                        {switches.map(sw => (
                          <option key={sw.name} value={sw.name}>{sw.name}{sw.serial && sw.serial !== sw.name ? ` (${sw.serial})` : ''}</option>
                        ))}
                      </select>
                    ) : (
                      <input type="text" value={form.trunkSwitchSerial} onChange={e => setForm(f => ({ ...f, trunkSwitchSerial: e.target.value }))} className={inputCls} placeholder={switchesLoading ? 'Loading...' : 'JAHE-SW01'} />
                    )}
                  </div>
                  <div>
                    <label className="block text-xs text-gray-400 mb-1.5 font-medium">Port</label>
                    {(() => {
                      const selectedSw = switches.find(sw => sw.name === form.trunkSwitchSerial);
                      const ports = selectedSw?.ports || [];
                      if (ports.length > 0) {
                        return (
                          <select value={form.trunkSwitchPort} onChange={e => setForm(f => ({ ...f, trunkSwitchPort: e.target.value }))} className={selectCls}>
                            <option value="">None</option>
                            {ports.map(p => (
                              <option key={p.name} value={p.name}>
                                {p.name}{p.vlan ? ` — ${p.vlan}` : ''}{p.type === 'trunk' ? ` [LAG: ${p.members}]` : ''}
                              </option>
                            ))}
                          </select>
                        );
                      }
                      return <input type="text" value={form.trunkSwitchPort} onChange={e => setForm(f => ({ ...f, trunkSwitchPort: e.target.value }))} className={inputCls} placeholder="port49" />;
                    })()}
                  </div>
                </div>
                <p className="text-xs text-gray-600 mt-1.5">Port connected to the hypervisor. New VLANs will be added to its allowed-vlans list.</p>
              </div>

              {error && <p className="text-xs text-red-400 bg-red-900/20 border border-red-800/30 rounded-xl p-3">{error}</p>}
              <div className="flex gap-3 pt-1">
                <button type="button" onClick={() => setShowForm(false)} className="flex-1 bg-gray-700 hover:bg-gray-600 text-white rounded-xl py-2.5 text-sm transition-colors">Cancel</button>
                <button type="submit" disabled={saving} className="flex-1 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-xl py-2.5 text-sm font-semibold transition-colors shadow-lg shadow-blue-600/20">
                  {saving ? 'Saving...' : editId ? 'Update' : 'Add Firewall'}
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
const selectCls = 'w-full bg-gray-800 border border-gray-700/50 rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/20 transition-all';
