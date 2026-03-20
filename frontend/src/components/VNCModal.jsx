import { useEffect, useRef, useState } from 'react';
import Modal from './Modal.jsx';
import api from '../api.js';

// Request a full (non-incremental) framebuffer update from the VNC server.
// noVNC's initial full request can be missed if the canvas isn't sized yet,
// after which it only sends incremental updates (blank screen until something moves).
function forceFullRefresh(rfb) {
  if (!rfb) return;
  try {
    rfb._sendFramebufferUpdateRequest(0, 0, rfb._fb_width || 1024, rfb._fb_height || 768, false);
  } catch {
    // Internal API unavailable in this noVNC version — trigger via container resize
    const el = rfb._target;
    if (el) {
      const ev = new Event('resize');
      el.dispatchEvent(ev);
    }
  }
}

export default function VNCModal({ vm, onClose }) {
  const containerRef = useRef(null);
  const rfbRef       = useRef(null);
  const [status, setStatus]  = useState('Connecting...');
  const [error, setError]    = useState('');

  useEffect(() => {
    let cancelled = false;

    async function connect() {
      try {
        const { data } = await api.post(`/vms/${vm.node}/${vm.vmid}/vnc-ticket`);
        if (cancelled) return;

        const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
        const wsUrl = `${proto}://${window.location.host}/api/vnc`;

        const { default: RFB } = await import('@novnc/novnc/lib/rfb.js');
        if (cancelled || !containerRef.current) return;

        const rfb = new RFB(containerRef.current, wsUrl, {
          credentials: { password: data.ticket },
          wsProtocols: ['binary', `vmmgr-token-${data.token}`],
        });

        rfb.scaleViewport = true;
        rfb.resizeSession = false;

        rfb.addEventListener('connect', () => {
          setStatus('Connected');
          // Force a full (non-incremental) framebuffer request after a short delay.
          // The modal may still be animating when the initial full update arrives,
          // causing it to paint to a mis-sized canvas. This re-requests everything.
          setTimeout(() => forceFullRefresh(rfb), 500);
        });
        rfb.addEventListener('disconnect', (e) => setStatus(e.detail.clean ? 'Disconnected' : 'Connection lost'));

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
  }, [vm.node, vm.vmid]);

  const sendCtrlAltDel = () => rfbRef.current?.sendCtrlAltDel();

  const refresh = () => forceFullRefresh(rfbRef.current);

  return (
    <Modal title={`VNC — ${vm.name || `VM ${vm.vmid}`}`} onClose={onClose} size="full">
      <div className="flex flex-col" style={{ height: '75vh' }}>
        {/* Toolbar */}
        <div className="flex items-center gap-3 px-4 py-2 border-b border-gray-700 bg-gray-900 shrink-0">
          <span className={`text-xs px-2 py-0.5 rounded ${
            status === 'Connected' ? 'bg-green-900 text-green-300' : 'bg-gray-800 text-gray-400'
          }`}>{status}</span>
          <button
            onClick={sendCtrlAltDel}
            className="text-xs px-3 py-1 rounded bg-gray-700 hover:bg-gray-600 text-gray-300 hover:text-white transition-colors"
          >
            Ctrl+Alt+Del
          </button>
          <button
            onClick={refresh}
            className="text-xs px-3 py-1 rounded bg-gray-700 hover:bg-gray-600 text-gray-300 hover:text-white transition-colors"
            title="Request full screen refresh"
          >
            Refresh
          </button>
        </div>

        {/* Canvas area */}
        <div className="relative flex-1 bg-black min-h-0 overflow-hidden">
          {error ? (
            <div className="absolute inset-0 flex items-center justify-center text-red-400 text-sm">
              {error}
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
    </Modal>
  );
}
