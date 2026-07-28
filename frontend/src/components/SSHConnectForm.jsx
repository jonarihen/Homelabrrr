import { useEffect, useState } from 'react';
import api from '../api.js';
import { routeNode } from '../utils/nodeRef.js';

const inputCls = 'w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 transition-colors';
const btnCls = 'w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg py-2.5 text-sm font-medium transition-colors';

/**
 * Reusable SSH connection form (key selection, host/port/username/fingerprint).
 *
 * @param {object} props
 * @param {object} props.vm                  VM object with node/vmid/nodeRef
 * @param {function} props.onConnect         Called with (token, mintToken) on successful connect.
 *                                           `mintToken` re-runs just the connect POST with the
 *                                           same key and passphrase and resolves to a fresh
 *                                           token, so a dropped session can reconnect without
 *                                           sending the user back through this form. The
 *                                           passphrase stays captive in this closure.
 * @param {string}  [props.connectEndpoint]  REST endpoint (default '/ssh/connect')
 * @param {string}  [props.submitLabel]      Button label (default 'Connect')
 */
export default function SSHConnectForm({ vm, onConnect, connectEndpoint = '/ssh/connect', submitLabel = 'Connect' }) {
  const vmNode = routeNode(vm);
  const [keys, setKeys] = useState([]);
  const [form, setForm] = useState({
    keyId: '',
    host: '',
    port: 22,
    username: 'root',
    hostFingerprint: '',
    passphrase: '',
  });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [scanningFingerprint, setScanningFingerprint] = useState(false);
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    let cancelled = false;

    Promise.all([
      api.get('/ssh/keys'),
      api.get(`/ssh/config/${vmNode}/${vm.vmid}`),
    ]).then(([keysRes, configRes]) => {
      if (cancelled) return;

      setKeys(keysRes.data);
      const cfg = configRes.data;
      if (cfg) {
        setForm((current) => ({
          ...current,
          host: cfg.host,
          port: cfg.port,
          username: cfg.username,
          hostFingerprint: cfg.hostFingerprint || '',
        }));
      }

      if (keysRes.data.length > 0) {
        setForm((current) => ({
          ...current,
          keyId: current.keyId || keysRes.data[0].id,
        }));
      }
    }).catch((e) => {
      if (!cancelled) {
        setError(e.response?.data?.error || 'Failed to load SSH config');
      }
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });

    return () => { cancelled = true; };
  }, [vmNode, vm.vmid]);

  const connect = async (e) => {
    e.preventDefault();
    setError('');

    if (!form.keyId) return setError('Select an SSH key');
    if (!form.host) return setError('Host/IP is required');
    if (!form.hostFingerprint) return setError('SSH host fingerprint is required');

    setConnecting(true);
    try {
      await api.put(`/ssh/config/${vmNode}/${vm.vmid}`, {
        host: form.host,
        port: form.port,
        username: form.username,
        hostFingerprint: form.hostFingerprint,
      });

      // The host config is already persisted above, so a reconnect only needs
      // to re-mint the single-use session token.
      const mintToken = async () => {
        const { data } = await api.post(connectEndpoint, {
          node: vmNode,
          vmid: vm.vmid,
          keyId: form.keyId,
          passphrase: form.passphrase,
        });
        return data.token;
      };

      onConnect(await mintToken(), mintToken);
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to connect');
    } finally {
      setConnecting(false);
    }
  };

  const scanFingerprint = async () => {
    if (!form.host) {
      setError('Enter the SSH host/IP before scanning');
      return;
    }

    setScanningFingerprint(true);
    setError('');

    try {
      const { data } = await api.post(`/ssh/config/${vmNode}/${vm.vmid}/scan-fingerprint`, {
        host: form.host,
        port: form.port,
      });

      setForm((current) => ({ ...current, hostFingerprint: data.hostFingerprint || '' }));
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to scan SSH fingerprint');
    } finally {
      setScanningFingerprint(false);
    }
  };

  if (loading) {
    return <div className="h-40 flex items-center justify-center text-gray-500 text-sm">Loading...</div>;
  }

  if (keys.length === 0) {
    return (
      <div className="text-center py-8">
        <p className="text-gray-400 text-sm mb-2">No SSH keys found</p>
        <p className="text-gray-500 text-xs">Add an SSH key in the SSH Keys page first.</p>
      </div>
    );
  }

  return (
    <form onSubmit={connect} className="space-y-4">
      <Field label="SSH Key">
        <select
          value={form.keyId}
          onChange={(e) => setForm((current) => ({ ...current, keyId: Number.parseInt(e.target.value, 10) }))}
          className={inputCls}
        >
          {keys.map((key) => (
            <option key={key.id} value={key.id}>{key.name}</option>
          ))}
        </select>
      </Field>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Host / IP">
          <input
            type="text"
            required
            value={form.host}
            onChange={(e) => setForm((current) => ({ ...current, host: e.target.value }))}
            className={inputCls}
            placeholder="192.168.1.100"
          />
        </Field>

        <Field label="Port">
          <input
            type="number"
            value={form.port}
            onChange={(e) => setForm((current) => ({ ...current, port: Number.parseInt(e.target.value, 10) || 22 }))}
            className={inputCls}
          />
        </Field>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Username">
          <input
            type="text"
            value={form.username}
            onChange={(e) => setForm((current) => ({ ...current, username: e.target.value }))}
            className={inputCls}
          />
        </Field>

        <Field label="Key Passphrase (if encrypted)">
          <input
            type="password"
            value={form.passphrase}
            onChange={(e) => setForm((current) => ({ ...current, passphrase: e.target.value }))}
            className={inputCls}
            placeholder="Leave empty if none"
          />
        </Field>
      </div>

      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label className="block text-xs text-gray-400">Host Key Fingerprint</label>
          <button
            type="button"
            onClick={scanFingerprint}
            disabled={scanningFingerprint}
            className="text-xs text-blue-400 hover:text-blue-300 disabled:opacity-50 transition-colors"
          >
            {scanningFingerprint ? 'Scanning...' : 'Scan fingerprint'}
          </button>
        </div>

        <input
          type="text"
          required
          value={form.hostFingerprint}
          onChange={(e) => setForm((current) => ({ ...current, hostFingerprint: e.target.value }))}
          className={inputCls}
          placeholder="SHA256:..."
        />

        <p className="mt-1.5 text-xs text-gray-500">
          Scan reads the server host key and stores a pinned fingerprint for future SSH verification.
        </p>
      </div>

      {error && <p className="text-xs text-red-400 bg-red-900/20 rounded p-2">{error}</p>}

      <button type="submit" disabled={connecting} className={btnCls}>
        {connecting ? 'Connecting...' : submitLabel}
      </button>
    </form>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <label className="block text-xs text-gray-400 mb-1.5">{label}</label>
      {children}
    </div>
  );
}
