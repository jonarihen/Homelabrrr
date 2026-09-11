import { useCallback, useEffect, useState } from 'react';
import api from '../../api.js';

const emptyProfiles = () => ({ profiles: [], certificates: [] });
const emptyImportData = (loading = false) => ({ loading, sites: [], managedCount: 0, error: '' });

export function defaultWebsiteServerForm() {
  return {
    name: '', apiUrl: '', authType: 'none', authSecret: '', serverName: '', verifyTls: true, wanIp: '', fortigateId: '', inspectionProfile: '', inspectionBundleCert: '',
    sshHost: '', sshPort: 22, sshUser: '', sshAuthType: 'key', sshSecret: '', snippetPath: '/etc/caddy/homelabrrr.caddy', caddyfilePath: '/etc/caddy/Caddyfile',
  };
}

function formFromServer(server) {
  return {
    name: server.name, apiUrl: server.apiUrl, authType: server.authType || 'none', authSecret: '', serverName: server.serverName || '', verifyTls: !!server.verifyTls, wanIp: server.wanIpManual || '', fortigateId: server.fortigateId || '', inspectionProfile: server.inspectionProfile || '', inspectionBundleCert: server.inspectionBundleCert || '',
    sshHost: server.sshHost || '', sshPort: server.sshPort || 22, sshUser: server.sshUser || '', sshAuthType: server.sshAuthType || 'key', sshSecret: '', snippetPath: server.snippetPath || '/etc/caddy/homelabrrr.caddy', caddyfilePath: server.caddyfilePath || '/etc/caddy/Caddyfile',
  };
}

