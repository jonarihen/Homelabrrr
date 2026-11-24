import { useState, useEffect, useCallback } from 'react';
import api from '../../../api.js';

// Active tab plus the address/service object lists and their add forms. Kept
// above the tabs so an open form and its error survive switching tabs.
export default function usePolicyObjects({ selectedFw, canManageObjects }) {
  const [activeTab, setActiveTab] = useState('rules');
  const [addressObjects, setAddressObjects] = useState([]);
  const [serviceObjects, setServiceObjects] = useState([]);
  const [objectsLoading, setObjectsLoading] = useState(false);
  const [showAddrForm, setShowAddrForm] = useState(false);
  const [showSvcForm, setShowSvcForm] = useState(false);
  const [addrForm, setAddrForm] = useState({ name: '', subnet: '', comment: '' });
  const [svcForm, setSvcForm] = useState({ name: '', tcpPortrange: '', udpPortrange: '', comment: '' });
  const [objectError, setObjectError] = useState('');

  const loadObjects = useCallback(() => {
    if (!selectedFw) return;
    setObjectsLoading(true);
    Promise.all([
      api.get(`/admin/objects/addresses?firewallId=${selectedFw}`),
      api.get(`/admin/objects/services?firewallId=${selectedFw}`),
    ]).then(([addrRes, svcRes]) => {
      setAddressObjects(addrRes.data || []);
      setServiceObjects(svcRes.data || []);
    }).catch((err) => {
      console.error('Failed to load objects:', err);
    }).finally(() => setObjectsLoading(false));
  }, [selectedFw]);

  useEffect(() => {
    if (!canManageObjects && activeTab !== 'rules') setActiveTab('rules');
  }, [activeTab, canManageObjects]);

  useEffect(() => {
    if (!canManageObjects) return;
    if ((activeTab === 'addresses' || activeTab === 'services') && selectedFw) loadObjects();
  }, [activeTab, canManageObjects, selectedFw, loadObjects]);

  return {
    activeTab, setActiveTab,
    addressObjects, serviceObjects, objectsLoading, loadObjects,
    showAddrForm, setShowAddrForm, addrForm, setAddrForm,
    showSvcForm, setShowSvcForm, svcForm, setSvcForm,
    objectError, setObjectError,
  };
}
