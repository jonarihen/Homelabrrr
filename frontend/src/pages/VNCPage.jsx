import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import useDocumentTitle from '../hooks/useDocumentTitle.js';
import api from '../api.js';

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
  useDocumentTitle(`VNC - VM ${vmid}`);
  const navigate        = useNavigate();
  const containerRef    = useRef(null);
  const rfbRef          = useRef(null);
  const [status, setStatus] = useState('Connecting...');
  const [error, setError]   = useState('');

  useEffect(() => {
    let cancelled = false;

    async function connect() {
      try {
        const { data } = await api.post(`/vms/${node}/${vmid}/vnc-ticket`);
        if (cancelled) return;

        const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
        const wsUrl = `${proto}://${window.location.host}/api/vnc?token=${data.token}`;

        const { default: RFB } = await import('@novnc/novnc/lib/rfb.js');
        if (cancelled || !containerRef.current) return;

        const rfb = new RFB(containerRef.current, wsUrl, {
          credentials: { password: data.ticket },
        });

        rfb.scaleViewport  = true;
        rfb.resizeSession  = true;

        rfb.addEventListener('connect', () => {
          setStatus('Connected');
          setTimeout(() => forceFullRefresh(rfb), 500);
        });
        rfb.addEventListener('disconnect', (e) => {
          setStatus(e.detail.clean ? 'Disconnected' : 'Connection lost');
        });

        rfbRef.current = rfb;
      } catch (e) {
        if (!cancelled) setError(e.response?.data?.error || e.message || 'Failed to connect');
      }
    }

    connect();
    return () => {
      cancelled = true;
      rfbRef.current?.disconnect();
    };
  }, [node, vmid]);

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
          VNC — {node}/{vmid}
        </span>

        <span className={`text-xs px-2 py-0.5 rounded ml-1 ${
          status === 'Connected' ? 'bg-green-900 text-green-300' : 'bg-gray-800 text-gray-400'
        }`}>{status}</span>

        <div className="flex-1" />

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
        {error ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-red-400 gap-3">
            <p>{error}</p>
            <button
              onClick={() => window.location.reload()}
              className="text-sm px-4 py-2 bg-gray-800 hover:bg-gray-700 rounded-lg text-gray-300"
            >
              Retry
            </button>
          </div>
        ) : (
          <div ref={containerRef} className="w-full h-full" />
        )}
        {!error && status !== 'Connected' && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/60 text-gray-400 text-sm pointer-events-none">
            {status}
          </div>
        )}
      </div>
    </div>
  );
}
