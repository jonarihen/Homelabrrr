import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import ErrorCallout from '../components/ErrorCallout.jsx';
import SSHSessionPanel from '../components/SSHSessionPanel.jsx';
import VNCSessionPanel from '../components/VNCSessionPanel.jsx';
import { useAuth } from './AuthContext.jsx';
import { displayNode, routeNode, vmIdentityKey } from '../utils/nodeRef.js';
import { computeTileLayout } from '../utils/tileSessions.js';
import { consoleSessionUrl } from '../utils/consolePopOut.js';

const ConsoleSessionsContext = createContext(null);

let sessionCounter = 0;

function nextSessionId() {
  sessionCounter += 1;
  return `console-${Date.now()}-${sessionCounter}`;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function getViewport() {
  if (typeof window === 'undefined') {
    return { width: 1440, height: 900 };
  }

  return {
    width: window.innerWidth,
    height: window.innerHeight,
  };
}

function createSessionGeometry(type, openCount) {
  const { width, height } = getViewport();
  const sidebarOffset = width >= 1024 ? 248 : 16;
  const maxWidth = Math.max(360, width - sidebarOffset - 24);
  const maxHeight = Math.max(320, height - 104);
  const preferredWidth = type === 'vnc' ? 1040 : 860;
  const preferredHeight = type === 'vnc' ? 720 : 620;
  const minWidth = type === 'vnc' ? 440 : 420;
  const minHeight = type === 'vnc' ? 320 : 340;
  const windowWidth = clamp(preferredWidth, Math.min(minWidth, maxWidth), maxWidth);
  const windowHeight = clamp(preferredHeight, Math.min(minHeight, maxHeight), maxHeight);
  const cascadeX = (openCount % 4) * 34;
  const cascadeY = (openCount % 4) * 26;

  return {
    width: windowWidth,
    height: windowHeight,
    x: clamp(sidebarOffset + 20 + cascadeX, 12, width - windowWidth - 12),
    y: clamp(68 + cascadeY, 12, height - windowHeight - 72),
  };
}

function normalizeVm(vm) {
  const nodeRef = routeNode(vm);
  return {
    ...vm,
    nodeRef,
    node: displayNode(nodeRef || vm?.node),
  };
}

export function ConsoleSessionsProvider({ children }) {
  const { user } = useAuth();
  const [sessions, setSessions] = useState([]);
  const [portalReady, setPortalReady] = useState(false);

  useEffect(() => {
    setPortalReady(true);
  }, []);

  useEffect(() => {
    if (!user) {
      setSessions([]);
    }
  }, [user]);

  const focusSession = useCallback((id) => {
    setSessions((current) => {
      const target = current.find((session) => session.id === id);
      if (!target) return current;
      return [...current.filter((session) => session.id !== id), target];
    });
  }, []);

  const openSession = useCallback((type, vm) => {
    const normalizedVm = normalizeVm(vm);

    setSessions((current) => {
      const instance = current.filter((session) => (
        session.type === type && vmIdentityKey(session.vm) === vmIdentityKey(normalizedVm)
      )).length + 1;

      return [
        ...current,
        {
          id: nextSessionId(),
          type,
          instance,
          vm: normalizedVm,
          minimized: false,
          ...createSessionGeometry(type, current.filter((session) => !session.minimized).length),
        },
      ];
    });
  }, []);

  const openSshSession = useCallback((vm) => openSession('ssh', vm), [openSession]);
  const openVncSession = useCallback((vm) => openSession('vnc', vm), [openSession]);

  const minimizeSession = useCallback((id) => {
    setSessions((current) => current.map((session) => (
      session.id === id ? { ...session, minimized: true } : session
    )));
  }, []);

  const restoreSession = useCallback((id) => {
    setSessions((current) => {
      const target = current.find((session) => session.id === id);
      if (!target) return current;

      const restored = { ...target, minimized: false };
      return [...current.filter((session) => session.id !== id), restored];
    });
  }, []);

  const closeSession = useCallback((id) => {
    setSessions((current) => current.filter((session) => session.id !== id));
  }, []);

  const moveSession = useCallback((id, position) => {
    setSessions((current) => current.map((session) => (
      session.id === id ? { ...session, ...position } : session
    )));
  }, []);

  const tileSessions = useCallback((mode) => {
    setSessions((current) => {
      const visible = current.filter((s) => !s.minimized);
      if (visible.length < 2) return current;

      const layout = computeTileLayout(visible, mode, getViewport());
      const updates = new Map(layout.map((l) => [l.id, l]));

      return current.map((session) => {
        const upd = updates.get(session.id);
        return upd ? { ...session, x: upd.x, y: upd.y, width: upd.width, height: upd.height } : session;
      });
    });
  }, []);

  const popOutSession = useCallback((id) => {
    const session = sessions.find((s) => s.id === id);
    if (!session) return;

    const url = consoleSessionUrl(session);
    const popup = window.open('about:blank', '_blank');
    if (!popup) {
      setSessions((current) => current.map((s) => (
        s.id === id ? { ...s, popOutError: 'Pop-up blocked. Allow pop-ups for this site, then try again. Your console is still open here.' } : s
      )));
      return;
    }

    popup.opener = null;
    popup.location.href = url;
    closeSession(id);
  }, [sessions, closeSession]);

  const value = useMemo(() => ({
    sessions,
    openSshSession,
    openVncSession,
    focusSession,
    minimizeSession,
    restoreSession,
    closeSession,
  }), [sessions, openSshSession, openVncSession, focusSession, minimizeSession, restoreSession, closeSession]);

  return (
    <ConsoleSessionsContext.Provider value={value}>
      {children}
      {portalReady && user && createPortal(
        <ConsoleSessionLayer
          sessions={sessions}
          focusSession={focusSession}
          minimizeSession={minimizeSession}
          restoreSession={restoreSession}
          closeSession={closeSession}
          moveSession={moveSession}
          tileSessions={tileSessions}
          popOutSession={popOutSession}
        />,
        document.body,
      )}
    </ConsoleSessionsContext.Provider>
  );
}

export function useConsoleSessions() {
  const context = useContext(ConsoleSessionsContext);
  if (!context) {
    throw new Error('useConsoleSessions must be used within a ConsoleSessionsProvider');
  }
  return context;
}

function ConsoleSessionLayer({
  sessions,
  focusSession,
  minimizeSession,
  restoreSession,
  closeSession,
  moveSession,
  tileSessions,
  popOutSession,
}) {
  const minimizedSessions = sessions.filter((session) => session.minimized);
  const liveCount = sessions.length - minimizedSessions.length;

  return (
    <div className="pointer-events-none fixed inset-0 z-40">
      {sessions.map((session, index) => (
        <ConsoleSessionWindow
          key={session.id}
          session={session}
          zIndex={40 + index}
          onFocus={focusSession}
          onMinimize={minimizeSession}
          onClose={closeSession}
          onMove={moveSession}
          onPopOut={popOutSession}
        />
      ))}

      {(minimizedSessions.length > 0 || liveCount >= 2) && (
        <ConsoleSessionDock
          sessions={minimizedSessions}
          restoreSession={restoreSession}
          closeSession={closeSession}
          liveCount={liveCount}
          tileSessions={tileSessions}
        />
      )}
    </div>
  );
}

const KEYBOARD_MOVE_STEP = 20;
const ARROW_DELTAS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

function clampWindowPosition(session, x, y) {
  const { width, height } = getViewport();
  return {
    x: clamp(x, 12, Math.max(12, width - session.width - 12)),
    y: clamp(y, 12, Math.max(12, height - session.height - 72)),
  };
}

function ConsoleSessionWindow({ session, zIndex, onFocus, onMinimize, onClose, onMove, onPopOut }) {
  const windowRef = useRef(null);
  const sizeRef = useRef({ width: session.width, height: session.height });
  sizeRef.current = { width: session.width, height: session.height };

  // Sync a native CSS resize (resize: both) back into session state so drag/tile clamping sees the new size.
  useEffect(() => {
    const el = windowRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => {
      const width = el.offsetWidth;
      const height = el.offsetHeight;
      if (!width || !height) return; // hidden while minimized
      if (width !== sizeRef.current.width || height !== sizeRef.current.height) {
        onMove(session.id, { width, height });
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [onMove, session.id]);

  const startDrag = useCallback((event) => {
    if (event.button !== 0) return;

    onFocus(session.id);

    const initialPointerX = event.clientX;
    const initialPointerY = event.clientY;
    const initialX = session.x;
    const initialY = session.y;

    const handleMove = (moveEvent) => {
      onMove(session.id, clampWindowPosition(
        session,
        initialX + (moveEvent.clientX - initialPointerX),
        initialY + (moveEvent.clientY - initialPointerY),
      ));
    };

    const stopDrag = () => {
      document.removeEventListener('pointermove', handleMove);
      document.removeEventListener('pointerup', stopDrag);
      document.removeEventListener('pointercancel', stopDrag);
      document.body.style.userSelect = '';
    };

    document.body.style.userSelect = 'none';
    document.addEventListener('pointermove', handleMove);
    document.addEventListener('pointerup', stopDrag);
    document.addEventListener('pointercancel', stopDrag);
    event.preventDefault();
  }, [onFocus, onMove, session]);

  const handleMoveKey = useCallback((event) => {
    const delta = ARROW_DELTAS[event.key];
    if (!delta || event.target !== event.currentTarget) return;
    event.preventDefault();
    const step = event.shiftKey ? KEYBOARD_MOVE_STEP * 5 : KEYBOARD_MOVE_STEP;
    onMove(session.id, clampWindowPosition(session, session.x + delta[0] * step, session.y + delta[1] * step));
  }, [onMove, session]);

  return (
    <div
      ref={windowRef}
      className={`${session.minimized ? 'hidden' : 'flex'} pointer-events-auto fixed flex-col overflow-hidden resize min-w-[320px] min-h-[240px] border border-gray-700 bg-gray-900`}
      style={{
        left: `${session.x}px`,
        top: `${session.y}px`,
        width: `${session.width}px`,
        height: `${session.height}px`,
        zIndex,
      }}
      onMouseDown={() => onFocus(session.id)}
    >
      <div
        className="flex items-center justify-between gap-3 border-b border-gray-700 bg-gray-950 px-4 py-3 cursor-move shrink-0 touch-none focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-blue-500"
        onPointerDown={startDrag}
        onKeyDown={handleMoveKey}
        tabIndex={0}
        aria-label={`Move ${consoleTitle(session)} window (arrow keys, Shift for larger steps)`}
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm text-white font-semibold">
            <SessionTypeBadge type={session.type} />
            <span className="truncate">{consoleTitle(session)}</span>
          </div>
          <p className="mt-0.5 truncate font-mono text-[10px] uppercase tracking-[0.1em] text-gray-500">
            {displayNode(session.vm.node)} / {session.vm.vmid}
          </p>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <WindowAction
            label="Minimize"
            onClick={() => onMinimize(session.id)}
            icon={<path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14" />}
          />
          <WindowAction
            label="Open in new tab"
            onClick={() => onPopOut(session.id)}
            icon={<path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />}
          />
          <WindowAction
            label="Close"
            onClick={() => onClose(session.id)}
            icon={<path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />}
          />
        </div>
      </div>

      <ErrorCallout error={session.popOutError} className="mx-4 my-2 shrink-0" />

      <div className="min-h-0 flex-1">
        {session.type === 'ssh' ? (
          <SSHSessionPanel vm={session.vm} visible={!session.minimized} />
        ) : (
          <VNCSessionPanel vm={session.vm} visible={!session.minimized} />
        )}
      </div>
    </div>
  );
}

function ConsoleSessionDock({ sessions, restoreSession, closeSession, liveCount, tileSessions }) {
  return (
    <div className="pointer-events-auto fixed bottom-4 left-4 right-4 lg:left-[15.5rem] lg:right-auto lg:max-w-[calc(100vw-17rem)]">
      <div className="inline-flex max-w-full flex-col gap-3 border border-gray-800 bg-gray-950 px-4 py-3">
        <div className="flex items-center justify-between gap-6">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.25em] text-gray-500">Console Dock</p>
            <p className="text-sm text-gray-300">
              {sessions.length > 0 ? `${sessions.length} minimized` : ''}
              {sessions.length > 0 && liveCount > 0 ? ' \u2022 ' : ''}
              {liveCount > 0 ? `${liveCount} live` : ''}
            </p>
          </div>

          {liveCount >= 2 && (
            <div className="flex items-center gap-1">
              <TileButton label="Grid" onClick={() => tileSessions('grid')} icon={
                <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>
              } />
              <TileButton label="Side by side" onClick={() => tileSessions('horizontal')} icon={
                <><rect x="3" y="3" width="8" height="18" rx="1" /><rect x="13" y="3" width="8" height="18" rx="1" /></>
              } />
              <TileButton label="Stacked" onClick={() => tileSessions('vertical')} icon={
                <><rect x="3" y="3" width="18" height="8" rx="1" /><rect x="3" y="13" width="18" height="8" rx="1" /></>
              } />
            </div>
          )}
        </div>

        {sessions.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {sessions.map((session) => (
              <div
                key={session.id}
                className="flex items-center gap-2 border border-gray-800 bg-gray-900/90 px-3 py-2"
              >
                <button
                  type="button"
                  onClick={() => restoreSession(session.id)}
                  className="flex min-w-0 items-center gap-2 text-left text-sm text-gray-200 hover:text-white transition-colors"
                >
                  <SessionTypeBadge type={session.type} compact />
                  <span className="truncate max-w-[12rem]">{consoleTitle(session)}</span>
                </button>

                <button
                  type="button"
                  onClick={() => closeSession(session.id)}
                  className="p-1 text-gray-500 hover:bg-red-500/10 hover:text-red-300 transition-colors"
                  aria-label={`Close ${consoleTitle(session)}`}
                >
                  <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function TileButton({ label, onClick, icon }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="p-1.5 text-gray-500 hover:bg-gray-800 hover:text-white transition-colors"
      aria-label={label}
      title={label}
    >
      <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
        {icon}
      </svg>
    </button>
  );
}

function SessionTypeBadge({ type, compact = false }) {
  const styles = type === 'ssh'
    ? 'bg-blue-500/15 text-blue-300 border-blue-500/20'
    : 'bg-emerald-500/15 text-emerald-300 border-emerald-500/20';

  return (
    <span className={`inline-flex items-center border px-2 ${compact ? 'py-0.5 text-[10px]' : 'py-1 text-[11px]'} font-semibold uppercase tracking-wide ${styles}`}>
      {type}
    </span>
  );
}

function WindowAction({ label, onClick, icon }) {
  return (
    <button
      type="button"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className="p-2 text-gray-500 hover:bg-gray-800 hover:text-white transition-colors"
      aria-label={label}
      title={label}
    >
      <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
        {icon}
      </svg>
    </button>
  );
}

function consoleTitle(session) {
  const base = `${session.type.toUpperCase()} — ${session.vm.name || `VM ${session.vm.vmid}`}`;
  return session.instance > 1 ? `${base} #${session.instance}` : base;
}
