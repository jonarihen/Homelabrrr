import { useEffect, useRef, useState } from 'react';
import api from '../api.js';
import { routeNode } from '../utils/nodeRef.js';

const migrationError = (error, fallback) => error.response?.data?.error || fallback;
const sleep = () => new Promise((resolve) => setTimeout(resolve, 3000));

function getPlaceableDisks(plan, adopt) {
  return (plan?.disks || []).filter((disk) => adopt
    ? disk.action === 'copy'
    : ['copy', 'remount'].includes(disk.action));
}

function getSplitSources(adopt, disks, diskTarget) {
  if (adopt) return [];
  const targetsBySource = disks.reduce((targets, disk) => {
    if (!disk.storage) return targets;
    const targetStorages = targets.get(disk.storage) || new Set();
    targetStorages.add(diskTarget(disk.key));
    targets.set(disk.storage, targetStorages);
    return targets;
  }, new Map());
  return [...targetsBySource]
    .filter(([, targets]) => targets.size > 1)
    .map(([source]) => source);
}

function getStorageIssue(plan, adopt, storage, disks, diskTarget) {
  if (adopt) return null;
  const chosen = new Set([storage, ...disks.map((disk) => diskTarget(disk.key))].filter(Boolean));
  return (plan?.storageCompatibility || []).find((item) => chosen.has(item.storage) && item.severity === 'error');
}

