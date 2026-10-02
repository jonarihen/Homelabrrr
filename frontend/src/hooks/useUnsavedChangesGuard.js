import { useEffect } from 'react';
import { useBlocker } from 'react-router-dom';

// Guards a dirty draft against being silently discarded: in-app navigation
// (links, the browser Back button) asks for confirmation through the router,
// and closing/reloading the tab triggers the browser's own prompt.
export default function useUnsavedChangesGuard(dirty, message = 'Discard unsaved changes?') {
  const blocker = useBlocker(({ currentLocation, nextLocation }) => (
    dirty && currentLocation.pathname !== nextLocation.pathname
  ));

  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    if (window.confirm(message)) blocker.proceed();
    else blocker.reset();
  }, [blocker, message]);

  useEffect(() => {
    if (!dirty) return undefined;
    const handler = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);
}
