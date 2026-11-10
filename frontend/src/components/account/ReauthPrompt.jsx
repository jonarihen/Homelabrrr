import { useEffect, useRef, useState } from 'react';
import api from '../../api.js';
import { setReauthHandler } from '../../utils/reauthPrompt.js';
import RecentReauthDialog from './RecentReauthDialog.jsx';

// App-wide identity confirmation for requests the api client replays; see
// utils/reauthPrompt.js. Mounted once in App.jsx, keyed by user.
export default function ReauthPrompt() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const resolver = useRef(null);

  const settle = (result) => {
    resolver.current?.(result);
    resolver.current = null;
    setOpen(false);
  };

  useEffect(() => {
    const unregister = setReauthHandler(() => new Promise((resolve) => {
      resolver.current = resolve;
      setError('');
      setOpen(true);
    }));
    return () => {
      unregister();
      resolver.current?.(false);
      resolver.current = null;
    };
  }, []);

  const confirm = async (credentials) => {
    setBusy(true);
    try {
      await api.post('/auth/reauthenticate', credentials);
      settle(true);
      return true;
    } catch (err) {
      setError(err.response?.data?.error || 'Identity confirmation failed');
      return false;
    } finally {
      setBusy(false);
    }
  };

  return <RecentReauthDialog open={open} busy={busy} error={error} onCancel={() => settle(false)} onConfirm={confirm} />;
}
