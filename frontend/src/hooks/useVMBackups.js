import { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../api.js';

export default function useVMBackups(node, vmid) {
  const [backups, setBackups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [storages, setStorages] = useState([]);
  const [creating, setCreating] = useState(false);
  const [restoring, setRestoring] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [form, setForm] = useState({ storage: '', mode: 'snapshot', compress: 'zstd', notes: '' });
  const [restoreConfirm, setRestoreConfirm] = useState(null);
  const [restoreStorage, setRestoreStorage] = useState('');
  const [browseBackup, setBrowseBackup] = useState(null);
  const [browseFiles, setBrowseFiles] = useState([]);
  const [browsePathStack, setBrowsePathStack] = useState([]);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [browseError, setBrowseError] = useState('');
  const [collapsedGroups, setCollapsedGroups] = useState({});
  const [expanded, setExpanded] = useState(false);
  const [tasks, setTasks] = useState([]);
  const [dismissedTaskId, setDismissedTaskId] = useState(null);

  const loadBackups = useCallback(async () => {
    try {
      const response = await api.get(`/vms/${node}/${vmid}/backups`);
      setBackups(response.data);
    } catch {
      setBackups([]);
    } finally {
      setLoading(false);
    }
  }, [node, vmid]);

  const loadTasks = useCallback(async () => {
    try {
      const response = await api.get(`/vms/${node}/${vmid}/backup-tasks`);
      setTasks(response.data || []);
      return response.data || [];
    } catch {
      return [];
    }
  }, [node, vmid]);

  useEffect(() => { loadBackups(); }, [loadBackups]);
  useEffect(() => { loadTasks(); }, [loadTasks]);

  const latestTask = tasks[0] || null;
  const runningTask = tasks.find(task => task.status === 'running') || null;
  const runningTaskId = runningTask?.id ?? null;

  useEffect(() => {
    if (runningTaskId == null) return undefined;
    const timer = setInterval(async () => {
      const next = await loadTasks();
      if (!next.some(task => task.status === 'running')) loadBackups();
    }, 5000);
    return () => clearInterval(timer);
  }, [runningTaskId, loadTasks, loadBackups]);

  useEffect(() => {
    api.get(`/vms/${node}/${vmid}/backup-storages`)
      .then(response => {
        setStorages(response.data);
        if (response.data.length > 0) setForm(current => (current.storage ? current : { ...current, storage: response.data[0].storage }));
      })
      .catch(() => {});
  }, [node, vmid]);

  const groups = useMemo(() => {
    const map = new Map();
    for (const backup of backups) {
      const key = backup.storage || 'unknown';
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(backup);
    }
    return [...map.entries()].map(([storage, items]) => {
      const meta = storages.find(item => item.storage === storage);
      return {
        storage,
        items,
        type: meta?.type || (items.some(item => /^pbs-/.test(item.format || '')) ? 'pbs' : undefined),
        total: meta?.total,
        used: meta?.used,
        size: items.reduce((sum, item) => sum + (item.size || 0), 0),
      };
    }).sort((a, b) => a.storage.localeCompare(b.storage));
  }, [backups, storages]);

  const totalSize = useMemo(() => backups.reduce((sum, backup) => sum + (backup.size || 0), 0), [backups]);

  const createBackup = async () => {
    setCreating(true); setError(''); setSuccess('');
    try {
      await api.post(`/vms/${node}/${vmid}/backup`, form);
      setShowForm(false);
      setDismissedTaskId(null);
      await Promise.all([loadTasks(), loadBackups()]);
    } catch (requestError) {
      setError(requestError.response?.data?.error || 'Failed to create backup');
    } finally {
      setCreating(false);
    }
  };

  const restoreBackup = async backup => {
    setRestoring(backup.volid); setError(''); setSuccess('');
    try {
      await api.post(`/vms/${node}/${vmid}/restore`, {
        archive: backup.volid,
        ...(restoreStorage && { storage: restoreStorage }),
      });
      setSuccess('Restore started — the VM will be overwritten with the backup contents. This may take several minutes.');
      setRestoreConfirm(null);
      setRestoreStorage('');
    } catch (requestError) {
      setError(requestError.response?.data?.error || 'Failed to restore backup');
    } finally {
      setRestoring(null);
    }
  };

  const deleteBackup = async (storage, volid) => {
    if (!confirm('Delete this backup? This cannot be undone.')) return;
    setDeleting(volid); setError('');
    try {
      await api.delete(`/vms/${node}/${vmid}/backups/${storage}/${volid}`);
      setBackups(current => current.filter(backup => backup.volid !== volid));
    } catch (requestError) {
      setError(requestError.response?.data?.error || 'Failed to delete backup');
    } finally {
      setDeleting(null);
    }
  };

  const loadFiles = async (storage, volid, filepath) => {
    setBrowseLoading(true); setBrowseError('');
    try {
      const response = await api.get(`/vms/${node}/${vmid}/backup-files/${storage}/${volid}`, { params: { filepath } });
      setBrowseFiles(Array.isArray(response.data) ? response.data : []);
    } catch (requestError) {
      setBrowseError(requestError.response?.data?.error || 'Failed to list files. File-level restore may not be supported for this backup format.');
      setBrowseFiles([]);
    } finally {
      setBrowseLoading(false);
    }
  };

  const openFileBrowser = async backup => {
    setBrowseBackup(backup);
    setBrowsePathStack([]);
    setBrowseError('');
    await loadFiles(backup.storage, backup.volid, '/');
  };

  const navigateInto = async item => {
    setBrowsePathStack(current => [...current, { filepath: item.filepath, label: item.text }]);
    await loadFiles(browseBackup.storage, browseBackup.volid, item.filepath);
  };

  const navigateBack = async () => {
    const next = browsePathStack.slice(0, -1);
    setBrowsePathStack(next);
    await loadFiles(browseBackup.storage, browseBackup.volid, next.length > 0 ? next[next.length - 1].filepath : '/');
  };

  const navigateTo = async index => {
    const next = index < 0 ? [] : browsePathStack.slice(0, index + 1);
    setBrowsePathStack(next);
    await loadFiles(browseBackup.storage, browseBackup.volid, next.length > 0 ? next[next.length - 1].filepath : '/');
  };

  const downloadFile = filepath => {
    const params = new URLSearchParams({ filepath });
    window.open(`/api/vms/${node}/${vmid}/backup-download/${browseBackup.storage}/${browseBackup.volid}?${params}`, '_blank');
  };

  return {
    backups, loading, storages, creating, restoring, deleting, showForm, setShowForm,
    error, success, form, setForm, restoreConfirm, setRestoreConfirm, restoreStorage,
    setRestoreStorage, browseBackup, setBrowseBackup, browseFiles, setBrowseFiles,
    browsePathStack, setBrowsePathStack, browseLoading, browseError, collapsedGroups,
    setCollapsedGroups, expanded, setExpanded, dismissedTaskId, setDismissedTaskId,
    latestTask, runningTask, groups, totalSize, createBackup, restoreBackup, deleteBackup,
    openFileBrowser, navigateInto, navigateBack, navigateTo, downloadFile,
  };
}
