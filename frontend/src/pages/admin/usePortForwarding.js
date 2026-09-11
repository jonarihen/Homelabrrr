import { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../../api.js';
import { routeNode } from '../../utils/nodeRef.js';
import { shortenVipName, PORT_FORWARD_NAME_MAX } from '../../utils/vipName.js';

export const SERVICE_PRESETS = [
  { label: 'SSH', port: 22, protocol: 'tcp' },
  { label: 'HTTP', port: 80, protocol: 'tcp' },
  { label: 'HTTPS', port: 443, protocol: 'tcp' },
  { label: 'RDP', port: 3389, protocol: 'tcp' },
  { label: 'Custom', port: null, protocol: 'tcp' },
];

const BLOCK_TITLES = {
  no_ip: n => (n === 1 ? 'VM IP address not recorded' : 'No VM IP addresses recorded'),
  untagged: n => (n === 1 ? 'VM has no VLAN tag' : 'No VLAN tags on your VMs'),
  vlan_not_synced: () => 'VLAN not synced to this firewall',
  vlan_not_assigned: n => (n === 1 ? 'VLAN not assigned to you' : 'No VLANs assigned to you'),
};

const BLOCK_SUMMARIES = {
  no_ip: n => `Homelabrrr doesn't know the IP address of any of your ${n} accessible VMs yet.`,
  untagged: n => `None of your ${n} accessible VMs have a VLAN tag on their network interface, so there's no firewall interface to publish through.`,
  vlan_not_synced: n => `The VLANs behind your ${n} accessible VMs haven't been synced to this firewall yet.`,
  vlan_not_assigned: n => `The VLANs behind your ${n} accessible VMs aren't assigned to you.`,
};

const initialForm = () => ({
  vmKey: '', service: 'SSH', protocol: 'tcp',
  extPort: '', mappedPort: '22', name: '',
  dstInterface: '', vlanInterface: '', mappedIp: '', customProtocol: 'tcp',
});

export function buildRuleName(vmName, service, port, protocol) {
  const trimmedVmName = String(vmName || '').trim();
  if (!trimmedVmName) return '';
  const suffix = String(port || '').trim();
  const raw = service === 'Custom'
    ? `${trimmedVmName} - Custom${suffix ? ` ${suffix}/${String(protocol || 'tcp').toLowerCase()}` : ''}`
    : `${trimmedVmName} - ${service}`;
  return shortenVipName(raw, PORT_FORWARD_NAME_MAX);
}

function getBlockedCallout(loading, selectableTargets, blockedTargets) {
  if (loading || selectableTargets.length || !blockedTargets.length) return null;
  const first = blockedTargets[0].blocked;
  if (!first || !blockedTargets.every(v => v.blocked?.code === first.code)) return null;
  const count = blockedTargets.length;
  const sameMessage = blockedTargets.every(v => v.blocked?.message === first.message);
  const sameHref = blockedTargets.every(v => (v.blocked?.href || '') === (first.href || ''));
  return {
    code: first.code,
    title: (BLOCK_TITLES[first.code] || (() => 'These VMs cannot be published yet'))(count),
    message: sameMessage ? first.message : (BLOCK_SUMMARIES[first.code] || (() => first.message))(count),
    action: first.action || '',
    href: sameHref ? (first.href || '') : '',
  };
}

function getMissingFields(form, portConflict) {
  const fields = [
    ['vmKey', 'Target VM'], ['extPort', 'External Port'], ['mappedPort', 'Internal Port'],
    ['mappedIp', 'Internal IP'], ['dstInterface', 'Destination Interface'], ['name', 'Rule Name'],
  ].filter(([key]) => !form[key]).map(([, label]) => label);
  if (portConflict) fields.push(`Port ${form.extPort} already in use`);
  return fields;
}

export default function usePortForwarding(canManageAllPortForwards) {
  const [firewalls, setFirewalls] = useState([]);
  const [selectedFw, setSelectedFw] = useState(null);
  const [fwConfig, setFwConfig] = useState(null);
  const [vips, setVips] = useState([]);
  const [interfaces, setInterfaces] = useState([]);
  const [vmTargets, setVmTargets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editingWan, setEditingWan] = useState(false);
  const [wanForm, setWanForm] = useState({ externalIp: '', rootWanZone: 'underlay' });
  const [savingWan, setSavingWan] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const [form, setForm] = useState(initialForm);
  const [attempted, setAttempted] = useState(false);
  const [deleting, setDeleting] = useState(null);

  useEffect(() => {
    api.get('/admin/firewalls').then(r => {
      setFirewalls(r.data);
      if (r.data.length) setSelectedFw(r.data[0].id);
    }).catch(() => setError('Failed to load firewalls')).finally(() => setLoading(false));
  }, []);

  const loadData = useCallback(async () => {
    if (!selectedFw) return;
    setLoading(true);
    setError('');
    try {
      const fw = firewalls.find(item => item.id === selectedFw);
      if (fw) {
        setFwConfig({ external_ip: fw.external_ip || '', root_wan_zone: fw.root_wan_zone || 'underlay' });
        setWanForm({ externalIp: fw.external_ip || '', rootWanZone: fw.root_wan_zone || 'underlay' });
      }
      const [vipsRes, ifacesRes, targetsRes] = await Promise.all([
        api.get(`/admin/firewalls/${selectedFw}/vips`),
        canManageAllPortForwards ? api.get(`/admin/firewalls/${selectedFw}/root-interfaces`) : Promise.resolve({ data: [] }),
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

  const selectedVm = useMemo(() => vmTargets.find(v => `${routeNode(v)}/${v.vmid}` === form.vmKey) || null, [form.vmKey, vmTargets]);
  const selectableTargets = useMemo(() => vmTargets.filter(v => v.eligible || v.overridable), [vmTargets]);
  const blockedTargets = useMemo(() => vmTargets.filter(v => !v.eligible && !v.overridable), [vmTargets]);
  const blockedCallout = useMemo(() => getBlockedCallout(loading, selectableTargets, blockedTargets), [loading, selectableTargets, blockedTargets]);
  const protocol = form.service === 'Custom' ? form.customProtocol : form.protocol;
  const portConflict = form.extPort ? vips.find(v => String(v.extport) === String(form.extPort) && (v.protocol || 'tcp') === protocol) : null;
  const missingFields = getMissingFields(form, portConflict);

  const handleVmChange = vmKey => {
    if (!vmKey) {
      setForm(value => ({ ...value, vmKey: '', mappedIp: '', dstInterface: '', name: '' }));
      return;
    }
    const vm = vmTargets.find(v => `${routeNode(v)}/${v.vmid}` === vmKey);
    if (!vm) return;
    setForm(value => ({ ...value, vmKey, mappedIp: vm.ip, dstInterface: vm.dstInterface || value.dstInterface, vlanInterface: vm.vlanInterface || '', name: buildRuleName(vm.name, value.service, value.mappedPort, value.customProtocol) }));
  };

  const handleServiceChange = service => {
    const preset = SERVICE_PRESETS.find(item => item.label === service);
    const vmName = selectedVm?.name || '';
    setForm(value => preset?.port ? {
      ...value, service, protocol: preset.protocol, mappedPort: String(preset.port), extPort: value.extPort || String(preset.port),
      name: buildRuleName(vmName, service, preset.port, preset.protocol) || value.name,
    } : { ...value, service, mappedPort: '', name: buildRuleName(vmName, service, value.mappedPort, value.customProtocol) || value.name });
  };

  const saveWanConfig = async () => {
    setSavingWan(true);
    try {
      await api.put(`/admin/firewalls/${selectedFw}/wan-config`, { externalIp: wanForm.externalIp, rootWanZone: wanForm.rootWanZone });
      setFwConfig({ external_ip: wanForm.externalIp, root_wan_zone: wanForm.rootWanZone });
      setEditingWan(false);
      setFirewalls(previous => previous.map(fw => fw.id === selectedFw ? { ...fw, external_ip: wanForm.externalIp, root_wan_zone: wanForm.rootWanZone } : fw));
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save WAN config');
    } finally {
      setSavingWan(false);
    }
  };

  const handleCreate = async event => {
    event.preventDefault();
    setAttempted(true);
    if (missingFields.length) return;
    setCreating(true);
    setCreateError('');
    try {
      await api.post(`/admin/firewalls/${selectedFw}/vips`, {
        node: selectedVm?.nodeRef || selectedVm?.node, vmid: selectedVm?.vmid, name: form.name, protocol,
        extPort: parseInt(form.extPort), mappedIp: form.mappedIp, mappedPort: parseInt(form.mappedPort),
        dstInterface: form.dstInterface, vlanInterface: form.vlanInterface, srcAddresses: ['all'],
      });
      setShowCreate(false);
      setForm(initialForm());
      setAttempted(false);
      await loadData();
    } catch (err) {
      setCreateError(err.response?.data?.error || 'Failed to create port forward');
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async vipName => {
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

  const closeCreate = () => { setShowCreate(false); setCreateError(''); setAttempted(false); };
  const toggleCreate = () => { setShowCreate(value => !value); setCreateError(''); setAttempted(false); };
  const selectFirewall = id => { setSelectedFw(id); setShowCreate(false); };
  const cancelWanEdit = () => { setEditingWan(false); setWanForm({ externalIp: fwConfig.external_ip, rootWanZone: fwConfig.root_wan_zone }); };
  const sortedVips = useMemo(() => [...vips].sort((a, b) => a.managed !== b.managed ? (a.managed ? -1 : 1) : parseInt(a.extport || 0) - parseInt(b.extport || 0)), [vips]);

  return {
    firewalls, selectedFw, selectFirewall, fwConfig, vips, interfaces, vmTargets, loading, error, setError,
    editingWan, setEditingWan, wanForm, setWanForm, savingWan, saveWanConfig, cancelWanEdit,
    showCreate, toggleCreate, closeCreate, creating, createError, form, setForm, attempted, deleting,
    selectedVm, selectableTargets, blockedTargets, blockedCallout, portConflict, missingFields,
    handleVmChange, handleServiceChange, handleCreate, handleDelete, sortedVips,
  };
}
