import { useEffect, useState } from 'react';
import api from '../api.js';
import { useAuth } from '../contexts/AuthContext.jsx';
import { supportVisible } from '../utils/supportStatus.js';

// Layout remounts on every navigation, so the answer is shared at module level
// and asked for once per signed-in user. A failed request is not kept: the
// entry stays hidden and the next mount asks again.
let cache = null; // { userId, promise }
const listeners = new Set();

function load(userId) {
  if (cache?.userId !== userId) {
    const entry = { userId };
    entry.promise = api.get('/payments/status').then(({ data }) => data, () => { if (cache === entry) cache = null; return null; });
    cache = entry;
  }
  return cache.promise;
}

// Call after the support methods change (the owner flips a switch): every
// mounted hook asks again and keeps its current answer until the new one lands.
export function invalidateSupportStatus() {
  cache = null;
  listeners.forEach((refetch) => refetch());
}

export default function useSupportStatus() {
  const { user } = useAuth();
  // No request without a full session: a 2FA-enrollment-only session is refused anyway.
  const userId = user && !user.twoFactorSetupRequired ? user.id ?? null : null;
  const [epoch, setEpoch] = useState(0);
  const [answer, setAnswer] = useState({ userId: null, status: null });

  useEffect(() => {
    const refetch = () => setEpoch((n) => n + 1);
    listeners.add(refetch);
    return () => { listeners.delete(refetch); };
  }, []);

  useEffect(() => {
    if (userId == null) return undefined;
    let cancelled = false;
    load(userId).then((status) => { if (!cancelled) setAnswer({ userId, status }); });
    return () => { cancelled = true; };
  }, [userId, epoch]);

  // An answer fetched for another user is never shown.
  const status = userId != null && answer.userId === userId ? answer.status : null;
  return { status, visible: supportVisible(status) };
}
