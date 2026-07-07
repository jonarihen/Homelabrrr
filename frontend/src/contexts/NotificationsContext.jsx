import { createContext, useContext, useState, useCallback, useRef, useMemo, useEffect } from 'react';

// AARIS-styled, accessible toast notifications. Replaces native alert() so
// failures/confirmations read as operator-console status lines instead of an
// OS modal. The stack is an aria-live region; errors announce assertively.
const NotificationsContext = createContext(null);

const CONFIG = {
  success: { led: 'aaris-led--ok',      label: 'OK',    ttl: 4500 },
  error:   { led: 'aaris-led--error',   label: 'Error', ttl: 9000 },
  warning: { led: 'aaris-led--warning', label: 'Warn',  ttl: 7000 },
  info:    { led: 'aaris-led--off',     label: 'Info',  ttl: 5000 },
};

export function NotificationsProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const idRef = useRef(0);
  const timers = useRef(new Map());

  const dismiss = useCallback((id) => {
    setToasts(list => list.filter(t => t.id !== id));
    const tm = timers.current.get(id);
    if (tm) { clearTimeout(tm); timers.current.delete(id); }
  }, []);

  const push = useCallback((type, message, opts = {}) => {
    const id = ++idRef.current;
    const cfg = CONFIG[type] || CONFIG.info;
    setToasts(list => [...list, { id, type, message: String(message ?? ''), title: opts.title }]);
    const ttl = opts.ttl ?? cfg.ttl;
    if (ttl > 0) timers.current.set(id, setTimeout(() => dismiss(id), ttl));
    return id;
  }, [dismiss]);

  useEffect(() => () => { timers.current.forEach(clearTimeout); timers.current.clear(); }, []);

  const notify = useMemo(() => ({
    show: push,
    success: (m, o) => push('success', m, o),
    error:   (m, o) => push('error', m, o),
    warning: (m, o) => push('warning', m, o),
    info:    (m, o) => push('info', m, o),
    dismiss,
  }), [push, dismiss]);

  return (
    <NotificationsContext.Provider value={notify}>
      {children}
      <div
        className="fixed bottom-4 right-4 z-[100] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2 pointer-events-none"
        aria-live="polite"
        aria-relevant="additions"
      >
        {toasts.map(t => <Toast key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />)}
      </div>
    </NotificationsContext.Provider>
  );
}

function Toast({ toast, onDismiss }) {
  const cfg = CONFIG[toast.type] || CONFIG.info;
  const isError = toast.type === 'error';
  return (
    <div
      role={isError ? 'alert' : 'status'}
      className="pointer-events-auto flex items-start gap-3 border border-gray-700 bg-gray-900/95 px-3.5 py-3 backdrop-blur-sm aaris-toast-in"
    >
      <span className={`aaris-led ${cfg.led} mt-1 shrink-0`} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-gray-500">{toast.title || cfg.label}</p>
        <p className="mt-0.5 break-words text-sm text-gray-100">{toast.message}</p>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss notification"
        className="-mr-1 -mt-0.5 shrink-0 p-1 text-gray-600 transition-colors hover:text-gray-200"
      >
        <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}

export function useNotify() {
  const ctx = useContext(NotificationsContext);
  if (!ctx) throw new Error('useNotify must be used within a NotificationsProvider');
  return ctx;
}
