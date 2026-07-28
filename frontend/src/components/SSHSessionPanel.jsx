import { useEffect, useRef, useState } from 'react';
import '@xterm/xterm/css/xterm.css';
import api from '../api.js';
import { routeNode } from '../utils/nodeRef.js';
import SSHConnectForm from './SSHConnectForm.jsx';
import SFTPBrowser from './SFTPBrowser.jsx';
import {
  CONNECTING, CONNECTED, DISCONNECTED, CONNECTION_ERROR,
  canReconnect, isConnected,
} from '../utils/consoleStatus.js';

export default function SSHSessionPanel({ vm, visible = true }) {
  const [step, setStep] = useState('config');
  const [sshToken, setSshToken] = useState(null);
  const [sftpToken, setSftpToken] = useState(null);
  const [activeTab, setActiveTab] = useState('terminal');
  const [sftpConnecting, setSftpConnecting] = useState(false);
  const [sftpError, setSftpError] = useState('');
  // Re-mints an SSH session token with the settings the user connected with,
  // so a dropped shell doesn't send them back through the form.
  const mintTokenRef = useRef(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [reconnectError, setReconnectError] = useState('');

  const handleSshConnect = (token, mintToken) => {
    setSshToken(token);
    mintTokenRef.current = mintToken;
    setStep('connected');
  };

  const reconnectSsh = async () => {
    if (!mintTokenRef.current || reconnecting) return;

    setReconnecting(true);
    setReconnectError('');
    try {
      // A new token remounts the SSH channel: SSHTerminal keys its effect on it.
      setSshToken(await mintTokenRef.current());
    } catch (e) {
      setReconnectError(e.response?.data?.error || 'Failed to reconnect');
    } finally {
      setReconnecting(false);
    }
  };

  const openFiles = async () => {
    if (sftpToken) {
      setActiveTab('files');
      return;
    }

    const vmNode = routeNode(vm);
    setSftpConnecting(true);
    setSftpError('');
    try {
      const keysRes = await api.get('/ssh/keys');

      if (keysRes.data.length === 0) {
        setSftpError('No SSH keys available');
        setSftpConnecting(false);
        return;
      }

      const { data } = await api.post('/sftp/connect', {
        node: vmNode,
        vmid: vm.vmid,
        keyId: keysRes.data[0].id,
        passphrase: '',
      });

      setSftpToken(data.token);
      setActiveTab('files');
    } catch (e) {
      setSftpError(e.response?.data?.error || 'Failed to connect SFTP');
    } finally {
      setSftpConnecting(false);
    }
  };

  if (step === 'config') {
    return (
      <div className="h-full overflow-y-auto p-5">
        <SSHConnectForm vm={vm} onConnect={handleSshConnect} />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Tab bar */}
      <div className="flex items-center gap-1 px-3 py-1.5 border-b border-gray-700 bg-gray-900/80 shrink-0">
        <TabButton active={activeTab === 'terminal'} onClick={() => setActiveTab('terminal')} icon={
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 7.5l3 2.25-3 2.25m4.5 0h3" />
          </svg>
        }>Terminal</TabButton>

        <TabButton
          active={activeTab === 'files'}
          onClick={openFiles}
          loading={sftpConnecting}
          icon={
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
            </svg>
          }
        >Files</TabButton>

        {sftpError && <span className="text-xs text-red-400 ml-2">{sftpError}</span>}
      </div>

      {/* Panels */}
      <div className={`min-h-0 flex-1 ${activeTab === 'terminal' ? '' : 'hidden'}`}>
        <SSHTerminal
          token={sshToken}
          visible={visible && activeTab === 'terminal'}
          onReconnect={reconnectSsh}
          reconnecting={reconnecting}
          reconnectError={reconnectError}
        />
      </div>

      {activeTab === 'files' && sftpToken && (
        <div className="min-h-0 flex-1 relative">
          <SFTPBrowser token={sftpToken} />
        </div>
      )}
    </div>
  );
}

function TabButton({ active, onClick, icon, children, loading = false }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={loading}
      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
        active
          ? 'bg-gray-700 text-white'
          : 'text-gray-400 hover:text-white hover:bg-gray-800'
      } ${loading ? 'opacity-50' : ''}`}
    >
      {icon}
      {loading ? 'Connecting...' : children}
    </button>
  );
}

function SSHTerminal({ token, visible, onReconnect, reconnecting = false, reconnectError = '' }) {
  const containerRef = useRef(null);
  const termRef = useRef(null);
  const wsRef = useRef(null);
  const fitAddonRef = useRef(null);
  const resizeObserverRef = useRef(null);
  const [status, setStatus] = useState(CONNECTING);

  useEffect(() => {
    let disposed = false;
    setStatus(CONNECTING);

    async function init() {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
      ]);

      if (disposed) { console.warn('[SSH] disposed after xterm import'); return; }
      if (!containerRef.current) { console.warn('[SSH] containerRef null after xterm import'); return; }

      const fitAddon = new FitAddon();
      fitAddonRef.current = fitAddon;

      const term = new Terminal({
        cursorBlink: true,
        fontSize: 14,
        fontFamily: "'IBM Plex Mono', 'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
        theme: {
          // AARIS operator-console theme — orange cursor, near-black surface
          background: '#0b0d11',
          foreground: '#e9ecef',
          cursor: '#ff5a1f',
          selectionBackground: '#3a3f47',
          black: '#0b0d11',
          red: '#e5484d',
          green: '#3fd97f',
          yellow: '#ffb224',
          blue: '#8b939e',
          magenta: '#ff8a55',
          cyan: '#39c5cf',
          white: '#e9ecef',
        },
      });

      term.loadAddon(fitAddon);
      term.open(containerRef.current);
      fitAddon.fit();
      termRef.current = term;

      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const wsUrl = `${proto}://${window.location.host}/api/ssh`;
      console.log('[SSH] opening WebSocket →', wsUrl, 'token:', token?.slice(0, 8));
      const ws = new WebSocket(wsUrl, ['vmmgr-shell', `vmmgr-token-${token}`]);
      wsRef.current = ws;

      const sendSize = () => {
        if (ws.readyState === 1 && termRef.current) {
          ws.send(JSON.stringify({
            type: 'resize',
            cols: termRef.current.cols,
            rows: termRef.current.rows,
          }));
        }
      };

      ws.onopen = sendSize;

      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'data') {
            // Decode base64 to bytes and hand the Uint8Array to xterm so it
            // parses multi-byte UTF-8 (spinners, checkmarks, box chars) correctly.
            const bin = atob(msg.data);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
            term.write(bytes);
          } else if (msg.type === 'status') {
            setStatus(msg.status === 'connected' ? CONNECTED : DISCONNECTED);
          } else if (msg.type === 'error') {
            term.write(`\r\n\x1b[31mError: ${msg.error}\x1b[0m\r\n`);
            setStatus(CONNECTION_ERROR);
          }
        } catch {
          // Ignore malformed websocket payloads
        }
      };

      ws.onclose = (e) => {
        console.warn('[SSH] WebSocket closed, code:', e.code, 'reason:', e.reason);
        term.write('\r\n\x1b[33mConnection closed — use Reconnect to start a new session.\x1b[0m\r\n');
        setStatus(DISCONNECTED);
      };

      ws.onerror = (e) => {
        console.error('[SSH] WebSocket error', e);
        setStatus(CONNECTION_ERROR);
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

      const resizeObserver = new ResizeObserver(() => {
        try {
          fitAddon.fit();
          sendSize();
        } catch {
          // Ignore fit errors during transient layout changes
        }
      });
      resizeObserver.observe(containerRef.current);
      resizeObserverRef.current = resizeObserver;
    }

    init();

    return () => {
      disposed = true;
      resizeObserverRef.current?.disconnect();
      wsRef.current?.close();
      termRef.current?.dispose();
    };
  }, [token]);

  useEffect(() => {
    if (!visible || !termRef.current || !fitAddonRef.current) return undefined;

    const timer = window.setTimeout(() => {
      try {
        fitAddonRef.current?.fit();
        if (wsRef.current?.readyState === 1) {
          wsRef.current.send(JSON.stringify({
            type: 'resize',
            cols: termRef.current.cols,
            rows: termRef.current.rows,
          }));
        }
      } catch {
        // Ignore fit errors while the console window is restoring
      }
    }, 80);

    return () => window.clearTimeout(timer);
  }, [visible]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-3 px-4 py-2 border-b border-gray-700 bg-gray-900 shrink-0">
        <span className={`text-xs px-2 py-0.5 rounded ${
          isConnected(status) ? 'bg-green-900 text-green-300' : 'bg-gray-800 text-gray-400'
        }`}>{reconnecting ? 'Reconnecting…' : status}</span>

        {onReconnect && canReconnect(status) && (
          <button
            type="button"
            onClick={onReconnect}
            disabled={reconnecting}
            className="text-xs px-3 py-1 rounded bg-orange-600 hover:bg-orange-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-medium transition-colors"
            title="Open a new SSH session with the same key and host settings"
          >
            {reconnecting ? 'Reconnecting…' : 'Reconnect'}
          </button>
        )}

        {reconnectError && <span className="text-xs text-red-400">{reconnectError}</span>}
      </div>

      <div ref={containerRef} className="flex-1 min-h-0 bg-[#0b0d11] p-1" />
    </div>
  );
}
