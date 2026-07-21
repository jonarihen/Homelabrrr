import { useState, useEffect } from 'react';
import Modal from './Modal.jsx';
import api from '../api.js';
import { routeNode } from '../utils/nodeRef.js';
import { useAuth } from '../contexts/AuthContext.jsx';

export default function VLANModal({ vm, onClose, onSaved }) {
  const vmNode = routeNode(vm);
  const { user } = useAuth();
  const isAdmin = !!user?.isAdmin;
  const [vlans, setVlans]           = useState([]);
  const [config, setConfig]         = useState(null);
  const [selectedTag, setSelectedTag] = useState('');
  const [netIface, setNetIface]     = useState('net0');
  const [reboot, setReboot]         = useState(false);
  const [loading, setLoading]       = useState(true);
  const [saving, setSaving]         = useState(false);
  const [error, setError]           = useState('');
  const [step, setStep]             = useState('form'); // 'form' | 'confirm'

  useEffect(() => {
    Promise.all([
      api.get('/vms/my-vlans'),
      api.get(`/vms/${vmNode}/${vm.vmid}/config`),
    ]).then(([vlanRes, cfgRes]) => {
      setVlans(vlanRes.data);
      setConfig(cfgRes.data);

      // Parse current VLAN tag from net0
      const iface = 'net0';
      const netStr = cfgRes.data[iface] || '';
      const tagMatch = netStr.match(/tag=(\d+)/);
      if (tagMatch) setSelectedTag(tagMatch[1]);
    }).catch(e => setError(e.response?.data?.error || 'Failed to load')).finally(() => setLoading(false));
  }, [vmNode, vm.vmid]);

  // Detect available net interfaces from config
  const netInterfaces = config
    ? Object.keys(config).filter(k => /^net\d+$/.test(k))
    : ['net0'];

  const currentNetStr = config?.[netIface] || '';
  const currentTag = currentNetStr.match(/tag=(\d+)/)?.[1] || 'Untagged';

  const apply = async () => {
    setSaving(true);
    setError('');
    try {
      await api.put(`/vms/${vmNode}/${vm.vmid}/vlan`, {
        netInterface: netIface,
        vlanTag: selectedTag === '' ? null : parseInt(selectedTag),
      });
      if (reboot) {
        await api.post(`/vms/${vmNode}/${vm.vmid}/action`, { action: 'reboot' });
      }
      onSaved?.();
      onClose();
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to apply');
      setStep('form');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={`Change VLAN — ${vm.name || `VM ${vm.vmid}`}`} onClose={onClose} size="sm">
      <div className="p-5 space-y-4">
        {loading ? (
          <p className="text-gray-400 text-sm text-center py-4">Loading...</p>
        ) : step === 'form' ? (
          <>
            {/* Net interface selector */}
            <div>
              <label className="block text-xs text-gray-400 mb-1">Network Interface</label>
              <select
                value={netIface}
                onChange={e => setNetIface(e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
              >
                {netInterfaces.map(i => <option key={i} value={i}>{i}</option>)}
              </select>
              <p className="text-xs text-gray-500 mt-1">Current: {currentNetStr || '—'}</p>
            </div>

            {/* VLAN selector */}
            <div>
              <label className="block text-xs text-gray-400 mb-1">VLAN Tag</label>
              {vlans.length === 0 ? (
                <p className="text-xs text-yellow-400 bg-yellow-900/20 rounded p-3">
                  No VLANs assigned to your account. Ask an admin to assign VLANs.
                </p>
              ) : (
                <div className="space-y-2">
                  {/* Untagged drops the VM onto the native network — admin-only.
                      The backend enforces this too (see utils/vlanAccess.js). */}
                  {isAdmin && (
                    <label className="flex items-center gap-3 p-2.5 rounded-lg bg-gray-800 border border-gray-700 cursor-pointer hover:border-blue-500 transition-colors">
                      <input
                        type="radio"
                        name="vlan"
                        value=""
                        checked={selectedTag === ''}
                        onChange={() => setSelectedTag('')}
                        className="accent-blue-500"
                      />
                      <span className="text-sm text-gray-300">Untagged (remove VLAN)</span>
                    </label>
                  )}
                  {vlans.map(v => (
                    <label
                      key={v.id}
                      className="flex items-center gap-3 p-2.5 rounded-lg bg-gray-800 border border-gray-700 cursor-pointer hover:border-blue-500 transition-colors"
                    >
                      <input
                        type="radio"
                        name="vlan"
                        value={v.tag}
                        checked={selectedTag === String(v.tag)}
                        onChange={() => setSelectedTag(String(v.tag))}
                        className="accent-blue-500"
                      />
                      <div>
                        <span className="text-sm text-white">{v.name}</span>
                        <span className="text-xs text-gray-500 ml-2">Tag {v.tag}</span>
                        {v.description && <p className="text-xs text-gray-500">{v.description}</p>}
                      </div>
                    </label>
                  ))}
                </div>
              )}
            </div>

            {error && <p className="text-xs text-red-400 bg-red-900/20 rounded p-2">{error}</p>}

            <button
              onClick={() => setStep('confirm')}
              disabled={vlans.length === 0 || (!isAdmin && selectedTag === '')}
              className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded-lg py-2.5 text-sm font-medium transition-colors"
            >
              Continue
            </button>
          </>
        ) : (
          /* Confirm step */
          <div className="space-y-4">
            <div className="bg-gray-800 rounded-lg p-4 text-sm space-y-1">
              <p className="text-gray-400">Interface: <span className="text-white">{netIface}</span></p>
              <p className="text-gray-400">
                VLAN: <span className="text-white line-through mr-2">{currentTag}</span>
                <span className="text-green-400">{selectedTag === '' ? 'Untagged' : `Tag ${selectedTag}`}</span>
              </p>
            </div>

            <p className="text-sm text-gray-300">
              The network config will be updated now. The guest OS may need the network interface
              restarted to pick up the change.
            </p>

            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={reboot}
                onChange={e => setReboot(e.target.checked)}
                className="mt-0.5 accent-blue-500"
              />
              <span className="text-sm text-gray-300">
                Reboot VM after applying (recommended for guest to pick up the new VLAN)
              </span>
            </label>

            {error && <p className="text-xs text-red-400 bg-red-900/20 rounded p-2">{error}</p>}

            <div className="flex gap-3">
              <button
                onClick={() => setStep('form')}
                className="flex-1 bg-gray-700 hover:bg-gray-600 text-white rounded-lg py-2.5 text-sm transition-colors"
              >
                Back
              </button>
              <button
                onClick={apply}
                disabled={saving}
                className="flex-1 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg py-2.5 text-sm font-medium transition-colors"
              >
                {saving ? 'Applying...' : reboot ? 'Apply & Reboot' : 'Apply'}
              </button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
