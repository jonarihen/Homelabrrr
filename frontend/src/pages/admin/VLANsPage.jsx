import { useId, useState, useEffect } from 'react';
import api from '../../api.js';
import Modal from '../../components/Modal.jsx';
import useDocumentTitle from '../../hooks/useDocumentTitle.js';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useNotify } from '../../contexts/NotificationsContext.jsx';
import { useConfirm } from '../../contexts/ConfirmContext.jsx';

function buildManagedSubnet(tag) {
  const parsedTag = parseInt(tag, 10);
  if (!parsedTag || String(parsedTag).length !== 4) return null;

  const padded = String(parsedTag).padStart(4, '0');
  const octet2 = parseInt(padded.substring(0, 2), 10);
  const octet3 = parseInt(padded.substring(2, 4), 10);
  if (octet2 > 255 || octet3 > 255) return null;

  return {
    network: `10.${octet2}.${octet3}.0/24`,
    gateway: `10.${octet2}.${octet3}.1`,
    dhcp: `10.${octet2}.${octet3}.10 - 10.${octet2}.${octet3}.254`,
  };
}

function findNextAvailableVlanTag(vlans, firewalls) {
  const usedTags = new Set(vlans.map(vlan => parseInt(vlan.tag, 10)).filter(Number.isInteger));
  const ranges = firewalls.length > 0
    ? firewalls
        .map(firewall => ({
          start: firewall.vlan_range_start || 1001,
          end: firewall.vlan_range_end || 1999,
        }))
        .sort((a, b) => a.start - b.start || a.end - b.end)
    : [{ start: 1001, end: 1999 }];

  for (const range of ranges) {
    for (let tag = range.start; tag <= range.end; tag += 1) {
      if (!usedTags.has(tag)) return tag;
    }
  }

  for (let tag = 1; tag <= 4094; tag += 1) {
    if (!usedTags.has(tag)) return tag;
  }

  return null;
}

