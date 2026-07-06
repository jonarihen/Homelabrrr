import { createContext, useContext, useState, useCallback, useRef } from 'react';
import Modal from '../components/Modal.jsx';

// Promise-based confirmation dialog. `const confirm = useConfirm();
// if (await confirm({ ... })) { ... }` replaces the blocking native confirm()
// with an AARIS-styled, focus-trapped modal that keeps the operator-console look.
const ConfirmContext = createContext(null);

export function ConfirmProvider({ children }) {
  const [state, setState] = useState(null); // { title, message, confirmLabel, cancelLabel, danger }
  const resolverRef = useRef(null);

  const confirm = useCallback((opts = {}) => {
    return new Promise((resolve) => {
      resolverRef.current = resolve;
      setState({
        title: opts.title || 'Confirm',
        message: opts.message || 'Are you sure?',
        confirmLabel: opts.confirmLabel || 'Confirm',
        cancelLabel: opts.cancelLabel || 'Cancel',
        danger: opts.danger !== false, // default to destructive styling
      });
    });
  }, []);

  const settle = useCallback((result) => {
    setState(null);
    const resolve = resolverRef.current;
    resolverRef.current = null;
    if (resolve) resolve(result);
  }, []);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {state && (
        <Modal title={state.title} onClose={() => settle(false)} size="sm">
          <div className="space-y-5 p-5">
            <p className="text-sm leading-relaxed text-gray-300">{state.message}</p>
            <div className="flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={() => settle(false)}
                className="border border-gray-700 px-4 py-2 font-mono text-xs font-semibold uppercase tracking-[0.12em] text-gray-400 transition-colors hover:border-gray-600 hover:text-gray-100"
              >
                {state.cancelLabel}
              </button>
              <button
                type="button"
                onClick={() => settle(true)}
                className={
                  state.danger
                    ? 'border border-red-600 bg-red-600 px-4 py-2 font-mono text-xs font-semibold uppercase tracking-[0.12em] text-gray-950 transition-colors hover:border-red-500 hover:bg-red-500'
                    : 'border border-orange-600 bg-orange-600 px-4 py-2 font-mono text-xs font-semibold uppercase tracking-[0.12em] text-gray-950 transition-colors hover:border-orange-500 hover:bg-orange-500'
                }
              >
                {state.confirmLabel}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </ConfirmContext.Provider>
  );
}

export function useConfirm() {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm must be used within a ConfirmProvider');
  return ctx;
}
