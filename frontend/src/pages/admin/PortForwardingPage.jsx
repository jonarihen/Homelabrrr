import { useState, useEffect, useCallback, useMemo } from 'react';
import api from '../../api.js';
import useDocumentTitle from '../../hooks/useDocumentTitle.js';
import { displayNode, routeNode } from '../../utils/nodeRef.js';
import { shortenVipName, PORT_FORWARD_NAME_MAX } from '../../utils/vipName.js';
import { useAuth } from '../../contexts/AuthContext.jsx';

const inputCls = 'w-full bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-3 py-2 focus:ring-1 focus:ring-blue-500 focus:border-blue-500';

const SERVICE_PRESETS = [
  { label: 'SSH',    port: 22,   protocol: 'tcp' },
  { label: 'HTTP',   port: 80,   protocol: 'tcp' },
  { label: 'HTTPS',  port: 443,  protocol: 'tcp' },
  { label: 'RDP',    port: 3389, protocol: 'tcp' },
  { label: 'Custom', port: null, protocol: 'tcp' },
];

function portProtocolLabel(port, protocol) {
  const trimmedPort = String(port || '').trim();
  if (!trimmedPort) return '';
  return `${trimmedPort}/${String(protocol || 'tcp').toLowerCase()}`;
}

function buildRuleName(vmName, service, port, protocol) {
  const trimmedVmName = String(vmName || '').trim();
  if (!trimmedVmName) return '';
  let raw;
  if (service === 'Custom') {
    const suffix = portProtocolLabel(port, protocol);
    raw = `${trimmedVmName} - Custom${suffix ? ` ${suffix}` : ''}`;
  } else {
    raw = `${trimmedVmName} - ${service}`;
  }
  // Shorten to FortiGate's limit so the previewed name matches what the backend
  // persists (the backend re-applies the same shortener as a hard guard).
  return shortenVipName(raw, PORT_FORWARD_NAME_MAX);
}

