import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import SSHSessionPanel from '../components/SSHSessionPanel.jsx';
import VNCSessionPanel from '../components/VNCSessionPanel.jsx';
import { useAuth } from './AuthContext.jsx';
import { displayNode, routeNode, vmIdentityKey } from '../utils/nodeRef.js';

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
}) {
  const minimizedSessions = sessions.filter((session) => session.minimized);

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
        />
      ))}

      {minimizedSessions.length > 0 && (
        <ConsoleSessionDock
          sessions={minimizedSessions}
          restoreSession={restoreSession}
          closeSession={closeSession}
          liveCount={sessions.length - minimizedSessions.length}
        />
      )}
    </div>
  );
}

function ConsoleSessionWindow({ session, zIndex, onFocus, onMinimize, onClose, onMove }) {
  const startDrag = useCallback((event) => {
    if (event.button !== 0) return;

    onFocus(session.id);

    const initialMouseX = event.clientX;
    const initialMouseY = event.clientY;
    const initialX = session.x;
    const initialY = session.y;

    const handleMove = (moveEvent) => {
      const { width, height } = getViewport();
      const maxX = Math.max(12, width - session.width - 12);
      const maxY = Math.max(12, height - session.height - 72);

      onMove(session.id, {
        x: clamp(initialX + (moveEvent.clientX - initialMouseX), 12, maxX),
        y: clamp(initialY + (moveEvent.clientY - initialMouseY), 12, maxY),
      });
    };

    const stopDrag = () => {
      document.removeEventListener('mousemove', handleMove);
      document.removeEventListener('mouseup', stopDrag);
      document.body.style.userSelect = '';
    };

    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', stopDrag);
    event.preventDefault();
  }, [onFocus, onMove, session.id, session.width, session.height, session.x, session.y]);

  return (
    <div
      className={`${session.minimized ? 'hidden' : 'flex'} pointer-events-auto fixed flex-col overflow-hidden rounded-2xl border border-gray-700/80 bg-gray-900/95 shadow-2xl shadow-black/40 backdrop-blur-xl`}
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
        className="flex items-center justify-between gap-3 border-b border-gray-700/80 bg-gray-950/90 px-4 py-3 cursor-move shrink-0"
        onMouseDown={startDrag}
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm text-white font-semibold">
            <SessionTypeBadge type={session.type} />
            <span className="truncate">{consoleTitle(session)}</span>
          </div>
          <p className="mt-0.5 truncate text-xs text-gray-500 font-mono">
            {session.vm.node} / {session.vm.vmid}
          </p>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <WindowAction
            label="Minimize"
            onClick={() => onMinimize(session.id)}
            icon={<path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14" />}
          />
          <WindowAction
            label="Close"
            onClick={() => onClose(session.id)}
            icon={<path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />}
          />
        </div>
      </div>

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

function ConsoleSessionDock({ sessions, restoreSession, closeSession, liveCount }) {
  return (
    <div className="pointer-events-auto fixed bottom-4 left-4 right-4 lg:left-[15.5rem] lg:right-auto lg:max-w-[calc(100vw-17rem)]">
      <div className="inline-flex max-w-full flex-col gap-3 rounded-2xl border border-gray-800 bg-gray-950/92 px-4 py-3 shadow-2xl shadow-black/40 backdrop-blur-xl">
        <div className="flex items-center justify-between gap-6">
          <div>
            <p className="text-[11px] uppercase tracking-[0.25em] text-gray-500">Console Dock</p>
            <p className="text-sm text-gray-300">
              {sessions.length} minimized
              {liveCount > 0 ? ` • ${liveCount} live` : ''}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          {sessions.map((session) => (
            <div
              key={session.id}
              className="flex items-center gap-2 rounded-xl border border-gray-800 bg-gray-900/90 px-3 py-2"
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
                className="rounded-md p-1 text-gray-500 hover:bg-red-500/10 hover:text-red-300 transition-colors"
                aria-label={`Close ${consoleTitle(session)}`}
              >
                <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function SessionTypeBadge({ type, compact = false }) {
  const styles = type === 'ssh'
    ? 'bg-blue-500/15 text-blue-300 border-blue-500/20'
    : 'bg-emerald-500/15 text-emerald-300 border-emerald-500/20';

  return (
    <span className={`inline-flex items-center rounded-lg border px-2 ${compact ? 'py-0.5 text-[10px]' : 'py-1 text-[11px]'} font-semibold uppercase tracking-wide ${styles}`}>
      {type}
    </span>
  );
}

function WindowAction({ label, onClick, icon }) {
  return (
    <button
      type="button"
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className="rounded-lg p-2 text-gray-500 hover:bg-gray-800 hover:text-white transition-colors"
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
