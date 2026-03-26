import { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../api.js';

export default function VMIPManagementPanel({ node, vmid, currentSshHost = '', onSshHostUpdate }) {
  const [interfaces, setInterfaces] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const response = await api.get(`/vms/${node}/${vmid}/ip-management`);
      setInterfaces(response.data.interfaces || []);
      setError('');
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to load IP management');
    } finally {
      setLoading(false);
    }
  }, [node, vmid]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-white">IP Management</h2>
        <button
          type="button"
          onClick={load}
          className="text-xs text-gray-500 hover:text-white transition-colors"
        >
          Refresh
        </button>
      </div>

      {loading ? (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          {[1, 2].map((item) => (
            <div key={item} className="h-52 rounded-2xl bg-gray-900 border border-gray-800 animate-pulse" />
          ))}
        </div>
      ) : error ? (
        <div className="bg-red-900/20 border border-red-800/40 rounded-2xl p-4 text-sm text-red-300">{error}</div>
      ) : interfaces.length === 0 ? (
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5 text-sm text-gray-500">
          No network interfaces were detected on this VM.
        </div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          {interfaces.map((network) => (
            <IPInterfaceCard
              key={network.name}
              network={network}
              node={node}
              vmid={vmid}
              currentSshHost={currentSshHost}
              onReload={load}
              onSshHostUpdate={onSshHostUpdate}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function IPInterfaceCard({ network, node, vmid, currentSshHost, onReload, onSshHostUpdate }) {
  const scopes = network.dhcpScopes || [];
  const defaultScopeId = useMemo(() => {
    const preferred = scopes.find((scope) => !scope.error);
    return preferred ? String(preferred.firewallId) : (scopes[0] ? String(scopes[0].firewallId) : '');
  }, [scopes]);

  const [selectedFirewallId, setSelectedFirewallId] = useState(defaultScopeId);
  const selectedScope = useMemo(() => (
    scopes.find((scope) => String(scope.firewallId) === String(selectedFirewallId)) || scopes[0] || null
  ), [scopes, selectedFirewallId]);

  const [reservationIp, setReservationIp] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  useEffect(() => {
    setSelectedFirewallId((current) => current || defaultScopeId);
  }, [defaultScopeId]);

  useEffect(() => {
    setReservationIp(selectedScope?.reservation?.ip || selectedScope?.effectiveIp || '');
    setDescription(selectedScope?.reservation?.description || '');
    setError('');
    setSuccess('');
  }, [selectedScope?.firewallId, selectedScope?.reservation?.ip, selectedScope?.effectiveIp, selectedScope?.reservation?.description]);

  const saveReservation = async () => {
    if (!selectedScope || selectedScope.error) return;

    setSaving(true);
    setError('');
    setSuccess('');

    try {
      const { data } = await api.put(`/vms/${node}/${vmid}/ip-management/${encodeURIComponent(network.name)}/reservation`, {
        firewallId: selectedScope.firewallId,
        ip: reservationIp,
        description,
      });

      if (data.sshConfigHost) {
        onSshHostUpdate?.(data.sshConfigHost);
      }

      setSuccess(data.sshConfigHost
        ? 'Reservation saved and SSH target updated'
        : 'Reservation saved');
      await onReload?.();
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to save reservation');
    } finally {
      setSaving(false);
    }
  };

  const removeReservation = async () => {
    if (!selectedScope || selectedScope.error || !selectedScope.reservation) return;

    setSaving(true);
    setError('');
    setSuccess('');

    try {
      await api.delete(`/vms/${node}/${vmid}/ip-management/${encodeURIComponent(network.name)}/reservation`, {
        data: { firewallId: selectedScope.firewallId },
      });
      setSuccess('Reservation removed');
      await onReload?.();
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to remove reservation');
    } finally {
      setSaving(false);
    }
  };

  const currentIp = selectedScope?.effectiveIp || '';
  const currentIpLabel = selectedScope?.reservation?.ip
    ? 'Reserved'
    : selectedScope?.currentLease?.ip
      ? 'Leased'
      : '';
  const sshMismatch = currentSshHost && currentIp && currentSshHost !== currentIp;

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-white font-semibold">{network.name}</h3>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Badge>{network.model || network.guestName || 'nic'}</Badge>
            {network.vlanTag ? <Badge accent="blue">VLAN {network.vlanTag}</Badge> : <Badge accent="gray">Untagged</Badge>}
            {network.vlan?.name && <Badge accent="emerald">{network.vlan.name}</Badge>}
          </div>
        </div>

        <div className="text-right text-xs text-gray-500 font-mono">
          <p>{network.mac || 'No MAC'}</p>
          {network.bridge && <p className="mt-1">{network.bridge}</p>}
        </div>
      </div>

      {network.status !== 'managed' ? (
        <p className="text-sm text-gray-400 bg-gray-950/70 border border-gray-800 rounded-xl px-4 py-3">
          {network.message}
        </p>
      ) : (
        <>
          {scopes.length > 1 && (
            <div>
              <label className="block text-xs text-gray-500 mb-1.5">Firewall DHCP Scope</label>
              <select
                value={selectedFirewallId}
                onChange={(e) => setSelectedFirewallId(e.target.value)}
                className={inputCls}
              >
                {scopes.map((scope) => (
                  <option key={scope.firewallId} value={scope.firewallId}>
                    {scope.firewallName} ({scope.interfaceName})
                  </option>
                ))}
              </select>
            </div>
          )}

          {selectedScope?.error ? (
            <p className="text-sm text-red-300 bg-red-900/20 border border-red-800/30 rounded-xl px-4 py-3">
              {selectedScope.error}
            </p>
          ) : (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <InfoCard
                  label="Current IP"
                  value={currentIp || 'No DHCP match'}
                  note={currentIpLabel || 'No current lease or reservation'}
                  accent={currentIp ? 'emerald' : 'gray'}
                />
                <InfoCard
                  label="DHCP Scope"
                  value={selectedScope?.subnet || 'Unknown subnet'}
                  note={selectedScope?.rangeStart && selectedScope?.rangeEnd
                    ? `${selectedScope.rangeStart} - ${selectedScope.rangeEnd}`
                    : `${selectedScope?.firewallName} / ${selectedScope?.interfaceName}`}
                  accent="blue"
                />
              </div>

              {selectedScope?.currentLease?.hostname && (
                <p className="text-xs text-gray-500">
                  DHCP hostname: <span className="text-gray-300">{selectedScope.currentLease.hostname}</span>
                </p>
              )}

              {sshMismatch && (
                <p className="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">
                  SSH is currently pointed at {currentSshHost}. Saving a reservation here will move the SSH target to the reserved IP.
                </p>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1.5">Reserved IP</label>
                  <input
                    type="text"
                    value={reservationIp}
                    onChange={(e) => setReservationIp(e.target.value)}
                    placeholder={selectedScope?.currentLease?.ip || '10.10.x.x'}
                    className={inputCls}
                  />
                </div>

                <div>
                  <label className="block text-xs text-gray-500 mb-1.5">Description</label>
                  <input
                    type="text"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder={network.vlan?.name ? `${network.vlan.name} reservation` : 'Optional note'}
                    className={inputCls}
                  />
                </div>
              </div>

              {error && <p className="text-xs text-red-300 bg-red-900/20 border border-red-800/30 rounded-lg px-3 py-2">{error}</p>}
              {success && <p className="text-xs text-green-300 bg-green-900/20 border border-green-800/30 rounded-lg px-3 py-2">{success}</p>}

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={saveReservation}
                  disabled={saving || !reservationIp.trim()}
                  className="text-xs px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white font-medium transition-colors"
                >
                  {saving ? 'Saving...' : selectedScope?.reservation ? 'Update Reservation' : 'Reserve IP'}
                </button>

                <button
                  type="button"
                  onClick={removeReservation}
                  disabled={saving || !selectedScope?.reservation}
                  className="text-xs px-4 py-2 rounded-lg bg-gray-800 hover:bg-gray-700 disabled:opacity-40 text-gray-200 transition-colors"
                >
                  Remove Reservation
                </button>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

function Badge({ children, accent = 'gray' }) {
  const styles = {
    gray: 'bg-gray-800 text-gray-300 border-gray-700',
    blue: 'bg-blue-500/10 text-blue-300 border-blue-500/20',
    emerald: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20',
  };

  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide ${styles[accent] || styles.gray}`}>
      {children}
    </span>
  );
}

function InfoCard({ label, value, note, accent = 'gray' }) {
  const accents = {
    gray: 'text-gray-300',
    blue: 'text-blue-300',
    emerald: 'text-emerald-300',
  };

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-950/60 px-4 py-3">
      <p className="text-[11px] uppercase tracking-[0.2em] text-gray-600">{label}</p>
      <p className={`mt-2 font-mono text-sm ${accents[accent] || accents.gray}`}>{value}</p>
      <p className="mt-1 text-xs text-gray-500">{note}</p>
    </div>
  );
}

const inputCls = 'w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 transition-colors';
