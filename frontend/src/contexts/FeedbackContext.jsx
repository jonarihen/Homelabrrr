import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import ConfirmDialog from '../components/ConfirmDialog.jsx';
import { confirmOptions, toastReducer, toastTimeout } from '../utils/feedback.js';

const ToastContext = createContext(null);
const ConfirmContext = createContext(null);

const toastStyles = {
  error: 'border-l-red-600 text-red-300',
  success: 'border-l-green-600 text-green-300',
  info: 'border-l-blue-600 text-gray-200',
};

function Toast({ toast, dispatch }) {
  const { id, kind, message } = toast;
  useEffect(() => {
    const ms = toastTimeout(kind);
    if (ms == null) return undefined;
    const timer = setTimeout(() => dispatch({ type: 'dismiss', id }), ms);
    return () => clearTimeout(timer);
  }, [id, kind, dispatch]);
  return (
    <div className={`pointer-events-auto flex items-start gap-3 border border-l-4 border-gray-700 bg-gray-900 px-4 py-3 shadow-2xl ${toastStyles[kind] || toastStyles.info}`}>
      <p className="flex-1 text-sm whitespace-pre-line break-words">{message}</p>
      <button type="button" onClick={() => dispatch({ type: 'dismiss', id })} aria-label="Dismiss" className="text-gray-500 hover:text-white">
        <svg aria-hidden="true" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}

// Provides useToast() and useConfirm(); mounted once in App.jsx.
export function FeedbackProvider({ children }) {
  const [toasts, dispatch] = useReducer(toastReducer, []);
  const nextId = useRef(0);

  const toast = useMemo(() => {
    const add = (kind) => (message) => dispatch({ type: 'add', toast: { id: ++nextId.current, kind, message: String(message) } });
    return { error: add('error'), success: add('success'), info: add('info') };
  }, []);

  // Requests queue so overlapping confirms are answered one at a time.
  const [queue, setQueue] = useState([]);
  const confirm = useCallback((arg) => new Promise((resolve) => {
    setQueue((q) => [...q, { ...confirmOptions(arg), id: ++nextId.current, resolve }]);
  }), []);
  const current = queue[0];
  const settle = (result) => {
    current.resolve(result);
    setQueue((q) => q.slice(1));
  };

  return (
    <ToastContext.Provider value={toast}>
      <ConfirmContext.Provider value={confirm}>
        {children}
        {current && (
          <ConfirmDialog
            key={current.id}
            title={current.title}
            message={current.message}
            confirmLabel={current.confirmLabel}
            cancelLabel={current.cancelLabel}
            danger={current.danger}
            onConfirm={() => settle(true)}
            onCancel={() => settle(false)}
          />
        )}
        <div aria-live="polite" className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2">
          {toasts.map((t) => <Toast key={t.id} toast={t} dispatch={dispatch} />)}
        </div>
      </ConfirmContext.Provider>
    </ToastContext.Provider>
  );
}

// toast.error(msg) persists until dismissed; toast.success / toast.info auto-dismiss.
export function useToast() {
  return useContext(ToastContext);
}

// `if (!(await confirm('Apply this?'))) return;` or confirm({ title, message, confirmLabel, danger }).
export function useConfirm() {
  return useContext(ConfirmContext);
}
