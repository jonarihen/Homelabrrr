import { useEffect, useRef, useState } from 'react';
import '@xterm/xterm/css/xterm.css';
import Modal from './Modal.jsx';
import api from '../api.js';

export default function SSHModal({ vm, onClose }) {
  const [step, setStep] = useState('config'); // 'config' | 'terminal'
  const [keys, setKeys] = useState([]);
  const [form, setForm] = useState({ keyId: '', host: '', port: 22, username: 'root', hostFingerprint: '', passphrase: '' });
  const [error, setError] = useState('');
  const [token, setToken] = useState(null);
  const [loading, setLoading] = useState(true);
  const [scanningFingerprint, setScanningFingerprint] = useState(false);

  useEffect(() => {
    Promise.all([
      api.get('/ssh/keys'),
      api.get(`/ssh/config/${vm.node}/${vm.vmid}`),
    ]).then(([keysRes, configRes]) => {
      setKeys(keysRes.data);
      const cfg = configRes.data;
      if (cfg) {
        setForm(f => ({
          ...f,
          host: cfg.host,
          port: cfg.port,
          username: cfg.username,
          hostFingerprint: cfg.hostFingerprint || '',
        }));
      }
      if (keysRes.data.length > 0) {
        setForm(f => ({ ...f, keyId: keysRes.data[0].id }));
      }
    }).catch(e => {
      setError(e.response?.data?.error || 'Failed to load SSH config');
    }).finally(() => setLoading(false));
  }, [vm.node, vm.vmid]);

  const connect = async (e) => {
    e.preventDefault();
    setError('');
    if (!form.keyId) return setError('Select an SSH key');
    if (!form.host) return setError('Host/IP is required');
    if (!form.hostFingerprint) return setError('SSH host fingerprint is required');

    try {
      // Save config for this VM
      await api.put(`/ssh/config/${vm.node}/${vm.vmid}`, {
        host: form.host,
        port: form.port,
        username: form.username,
        hostFingerprint: form.hostFingerprint,
      });
      // Get connection token
      const { data } = await api.post('/ssh/connect', {
        node: vm.node, vmid: vm.vmid,
        keyId: form.keyId,
        passphrase: form.passphrase,
      });
      setToken(data.token);
      setStep('terminal');
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to connect');
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
      const { data } = await api.post(`/ssh/config/${vm.node}/${vm.vmid}/scan-fingerprint`, {
        host: form.host,
        port: form.port,
      });
      setForm(f => ({ ...f, hostFingerprint: data.hostFingerprint || '' }));
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to scan SSH fingerprint');
    } finally {
      setScanningFingerprint(false);
    }
  };

  return (
    <Modal
      title={`SSH — ${vm.name || `VM ${vm.vmid}`}`}
      onClose={onClose}
      size={step === 'terminal' ? 'full' : 'md'}
    >
      {step === 'config' ? (
        <form onSubmit={connect} className="p-5 space-y-4">
          {loading ? (
            <div className="h-40 flex items-center justify-center text-gray-500 text-sm">Loading...</div>
          ) : keys.length === 0 ? (
            <div className="text-center py-8">
              <p className="text-gray-400 text-sm mb-2">No SSH keys found</p>
              <p className="text-gray-500 text-xs">Add an SSH key in the SSH Keys page first.</p>
            </div>
          ) : (
            <>
              <Field label="SSH Key">
                <select
                  value={form.keyId}
                  onChange={e => setForm(f => ({ ...f, keyId: parseInt(e.target.value) }))}
                  className={inputCls}
                >
                  {keys.map(k => (
                    <option key={k.id} value={k.id}>{k.name}</option>
                  ))}
                </select>
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Host / IP">
                  <input
                    type="text"
                    required
                    value={form.host}
                    onChange={e => setForm(f => ({ ...f, host: e.target.value }))}
                    className={inputCls}
                    placeholder="192.168.1.100"
                  />
                </Field>
                <Field label="Port">
                  <input
                    type="number"
                    value={form.port}
                    onChange={e => setForm(f => ({ ...f, port: parseInt(e.target.value) || 22 }))}
                    className={inputCls}
                  />
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Username">
                  <input
                    type="text"
                    value={form.username}
                    onChange={e => setForm(f => ({ ...f, username: e.target.value }))}
                    className={inputCls}
                  />
                </Field>
                <Field label="Key Passphrase (if encrypted)">
                  <input
                    type="password"
                    value={form.passphrase}
                    onChange={e => setForm(f => ({ ...f, passphrase: e.target.value }))}
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
                  onChange={e => setForm(f => ({ ...f, hostFingerprint: e.target.value }))}
                  className={inputCls}
                  placeholder="SHA256:..."
                />
                <p className="mt-1.5 text-xs text-gray-500">
                  Scan reads the server host key and stores a pinned fingerprint for future SSH verification.
                </p>
              </div>
              {error && <p className="text-xs text-red-400 bg-red-900/20 rounded p-2">{error}</p>}
              <button type="submit" className={btnCls}>Connect</button>
            </>
          )}
        </form>
      ) : (
        <SSHTerminal token={token} />
      )}
    </Modal>
  );
}

