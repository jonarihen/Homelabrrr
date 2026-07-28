import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import useDocumentTitle from '../hooks/useDocumentTitle.js';
import useVmName from '../hooks/useVmName.js';
import api from '../api.js';
import { displayNode } from '../utils/nodeRef.js';
import { readClipboardText, typeIntoVnc } from '../utils/vncPaste.js';
import {
  CONNECTING, CONNECTED, DISCONNECTED, CONNECTION_LOST,
  canReconnect, isConnected,
} from '../utils/consoleStatus.js';

// Preload noVNC — Proxmox VNC proxies time out quickly
const rfbModulePromise = import('@novnc/novnc/lib/rfb.js');

function forceFullRefresh(rfb) {
  if (!rfb) return;
  try {
    rfb._sendFramebufferUpdateRequest(0, 0, rfb._fb_width || 1024, rfb._fb_height || 768, false);
  } catch {
    const el = rfb._target;
    if (el) el.dispatchEvent(new Event('resize'));
  }
}

export default function VNCPage() {
  const { node, vmid } = useParams();
  const vmName = useVmName(node, vmid);
  useDocumentTitle(`VNC - ${vmName}`);
  const navigate        = useNavigate();
  const containerRef    = useRef(null);
  const rfbRef          = useRef(null);
  const [status, setStatus] = useState(CONNECTING);
  const [error, setError]   = useState('');
  const [pasting, setPasting] = useState(false);
  const pasteStopRef = useRef(false);
  // Bumping this re-runs the connect effect for a fresh (single-use) ticket.
  const [attempt, setAttempt] = useState(0);
  const reconnect = () => setAttempt((n) => n + 1);
  const showReconnect = canReconnect(status);

  const pasteClipboard = async () => {
    const rfb = rfbRef.current;
    if (!rfb || pasting) return;
    const text = await readClipboardText();
    if (!text) return;
    if (text.length > 2000 && !confirm(`Type all ${text.length} clipboard characters into the VM?`)) return;
    setPasting(true);
    try {
      await typeIntoVnc(rfb, text, { shouldStop: () => pasteStopRef.current || rfbRef.current !== rfb });
    } finally {
      setPasting(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    pasteStopRef.current = false;
    setStatus(CONNECTING);
    setError('');

    async function connect() {
      try {
        const { default: RFB } = await rfbModulePromise;
        if (cancelled || !containerRef.current) return;

        const { data } = await api.post(`/vms/${node}/${vmid}/vnc-ticket`);
        if (cancelled) return;

        const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
        const wsUrl = `${proto}://${window.location.host}/api/vnc`;

        const rfb = new RFB(containerRef.current, wsUrl, {
          credentials: { password: data.ticket },
          wsProtocols: ['binary', `vmmgr-token-${data.token}`],
        });

        rfb.scaleViewport  = true;
        rfb.resizeSession  = true;

        rfb.addEventListener('connect', () => {
          setStatus(CONNECTED);
          setTimeout(() => forceFullRefresh(rfb), 500);
        });
        rfb.addEventListener('disconnect', (e) => {
          setStatus(e.detail.clean ? DISCONNECTED : CONNECTION_LOST);
        });

        rfbRef.current = rfb;
      } catch (e) {
        if (!cancelled) {
          setStatus(CONNECTION_LOST);
          setError(e.response?.data?.error || e.message || 'Failed to connect');
        }
      }
    }

    connect();
    return () => {
      cancelled = true;
      pasteStopRef.current = true;
      rfbRef.current?.disconnect();
      rfbRef.current = null;
    };
  }, [node, vmid, attempt]);

  return (
    <div className="flex flex-col h-screen bg-black">
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-4 py-2 bg-gray-900 border-b border-gray-800 shrink-0">
        <button
          onClick={() => navigate(-1)}
          className="text-gray-400 hover:text-white transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
          </svg>
        </button>

        <span className="text-gray-400 text-sm">
          VNC — {vmName}
          <span className="text-gray-600 font-mono ml-2">{displayNode(node)}/{vmid}</span>
        </span>

        <span className={`text-xs px-2 py-0.5 rounded ml-1 ${
          isConnected(status) ? 'bg-green-900 text-green-300' : 'bg-gray-800 text-gray-400'
        }`}>{status}</span>

        {showReconnect && (
          <button
            onClick={reconnect}
            className="text-xs px-3 py-1 rounded bg-orange-600 hover:bg-orange-500 text-white font-medium transition-colors"
            title="Request a new console ticket and reconnect"
          >
            Reconnect
          </button>
        )}

        <div className="flex-1" />

        <button
          onClick={pasteClipboard}
          disabled={pasting || !isConnected(status)}
          className="text-xs px-3 py-1 rounded bg-gray-700 hover:bg-gray-600 text-gray-300 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          title="Type clipboard text into the VM as keystrokes"
        >
          {pasting ? 'Typing…' : 'Paste'}
        </button>

        <button
          onClick={() => rfbRef.current?.sendCtrlAltDel()}
          className="text-xs px-3 py-1 rounded bg-gray-700 hover:bg-gray-600 text-gray-300 hover:text-white transition-colors"
        >
          Ctrl+Alt+Del
        </button>

        <button
          onClick={() => forceFullRefresh(rfbRef.current)}
          className="text-xs px-3 py-1 rounded bg-gray-700 hover:bg-gray-600 text-gray-300 hover:text-white transition-colors"
          title="Request full screen refresh"
        >
          Refresh
        </button>

        <button
          onClick={() => {
            const el = document.documentElement;
            if (!document.fullscreenElement) el.requestFullscreen();
            else document.exitFullscreen();
          }}
          className="text-xs px-3 py-1 rounded bg-gray-700 hover:bg-gray-600 text-gray-300 hover:text-white transition-colors"
        >
          Fullscreen
        </button>
      </div>

      {/* VNC canvas */}
      <div className="flex-1 relative">
        {/* Always mounted: a reconnect attaches the new RFB to this element, so
            it must not be swapped out for the error state. */}
        <div ref={containerRef} className="w-full h-full" />

        {!isConnected(status) && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/60 text-sm">
            <p className={error ? 'text-red-400' : 'text-gray-400'}>{error || status}</p>
            {showReconnect && (
              <button
                onClick={reconnect}
                className="text-sm px-4 py-2 bg-gray-800 hover:bg-gray-700 rounded-lg text-gray-300 hover:text-white transition-colors"
              >
                Reconnect
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
