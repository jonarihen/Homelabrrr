import { useId, useLayoutEffect, useRef } from 'react';
import { activateModal, isTopModal } from '../utils/modalFocus.js';

export default function Modal({ title, onClose, children, size = 'md' }) {
  const titleId = useId();
  const dialogRef = useRef(null);
  const contentRef = useRef(null);
  const triggerRef = useRef(document.activeElement);
  const onCloseRef = useRef(onClose);

  useLayoutEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  useLayoutEffect(() => activateModal({
    dialog: dialogRef.current,
    content: contentRef.current,
    trigger: triggerRef.current,
    onClose: () => onCloseRef.current(),
  }), []);

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
      onClick={(e) => { if (e.target === e.currentTarget && isTopModal(dialogRef.current)) onClose(); }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`w-full ${sizes[size]} bg-gray-900 border border-gray-700 rounded-xl shadow-2xl flex flex-col max-h-[90vh]`}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-700 shrink-0">
          <h2 id={titleId} className="aaris-display text-sm text-gray-100">{title}</h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="text-gray-500 hover:text-white transition-colors p-1 rounded hover:bg-gray-700"
          >
            <svg aria-hidden="true" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div ref={contentRef} className="overflow-y-auto flex-1 min-h-0">
          {children}
        </div>
      </div>
    </div>
  );
}
