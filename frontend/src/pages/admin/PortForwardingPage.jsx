import { useState, useEffect, useCallback } from 'react';
import api from '../../api.js';
import useDocumentTitle from '../../hooks/useDocumentTitle.js';

export default function PortForwardingPage() {
  useDocumentTitle('Port Forwarding');

  const [firewalls, setFirewalls] = useState([]);
  const [selectedFw, setSelectedFw] = useState(null);
  const [fwConfig, setFwConfig] = useState(null);

  const [vips, setVips] = useState([]);
  const [interfaces, setInterfaces] = useState([]);
  const [addressObjects, setAddressObjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // WAN config editing
  const [editingWan, setEditingWan] = useState(false);
  const [wanForm, setWanForm] = useState({ externalIp: '', rootWanZone: 'underlay' });
  const [savingWan, setSavingWan] = useState(false);

  // Create form
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const [form, setForm] = useState({
    name: '', protocol: 'tcp', extPort: '', mappedIp: '', mappedPort: '',
    dstInterface: '', srcAddresses: 'all',
  });

  const [deleting, setDeleting] = useState(null);

  // Load firewalls
  useEffect(() => {
    api.get('/api/admin/firewalls')
      .then(r => {
        setFirewalls(r.data);
        if (r.data.length > 0) setSelectedFw(r.data[0].id);
      })
      .catch(() => setError('Failed to load firewalls'))
      .finally(() => setLoading(false));
  }, []);

  // Load VIPs + interfaces when firewall changes
  const loadData = useCallback(async () => {
    if (!selectedFw) return;
    setLoading(true);
    setError('');
    try {
      const fw = firewalls.find(f => f.id === selectedFw);
      if (fw) {
        setFwConfig({ external_ip: fw.external_ip || '', root_wan_zone: fw.root_wan_zone || 'underlay' });
        setWanForm({ externalIp: fw.external_ip || '', rootWanZone: fw.root_wan_zone || 'underlay' });
      }
      const [vipsRes, ifacesRes, addrsRes] = await Promise.all([
        api.get(`/api/admin/firewalls/${selectedFw}/vips`),
        api.get(`/api/admin/firewalls/${selectedFw}/root-interfaces`),
        api.get(`/api/admin/firewalls/${selectedFw}/root-addresses`),
      ]);
      setVips(vipsRes.data);
      setInterfaces(ifacesRes.data);
      // Combine address objects + groups for dropdown
      const addrs = [
        { name: 'all', label: 'all (no restriction)' },
        ...(addrsRes.data.groups || []).map(g => ({ name: g.name, label: `[Group] ${g.name}` })),
        ...(addrsRes.data.addresses || []).map(a => ({ name: a.name, label: a.name })),
      ];
      setAddressObjects(addrs);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load port forwarding data');
    } finally {
      setLoading(false);
    }
  }, [selectedFw, firewalls]);

  useEffect(() => { loadData(); }, [loadData]);

  // Live port conflict check
  const portConflict = form.extPort
    ? vips.find(v => String(v.extport) === String(form.extPort) && (v.protocol || 'tcp') === form.protocol)
    : null;

  const saveWanConfig = async () => {
    setSavingWan(true);
    try {
      await api.put(`/api/admin/firewalls/${selectedFw}/wan-config`, {
        externalIp: wanForm.externalIp,
        rootWanZone: wanForm.rootWanZone,
      });
      setFwConfig({ external_ip: wanForm.externalIp, root_wan_zone: wanForm.rootWanZone });
      setEditingWan(false);
      setFirewalls(prev => prev.map(f =>
        f.id === selectedFw ? { ...f, external_ip: wanForm.externalIp, root_wan_zone: wanForm.rootWanZone } : f
      ));
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save WAN config');
    } finally {
      setSavingWan(false);
    }
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    if (portConflict) return;
    setCreating(true);
    setCreateError('');
    try {
      await api.post(`/api/admin/firewalls/${selectedFw}/vips`, {
        name: form.name,
        protocol: form.protocol,
        extPort: parseInt(form.extPort),
        mappedIp: form.mappedIp,
        mappedPort: parseInt(form.mappedPort),
        dstInterface: form.dstInterface,
        srcAddresses: form.srcAddresses === 'all' ? ['all'] : [form.srcAddresses],
      });
      setShowCreate(false);
      setForm({ name: '', protocol: 'tcp', extPort: '', mappedIp: '', mappedPort: '', dstInterface: '', srcAddresses: 'all' });
      await loadData();
    } catch (err) {
      setCreateError(err.response?.data?.error || 'Failed to create port forward');
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (vipName) => {
    if (!confirm(`Delete port forward "${vipName}"?\nThis will remove the VIP and its firewall policy from the root VDOM.`)) return;
    setDeleting(vipName);
    try {
      await api.delete(`/api/admin/firewalls/${selectedFw}/vips/${encodeURIComponent(vipName)}`);
      await loadData();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to delete port forward');
    } finally {
      setDeleting(null);
    }
  };

  const sortedVips = [...vips].sort((a, b) => {
    if (a.managed !== b.managed) return a.managed ? -1 : 1;
    return parseInt(a.extport || 0) - parseInt(b.extport || 0);
  });

  const needsWanConfig = !fwConfig?.external_ip;
  const managedCount = vips.filter(v => v.managed).length;
  const externalCount = vips.filter(v => !v.managed).length;

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Port Forwarding</h1>
          <p className="text-sm text-gray-500 mt-1">Manage WAN VIP rules on the root VDOM</p>
        </div>
        {!needsWanConfig && !loading && (
          <button
            onClick={() => { setShowCreate(!showCreate); setCreateError(''); }}
            className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
              showCreate
                ? 'bg-gray-700 hover:bg-gray-600 text-gray-300'
                : 'bg-blue-600 hover:bg-blue-500 text-white'
            }`}
          >
            {showCreate ? 'Cancel' : 'New Port Forward'}
          </button>
        )}
      </div>

      {/* Firewall selector */}
      {firewalls.length > 1 && (
        <div className="flex items-center gap-3">
          <label className="text-sm text-gray-400">Firewall:</label>
          <select
            value={selectedFw || ''}
            onChange={e => { setSelectedFw(parseInt(e.target.value)); setShowCreate(false); }}
            className="bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-3 py-1.5 focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
          >
            {firewalls.map(fw => (
              <option key={fw.id} value={fw.id}>{fw.name}</option>
            ))}
          </select>
        </div>
      )}

      {/* WAN Config */}
      {fwConfig && (
        <div className="bg-gray-900/50 border border-gray-800/50 rounded-xl p-4">
          {editingWan ? (
            <div className="space-y-3">
              <h3 className="text-sm font-medium text-white">WAN Configuration</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-gray-400 mb-1">External IP (public IP for VIPs)</label>
                  <input
                    type="text"
                    value={wanForm.externalIp}
                    onChange={e => setWanForm(p => ({ ...p, externalIp: e.target.value }))}
                    placeholder="e.g. 46.32.144.243"
                    className="w-full bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-3 py-2 focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-400 mb-1">WAN zone / interface (root VDOM)</label>
                  <input
                    type="text"
                    value={wanForm.rootWanZone}
                    onChange={e => setWanForm(p => ({ ...p, rootWanZone: e.target.value }))}
                    placeholder="e.g. underlay"
                    className="w-full bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-3 py-2 focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>
              </div>
              <div className="flex gap-2">
                <button onClick={saveWanConfig} disabled={savingWan || !wanForm.externalIp}
                  className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm rounded-lg transition-colors">
                  {savingWan ? 'Saving...' : 'Save'}
                </button>
                <button onClick={() => { setEditingWan(false); setWanForm({ externalIp: fwConfig.external_ip, rootWanZone: fwConfig.root_wan_zone }); }}
                  className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-white text-sm rounded-lg transition-colors">
                  Cancel
                </button>
              </div>
            </div>
          ) : needsWanConfig ? (
            <div className="text-center py-6">
              <svg className="w-8 h-8 mx-auto text-yellow-500/60 mb-3" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
              </svg>
              <p className="text-yellow-400 text-sm font-medium mb-1">External IP not configured</p>
              <p className="text-gray-500 text-xs mb-4">Set your public IP address to enable port forwarding.</p>
              <button onClick={() => setEditingWan(true)}
                className="px-4 py-2 bg-yellow-600 hover:bg-yellow-500 text-white text-sm font-medium rounded-lg transition-colors">
                Configure WAN
              </button>
            </div>
          ) : (
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-6 text-sm">
                <div>
                  <span className="text-gray-500">External IP: </span>
                  <span className="text-white font-mono">{fwConfig.external_ip}</span>
                </div>
                <div>
                  <span className="text-gray-500">WAN Zone: </span>
                  <span className="text-white font-mono">{fwConfig.root_wan_zone}</span>
                </div>
                <div>
                  <span className="text-gray-500">VIPs: </span>
                  <span className="text-white">{vips.length}</span>
                  {managedCount > 0 && <span className="text-gray-600 ml-1">({managedCount} managed)</span>}
                </div>
              </div>
              <button onClick={() => setEditingWan(true)}
                className="text-xs text-gray-500 hover:text-gray-300 transition-colors">
                Edit
              </button>
            </div>
          )}
        </div>
      )}

      {/* Error banner */}
      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-3 text-sm text-red-400 flex items-center justify-between">
          <span>{error}</span>
          <button onClick={() => setError('')} className="text-red-500 hover:text-red-400 ml-4 text-lg leading-none">&times;</button>
        </div>
      )}

      {/* Create form */}
      {showCreate && !needsWanConfig && (
        <div className="bg-gray-900/50 border border-blue-500/20 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-white mb-4">New Port Forward</h3>
          <form onSubmit={handleCreate} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-gray-400 mb-1">Name</label>
                <input type="text" required value={form.name}
                  onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
                  placeholder="e.g. WebServer - HTTP"
                  className="w-full bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-3 py-2 focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">Protocol</label>
                <select value={form.protocol}
                  onChange={e => setForm(p => ({ ...p, protocol: e.target.value }))}
                  className="w-full bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-3 py-2 focus:ring-1 focus:ring-blue-500 focus:border-blue-500">
                  <option value="tcp">TCP</option>
                  <option value="udp">UDP</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs text-gray-400 mb-1">External Port</label>
                <input type="number" required min="1" max="65535" value={form.extPort}
                  onChange={e => setForm(p => ({ ...p, extPort: e.target.value }))}
                  placeholder="e.g. 8080"
                  className={`w-full bg-gray-800 border text-white text-sm rounded-lg px-3 py-2 focus:ring-1 focus:ring-blue-500 ${
                    portConflict ? 'border-red-500 focus:ring-red-500 focus:border-red-500' : 'border-gray-700 focus:border-blue-500'
                  }`}
                />
                {portConflict && (
                  <p className="text-xs text-red-400 mt-1">
                    Port {form.extPort}/{form.protocol.toUpperCase()} used by &ldquo;{portConflict.name}&rdquo;
                  </p>
                )}
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">Internal IP</label>
                <input type="text" required value={form.mappedIp}
                  onChange={e => setForm(p => ({ ...p, mappedIp: e.target.value }))}
                  placeholder="e.g. 172.21.12.32"
                  className="w-full bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-3 py-2 focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">Internal Port</label>
                <input type="number" required min="1" max="65535" value={form.mappedPort}
                  onChange={e => setForm(p => ({ ...p, mappedPort: e.target.value }))}
                  placeholder="e.g. 80"
                  className="w-full bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-3 py-2 focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-gray-400 mb-1">Destination Zone (root VDOM interface)</label>
                <select required value={form.dstInterface}
                  onChange={e => setForm(p => ({ ...p, dstInterface: e.target.value }))}
                  className="w-full bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-3 py-2 focus:ring-1 focus:ring-blue-500 focus:border-blue-500">
                  <option value="">Select interface...</option>
                  {interfaces.map(i => (
                    <option key={i.name} value={i.name}>
                      {i.name}{i.description ? ` (${i.description})` : ''}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">Source Restriction</label>
                <select value={form.srcAddresses}
                  onChange={e => setForm(p => ({ ...p, srcAddresses: e.target.value }))}
                  className="w-full bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-3 py-2 focus:ring-1 focus:ring-blue-500 focus:border-blue-500">
                  {addressObjects.map(a => (
                    <option key={a.name} value={a.name}>{a.label || a.name}</option>
                  ))}
                </select>
                <p className="text-[11px] text-gray-600 mt-1">Address object or group to restrict source IPs</p>
              </div>
            </div>

            {createError && (
              <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 text-sm text-red-400">
                {createError}
              </div>
            )}

            <div className="flex gap-2 pt-1">
              <button type="submit" disabled={creating || !!portConflict}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors">
                {creating ? 'Creating...' : 'Create Port Forward'}
              </button>
              <button type="button" onClick={() => { setShowCreate(false); setCreateError(''); }}
                className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white text-sm rounded-lg transition-colors">
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {/* VIP Table */}
      {loading ? (
        <div className="text-center py-16">
          <div className="inline-block w-6 h-6 border-2 border-gray-600 border-t-blue-500 rounded-full animate-spin" />
          <p className="text-gray-500 text-sm mt-3">Loading VIPs from FortiGate...</p>
        </div>
      ) : !needsWanConfig && (
        <div className="bg-gray-900/50 border border-gray-800/50 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-800/50">
                  <th className="px-4 py-3 text-left text-[10px] text-gray-500 uppercase tracking-wider font-semibold">Status</th>
                  <th className="px-4 py-3 text-left text-[10px] text-gray-500 uppercase tracking-wider font-semibold">Name</th>
                  <th className="px-4 py-3 text-left text-[10px] text-gray-500 uppercase tracking-wider font-semibold">Proto</th>
                  <th className="px-4 py-3 text-left text-[10px] text-gray-500 uppercase tracking-wider font-semibold">External</th>
                  <th className="px-4 py-3 text-center text-[10px] text-gray-500 uppercase tracking-wider font-semibold"></th>
                  <th className="px-4 py-3 text-left text-[10px] text-gray-500 uppercase tracking-wider font-semibold">Internal</th>
                  <th className="px-4 py-3 text-right text-[10px] text-gray-500 uppercase tracking-wider font-semibold w-20"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800/30">
                {sortedVips.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-12 text-center text-gray-600 text-sm">
                      No port forwarding rules found
                    </td>
                  </tr>
                ) : sortedVips.map(v => (
                  <tr key={`${v.name}-${v.protocol}-${v.extport}`}
                    className="hover:bg-gray-800/20 transition-colors group">
                    <td className="px-4 py-3">
                      {v.managed ? (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-blue-500/10 text-blue-400 border border-blue-500/20">
                          Managed
                        </span>
                      ) : (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-gray-500/10 text-gray-500 border border-gray-500/20">
                          External
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-sm text-white font-medium">{v.name}</span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-mono font-semibold ${
                        (v.protocol || 'tcp') === 'udp'
                          ? 'bg-orange-500/10 text-orange-400 border border-orange-500/20'
                          : 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/20'
                      }`}>
                        {(v.protocol || 'tcp').toUpperCase()}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm font-mono text-gray-300">
                      :{v.extport}
                    </td>
                    <td className="px-4 py-3 text-center text-gray-600 text-xs">
                      <svg className="w-4 h-4 inline" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
                      </svg>
                    </td>
                    <td className="px-4 py-3 text-sm font-mono text-gray-300">
                      {v.mappedip}:{v.mappedport}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {v.managed ? (
                        <button
                          onClick={() => handleDelete(v.name)}
                          disabled={deleting === v.name}
                          className="text-xs text-red-500/60 hover:text-red-400 disabled:opacity-50 transition-colors opacity-0 group-hover:opacity-100"
                        >
                          {deleting === v.name ? (
                            <span className="opacity-100">Deleting...</span>
                          ) : 'Delete'}
                        </button>
                      ) : (
                        <span className="text-gray-700" title="VIP not created through VM Manager">
                          <svg className="w-3.5 h-3.5 inline" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
                          </svg>
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Footer */}
          {vips.length > 0 && (
            <div className="border-t border-gray-800/50 px-4 py-2.5 text-xs text-gray-600 flex justify-between">
              <span>{vips.length} VIP{vips.length !== 1 ? 's' : ''} total</span>
              <span>
                {managedCount > 0 && <span className="text-blue-500/60">{managedCount} managed</span>}
                {managedCount > 0 && externalCount > 0 && <span className="mx-1.5">&middot;</span>}
                {externalCount > 0 && <span>{externalCount} external</span>}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
