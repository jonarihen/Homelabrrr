import { useState, useEffect, useRef } from 'react';
import Layout from '../components/Layout.jsx';
import api from '../api.js';
import useDocumentTitle from '../hooks/useDocumentTitle.js';
import { useAuth } from '../contexts/AuthContext.jsx';
import { normalizeUpstreamPort, isUpstreamDraftValid, hasUpstreamChanged } from '../utils/siteEdit.js';

const inputCls = 'w-full bg-gray-800 border border-gray-700/50 rounded-xl px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/20 transition-all';
const selectCls = inputCls;

const IN_FLIGHT = ['validating', 'pushing', 'issuing', 'inspecting', 'pending'];

export default function WebsitesPage() {
  useDocumentTitle('Websites');
  const { user } = useAuth();
  const [servers, setServers] = useState([]);
  const [sites, setSites] = useState([]);
  const [upstream, setUpstream] = useState({ isAdmin: false, vms: [], subnets: [] });
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);

  const load = async () => {
    try {
      const [cfg, s, up] = await Promise.all([
        api.get('/websites/config'),
        api.get('/websites/sites'),
        api.get('/websites/upstream-options'),
      ]);
      setServers(cfg.data.servers || []);
      setSites(s.data || []);
      setUpstream(up.data || { isAdmin: false, vms: [], subnets: [] });
    } catch { /* ignore */ }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const hasInFlight = sites.some((s) => IN_FLIGHT.includes(s.status));
  // While something is publishing, refresh the list periodically so terminal
  // transitions land even if a card unmounts.
  useEffect(() => {
    if (!hasInFlight) return;
    const t = setInterval(() => { api.get('/websites/sites').then((r) => setSites(r.data || [])).catch(() => {}); }, 4000);
    return () => clearInterval(t);
  }, [hasInFlight]);

  return (
    <Layout>
      <div className="p-6 lg:p-8 max-w-4xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="aaris-display text-xl text-gray-100">Websites</h1>
            <p className="text-sm text-gray-500 mt-1">Publish a domain through the homelab reverse proxy with an automatic Let’s Encrypt certificate</p>
          </div>
          {servers.length > 0 && !showForm && (
            <button onClick={() => setShowForm(true)} className="flex items-center gap-2 text-sm bg-blue-600 hover:bg-blue-500 text-white px-4 py-2.5 rounded-xl font-medium transition-colors shadow-lg shadow-blue-600/20">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" /></svg>
              Publish a website
            </button>
          )}
        </div>

        {loading ? (
          <div className="space-y-4">{[1, 2].map((i) => <div key={i} className="bg-gray-900 border border-gray-800 rounded-2xl h-24 animate-pulse" />)}</div>
        ) : servers.length === 0 ? (
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-8 text-center">
            <p className="text-white font-semibold">No reverse proxy configured yet</p>
            <p className="text-sm text-gray-500 mt-2">An admin needs to register a Caddy server before you can publish websites.</p>
          </div>
        ) : (
          <>
            {showForm && (
              <PublishForm
                servers={servers}
                upstream={upstream}
                isAdmin={!!user?.isAdmin}
                onClose={() => setShowForm(false)}
                onPublished={() => { setShowForm(false); load(); }}
              />
            )}

            <div className="space-y-3">
              {sites.length === 0 && !showForm && (
                <div className="bg-gray-900 border border-gray-800 rounded-2xl p-8 text-center">
                  <p className="text-gray-400 font-medium">No websites published yet</p>
                  <p className="text-sm text-gray-600 mt-1">Point a domain’s A record at the homelab WAN IP, then publish it here.</p>
                </div>
              )}
              {sites.map((site) => (
                <SiteCard key={site.id} site={site} upstream={upstream} isAdmin={!!user?.isAdmin} onChanged={load} />
              ))}
            </div>
          </>
        )}
      </div>
    </Layout>
  );
}

// ─── Publish form ──────────────────────────────────────────────────────────────