export default function useMigrateVM(vm, onDone) {
  const running = vm.status === 'running';
  const isLxc = vm.type === 'lxc';
  const vmNode = routeNode(vm);
  const vmid = vm.vmid;
  const [nodes, setNodes] = useState([]);
  const [targetNode, setTargetNode] = useState('');
  const [storages, setStorages] = useState([]);
  const [storage, setStorageValue] = useState('');
  const [diskStorages, setDiskStorages] = useState({});
  const [bridges, setBridges] = useState([]);
  const [bridge, setBridge] = useState('');
  const [plan, setPlan] = useState(null);
  const [fullCopy, setFullCopyValue] = useState(false);
  const [online, setOnline] = useState(running && !isLxc);
  const [deleteSource, setDeleteSource] = useState(true);
  const [error, setError] = useState('');
  const [loadingTarget, setLoadingTarget] = useState(false);
  const [starting, setStarting] = useState(false);
  const [migration, setMigration] = useState(null);
  const [bootIssue, setBootIssue] = useState(null);
  const [preparing, setPreparing] = useState('');
  const [info, setInfo] = useState('');
  const pollRef = useRef(null);

  useEffect(() => {
    api.get('/provision/nodes')
      .then(({ data }) => {
        const eligible = data.filter((node) => node.hostId !== vm.hostId && node.status === 'online');
        setNodes(eligible);
        if (eligible.length === 1) setTargetNode(eligible[0].nodeRef);
      })
      .catch((requestError) => setError(migrationError(requestError, 'Failed to load target hosts')));
  }, [vm.hostId]);

  useEffect(() => {
    if (!targetNode) return undefined;
    setLoadingTarget(true);
    setStorageValue('');
    setDiskStorages({});
    setBridge('');
    setPlan(null);
    const wanted = isLxc ? 'rootdir' : 'images';
    Promise.all([
      api.get(`/provision/nodes/${encodeURIComponent(targetNode)}/storages`),
      api.get(`/provision/nodes/${encodeURIComponent(targetNode)}/networks`),
      api.get(`/migrate/plan/${encodeURIComponent(vmNode)}/${vmid}?target=${encodeURIComponent(targetNode)}`),
    ]).then(([storageResponse, networkResponse, planResponse]) => {
      const usable = storageResponse.data.filter((item) => item.content?.includes(wanted));
      const sharedIds = new Set((planResponse.data.sharedStorages || []).map((item) => item.targetId));
      const firstLocal = usable.find((item) => !sharedIds.has(item.storage));
      setStorages(usable);
      setPlan(planResponse.data);
      setStorageValue(planResponse.data.mode === 'adopt' ? firstLocal?.storage || '' : usable[0]?.storage || '');
      setBridges(networkResponse.data);
      setBridge((networkResponse.data.find((item) => item.iface === 'vmbr0') || networkResponse.data[0])?.iface || '');
      setError('');
    }).catch((requestError) => setError(migrationError(requestError, 'Failed to load target node resources')))
      .finally(() => setLoadingTarget(false));
    return undefined;
  }, [targetNode, isLxc, vmNode, vmid]);

  useEffect(() => () => clearInterval(pollRef.current), []);

  const poll = (id) => {
    pollRef.current = setInterval(async () => {
      try {
        const { data } = await api.get(`/migrate/${id}`);
        setMigration(data);
        if (data.status === 'running') return;
        clearInterval(pollRef.current);
        onDone?.();
      } catch {}
    }, 4000);
  };

  const effectiveMode = plan && !fullCopy ? plan.mode : 'remote_migrate';
  const adopt = effectiveMode === 'adopt';
  const placeableDisks = getPlaceableDisks(plan, adopt);
  const diskTarget = (key) => diskStorages[key] ?? storage;
  const setDiskTarget = (key, value) => setDiskStorages((current) => ({ ...current, [key]: value }));
  const splitSources = getSplitSources(adopt, placeableDisks, diskTarget);
  const splitBlocked = !adopt && isLxc && splitSources.length > 0;
  const storageIssue = getStorageIssue(plan, adopt, storage, placeableDisks, diskTarget);
  const missingDiskTarget = !adopt && placeableDisks.some((disk) => !diskTarget(disk.key));

  const submitMigration = async (onlineOverride) => {
    const { data } = await api.post(`/migrate/${encodeURIComponent(vmNode)}/${vmid}`, {
      targetNode,
      targetStorage: storage || undefined,
      diskStorages: Object.fromEntries(placeableDisks.map((disk) => [disk.key, diskTarget(disk.key)])),
      targetBridge: bridge,
      online: onlineOverride ?? online,
      deleteSource,
      fullCopy,
    });
    setMigration({ id: data.id, mode: data.mode, status: 'running', status_detail: '', steps: [] });
    poll(data.id);
  };

  const start = async () => {
    setStarting(true);
    setError('');
    setBootIssue(null);
    try {
      await submitMigration();
    } catch (requestError) {
      const data = requestError.response?.data;
      if (data?.code === 'stale_boot_order') setBootIssue(data);
      else setError(data?.error || 'Failed to start migration');
    } finally {
      setStarting(false);
    }
  };

  const waitForStatus = async (wantedStatus, tries) => {
    for (let attempt = 0; attempt < tries; attempt += 1) {
      await sleep();
      try {
        const { data } = await api.get(`/vms/${encodeURIComponent(vmNode)}/${vmid}/status`);
        if (data.status === wantedStatus) return true;
      } catch {}
    }
    return false;
  };

  const powerAction = (action) => api.post(`/vms/${encodeURIComponent(vmNode)}/${vmid}/action`, { action });

  const stopAndMigrate = async () => {
    setPreparing('stop');
    setError('');
    try {
      await powerAction('stop');
      if (!(await waitForStatus('stopped', 40))) {
        setError('VM did not stop in time — check it and try again.');
        return;
      }
      setBootIssue(null);
      await submitMigration(false);
    } catch (requestError) {
      setError(migrationError(requestError, 'Failed to stop the VM'));
    } finally {
      setPreparing('');
    }
  };

  const rebootToFix = async () => {
    setPreparing('reboot');
    setError('');
    try {
      await powerAction('reboot');
      setBootIssue(null);
      setError('');
      setInfo('Rebooting the VM to apply the boot-order fix. Once it is running again, click Start migration for a live move.');
    } catch (requestError) {
      setError(migrationError(requestError, 'Failed to reboot the VM'));
    } finally {
      setPreparing('');
    }
  };

  const setStorage = (value) => {
    setStorageValue(value);
    setDiskStorages({});
  };
  const setFullCopy = (value) => {
    setFullCopyValue(value);
    setDiskStorages({});
  };
  const blockedByRunning = adopt && running;
  const startDisabled = starting || loadingTarget || !targetNode || !bridge || blockedByRunning
    || Boolean(storageIssue) || splitBlocked || missingDiskTarget || (!adopt && !storage);

  return {
    adopt, blockedByRunning, bootIssue, bridge, bridges, deleteSource, diskTarget, error,
    fullCopy, info, isLxc, loadingTarget, migration, nodes, online, placeableDisks, plan,
    preparing, rebootToFix, running, setBridge, setDeleteSource, setDiskTarget, setFullCopy,
    setOnline, setStorage, setTargetNode, splitBlocked, splitSources, start, startDisabled,
    starting, stopAndMigrate, storage, storageIssue, storages, targetNode,
    targetHostName: nodes.find((node) => node.nodeRef === targetNode)?.hostName || '',
  };
}
