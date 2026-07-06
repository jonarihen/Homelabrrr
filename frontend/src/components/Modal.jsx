import { useRef, useId } from 'react';
import useDialogA11y from '../hooks/useDialogA11y.js';

export default function Modal({ title, onClose, children, size = 'md' }) {
  const dialogRef = useRef(null);
  const titleId = useId();
  // Escape-to-close, focus trap, and focus restore (WCAG focus management).
  useDialogA11y(dialogRef, onClose);

  const sizes = {
    sm: 'max-w-md',
    md: 'max-w-lg',
    lg: 'max-w-2xl',
    xl: 'max-w-4xl',
    full: 'max-w-7xl',
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`w-full ${sizes[size]} bg-gray-900 border border-gray-700 shadow-2xl flex flex-col max-h-[90vh] focus:outline-none`}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-700 shrink-0">
          <h2 id={titleId} className="aaris-display text-sm text-gray-100">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            className="text-gray-500 hover:text-white transition-colors p-1 hover:bg-gray-700"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="overflow-y-auto flex-1 min-h-0">
          {children}
        </div>
      </div>
    </div>
  );
}
