import { useEffect, useRef } from 'react';
import { useBlocker } from 'react-router-dom';
import { useConfirm } from '../contexts/FeedbackContext.jsx';

// Guards a dirty draft against being silently discarded: in-app navigation
// (links, the browser Back button) asks for confirmation through the router,
// and closing/reloading the tab triggers the browser's own prompt.
export default function useUnsavedChangesGuard(dirty, message = 'Discard unsaved changes?') {
  const blocker = useBlocker(({ currentLocation, nextLocation }) => (
    dirty && currentLocation.pathname !== nextLocation.pathname
  ));

  const confirm = useConfirm();
  const asking = useRef(false);
  useEffect(() => {
    // The blocker object is recreated on re-render; ask once per blocked navigation.
    if (blocker.state !== 'blocked' || asking.current) return;
    asking.current = true;
    confirm({ message, confirmLabel: 'Discard', danger: true }).then((ok) => {
      asking.current = false;
      if (ok) blocker.proceed();
      else blocker.reset();
    });
  }, [blocker, message, confirm]);

  useEffect(() => {
    if (!dirty) return undefined;
    const handler = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);
}
