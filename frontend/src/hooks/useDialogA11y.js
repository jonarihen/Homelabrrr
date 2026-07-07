import { useEffect, useRef } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Dialog accessibility for modals: Escape-to-close, focus trap (Tab cycles
// within the panel), initial focus into the panel (respecting an inner
// autoFocus), and focus restore to the opener on close. Pass a ref to the
// dialog panel and its onClose. `active` gates it for panels that are toggled
// rather than mounted/unmounted; defaults on for mount-only modals.
export default function useDialogA11y(panelRef, onClose, active = true) {
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; });

  useEffect(() => {
    if (!active) return undefined;
    const opener = document.activeElement;
    const node = panelRef.current;

    if (node && !node.contains(document.activeElement)) {
      const first = node.querySelector(FOCUSABLE);
      (first || node).focus();
    }

    const handleKey = (e) => {
      if (e.key === 'Escape') { onCloseRef.current?.(); return; }
      if (e.key !== 'Tab' || !node) return;
      const items = node.querySelectorAll(FOCUSABLE);
      if (items.length === 0) { e.preventDefault(); return; }
      const firstEl = items[0];
      const lastEl = items[items.length - 1];
      if (e.shiftKey && document.activeElement === firstEl) { e.preventDefault(); lastEl.focus(); }
      else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); firstEl.focus(); }
    };

    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('keydown', handleKey);
      if (opener && typeof opener.focus === 'function') opener.focus();
    };
  }, [active]);
}
