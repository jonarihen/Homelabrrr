import { useEffect, useRef, useState } from 'react';
import api from '../api.js';
import { routeNode } from '../utils/nodeRef.js';

function forceFullRefresh(rfb) {
  if (!rfb) return;

  try {
    rfb._sendFramebufferUpdateRequest(0, 0, rfb._fb_width || 1024, rfb._fb_height || 768, false);
  } catch {
    const el = rfb._target;
    if (el) {
      el.dispatchEvent(new Event('resize'));
    }
  }
}

export default function VNCSessionPanel({ vm, visible = true }) {
  const vmNode = routeNode(vm);
  const containerRef = useRef(null);
  const rfbRef = useRef(null);
  const resizeObserverRef = useRef(null);
  const refreshTimerRef = useRef(null);
  const [status, setStatus] = useState('Connecting...');
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;

    async function connect() {
      try {
        const { data } = await api.post(`/vms/${vmNode}/${vm.vmid}/vnc-ticket`);
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
          refreshTimerRef.current = window.setTimeout(() => forceFullRefresh(rfb), 500);
        });
        rfb.addEventListener('disconnect', (e) => {
          setStatus(e.detail.clean ? 'Disconnected' : 'Connection lost');
        });

        rfbRef.current = rfb;

        const resizeObserver = new ResizeObserver(() => {
          window.clearTimeout(refreshTimerRef.current);
          refreshTimerRef.current = window.setTimeout(() => forceFullRefresh(rfbRef.current), 120);
        });
        resizeObserver.observe(containerRef.current);
        resizeObserverRef.current = resizeObserver;
      } catch (e) {
        if (!cancelled) {
          setError(e.response?.data?.error || e.message || 'Failed to connect');
        }
      }
    }

    connect();

    return () => {
      cancelled = true;
      window.clearTimeout(refreshTimerRef.current);
      resizeObserverRef.current?.disconnect();
      rfbRef.current?.disconnect();
    };
  }, [vmNode, vm.vmid]);

  useEffect(() => {
    if (!visible || !rfbRef.current) return undefined;

    const timer = window.setTimeout(() => forceFullRefresh(rfbRef.current), 100);
    return () => window.clearTimeout(timer);
  }, [visible]);

  const sendCtrlAltDel = () => rfbRef.current?.sendCtrlAltDel();
  const refresh = () => forceFullRefresh(rfbRef.current);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-3 px-4 py-2 border-b border-gray-700 bg-gray-900 shrink-0">
        <span className={`text-xs px-2 py-0.5 rounded ${
          status === 'Connected' ? 'bg-green-900 text-green-300' : 'bg-gray-800 text-gray-400'
        }`}>{status}</span>

        <button
          type="button"
          onClick={sendCtrlAltDel}
          className="text-xs px-3 py-1 rounded bg-gray-700 hover:bg-gray-600 text-gray-300 hover:text-white transition-colors"
        >
          Ctrl+Alt+Del
        </button>

        <button
          type="button"
          onClick={refresh}
          className="text-xs px-3 py-1 rounded bg-gray-700 hover:bg-gray-600 text-gray-300 hover:text-white transition-colors"
          title="Request full screen refresh"
        >
          Refresh
        </button>
      </div>

      <div className="relative flex-1 min-h-0 bg-black overflow-hidden">
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
  );
}