export default function VLANsPage() {
  useDocumentTitle('VLANs');
  const { user } = useAuth();
  const notify = useNotify();
  const confirm = useConfirm();
  const [vlans, setVlans]       = useState([]);
  const [firewalls, setFirewalls] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editVlan, setEditVlan] = useState(null);
  const [syncModalVlan, setSyncModalVlan] = useState(null);
  const [error, setError]       = useState('');

  const load = async () => {
    try {
      const vlanRes = await api.get('/admin/vlans');
      setVlans(vlanRes.data);
      // Extract firewall ranges from VLAN data (always available)
      // Full firewall list only loads for users with can_manage_firewalls
      try {
        const fwRes = await api.get('/admin/firewalls');
        setFirewalls(fwRes.data);
      } catch {
        // Non-admin VLAN managers won't have firewall access — use ranges from VLAN data
        const ranges = vlanRes.data[0]?.firewallRanges || [];
        setFirewalls(ranges);
      }
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to load');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const del = async (id) => {
    const vlan = vlans.find(v => v.id === id);
    const hasSyncs = vlan?.firewallSync?.length > 0;
    const msg = hasSyncs
      ? `This will remove VLAN ${vlan.tag} (${vlan.name}) from: ${vlan.firewallSync.map(s => s.firewallName).join(', ')}. All user assignments will also be removed.`
      : `Delete VLAN ${vlan.tag} (${vlan.name})? All user assignments will be removed.`;
    if (!(await confirm({ title: 'Delete VLAN', message: msg, confirmLabel: 'Delete', danger: true }))) return;
    try {
      const r = await api.delete(`/admin/vlans/${id}`);
      const failed = r.data?.firewallCleanup?.filter(f => f.status === 'error' || f.status === 'partial');
      if (failed?.length > 0) {
        notify.warning(`VLAN deleted from database, but FortiGate cleanup had issues: ${failed.map(f => `${f.firewall}: ${f.error || f.errors?.join(', ')}`).join('; ')}. You may need to manually remove the interface/policies from the firewall.`);
      }
      load();
    } catch (e) {
      notify.error(e.response?.data?.error || 'Failed to delete');
    }
  };

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="aaris-display text-lg text-gray-100">VLANs</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {vlans.length} defined
            {firewalls.length > 0 && <span className="ml-2 text-orange-400/70">| {firewalls.length} firewall{firewalls.length !== 1 ? 's' : ''} connected</span>}
          </p>
        </div>
        <button
          onClick={() => { setEditVlan(null); setModalOpen(true); }}
          className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
        >
          + New VLAN
        </button>
      </div>

      {error && <p role="alert" className="text-red-400 text-sm mb-4 bg-red-900/20 rounded p-3">{error}</p>}

      {loading ? (
        <div className="space-y-3">
          {[1,2,3].map(i => <div key={i} className="h-14 bg-gray-900 rounded-xl animate-pulse" />)}
        </div>
      ) : vlans.length === 0 ? (
        <div className="text-center py-20 text-gray-500">
          <p>No VLANs {user?.isAdmin ? 'defined' : 'assigned to you'} yet.</p>
          <p className="text-sm mt-1">{user?.isAdmin ? 'Create a VLAN and then assign it to users.' : 'Create a new VLAN or ask an admin to assign one to you.'}</p>
        </div>
      ) : (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800 text-gray-500 text-xs uppercase tracking-wider">
                <th className="text-left px-4 py-3">Tag</th>
                <th className="text-left px-4 py-3">Name</th>
                <th className="text-left px-4 py-3">Subnet</th>
                <th className="text-left px-4 py-3">Firewall</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {vlans.map(v => (
                <tr key={v.id} className="border-b border-gray-800 last:border-0 hover:bg-gray-800/50 transition-colors">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-blue-400 bg-blue-900/20 px-2 py-0.5 rounded text-xs">{v.tag}</span>
                      {v.mode === 'tagged_only' && (
                        <span className="text-[10px] uppercase tracking-wider text-fuchsia-300 bg-fuchsia-500/10 border border-fuchsia-500/20 px-2 py-0.5 rounded">
                          Tagged only
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-white font-medium">
                    {v.name}
                    {v.description && <span className="text-gray-500 text-xs ml-2">{v.description}</span>}
                  </td>
                  <td className="px-4 py-3">
                    {v.subnet ? (
                      <div className="space-y-1">
                        <span className="font-mono text-xs text-gray-400">{v.subnet.network}</span>
                        {v.mode === 'tagged_only' && (
                          <p className="text-[11px] text-fuchsia-300/80">Custom tagged subnet</p>
                        )}
                      </div>
                    ) : (
                      <span className="text-xs text-gray-600">N/A</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {v.firewallSync.length > 0 ? (
                      <div className="flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
                        <span className="text-xs text-green-400">
                          {v.firewallSync.map(s => s.firewallName).join(', ')}
                        </span>
                      </div>
                    ) : v.mode === 'tagged_only' ? (
                      <span className="text-xs text-fuchsia-300/80">Tagged only</span>
                    ) : firewalls.length > 0 ? (
                      <button
                        onClick={() => setSyncModalVlan(v)}
                        className="text-xs text-orange-400 hover:text-orange-300 bg-orange-500/10 hover:bg-orange-500/20 px-2 py-1 rounded transition-colors"
                      >
                        Push to Firewall
                      </button>
                    ) : (
                      <span className="text-xs text-gray-600">No firewalls</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      {v.mode !== 'tagged_only' && v.firewallSync.length > 0 && (
                        <button
                          onClick={() => setSyncModalVlan(v)}
                          className="text-xs text-orange-400 hover:text-orange-300 px-2 py-1 rounded hover:bg-gray-700 transition-colors"
                        >
                          Sync
                        </button>
                      )}
                      <button
                        onClick={() => { setEditVlan(v); setModalOpen(true); }}
                        className="text-xs text-blue-400 hover:text-blue-300 px-2 py-1 rounded hover:bg-gray-700 transition-colors"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => del(v.id)}
                        className="text-xs text-red-500 hover:text-red-400 px-2 py-1 rounded hover:bg-gray-700 transition-colors"
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modalOpen && (
        <VLANFormModal
          user={user}
          vlan={editVlan}
          vlans={vlans}
          firewalls={firewalls}
          onClose={() => setModalOpen(false)}
          onSaved={load}
        />
      )}

      {syncModalVlan && (
        <SyncModal
          vlan={syncModalVlan}
          firewalls={firewalls}
          onClose={() => setSyncModalVlan(null)}
          onSaved={load}
        />
      )}
    </div>
  );
}

function VLANFormModal({ user, vlan, vlans, firewalls, onClose, onSaved }) {
  const isAdmin = !!user?.isAdmin;
  const typeLabelId = useId();
  const tagId = useId();
  const subnetCidrId = useId();
  const nameId = useId();
  const descriptionId = useId();
  const suggestedTag = !vlan ? findNextAvailableVlanTag(vlans, firewalls) : null;
  const [form, setForm] = useState({
    name: vlan?.name || '',
    tag: vlan?.tag || suggestedTag || '',
    mode: vlan?.mode || 'managed',
    subnetCidr: vlan?.subnet_cidr || '',
    description: vlan?.description || '',
  });
  const [syncToFw, setSyncToFw] = useState(!vlan && firewalls.length > 0);
  const [allowInternet, setAllowInternet] = useState(true);
  const [enableDhcp, setEnableDhcp] = useState(true);
  const [error, setError]   = useState('');
  const [saving, setSaving] = useState(false);
  const [subnet, setSubnet] = useState(null);
  const isTaggedOnly = form.mode === 'tagged_only';

  // Compute subnet preview when tag changes
  useEffect(() => {
    if (isTaggedOnly) {
      setSubnet(form.subnetCidr ? { network: form.subnetCidr, gateway: '', dhcp: '', custom: true } : null);
      return;
    }
    setSubnet(buildManagedSubnet(form.tag));
  }, [form.tag, form.mode, form.subnetCidr, isTaggedOnly]);

  useEffect(() => {
    if (isTaggedOnly) {
      setSyncToFw(false);
    } else if (!vlan && firewalls.length > 0) {
      setSyncToFw(true);
    }
  }, [firewalls.length, isTaggedOnly, vlan]);

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      let vlanId = vlan?.id;
      if (vlan) {
        await api.put(`/admin/vlans/${vlan.id}`, {
          name: form.name,
          description: form.description,
          ...(isAdmin ? {
            tag: form.tag,
            mode: form.mode,
            subnetCidr: form.mode === 'tagged_only' ? form.subnetCidr : '',
          } : {}),
        });
      } else {
        const r = await api.post('/admin/vlans', {
          name: form.name,
          description: form.description,
          ...(isAdmin ? {
            tag: form.tag,
            mode: form.mode,
            subnetCidr: form.mode === 'tagged_only' ? form.subnetCidr : '',
          } : {}),
        });
        vlanId = r.data.id;
      }

      // Sync to firewalls if requested (only on create)
      if (!vlan && !isTaggedOnly && syncToFw && vlanId) {
        const syncRes = await api.post(`/admin/vlans/${vlanId}/sync`, { allowInternet, enableDhcp });
        const failed = syncRes.data?.filter(r => r.status === 'error');
        if (failed?.length > 0) {
          setError(`VLAN created, but firewall push failed:\n${failed.map(r => `${r.firewall}: ${r.error}`).join('\n')}`);
          onSaved();
          setSaving(false);
          return; // Keep modal open so user sees the error
        }
      }

      onSaved();
      onClose();
    } catch (e) {
      setError(e.response?.data?.error || e.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={vlan ? `Edit VLAN ${vlan.tag}` : 'New VLAN'} onClose={onClose} size="sm">
      <form onSubmit={submit} className="p-5 space-y-4">
        <div>
          <label id={typeLabelId} className="block text-xs text-gray-400 mb-1.5">VLAN Type</label>
          {isAdmin ? (
            <div className="grid grid-cols-2 gap-2" role="group" aria-labelledby={typeLabelId}>
              <button
                type="button"
                aria-pressed={!isTaggedOnly}
                onClick={() => setForm(f => ({ ...f, mode: 'managed', subnetCidr: '' }))}
                className={`rounded-lg border px-3 py-2.5 text-left transition-colors ${!isTaggedOnly ? 'border-blue-500 bg-blue-500/10 text-blue-300' : 'border-gray-700 bg-gray-800 text-gray-300 hover:border-gray-600'}`}
              >
                <span className="block text-sm font-medium">Managed</span>
                <span className="block text-xs text-gray-500 mt-1">Uses the lab tag scheme and can be pushed to the firewall.</span>
              </button>
              <button
                type="button"
                aria-pressed={isTaggedOnly}
                onClick={() => setForm(f => ({ ...f, mode: 'tagged_only' }))}
                className={`rounded-lg border px-3 py-2.5 text-left transition-colors ${isTaggedOnly ? 'border-fuchsia-500 bg-fuchsia-500/10 text-fuchsia-300' : 'border-gray-700 bg-gray-800 text-gray-300 hover:border-gray-600'}`}
              >
                <span className="block text-sm font-medium">Tagged Only</span>
                <span className="block text-xs text-gray-500 mt-1">Custom tag and subnet. Stays local and never syncs to the firewall.</span>
              </button>
            </div>
          ) : (
            <div className="rounded-lg border border-emerald-800/40 bg-emerald-900/10 px-3 py-2.5 text-sm text-emerald-300">
              {isTaggedOnly ? 'Tagged-only VLAN' : 'Managed VLAN'}
            </div>
          )}
        </div>
        <div>
          <label htmlFor={tagId} className="block text-xs text-gray-400 mb-1.5">
            VLAN Tag {isTaggedOnly ? '(1–4094)' : '(1000–4094 recommended)'}
          </label>
          {isAdmin ? (
            <input
              id={tagId}
              type="number"
              min="1" max="4094"
              required
              value={form.tag}
              onChange={e => setForm(f => ({ ...f, tag: e.target.value }))}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 transition-colors"
              placeholder={isTaggedOnly ? 'e.g. 11' : 'e.g. 1126'}
              autoFocus
            />
          ) : (
            <div className="w-full rounded-lg border border-emerald-800/40 bg-emerald-900/10 px-3 py-2.5 text-sm text-emerald-300">
              {form.tag || 'Auto-assigned on create'}
            </div>
          )}
          {!vlan && !isAdmin && suggestedTag && (
            <p className="mt-2 text-xs text-emerald-400">
              Non-admin VLAN managers are assigned the next free tag automatically from the firewall pool.
            </p>
          )}
          {!vlan && !isAdmin && !suggestedTag && (
            <p className="mt-2 text-xs text-amber-400">
              No free VLAN tags were found in the configured firewall pools. Ask an admin to expand the range or free a tag.
            </p>
          )}
          {!vlan && !isTaggedOnly && isAdmin && suggestedTag && String(form.tag) === String(suggestedTag) && (
            <p className="mt-2 text-xs text-emerald-400">
              Suggested next available tag from the configured firewall ranges.
            </p>
          )}
          {!isTaggedOnly && subnet && (
            <div className="mt-2 bg-blue-900/20 border border-blue-800/30 rounded-lg px-3 py-2 text-xs space-y-0.5">
              <p className="text-blue-400">Auto subnet: <span className="font-mono">{subnet.network}</span></p>
              <p className="text-gray-500">Gateway: <span className="font-mono text-gray-400">{subnet.gateway}</span></p>
              <p className="text-gray-500">DHCP range: <span className="font-mono text-gray-400">{subnet.dhcp}</span></p>
            </div>
          )}
        </div>
        {isTaggedOnly && (
          <div>
            <label htmlFor={subnetCidrId} className="block text-xs text-gray-400 mb-1.5">Subnet CIDR</label>
            <input
              id={subnetCidrId}
              type="text"
              required
              value={form.subnetCidr}
              onChange={e => setForm(f => ({ ...f, subnetCidr: e.target.value }))}
              placeholder="e.g. 192.168.11.0/24"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-fuchsia-500 transition-colors"
            />
            <p className="mt-2 text-xs text-fuchsia-300/80">
              Tagged-only VLANs use your custom subnet and are kept out of the firewall sync flow.
            </p>
          </div>
        )}
        <div>
          <label htmlFor={nameId} className="block text-xs text-gray-400 mb-1.5">Name</label>
          <input
            id={nameId}
            type="text"
            required
            value={form.name}
            onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            placeholder="e.g. Gaming, Office, IoT"
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 transition-colors"
          />
        </div>
        <div>
          <label htmlFor={descriptionId} className="block text-xs text-gray-400 mb-1.5">Description (optional)</label>
          <input
            id={descriptionId}
            type="text"
            value={form.description}
            onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 transition-colors"
          />
        </div>

        {/* Firewall sync options (only on create) */}
        {!vlan && !isTaggedOnly && firewalls.length > 0 && (() => {
          const tag = parseInt(form.tag);
          const inRange = firewalls.filter(f => tag >= (f.vlan_range_start || 1001) && tag <= (f.vlan_range_end || 1999));
          const outOfRange = tag && inRange.length === 0;
          return (
          <div className={`border rounded-lg p-3 space-y-3 ${outOfRange ? 'border-red-800/30 bg-red-900/10' : 'border-orange-800/30 bg-orange-900/10'}`}>
            {outOfRange ? (
              <p className="text-xs text-red-400">Tag {tag} is outside all firewall VLAN ranges ({firewalls.map(f => `${f.name}: ${f.vlan_range_start || 1001}–${f.vlan_range_end || 1999}`).join(', ')})</p>
            ) : (
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={syncToFw && !outOfRange}
                disabled={outOfRange}
                onChange={e => setSyncToFw(e.target.checked)}
                className="accent-orange-500"
              />
              <span className="text-sm text-orange-300">Create on FortiGate ({inRange.map(f => f.name).join(', ')})</span>
            </label>
            )}
            {syncToFw && (
              <div className="pl-5 space-y-2">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={allowInternet} onChange={e => setAllowInternet(e.target.checked)} className="accent-blue-500" />
                  <span className="text-xs text-gray-400">Allow internet access (outbound NAT policy)</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={enableDhcp} onChange={e => setEnableDhcp(e.target.checked)} className="accent-blue-500" />
                  <span className="text-xs text-gray-400">Enable DHCP server (.10 - .254)</span>
                </label>
              </div>
            )}
          </div>
          );
        })()}

        {error && <p role="alert" className="text-xs text-red-400 bg-red-900/20 rounded p-2">{error}</p>}
        <button type="submit" disabled={saving} className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg py-2.5 text-sm font-medium transition-colors">
          {saving ? 'Saving...' : vlan ? 'Save Changes' : !isTaggedOnly && syncToFw ? 'Create VLAN & Push to Firewall' : 'Create VLAN'}
        </button>
      </form>
    </Modal>
  );
}

function SyncModal({ vlan, firewalls, onClose, onSaved }) {
  const notify = useNotify();
  const [syncs, setSyncs]     = useState(vlan.firewallSync || []);
  const [syncing, setSyncing] = useState(false);
  const [removing, setRemoving] = useState(null);
  const [error, setError]     = useState('');
  const [results, setResults] = useState(null);
  const [allowInternet, setAllowInternet] = useState(true);
  const [enableDhcp, setEnableDhcp] = useState(true);

  const unsyncedFws = firewalls.filter(fw => !syncs.find(s => s.firewallId === fw.id));
  const inRangeFws = unsyncedFws.filter(fw => vlan.tag >= (fw.vlan_range_start || 1001) && vlan.tag <= (fw.vlan_range_end || 1999));
  const outOfRangeFws = unsyncedFws.filter(fw => vlan.tag < (fw.vlan_range_start || 1001) || vlan.tag > (fw.vlan_range_end || 1999));

  const pushToAll = async () => {
    setSyncing(true); setError(''); setResults(null);
    try {
      const r = await api.post(`/admin/vlans/${vlan.id}/sync`, { allowInternet, enableDhcp });
      setResults(r.data);
      onSaved();
      // Refresh sync state
      const syncRes = await api.get(`/admin/vlans/${vlan.id}/sync`);
      setSyncs(syncRes.data.map(s => ({ firewallId: s.firewall_id, firewallName: s.firewall_name, interfaceName: s.interface_name })));
    } catch (e) {
      setError(e.response?.data?.error || 'Sync failed');
    } finally { setSyncing(false); }
  };

  const removeSync = async (firewallId) => {
    setRemoving(firewallId);
    try {
      await api.delete(`/admin/vlans/${vlan.id}/sync/${firewallId}`);
      setSyncs(prev => prev.filter(s => s.firewallId !== firewallId));
      onSaved();
    } catch (e) {
      notify.error(e.response?.data?.error || 'Failed to remove');
    } finally { setRemoving(null); }
  };

  return (
    <Modal title={`Firewall Sync — VLAN ${vlan.tag} (${vlan.name})`} onClose={onClose} size="md">
      <div className="p-5 space-y-4">
        {vlan.subnet && (
          <div className="bg-gray-800/50 rounded-lg px-3 py-2 text-xs text-gray-400">
            Subnet: <span className="font-mono text-white">{vlan.subnet.network}</span> | Gateway: <span className="font-mono text-white">{vlan.subnet.gateway}</span>
          </div>
        )}

        {/* Current syncs */}
        {syncs.length > 0 && (
          <div>
            <p className="text-xs text-gray-500 uppercase tracking-wider mb-2">Synced to</p>
            <div className="space-y-2">
              {syncs.map(s => (
                <div key={s.firewallId} className="flex items-center justify-between bg-green-900/10 border border-green-800/30 rounded-lg px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
                    <span className="text-sm text-white">{s.firewallName}</span>
                    <span className="text-xs text-gray-500 font-mono">{s.interfaceName}</span>
                  </div>
                  <button
                    onClick={() => removeSync(s.firewallId)}
                    disabled={removing === s.firewallId}
                    className="text-xs text-red-500 hover:text-red-400 px-2 py-1 rounded hover:bg-red-500/10 transition-colors disabled:opacity-50"
                  >
                    {removing === s.firewallId ? 'Removing...' : 'Remove'}
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Push to unsynced firewalls */}
        {outOfRangeFws.length > 0 && (
          <div className="border border-red-800/30 bg-red-900/10 rounded-lg p-3">
            <p className="text-xs text-red-400">
              Tag {vlan.tag} is outside range for: {outOfRangeFws.map(f => `${f.name} (${f.vlan_range_start || 1001}–${f.vlan_range_end || 1999})`).join(', ')}
            </p>
          </div>
        )}
        {inRangeFws.length > 0 && (
          <div className="border border-orange-800/30 bg-orange-900/10 rounded-lg p-4 space-y-3">
            <p className="text-sm text-orange-300">
              Push to: {inRangeFws.map(f => f.name).join(', ')}
            </p>
            <div className="space-y-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={allowInternet} onChange={e => setAllowInternet(e.target.checked)} className="accent-blue-500" />
                <span className="text-xs text-gray-400">Allow internet access (outbound NAT)</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={enableDhcp} onChange={e => setEnableDhcp(e.target.checked)} className="accent-blue-500" />
                <span className="text-xs text-gray-400">Enable DHCP server</span>
              </label>
            </div>
            <button
              onClick={pushToAll}
              disabled={syncing}
              className="w-full bg-orange-600 hover:bg-orange-500 disabled:opacity-50 text-white rounded-lg py-2 text-sm font-medium transition-colors"
            >
              {syncing ? 'Provisioning...' : 'Push to Firewall'}
            </button>
          </div>
        )}

        {/* Results */}
        {results && (
          <div className="space-y-1">
            {results.map((r, i) => (
              <div key={i} className={`text-xs rounded px-3 py-2 ${r.status === 'ok' ? 'bg-green-900/20 text-green-400' : r.status === 'already_synced' ? 'bg-gray-800 text-gray-400' : 'bg-red-900/20 text-red-400'}`}>
                <span className="font-medium">{r.firewall}:</span> {r.status === 'ok' ? `Created ${r.interfaceName} (${r.subnet?.network})` : r.status === 'already_synced' ? 'Already synced' : r.error}
              </div>
            ))}
          </div>
        )}

        {error && <p role="alert" className="text-xs text-red-400 bg-red-900/20 rounded p-2">{error}</p>}
      </div>
    </Modal>
  );
}
