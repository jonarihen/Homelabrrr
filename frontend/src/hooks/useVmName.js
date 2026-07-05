import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../api.js';

// Resolves the human-readable VM name for pop-out console tabs.
// Uses the ?name= query param for an instant title, then confirms
// via the status API (covers direct navigation without the param).
export default function useVmName(node, vmid) {
  const [searchParams] = useSearchParams();
  const [name, setName] = useState(searchParams.get('name') || '');

  useEffect(() => {
    let cancelled = false;
    api.get(`/vms/${node}/${vmid}/status`)
      .then((r) => { if (!cancelled && r.data?.name) setName(r.data.name); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [node, vmid]);

  return name || `VM ${vmid}`;
}