export default function useWebsitesAdmin() {
  const [servers, setServers] = useState([]);
  const [statuses, setStatuses] = useState({});
  const [sites, setSites] = useState([]);
  const [users, setUsers] = useState([]);
  const [firewalls, setFirewalls] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState(defaultWebsiteServerForm());
  const [profiles, setProfiles] = useState(emptyProfiles());
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [banner, setBanner] = useState('');
  const [syncingId, setSyncingId] = useState(null);
  const [confirmDeleteSite, setConfirmDeleteSite] = useState(null);
  const [importSrv, setImportSrv] = useState(null);
  const [importData, setImportData] = useState(emptyImportData());
  const [importSel, setImportSel] = useState(new Set());
  const [importing, setImporting] = useState(false);

  const load = useCallback(async () => {
    try {
      const [srv, st, us, fw] = await Promise.all([
        api.get('/websites/servers'), api.get('/websites/admin/sites'), api.get('/websites/admin/users'), api.get('/websites/firewalls'),
      ]);
      setServers(srv.data || []);
      setSites(st.data || []);
      setUsers(us.data || []);
      setFirewalls(fw.data || []);
      (srv.data || []).forEach((server) => {
        setStatuses((previous) => ({ ...previous, [server.id]: { loading: true } }));
        api.get(`/websites/servers/${server.id}/status`)
          .then((response) => setStatuses((previous) => ({ ...previous, [server.id]: { ...response.data, loading: false } })))
          .catch(() => setStatuses((previous) => ({ ...previous, [server.id]: { online: false, loading: false, error: 'Failed to check' } })));
      });
    } catch (requestError) {
      setError(requestError.response?.data?.error || 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const loadProfiles = (id) => {
    if (!id) {
      setProfiles(emptyProfiles());
      return;
    }
    api.get(`/websites/servers/${id}/inspection-profiles`)
      .then((response) => setProfiles(response.data || emptyProfiles()))
      .catch(() => setProfiles(emptyProfiles()));
  };

  const openImport = (server) => {
    setImportSrv(server);
    setImportData(emptyImportData(true));
    setImportSel(new Set());
    api.get(`/websites/servers/${server.id}/discover`)
      .then((response) => {
        const discoveredSites = response.data.sites || [];
        setImportData({ loading: false, sites: discoveredSites, managedCount: response.data.managedCount || 0, error: '' });
        setImportSel(new Set(discoveredSites.filter((site) => site.importable).map((site) => site.domain)));
      })
      .catch((requestError) => setImportData({ ...emptyImportData(), error: requestError.response?.data?.error || 'Failed to read the Caddy config' }));
  };

  const openAdd = () => {
    setEditId(null);
    setForm(defaultWebsiteServerForm());
    setProfiles(emptyProfiles());
    setError('');
    setShowForm(true);
  };

  const openEdit = (server) => {
    setEditId(server.id);
    setForm(formFromServer(server));
    setError('');
    setShowForm(true);
    loadProfiles(server.id);
  };

  const save = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      const response = editId
        ? await api.put(`/websites/servers/${editId}`, form)
        : await api.post('/websites/servers', form);
      if (response.data.syncWarning) setBanner(response.data.syncWarning);
      setShowForm(false);
      load();
      if (!editId) openImport({ id: response.data.id, name: form.name });
    } catch (requestError) {
      setError(requestError.response?.data?.error || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id) => {
    setError('');
    try {
      await api.delete(`/websites/servers/${id}`);
      load();
    } catch (requestError) {
      setError(requestError.response?.data?.error || 'Failed to delete');
    }
  };

  const syncServer = async (server) => {
    setBanner('');
    setError('');
    setSyncingId(server.id);
    try {
      const response = await api.post(`/websites/servers/${server.id}/sync`);
      if (response.data.mode === 'caddyfile') setBanner(`Caddyfile synced on ${server.name}: ${response.data.sites} site(s) written, Caddy reloaded`);
      else setBanner(response.data.repaired.length ? `Re-pushed ${response.data.repaired.length} missing route(s) on ${server.name}: ${response.data.repaired.join(', ')}` : `No drift on ${server.name} — every managed route is present`);
      load();
    } catch (requestError) {
      setError(requestError.response?.data?.error || 'Sync failed');
    } finally {
      setSyncingId(null);
    }
  };

  const detectWanIp = async () => {
    if (!editId) return;
    try {
      const response = await api.post(`/websites/servers/${editId}/detect-wan-ip`);
      setForm((current) => ({ ...current, wanIp: response.data.wanIp }));
    } catch (requestError) {
      setError(requestError.response?.data?.error || 'Detection failed');
    }
  };

  const assign = async (site, userId) => {
    setBanner('');
    try {
      await api.post(`/websites/admin/sites/${site.id}/assign`, { userId: userId === '' ? null : userId });
      setBanner(`Reassigned ${site.domain}`);
      load();
    } catch (requestError) {
      setError(requestError.response?.data?.error || 'Failed to assign');
    }
  };

  const deleteSite = async (site) => {
    try {
      await api.delete(`/websites/admin/sites/${site.id}`);
      setConfirmDeleteSite(null);
      load();
    } catch (requestError) {
      setError(requestError.response?.data?.error || 'Failed to delete');
    }
  };

  const toggleImport = (domain) => setImportSel((previous) => {
    const next = new Set(previous);
    if (next.has(domain)) next.delete(domain);
    else next.add(domain);
    return next;
  });

  const runImport = async () => {
    if (!importSrv || importSel.size === 0) return;
    setImporting(true);
    try {
      const response = await api.post(`/websites/servers/${importSrv.id}/import`, { domains: [...importSel] });
      const skipped = response.data.skipped?.length ? `, ${response.data.skipped.length} skipped` : '';
      setBanner(`Imported ${response.data.imported.length} site(s) from ${importSrv.name}${skipped}`);
      setImportSrv(null);
      load();
    } catch (requestError) {
      setImportData((current) => ({ ...current, error: requestError.response?.data?.error || 'Import failed' }));
    } finally {
      setImporting(false);
    }
  };

  return {
    servers, statuses, sites, users, firewalls, loading, showForm, editId, form, profiles, error, saving, banner, syncingId, confirmDeleteSite,
    importSrv, importData, importSel, importing, setShowForm, setForm, setConfirmDeleteSite, setImportSrv, openAdd, openEdit, save, remove,
    syncServer, detectWanIp, assign, deleteSite, openImport, toggleImport, runImport,
  };
}
