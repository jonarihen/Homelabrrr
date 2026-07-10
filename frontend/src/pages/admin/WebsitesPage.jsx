import { useState, useEffect } from 'react';
import api from '../../api.js';
import useDocumentTitle from '../../hooks/useDocumentTitle.js';

const inputCls = 'w-full bg-gray-800 border border-gray-700/50 rounded-xl px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/20 transition-all';
const selectCls = inputCls;

const IN_FLIGHT = ['validating', 'pushing', 'issuing', 'inspecting', 'pending'];

function defaultForm() {
  return { name: '', apiUrl: '', authType: 'none', authSecret: '', serverName: '', verifyTls: true, wanIp: '', fortigateId: '', inspectionProfile: '' };
}

export default function AdminWebsitesPage() {
  useDocumentTitle('Websites');
  const [servers, setServers] = useState([]);
  const [statuses, setStatuses] = useState({});
  const [sites, setSites] = useState([]);
  const [users, setUsers] = useState([]);
  const [firewalls, setFirewalls] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState(defaultForm());
  const [profiles, setProfiles] = useState({ profiles: [], certificates: [] });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [banner, setBanner] = useState('');

  const load = async () => {
    try {
      const [srv, st, us, fw] = await Promise.all([
        api.get('/websites/servers'),
        api.get('/websites/admin/sites'),
        api.get('/websites/admin/users'),
        api.get('/websites/firewalls'),
      ]);
      setServers(srv.data || []);
      setSites(st.data || []);
      setUsers(us.data || []);
      setFirewalls(fw.data || []);
      (srv.data || []).forEach((s) => {
        setStatuses((prev) => ({ ...prev, [s.id]: { loading: true } }));
        api.get(`/websites/servers/${s.id}/status`)
          .then((r) => setStatuses((prev) => ({ ...prev, [s.id]: { ...r.data, loading: false } })))
          .catch(() => setStatuses((prev) => ({ ...prev, [s.id]: { online: false, loading: false, error: 'Failed to check' } })));
      });
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to load');
    } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const loadProfiles = (id) => {
    if (!id) { setProfiles({ profiles: [], certificates: [] }); return; }
    api.get(`/websites/servers/${id}/inspection-profiles`)
      .then((r) => setProfiles(r.data || { profiles: [], certificates: [] }))
      .catch(() => setProfiles({ profiles: [], certificates: [] }));
  };

  const openAdd = () => { setEditId(null); setForm(defaultForm()); setProfiles({ profiles: [], certificates: [] }); setError(''); setShowForm(true); };

  const openEdit = (s) => {
    setEditId(s.id);
    setForm({ name: s.name, apiUrl: s.apiUrl, authType: s.authType || 'none', authSecret: '', serverName: s.serverName || '', verifyTls: !!s.verifyTls, wanIp: s.wanIpManual || '', fortigateId: s.fortigateId || '', inspectionProfile: s.inspectionProfile || '' });
    setError('');
    setShowForm(true);
    loadProfiles(s.id);
  };

  const save = async (e) => {
    e.preventDefault();
    setSaving(true); setError('');
    try {
      if (editId) await api.put(`/websites/servers/${editId}`, form);
      else await api.post('/websites/servers', form);
      setShowForm(false);
      load();
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to save');
    } finally { setSaving(false); }
  };

  const remove = async (id) => {
    setError('');
    try { await api.delete(`/websites/servers/${id}`); load(); }
    catch (e) { setError(e.response?.data?.error || 'Failed to delete'); }
  };

  const detectWanIp = async () => {
    if (!editId) return;
    try { const r = await api.post(`/websites/servers/${editId}/detect-wan-ip`); setForm((f) => ({ ...f, wanIp: r.data.wanIp })); }
    catch (e) { setError(e.response?.data?.error || 'Detection failed'); }
  };

  const assign = async (site, userId) => {
    setBanner('');
    try {
      await api.post(`/websites/admin/sites/${site.id}/assign`, { userId: userId === '' ? null : userId });
      setBanner(`Reassigned ${site.domain}`);
      load();
    } catch (e) { setError(e.response?.data?.error || 'Failed to assign'); }
  };

  const [confirmDeleteSite, setConfirmDeleteSite] = useState(null);
  const deleteSite = async (site) => {
    try { await api.delete(`/websites/admin/sites/${site.id}`); setConfirmDeleteSite(null); load(); }
    catch (e) { setError(e.response?.data?.error || 'Failed to delete'); }
  };

  return (
    <div className="p-6 lg:p-8 max-w-5xl mx-auto space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="aaris-display text-xl text-gray-100">Websites</h1>
          <p className="text-sm text-gray-500 mt-1">Register the external Caddy reverse proxy and manage all published sites</p>
        </div>
        <button onClick={openAdd} className="flex items-center gap-2 text-sm bg-blue-600 hover:bg-blue-500 text-white px-4 py-2.5 rounded-xl font-medium transition-colors shadow-lg shadow-blue-600/20">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" /></svg>
          Add Caddy Server
        </button>
      </div>

      <div className="text-xs text-amber-300/90 bg-amber-900/15 border border-amber-800/30 rounded-xl p-3">
        <span className="font-semibold">Secure the Caddy admin API.</span> It is unauthenticated by default. Bind it to a management VLAN Homelabrrr can reach, or front it with mTLS / a token-checking proxy. Never expose <span className="font-mono">:2019</span> to untrusted networks.
      </div>

      {error && <p className="text-red-400 text-sm bg-red-900/20 border border-red-800/30 rounded-xl p-3">{error}</p>}
      {banner && <p className="text-green-400 text-sm bg-green-900/20 border border-green-800/30 rounded-xl p-3">{banner}</p>}

      {/* ── Caddy servers ── */}
      <section className="space-y-3">
        <h2 className="text-xs uppercase tracking-wider text-gray-500 font-medium">Caddy servers</h2>
        {loading ? (
          <div className="bg-gray-900 border border-gray-800 rounded-2xl h-28 animate-pulse" />
        ) : servers.length === 0 ? (
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 text-center text-sm text-gray-500">No Caddy server registered yet.</div>
        ) : servers.map((s) => {
          const st = statuses[s.id] || {};
          return (
            <div key={s.id} className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
              <div className={`h-0.5 ${st.online ? 'bg-green-500' : st.loading ? 'bg-gray-700 animate-pulse' : 'bg-red-500'}`} />
              <div className="p-5 flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="text-white font-semibold">{s.name}</h3>
                    {st.loading ? <span className="text-[10px] text-gray-500 bg-gray-800 px-2 py-0.5 rounded-full">Checking…</span>
                      : st.online ? <span className="text-[10px] text-green-400 bg-green-500/10 ring-1 ring-green-500/20 px-2 py-0.5 rounded-full">Online</span>
                      : <span className="text-[10px] text-red-400 bg-red-500/10 ring-1 ring-red-500/20 px-2 py-0.5 rounded-full">Offline</span>}
                  </div>
                  <p className="text-xs text-gray-500 font-mono mt-0.5">{s.apiUrl}</p>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-gray-500 mt-2">
                    <span>WAN IP: <span className="font-mono text-orange-400">{s.wanIp || '—'}</span></span>
                    <span>Auth: <span className="font-mono">{s.authType}{s.hasAuth ? '' : s.authType === 'none' ? '' : ' (unset)'}</span></span>
                    <span>TLS verify: {s.verifyTls ? 'on' : 'off'}</span>
                    {s.fortigateName && <span>FortiGate: <span className="text-gray-300">{s.fortigateName}</span></span>}
                    {s.inspectionProfile && <span>Profile: <span className="font-mono text-gray-300">{s.inspectionProfile}</span></span>}
                    <span>{s.siteCount} site{s.siteCount !== 1 ? 's' : ''}</span>
                    {typeof st.managedRoutes === 'number' && <span>{st.managedRoutes} managed route{st.managedRoutes !== 1 ? 's' : ''}</span>}
                  </div>
                  {!st.online && !st.loading && st.error && <p className="text-xs text-red-400/70 bg-red-900/10 rounded-lg px-3 py-2 mt-2">{st.error}</p>}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button onClick={() => openEdit(s)} className="text-gray-500 hover:text-white p-1.5 rounded-lg hover:bg-gray-800 transition-colors" aria-label="Edit">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931z" /></svg>
                  </button>
                  <button onClick={() => remove(s.id)} className="text-gray-500 hover:text-red-400 p-1.5 rounded-lg hover:bg-red-500/10 transition-colors" aria-label="Delete">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166M18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165" /></svg>
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </section>

      {/* ── All published sites ── */}
      <section className="space-y-3">
        <h2 className="text-xs uppercase tracking-wider text-gray-500 font-medium">Published sites</h2>
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800 text-gray-500 text-xs uppercase tracking-wider">
                <th className="text-left px-4 py-3">Domain</th>
                <th className="text-left px-4 py-3">Upstream</th>
                <th className="text-left px-4 py-3">Status</th>
                <th className="text-left px-4 py-3">Owner</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {sites.length === 0 ? (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-gray-600">No sites published yet.</td></tr>
              ) : sites.map((site) => (
                <tr key={site.id} className="border-b border-gray-800 last:border-0 hover:bg-gray-800/40 transition-colors">
                  <td className="px-4 py-3">
                    <a href={site.url} target="_blank" rel="noreferrer" className="text-white hover:text-orange-400 transition-colors">{site.domain}</a>
                  </td>
                  <td className="px-4 py-3 text-gray-400 font-mono text-xs">{site.upstreamHost}:{site.upstreamPort}</td>
                  <td className="px-4 py-3"><SiteStatus status={site.status} /></td>
                  <td className="px-4 py-3">
                    <select value={site.ownerUserId || ''} onChange={(e) => assign(site, e.target.value)} className="bg-gray-800 border border-gray-700/50 rounded-lg px-2 py-1 text-xs text-white focus:outline-none focus:border-blue-500">
                      <option value="">— unassigned —</option>
                      {users.map((u) => <option key={u.id} value={u.id}>{u.username}{u.isAdmin ? ' (admin)' : ''}</option>)}
                    </select>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {confirmDeleteSite === site.id ? (
                      <span className="inline-flex gap-1">
                        <button onClick={() => deleteSite(site)} className="text-xs text-red-400 hover:text-red-300 px-2 py-1 rounded hover:bg-red-500/10">Confirm</button>
                        <button onClick={() => setConfirmDeleteSite(null)} className="text-xs text-gray-500 hover:text-gray-300 px-2 py-1 rounded hover:bg-gray-800">Cancel</button>
                      </span>
                    ) : (
                      <button onClick={() => setConfirmDeleteSite(site.id)} className="text-xs text-red-500 hover:text-red-400 px-2 py-1 rounded hover:bg-gray-700 transition-colors">Delete</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── Server form modal ── */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" onClick={(e) => { if (e.target === e.currentTarget) setShowForm(false); }}>
          <form onSubmit={save} className="w-full max-w-lg bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-700">
              <h2 className="text-white font-semibold">{editId ? 'Edit Caddy Server' : 'Add Caddy Server'}</h2>
              <button type="button" onClick={() => setShowForm(false)} className="text-gray-500 hover:text-white p-1 rounded hover:bg-gray-700 transition-colors" aria-label="Close">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
            <div className="p-5 space-y-4">
              <div>
                <label className="block text-xs text-gray-400 mb-1.5 font-medium">Name</label>
                <input type="text" required value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} className={inputCls} placeholder="Edge Caddy" />
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1.5 font-medium">Admin API URL</label>
                <input type="text" required value={form.apiUrl} onChange={(e) => setForm((f) => ({ ...f, apiUrl: e.target.value }))} className={inputCls} placeholder="http://10.0.0.5:2019" />
                <p className="text-xs text-gray-600 mt-1">The Caddy admin endpoint. Keep it on a network only Homelabrrr can reach.</p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-400 mb-1.5 font-medium">Auth type</label>
                  <select value={form.authType} onChange={(e) => setForm((f) => ({ ...f, authType: e.target.value }))} className={selectCls}>
                    <option value="none">None (network-isolated)</option>
                    <option value="bearer">Bearer token</option>
                    <option value="basic">Basic (base64 user:pass)</option>
                    <option value="header">Raw Authorization header</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-gray-400 mb-1.5 font-medium">Auth secret {editId && <span className="text-gray-600">(keep)</span>}</label>
                  <input type="password" value={form.authSecret} onChange={(e) => setForm((f) => ({ ...f, authSecret: e.target.value }))} disabled={form.authType === 'none'} className={inputCls} placeholder={form.authType === 'none' ? '—' : 'token / credentials'} />
                </div>
              </div>
              <label className="flex items-start gap-3 cursor-pointer rounded-xl border border-gray-700/50 bg-gray-800/40 px-3 py-3">
                <input type="checkbox" checked={form.verifyTls} onChange={(e) => setForm((f) => ({ ...f, verifyTls: e.target.checked }))} className="accent-blue-500 mt-0.5" />
                <div>
                  <p className="text-sm text-white">Verify TLS certificate</p>
                  <p className="text-xs text-gray-500 mt-0.5">Only relevant when the admin API URL is https://. Leave on unless the endpoint uses a self-signed cert.</p>
                </div>
              </label>
              <div>
                <label className="block text-xs text-gray-400 mb-1.5 font-medium">Caddy HTTP server name <span className="text-gray-600">(optional)</span></label>
                <input type="text" value={form.serverName} onChange={(e) => setForm((f) => ({ ...f, serverName: e.target.value }))} className={inputCls} placeholder="auto-detect (e.g. srv0)" />
              </div>

              <div className="pt-2 border-t border-gray-700/50 space-y-4">
                <p className="text-xs text-gray-500 font-medium uppercase tracking-wider">DNS validation + SSL inspection</p>
                <div>
                  <label className="block text-xs text-gray-400 mb-1.5 font-medium">FortiGate</label>
                  <select value={form.fortigateId} onChange={(e) => setForm((f) => ({ ...f, fortigateId: e.target.value }))} className={selectCls}>
                    <option value="">None</option>
                    {firewalls.map((fw) => <option key={fw.id} value={fw.id}>{fw.name}{fw.externalIp ? ` — ${fw.externalIp}` : ''}</option>)}
                  </select>
                  <p className="text-xs text-gray-600 mt-1">Used to read the WAN IP and to attach synced certs to an inspection profile.</p>
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <div className="col-span-2">
                    <label className="block text-xs text-gray-400 mb-1.5 font-medium">Homelab WAN IP</label>
                    <input type="text" value={form.wanIp} onChange={(e) => setForm((f) => ({ ...f, wanIp: e.target.value }))} className={inputCls} placeholder="203.0.113.10 (blank = use FortiGate's)" />
                  </div>
                  <div className="flex items-end">
                    <button type="button" onClick={detectWanIp} disabled={!editId || !form.fortigateId} title={editId ? 'Read from the linked FortiGate' : 'Save first, then detect'} className="w-full text-xs bg-gray-800 hover:bg-gray-700 disabled:opacity-40 text-gray-200 px-2 py-2.5 rounded-xl transition-colors">Detect</button>
                  </div>
                </div>
                <div>
                  <label className="block text-xs text-gray-400 mb-1.5 font-medium">SSL/SSH inspection profile</label>
                  {profiles.profiles.length > 0 ? (
                    <select value={form.inspectionProfile} onChange={(e) => setForm((f) => ({ ...f, inspectionProfile: e.target.value }))} className={selectCls}>
                      <option value="">None (publish only, no inspection)</option>
                      {profiles.profiles.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
                    </select>
                  ) : (
                    <input type="text" value={form.inspectionProfile} onChange={(e) => setForm((f) => ({ ...f, inspectionProfile: e.target.value }))} className={inputCls} placeholder={editId ? 'e.g. custom-deep-inspection' : 'Save + link a FortiGate to pick from a list'} />
                  )}
                  <p className="text-xs text-gray-600 mt-1">Synced Let’s Encrypt certs are attached here so inbound inspection presents the real cert.</p>
                </div>
              </div>

              {error && <p className="text-xs text-red-400 bg-red-900/20 border border-red-800/30 rounded-xl p-3">{error}</p>}
              <div className="flex gap-3 pt-1">
                <button type="button" onClick={() => setShowForm(false)} className="flex-1 bg-gray-700 hover:bg-gray-600 text-white rounded-xl py-2.5 text-sm transition-colors">Cancel</button>
                <button type="submit" disabled={saving} className="flex-1 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-xl py-2.5 text-sm font-semibold transition-colors shadow-lg shadow-blue-600/20">
                  {saving ? 'Saving…' : editId ? 'Update' : 'Add Server'}
                </button>
              </div>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

function SiteStatus({ status }) {
  const cls = {
    live: 'text-green-400 bg-green-500/10 ring-green-500/20',
    warning: 'text-amber-400 bg-amber-500/10 ring-amber-500/20',
    error: 'text-red-400 bg-red-500/10 ring-red-500/20',
  }[status] || 'text-blue-400 bg-blue-500/10 ring-blue-500/20';
  const inFlight = IN_FLIGHT.includes(status);
  return <span className={`text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full ring-1 ${cls} ${inFlight ? 'animate-pulse' : ''}`}>{status}</span>;
}