export default function PortForwardingPage() {
  useDocumentTitle('Port Forwarding');
  const { user } = useAuth();
  const canManageAllPortForwards = !!(user?.isAdmin || user?.permissions?.canManageFirewalls);

  const [firewalls, setFirewalls] = useState([]);
  const [selectedFw, setSelectedFw] = useState(null);
  const [fwConfig, setFwConfig] = useState(null);

  const [vips, setVips] = useState([]);
  const [interfaces, setInterfaces] = useState([]);
  const [vmTargets, setVmTargets] = useState([]);
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
    vmKey: '', service: 'SSH', protocol: 'tcp',
    extPort: '', mappedPort: '22', name: '',
    dstInterface: '', vlanInterface: '', mappedIp: '',
    customProtocol: 'tcp',
  });
  const [attempted, setAttempted] = useState(false);

  const [deleting, setDeleting] = useState(null);

  // Load firewalls
  useEffect(() => {
    api.get('/admin/firewalls')
      .then(r => {
        setFirewalls(r.data);
        if (r.data.length > 0) setSelectedFw(r.data[0].id);
      })
      .catch(() => setError('Failed to load firewalls'))
      .finally(() => setLoading(false));
  }, []);

  // Load VIPs + interfaces + VM targets when firewall changes
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
      const [vipsRes, ifacesRes, targetsRes] = await Promise.all([
        api.get(`/admin/firewalls/${selectedFw}/vips`),
        canManageAllPortForwards
          ? api.get(`/admin/firewalls/${selectedFw}/root-interfaces`)
          : Promise.resolve({ data: [] }),
        api.get(`/admin/firewalls/${selectedFw}/vm-targets`),
      ]);
      setVips(vipsRes.data);
      setInterfaces(ifacesRes.data);
      setVmTargets(targetsRes.data.targets || []);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load port forwarding data');
    } finally {
      setLoading(false);
    }
  }, [selectedFw, firewalls, canManageAllPortForwards]);

  useEffect(() => { loadData(); }, [loadData]);

  // Selected VM details
  const selectedVm = useMemo(() => {
    if (!form.vmKey) return null;
    return vmTargets.find(v => `${routeNode(v)}/${v.vmid}` === form.vmKey) || null;
  }, [form.vmKey, vmTargets]);

  // When VM selection changes, auto-fill IP, interface, and name from pre-resolved data
  const handleVmChange = (vmKey) => {
    if (!vmKey) {
      setForm(f => ({ ...f, vmKey: '', mappedIp: '', dstInterface: '', name: '' }));
      return;
    }
    const vm = vmTargets.find(v => `${routeNode(v)}/${v.vmid}` === vmKey);
    if (!vm) return;

    setForm(f => ({
      ...f,
      vmKey,
      mappedIp: vm.ip,
      dstInterface: vm.dstInterface || f.dstInterface,
      vlanInterface: vm.vlanInterface || '',
      name: buildRuleName(vm.name, f.service, f.mappedPort, f.customProtocol),
    }));
  };

  // When service selection changes, update ports and name
  const handleServiceChange = (serviceLabel) => {
    const preset = SERVICE_PRESETS.find(s => s.label === serviceLabel);
    const vm = selectedVm;
    const vmName = vm?.name || '';
    if (preset && preset.port) {
      setForm(f => ({
        ...f,
        service: serviceLabel,
        protocol: preset.protocol,
        mappedPort: String(preset.port),
        extPort: f.extPort || String(preset.port),
        name: buildRuleName(vmName, serviceLabel, preset.port, preset.protocol) || f.name,
      }));
    } else {
      setForm(f => ({
        ...f,
        service: serviceLabel,
        mappedPort: '',
        name: buildRuleName(vmName, serviceLabel, f.mappedPort, f.customProtocol) || f.name,
      }));
    }
  };

  // Live port conflict check
  const portConflict = form.extPort
    ? vips.find(v => String(v.extport) === String(form.extPort) && (v.protocol || 'tcp') === (form.service === 'Custom' ? form.customProtocol : form.protocol))
    : null;

  const saveWanConfig = async () => {
    setSavingWan(true);
    try {
      await api.put(`/admin/firewalls/${selectedFw}/wan-config`, {
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

  // Compute missing fields for validation feedback
  const missingFields = [];
  if (!form.vmKey) missingFields.push('Target VM');
  if (!form.extPort) missingFields.push('External Port');
  if (!form.mappedPort) missingFields.push('Internal Port');
  if (!form.mappedIp) missingFields.push('Internal IP');
  if (!form.dstInterface) missingFields.push('Destination Interface');
  if (!form.name) missingFields.push('Rule Name');
  if (portConflict) missingFields.push(`Port ${form.extPort} already in use`);

  const handleCreate = async (e) => {
    e.preventDefault();
    setAttempted(true);
    if (missingFields.length > 0) return;
    setCreating(true);
    setCreateError('');
    const proto = form.service === 'Custom' ? form.customProtocol : form.protocol;
    try {
      await api.post(`/admin/firewalls/${selectedFw}/vips`, {
        node: selectedVm?.nodeRef || selectedVm?.node,
        vmid: selectedVm?.vmid,
        name: form.name,
        protocol: proto,
        extPort: parseInt(form.extPort),
        mappedIp: form.mappedIp,
        mappedPort: parseInt(form.mappedPort),
        dstInterface: form.dstInterface,
        vlanInterface: form.vlanInterface,
        srcAddresses: ['all'],
      });
      setShowCreate(false);
      setForm({
        vmKey: '', service: 'SSH', protocol: 'tcp',
        extPort: '', mappedPort: '22', name: '',
        dstInterface: '', vlanInterface: '', mappedIp: '', customProtocol: 'tcp',
      });
      setAttempted(false);
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
      await api.delete(`/admin/firewalls/${selectedFw}/vips/${encodeURIComponent(vipName)}`);
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

  const isCustom = form.service === 'Custom';
  const canSubmit = missingFields.length === 0;

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="aaris-display text-xl text-gray-100">Port Forwarding</h1>
          <p className="text-sm text-gray-500 mt-1">
            {canManageAllPortForwards
              ? 'Manage WAN VIP rules on the root VDOM'
              : 'Create and manage WAN VIP rules for VMs on VLANs assigned to you'}
          </p>
        </div>
        {!needsWanConfig && !loading && (
          <button
            onClick={() => { setShowCreate(!showCreate); setCreateError(''); setAttempted(false); }}
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
                  <input type="text" value={wanForm.externalIp}
                    onChange={e => setWanForm(p => ({ ...p, externalIp: e.target.value }))}
                    placeholder="e.g. 46.32.144.243" className={inputCls} />
                </div>
                <div>
                  <label className="block text-xs text-gray-400 mb-1">WAN zone / interface (root VDOM)</label>
                  <input type="text" value={wanForm.rootWanZone}
                    onChange={e => setWanForm(p => ({ ...p, rootWanZone: e.target.value }))}
                    placeholder="e.g. underlay" className={inputCls} />
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
              {canManageAllPortForwards ? (
                <button onClick={() => setEditingWan(true)}
                  className="px-4 py-2 bg-yellow-600 hover:bg-yellow-500 text-white text-sm font-medium rounded-lg transition-colors">
                  Configure WAN
                </button>
              ) : (
                <p className="text-xs text-gray-600">Ask a firewall admin to configure the WAN settings for this firewall.</p>
              )}
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
              {canManageAllPortForwards ? (
                <button onClick={() => setEditingWan(true)}
                  className="text-xs text-gray-500 hover:text-gray-300 transition-colors">
                  Edit
                </button>
              ) : <span />}
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

      {/* Create form — object-based */}
      {showCreate && !needsWanConfig && (
        <div className="bg-gray-900/50 border border-blue-500/20 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-white mb-4">New Port Forward</h3>
          <form onSubmit={handleCreate} className="space-y-4">
            {/* Row 1: VM + Service */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-gray-400 mb-1">Target VM</label>
                <select value={form.vmKey} onChange={e => handleVmChange(e.target.value)}
                  className={inputCls} required>
                  <option value="">Select a VM...</option>
                  {vmTargets.map(v => (
                    <option key={`${routeNode(v)}/${v.vmid}`} value={`${routeNode(v)}/${v.vmid}`}>
                      {v.name} ({v.ip}) · {displayNode(v.node)} / {v.vmid}
                    </option>
                  ))}
                </select>
                {vmTargets.length === 0 && !loading && (
                  <p className="text-[11px] text-gray-600 mt-1">
                    {canManageAllPortForwards
                      ? 'No VMs with SSH configs found. Configure SSH on a VM first.'
                      : 'No accessible VMs with SSH configs on your assigned VLANs were found.'}
                  </p>
                )}
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">Service</label>
                <select value={form.service} onChange={e => handleServiceChange(e.target.value)}
                  className={inputCls}>
                  {SERVICE_PRESETS.map(s => (
                    <option key={s.label} value={s.label}>
                      {s.label}{s.port ? ` (${s.protocol.toUpperCase()}/${s.port})` : ''}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Row 2: External port + protocol (custom only) + internal port */}
            <div className={`grid gap-4 ${isCustom ? 'grid-cols-1 sm:grid-cols-3' : 'grid-cols-1 sm:grid-cols-2'}`}>
              <div>
                <label className="block text-xs text-gray-400 mb-1">External Port</label>
                <input type="number" required min="1" max="65535" value={form.extPort}
                  onChange={e => setForm(f => ({ ...f, extPort: e.target.value }))}
                  placeholder="e.g. 2222"
                  className={`${inputCls} ${portConflict ? '!border-red-500 !focus:ring-red-500' : ''}`}
                />
                {portConflict && (
                  <p className="text-xs text-red-400 mt-1">
                    Port {form.extPort}/{(isCustom ? form.customProtocol : form.protocol).toUpperCase()} used by &ldquo;{portConflict.name}&rdquo;
                  </p>
                )}
              </div>
              {isCustom && (
                <div>
                  <label className="block text-xs text-gray-400 mb-1">Protocol</label>
                  <select value={form.customProtocol}
                    onChange={e => {
                      const customProtocol = e.target.value;
                      setForm(f => ({
                        ...f,
                        customProtocol,
                        name: f.service === 'Custom'
                          ? buildRuleName(selectedVm?.name, f.service, f.mappedPort, customProtocol)
                          : f.name,
                      }));
                    }}
                    className={inputCls}>
                    <option value="tcp">TCP</option>
                    <option value="udp">UDP</option>
                  </select>
                </div>
              )}
              <div>
                <label className="block text-xs text-gray-400 mb-1">Internal Port</label>
                <input type="number" required min="1" max="65535" value={form.mappedPort}
                  onChange={e => {
                    const mappedPort = e.target.value;
                    setForm(f => ({
                      ...f,
                      mappedPort,
                      name: f.service === 'Custom'
                        ? buildRuleName(selectedVm?.name, f.service, mappedPort, f.customProtocol)
                        : f.name,
                    }));
                  }}
                  placeholder={isCustom ? 'e.g. 8080' : ''}
                  className={inputCls}
                  readOnly={!isCustom}
                />
                {!isCustom && <p className="text-[11px] text-gray-600 mt-1">Set by service preset</p>}
              </div>
            </div>

            {/* Auto-resolved fields — shown as read-only context */}
            {selectedVm && (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 bg-gray-800/30 rounded-lg p-3 border border-gray-800/50">
                <div>
                  <label className="block text-[11px] text-gray-500 mb-0.5">Internal IP (from SSH config)</label>
                  <span className="text-sm text-white font-mono">{form.mappedIp || '—'}</span>
                </div>
                <div>
                  <label className="block text-[11px] text-gray-500 mb-0.5">Destination Interface</label>
                  {form.dstInterface ? (
                    <span className="text-sm text-white font-mono">{form.dstInterface}</span>
                  ) : canManageAllPortForwards ? (
                    <select value={form.dstInterface} onChange={e => setForm(f => ({ ...f, dstInterface: e.target.value }))}
                      className="bg-gray-800 border border-yellow-600/40 text-white text-sm rounded px-2 py-0.5 text-xs">
                      <option value="">Select manually...</option>
                      {interfaces.map(i => (
                        <option key={i.name} value={i.name}>{i.name}</option>
                      ))}
                    </select>
                  ) : (
                    <span className="text-xs text-yellow-500/80">Auto-detection required</span>
                  )}
                  {!form.dstInterface && (
                    <p className="text-[11px] text-yellow-500/80 mt-0.5">
                      {canManageAllPortForwards
                        ? 'Could not auto-detect from VM VLAN'
                        : 'This VM is not on a firewall-synced VLAN assigned to you'}
                    </p>
                  )}
                </div>
                <div>
                  <label className="block text-[11px] text-gray-500 mb-0.5">Rule Name</label>
                  <input type="text" value={form.name}
                    onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                    maxLength={PORT_FORWARD_NAME_MAX}
                    className="bg-transparent border-none text-sm text-white p-0 focus:outline-none focus:ring-0 w-full"
                    required />
                </div>
              </div>
            )}

            {createError && (
              <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 text-sm text-red-400">
                {createError}
              </div>
            )}

            {attempted && !canSubmit && (
              <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-lg px-3 py-2 text-sm text-yellow-400">
                Missing: {missingFields.join(', ')}
              </div>
            )}

            <div className="flex gap-2 pt-1">
              <button type="submit" disabled={creating}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors">
                {creating ? 'Creating...' : 'Create Port Forward'}
              </button>
              <button type="button" onClick={() => { setShowCreate(false); setCreateError(''); setAttempted(false); }}
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