function PublishForm({ servers, upstream, isAdmin, onClose, onPublished }) {
  const [serverId, setServerId] = useState(servers[0]?.id || '');
  const [domain, setDomain] = useState('');
  const [upstreamHost, setUpstreamHost] = useState('');
  const [upstreamPort, setUpstreamPort] = useState(80);
  const [dns, setDns] = useState(null); // { ok, message }
  const [checking, setChecking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const server = servers.find((s) => String(s.id) === String(serverId));

  const checkDns = async () => {
    setError(''); setDns(null); setChecking(true);
    try {
      const r = await api.post('/websites/validate-dns', { serverId, domain });
      setDns(r.data);
    } catch (e) {
      setError(e.response?.data?.error || 'DNS check failed');
    } finally { setChecking(false); }
  };

  const submit = async (e) => {
    e.preventDefault();
    setError(''); setSubmitting(true);
    try {
      await api.post('/websites/sites', { serverId, domain, upstreamHost, upstreamPort });
      onPublished();
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to publish');
    } finally { setSubmitting(false); }
  };

  return (
    <form onSubmit={submit} className="bg-gray-900 border border-gray-800 rounded-2xl p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-white font-semibold">Publish a website</h2>
        <button type="button" onClick={onClose} className="text-gray-500 hover:text-white p-1 rounded hover:bg-gray-800 transition-colors" aria-label="Close">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
        </button>
      </div>

      {servers.length > 1 && (
        <div>
          <label className="block text-xs text-gray-400 mb-1.5 font-medium">Reverse proxy</label>
          <select value={serverId} onChange={(e) => { setServerId(e.target.value); setDns(null); }} className={selectCls}>
            {servers.map((s) => <option key={s.id} value={s.id}>{s.name}{s.wanIp ? ` — ${s.wanIp}` : ''}</option>)}
          </select>
        </div>
      )}

      <div>
        <label className="block text-xs text-gray-400 mb-1.5 font-medium">Domain</label>
        <div className="flex gap-2">
          <input type="text" required value={domain} onChange={(e) => { setDomain(e.target.value); setDns(null); }} className={inputCls} placeholder="app.example.com" />
          <button type="button" onClick={checkDns} disabled={!domain || checking} className="shrink-0 text-sm bg-gray-800 hover:bg-gray-700 disabled:opacity-40 text-gray-200 px-3 py-2.5 rounded-xl transition-colors">
            {checking ? 'Checking…' : 'Check DNS'}
          </button>
        </div>
        <p className="text-xs text-gray-600 mt-1">
          Point an A record for this domain at the homelab WAN IP{server?.wanIp ? <> — <span className="font-mono text-orange-400">{server.wanIp}</span></> : ''} before publishing.
        </p>
        {dns && (
          <p className={`text-xs mt-2 rounded-xl p-2.5 border ${dns.ok ? 'text-green-400 bg-green-900/20 border-green-800/30' : 'text-amber-400 bg-amber-900/20 border-amber-800/30'}`}>
            {dns.ok ? '✓ ' : ''}{dns.message}
            {!dns.ok && isAdmin && <span className="block mt-1 text-gray-400">As an admin you can publish anyway (wildcard DNS, Cloudflare proxying, or a record you'll create later) — the DNS step will be recorded as skipped.</span>}
          </p>
        )}
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className="col-span-2">
          <label className="block text-xs text-gray-400 mb-1.5 font-medium">Upstream host</label>
          <input type="text" required value={upstreamHost} onChange={(e) => setUpstreamHost(e.target.value)} className={inputCls} placeholder="10.11.26.5" />
        </div>
        <div>
          <label className="block text-xs text-gray-400 mb-1.5 font-medium">Port</label>
          <input type="number" min="1" max="65535" required value={upstreamPort} onChange={(e) => setUpstreamPort(parseInt(e.target.value) || 80)} className={inputCls} />
        </div>
      </div>

      {!isAdmin && (
        <div className="text-xs text-gray-500 space-y-2">
          {upstream.vms?.length > 0 && (
            <div>
              <span className="text-gray-400">Your VMs:</span>
              <div className="flex flex-wrap gap-1.5 mt-1">
                {upstream.vms.map((vm) => (
                  <button type="button" key={`${vm.node}-${vm.vmid}`} onClick={() => setUpstreamHost(vm.ip)}
                    className="font-mono text-[11px] px-2 py-1 rounded border border-gray-700 bg-gray-800 hover:border-orange-500 hover:text-orange-400 transition-colors">
                    VM {vm.vmid} · {vm.ip}
                  </button>
                ))}
              </div>
            </div>
          )}
          <p>You can only proxy to a VM assigned to you{upstream.subnets?.length ? <> or an address inside your VLAN {upstream.subnets.length > 1 ? 'subnets' : 'subnet'} <span className="font-mono text-gray-400">{upstream.subnets.join(', ')}</span></> : ''}.</p>
        </div>
      )}

      {error && <p className="text-xs text-red-400 bg-red-900/20 border border-red-800/30 rounded-xl p-3">{error}</p>}

      <div className="flex gap-3 pt-1">
        <button type="button" onClick={onClose} className="flex-1 bg-gray-700 hover:bg-gray-600 text-white rounded-xl py-2.5 text-sm transition-colors">Cancel</button>
        <button type="submit" disabled={submitting} className="flex-1 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-xl py-2.5 text-sm font-semibold transition-colors shadow-lg shadow-blue-600/20">
          {submitting ? 'Publishing…' : 'Publish'}
        </button>
      </div>
    </form>
  );
}

// ─── Site card (with live stepper) ─────────────────────────────────────────────

function SiteCard({ site: initial, upstream, isAdmin, onChanged }) {
  const [site, setSite] = useState(initial);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const timerRef = useRef(null);

  useEffect(() => { setSite(initial); }, [initial]);

  const inFlight = IN_FLIGHT.includes(site.status);
  useEffect(() => {
    if (!inFlight) return undefined;
    const tick = async () => {
      try {
        const r = await api.get(`/websites/sites/${site.id}/status`);
        setSite(r.data);
        if (IN_FLIGHT.includes(r.data.status)) timerRef.current = setTimeout(tick, 2500);
        else onChanged?.();
      } catch { timerRef.current = setTimeout(tick, 4000); }
    };
    timerRef.current = setTimeout(tick, 2500);
    return () => clearTimeout(timerRef.current);
  }, [inFlight, site.id]);

  const retry = async () => {
    setBusy(true); setError('');
    try { const r = await api.post(`/websites/sites/${site.id}/retry`); setSite(r.data); }
    catch (e) { setError(e.response?.data?.error || 'Retry failed'); }
    finally { setBusy(false); }
  };

  const remove = async () => {
    setBusy(true); setError('');
    try { await api.delete(`/websites/sites/${site.id}`); onChanged?.(); }
    catch (e) { setError(e.response?.data?.error || 'Delete failed'); setBusy(false); setConfirmDelete(false); }
  };

  const done = site.steps.filter((s) => ['done', 'skipped'].includes(s.status)).length;
  const pct = site.steps.length ? Math.round((done / site.steps.length) * 100) : 0;
  const isLive = site.status === 'live';
  const isError = site.status === 'error';
  const isWarning = site.status === 'warning';
  // `blocked` means the route is serving, but a step needs something changed on
  // the firewall before it can ever complete (today: the SSL inspection profile
  // is at its 10-certificate limit). Retry stays available — it's the right
  // action *after* freeing a slot — but the copy never implies it's the fix.
  const isBlocked = site.status === 'blocked';
  // Only a route Homelabrrr owns and actually reverse-proxies has an upstream to
  // edit: sites imported from the Caddyfile are managed there (the backend
  // rejects a PUT for them), and a file_server/static block has no upstream at
  // all. Both fields are absent on servers that predate them, which reads as
  // "an ordinary managed reverse proxy".
  const canEdit = site.managed !== false && (!site.kind || site.kind === 'reverse_proxy');

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
      <div className={`h-0.5 ${isLive ? 'bg-green-500' : isError ? 'bg-red-500' : isBlocked ? 'bg-orange-500' : isWarning ? 'bg-amber-500' : 'bg-blue-500 animate-pulse'}`} />
      <div className="p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <a href={site.url} target="_blank" rel="noreferrer" className="text-white font-semibold hover:text-orange-400 transition-colors truncate">{site.domain}</a>
              <StatusPill status={site.status} />
              {site.managed === false && <span className="text-[10px] uppercase tracking-wider text-gray-400 bg-gray-700/50 ring-1 ring-gray-600/50 px-2 py-0.5 rounded-full" title="Imported from Caddy — managed in the Caddyfile, not by Homelabrrr">imported</span>}
              {site.wildcard && <span className="text-[10px] font-mono text-purple-300 bg-purple-500/10 ring-1 ring-purple-500/20 px-2 py-0.5 rounded-full" title={`Covered by the ${site.wildcard} wildcard certificate`}>{site.wildcard}</span>}
            </div>
            <p className="text-xs text-gray-500 font-mono mt-0.5">
              {site.kind && site.kind !== 'reverse_proxy' ? site.kind : `→ ${site.upstreamHost}:${site.upstreamPort}`}
            </p>
            {site.ownerUsername && <p className="text-[10px] text-gray-600 font-mono mt-0.5">owner: {site.ownerUsername}</p>}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {(isError || isWarning || isBlocked) && (
              <button onClick={retry} disabled={busy} className="text-xs text-blue-400 hover:text-blue-300 disabled:opacity-40 px-2 py-1 rounded hover:bg-gray-800 transition-colors" title={isBlocked ? 'Re-run the pipeline once the blocker described below is cleared' : undefined}>Retry</button>
            )}
            {canEdit && !inFlight && !confirmDelete && (
              <button onClick={() => { setError(''); setEditing((v) => !v); }} disabled={busy} className={`p-1.5 rounded-lg transition-colors ${editing ? 'text-orange-400 bg-gray-800' : 'text-gray-500 hover:text-white hover:bg-gray-800'} disabled:opacity-40`} aria-label="Edit website" title="Change the upstream target">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931z" /></svg>
              </button>
            )}
            {confirmDelete ? (
              <>
                <button onClick={remove} disabled={busy} className="text-xs text-red-400 hover:text-red-300 disabled:opacity-40 px-2 py-1 rounded hover:bg-red-500/10 transition-colors">Confirm</button>
                <button onClick={() => setConfirmDelete(false)} className="text-xs text-gray-500 hover:text-gray-300 px-2 py-1 rounded hover:bg-gray-800 transition-colors">Cancel</button>
              </>
            ) : (
              <button onClick={() => setConfirmDelete(true)} disabled={busy} className="text-gray-500 hover:text-red-400 p-1.5 rounded-lg hover:bg-red-500/10 transition-colors" aria-label="Delete website">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" /></svg>
              </button>
            )}
          </div>
        </div>

        {editing && canEdit && (
          <EditUpstreamForm
            site={site}
            upstream={upstream}
            isAdmin={isAdmin}
            onCancel={() => setEditing(false)}
            onSaved={(updated) => { setEditing(false); setSite(updated); onChanged?.(); }}
          />
        )}

        {/* Stepper (shown until fully live) */}
        {!isLive && (
          <div className="mt-4">
            <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden mb-3">
              <div className={`h-full transition-all duration-500 ${isError ? 'bg-red-500' : isBlocked ? 'bg-orange-500' : isWarning ? 'bg-amber-500' : 'bg-blue-500'}`} style={{ width: `${pct}%` }} />
            </div>
            <ol className="space-y-1">
              {site.steps.map((s) => (
                <li key={s.key} className="flex items-start gap-3 py-1">
                  <StepIcon status={s.status} />
                  <div className="min-w-0">
                    <p className={`text-sm ${s.status === 'active' ? 'text-white font-medium' : s.status === 'done' ? 'text-gray-300' : s.status === 'error' ? 'text-red-400' : s.status === 'blocked' ? 'text-orange-400' : 'text-gray-500'}`}>{s.label}</p>
                    {s.note && <p className={`text-xs mt-0.5 ${s.status === 'blocked' ? 'text-orange-300/90' : 'text-amber-400/80'}`}>{s.note}</p>}
                  </div>
                </li>
              ))}
            </ol>
          </div>
        )}

        {(isWarning || isError || isBlocked) && site.statusDetail && (
          <p className={`text-xs mt-4 rounded-xl p-3 border ${isError ? 'text-red-400 bg-red-900/20 border-red-800/30' : isBlocked ? 'text-orange-300 bg-orange-900/20 border-orange-800/30' : 'text-amber-400 bg-amber-900/20 border-amber-800/30'}`}>{site.statusDetail}</p>
        )}
        {error && <p className="text-xs text-red-400 mt-3">{error}</p>}
      </div>
    </div>
  );
}

// ─── Edit a published site (upstream target only) ──────────────────────────────

function EditUpstreamForm({ site, upstream, isAdmin, onCancel, onSaved }) {
  const [host, setHost] = useState(site.upstreamHost);
  const [port, setPort] = useState(String(site.upstreamPort));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const draft = { upstreamHost: host, upstreamPort: port };
  const canSave = isUpstreamDraftValid(draft) && hasUpstreamChanged(site, draft);

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true); setError('');
    try {
      const r = await api.put(`/websites/sites/${site.id}`, {
        upstreamHost: host.trim(),
        upstreamPort: normalizeUpstreamPort(port),
      });
      onSaved(r.data);
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to save');
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="mt-4 rounded-xl border border-gray-800 bg-gray-950/40 p-4 space-y-3">
      <p className="text-xs text-gray-500">
        Editing <span className="font-mono text-gray-300">{site.domain}</span>. The domain itself is fixed — it is the certificate’s subject — so publishing under a different name still means deleting this site and publishing the new one.
      </p>
      <div className="grid grid-cols-3 gap-3">
        <div className="col-span-2">
          <label className="block text-xs text-gray-400 mb-1.5 font-medium">Upstream host</label>
          <input type="text" required value={host} onChange={(e) => setHost(e.target.value)} className={inputCls} placeholder="10.11.26.5" />
        </div>
        <div>
          <label className="block text-xs text-gray-400 mb-1.5 font-medium">Port</label>
          <input type="number" min="1" max="65535" required value={port} onChange={(e) => setPort(e.target.value)} className={inputCls} />
        </div>
      </div>

      {!isAdmin && upstream?.vms?.length > 0 && (
        <div className="text-xs text-gray-500">
          <span className="text-gray-400">Your VMs:</span>
          <div className="flex flex-wrap gap-1.5 mt-1">
            {upstream.vms.map((vm) => (
              <button type="button" key={`${vm.node}-${vm.vmid}`} onClick={() => setHost(vm.ip)}
                className="font-mono text-[11px] px-2 py-1 rounded border border-gray-700 bg-gray-800 hover:border-orange-500 hover:text-orange-400 transition-colors">
                VM {vm.vmid} · {vm.ip}
              </button>
            ))}
          </div>
        </div>
      )}

      <p className="text-xs text-gray-600">Saving re-pushes the route to Caddy — the site goes back through the publish steps for a moment.</p>
      {error && <p className="text-xs text-red-400 bg-red-900/20 border border-red-800/30 rounded-xl p-3">{error}</p>}

      <div className="flex gap-3">
        <button type="button" onClick={onCancel} className="flex-1 bg-gray-700 hover:bg-gray-600 text-white rounded-xl py-2 text-sm transition-colors">Cancel</button>
        <button type="submit" disabled={saving || !canSave} className="flex-1 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-xl py-2 text-sm font-semibold transition-colors">
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </form>
  );
}

function StatusPill({ status }) {
  const cls = {
    live: 'bg-green-500/10 text-green-400 ring-green-500/20',
    warning: 'bg-amber-500/10 text-amber-400 ring-amber-500/20',
    blocked: 'bg-orange-500/10 text-orange-400 ring-orange-500/20',
    error: 'bg-red-500/10 text-red-400 ring-red-500/20',
  }[status] || 'bg-blue-500/10 text-blue-400 ring-blue-500/20';
  const inFlight = IN_FLIGHT.includes(status);
  return (
    <span className={`text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full ring-1 ${cls}`}>
      {inFlight ? <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />{status}</span> : status}
    </span>
  );
}

function StepIcon({ status }) {
  if (status === 'done') return <span className="mt-0.5 w-5 h-5 rounded-full bg-green-500/15 flex items-center justify-center shrink-0"><svg className="w-3 h-3 text-green-400" fill="none" stroke="currentColor" strokeWidth="3" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg></span>;
  if (status === 'active') return <span className="mt-0.5 w-5 h-5 flex items-center justify-center shrink-0"><span className="w-4 h-4 border-2 border-blue-400/30 border-t-blue-400 rounded-full animate-spin" /></span>;
  if (status === 'error') return <span className="mt-0.5 w-5 h-5 rounded-full bg-red-500/15 flex items-center justify-center shrink-0"><svg className="w-3 h-3 text-red-400" fill="none" stroke="currentColor" strokeWidth="3" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg></span>;
  // Blocked reads as "waiting on the operator", not as a failure to retry.
  if (status === 'blocked') return <span className="mt-0.5 w-5 h-5 rounded-full bg-orange-500/15 flex items-center justify-center shrink-0"><svg className="w-3 h-3 text-orange-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75M3.75 21.75h16.5a.75.75 0 00.75-.75v-8.25a.75.75 0 00-.75-.75H3.75a.75.75 0 00-.75.75V21a.75.75 0 00.75.75z" /></svg></span>;
  if (status === 'skipped') return <span className="mt-0.5 w-5 h-5 rounded-full bg-gray-700/40 flex items-center justify-center shrink-0"><svg className="w-3 h-3 text-gray-500" fill="none" stroke="currentColor" strokeWidth="3" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14" /></svg></span>;
  return <span className="mt-0.5 w-5 h-5 flex items-center justify-center shrink-0"><span className="w-2 h-2 rounded-full bg-gray-700" /></span>;
}