function SSHTerminal({ token }) {
  const containerRef = useRef(null);
  const termRef = useRef(null);
  const wsRef = useRef(null);
  const [status, setStatus] = useState('Connecting...');

  useEffect(() => {
    let disposed = false;

    async function init() {
      const [
        { Terminal },
        { FitAddon },
      ] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
      ]);

      if (disposed || !containerRef.current) return;

      const fitAddon = new FitAddon();
      const term = new Terminal({
        cursorBlink: true,
        fontSize: 14,
        fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
        theme: {
          background: '#0d1117',
          foreground: '#c9d1d9',
          cursor: '#58a6ff',
          selectionBackground: '#264f78',
          black: '#0d1117',
          red: '#ff7b72',
          green: '#3fb950',
          yellow: '#d29922',
          blue: '#58a6ff',
          magenta: '#bc8cff',
          cyan: '#39c5cf',
          white: '#c9d1d9',
        },
      });

      term.loadAddon(fitAddon);
      term.open(containerRef.current);
      fitAddon.fit();
      termRef.current = term;

      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${window.location.host}/api/ssh?token=${token}`);
      wsRef.current = ws;

      ws.onopen = () => {
        // Send initial size
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      };

      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'data') {
            term.write(atob(msg.data));
          } else if (msg.type === 'status') {
            setStatus(msg.status === 'connected' ? 'Connected' : 'Disconnected');
          } else if (msg.type === 'error') {
            term.write(`\r\n\x1b[31mError: ${msg.error}\x1b[0m\r\n`);
            setStatus('Error');
          }
        } catch { /* ignore */ }
      };

      ws.onclose = () => {
        term.write('\r\n\x1b[33mConnection closed.\x1b[0m\r\n');
        setStatus('Disconnected');
      };

      ws.onerror = () => {
        setStatus('Error');
      };

      term.onData((data) => {
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'data', data: btoa(data) }));
        }
      });

      term.onResize(({ cols, rows }) => {
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'resize', cols, rows }));
        }
      });

      const ro = new ResizeObserver(() => {
        try { fitAddon.fit(); } catch { /* ignore */ }
      });
      ro.observe(containerRef.current);

      term._ro = ro;
    }

    init();

    return () => {
      disposed = true;
      wsRef.current?.close();
      if (termRef.current) {
        termRef.current._ro?.disconnect();
        termRef.current.dispose();
      }
    };
  }, [token]);

  return (
    <div className="flex flex-col" style={{ height: '75vh' }}>
      <div className="flex items-center gap-3 px-4 py-2 border-b border-gray-700 bg-gray-900 shrink-0">
        <span className={`text-xs px-2 py-0.5 rounded ${
          status === 'Connected' ? 'bg-green-900 text-green-300' : 'bg-gray-800 text-gray-400'
        }`}>{status}</span>
      </div>
      <div ref={containerRef} className="flex-1 min-h-0 bg-[#0d1117] p-1" />
    </div>
  );
}

const inputCls = 'w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 transition-colors';
const btnCls = 'w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg py-2.5 text-sm font-medium transition-colors';

function Field({ label, children }) {
  return (
    <div>
      <label className="block text-xs text-gray-400 mb-1.5">{label}</label>
      {children}
    </div>
  );
}
