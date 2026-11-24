import { useState, useEffect, useCallback } from 'react';
import api from '../../../api.js';

// Firewall list, the selected firewall, and that firewall's synced VLANs and policies.
export default function usePoliciesData() {
  const [firewalls, setFirewalls] = useState([]);
  const [selectedFw, setSelectedFw] = useState(null);
  const [vlans, setVlans] = useState([]);
  const [policies, setPolicies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [policiesLoading, setPoliciesLoading] = useState(false);

  useEffect(() => {
    api.get('/admin/firewalls').then(r => {
      setFirewalls(r.data || []);
      if (r.data.length > 0) setSelectedFw(r.data[0].id);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  const loadData = useCallback(() => {
    if (!selectedFw) return;
    setPoliciesLoading(true);
    Promise.all([
      api.get('/admin/vlans'),
      api.get(`/admin/policies?firewallId=${selectedFw}`),
    ]).then(([vlansRes, policiesRes]) => {
      const allVlans = vlansRes.data || [];
      // Keep only VLANs synced to this firewall, with the subnet that sync provisioned.
      const syncedVlans = allVlans.flatMap(v => {
        const sync = v.firewallSync?.find(s => String(s.firewallId) === String(selectedFw));
        return sync ? [{ ...v, fwSubnet: sync.subnet || v.subnet?.network || '' }] : [];
      });
      setVlans(syncedVlans);
      setPolicies(policiesRes.data || []);
    }).catch((err) => {
      console.error('Failed to load policy data:', err);
    }).finally(() => setPoliciesLoading(false));
  }, [selectedFw]);

  useEffect(() => {
    if (!selectedFw) return;
    loadData();
  }, [selectedFw, loadData]);

  return { firewalls, selectedFw, setSelectedFw, vlans, policies, loading, policiesLoading, loadData };
}
