import { useState, useEffect, useCallback, useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import Layout from '../components/Layout.jsx';
import useDocumentTitle from '../hooks/useDocumentTitle.js';
import { useAuth } from '../contexts/AuthContext.jsx';
import api from '../api.js';
import { routeNode } from '../utils/nodeRef.js';

const OVERALL_STATES = {
  operational: { led: 'aaris-led--ok aaris-led--pulse', text: 'text-green-400', label: 'All systems operational' },
  degraded: { led: 'aaris-led--warning aaris-led--pulse', text: 'text-amber-400', label: 'Degraded' },
  down: { led: 'aaris-led--error aaris-led--pulse', text: 'text-red-400', label: 'Major outage' },
  unknown: { led: 'aaris-led--off', text: 'text-gray-500', label: 'No hypervisors registered' },
};

const NOTICE_LEVELS = {
  info: { label: 'Info', tag: 'border-gray-700 text-gray-400', accent: 'border-l-gray-600' },
  maintenance: { label: 'Maintenance', tag: 'border-amber-500/40 text-amber-400', accent: 'border-l-amber-500' },
  warning: { label: 'Warning', tag: 'border-red-500/40 text-red-400', accent: 'border-l-red-500' },
};

const EMPTY_NOTICE = { title: '', body: '', level: 'info' };

// Setup-status rows: missing (red) first, then warn (amber), then ok.
const READINESS_STATES = {
  missing: { led: 'aaris-led--error', tag: 'border-red-500/40 text-red-400', label: 'Missing', rank: 2 },
  warn: { led: 'aaris-led--warning', tag: 'border-amber-500/40 text-amber-400', label: 'Check', rank: 1 },
  ok: { led: 'aaris-led--ok', tag: 'border-green-500/40 text-green-400', label: 'OK', rank: 0 },
};

export default function WelcomePage() {
  useDocumentTitle('Welcome');
  const { user } = useAuth();
  const navigate = useNavigate();
  const isAdmin = !!user?.isAdmin;

  const [status, setStatus] = useState(null);
  const [statusError, setStatusError] = useState('');
  const [vms, setVms] = useState([]);
  const [vmsError, setVmsError] = useState('');
  const [notices, setNotices] = useState([]);
  const [links, setLinks] = useState([]);
  const [loading, setLoading] = useState(true);

  // Setup status (admin only) — the prerequisite chain behind each feature.
  const [readiness, setReadiness] = useState(null);
  const [readinessError, setReadinessError] = useState('');
  const [showAllChecks, setShowAllChecks] = useState(false);

  // Notice admin form
  const [noticeForm, setNoticeForm] = useState(null); // null = closed, {id?} = editing
  const [noticeSaving, setNoticeSaving] = useState(false);
  const [noticeError, setNoticeError] = useState('');

  // Link admin form
  const [linkForm, setLinkForm] = useState(null);
  const [linkSaving, setLinkSaving] = useState(false);
  const [linkError, setLinkError] = useState('');

  const loadStatus = useCallback(async () => {
    try {
      const r = await api.get('/portal/status');
      setStatus(r.data);
      setStatusError('');
    } catch (e) {
      setStatusError(e.response?.data?.error || 'Failed to load system status');
    }
  }, []);

  const loadVms = useCallback(async () => {
    try {
      const r = await api.get('/vms');
      setVms(r.data);
      setVmsError('');
    } catch (e) {
      setVmsError(e.response?.data?.error || 'Failed to load VMs');
    }
  }, []);

  const loadNotices = useCallback(async () => {
    try {
      const r = await api.get('/portal/notices', { params: isAdmin ? { all: 1 } : {} });
      setNotices(r.data);
    } catch { /* non-fatal */ }
  }, [isAdmin]);

  const loadLinks = useCallback(async () => {
    try {
      const r = await api.get('/portal/links');
      setLinks(r.data);
    } catch { /* non-fatal */ }
  }, []);

  const loadReadiness = useCallback(async () => {
    if (!isAdmin) return;
    try {
      const r = await api.get('/admin/readiness');
      setReadiness(r.data);
      setReadinessError('');
    } catch (e) {
      setReadinessError(e.response?.data?.error || 'Failed to load setup status');
    }
  }, [isAdmin]);

  useEffect(() => {
    Promise.allSettled([loadStatus(), loadVms(), loadNotices(), loadLinks(), loadReadiness()])
      .then(() => setLoading(false));
    const interval = setInterval(() => { loadStatus(); loadVms(); }, 30000);
    return () => clearInterval(interval);
  }, [loadStatus, loadVms, loadNotices, loadLinks, loadReadiness]);

  const running = vms.filter(v => v.status === 'running').length;
  const stopped = vms.length - running;

  const vmList = useMemo(() => {
    const sorted = [...vms].sort((a, b) => {
      if ((a.status === 'running') !== (b.status === 'running')) {
        return a.status === 'running' ? -1 : 1;
      }
      return (a.name || '').localeCompare(b.name || '');
    });
    return sorted.slice(0, 8);
  }, [vms]);

  // Actionable rows first; the ok rows are collapsed behind a toggle so a
  // healthy install shows one green line instead of a wall of green.
  const checks = useMemo(() => {
    const all = readiness?.checks || [];
    return [...all].sort((a, b) =>
      (READINESS_STATES[b.status]?.rank ?? 0) - (READINESS_STATES[a.status]?.rank ?? 0));
  }, [readiness]);
  const openChecks = checks.filter(c => c.status !== 'ok');
  const visibleChecks = showAllChecks ? checks : openChecks;

  const saveNotice = async () => {
    if (!noticeForm?.title.trim()) {
      setNoticeError('Title is required');
      return;
    }
    setNoticeSaving(true);
    setNoticeError('');
    try {
      if (noticeForm.id) {
        await api.put(`/portal/notices/${noticeForm.id}`, {
          title: noticeForm.title, body: noticeForm.body, level: noticeForm.level,
        });
      } else {
        await api.post('/portal/notices', noticeForm);
      }
      setNoticeForm(null);
      loadNotices();
    } catch (e) {
      setNoticeError(e.response?.data?.error || 'Failed to save notice');
    } finally {
      setNoticeSaving(false);
    }
  };

  const toggleNotice = async (notice) => {
    try {
      await api.put(`/portal/notices/${notice.id}`, { active: !notice.active });
      loadNotices();
    } catch (e) {
      setNoticeError(e.response?.data?.error || 'Failed to update notice');
    }
  };

  const deleteNotice = async (notice) => {
    if (!window.confirm(`Delete notice "${notice.title}"?`)) return;
    try {
      await api.delete(`/portal/notices/${notice.id}`);
      loadNotices();
    } catch (e) {
      setNoticeError(e.response?.data?.error || 'Failed to delete notice');
    }
  };

  const saveLink = async () => {
    if (!linkForm?.label.trim() || !linkForm?.url.trim()) {
      setLinkError('Label and URL are required');
      return;
    }
    setLinkSaving(true);
    setLinkError('');
    try {
      await api.post('/portal/links', linkForm);
      setLinkForm(null);
      loadLinks();
    } catch (e) {
      setLinkError(e.response?.data?.error || 'Failed to save link');
    } finally {
      setLinkSaving(false);
    }
  };

  const deleteLink = async (link) => {
    if (!window.confirm(`Remove link "${link.label}"?`)) return;
    try {
      await api.delete(`/portal/links/${link.id}`);
      loadLinks();
    } catch (e) {
      setLinkError(e.response?.data?.error || 'Failed to delete link');
    }
  };

  const overall = OVERALL_STATES[status?.overall] || OVERALL_STATES.unknown;
  const today = new Date().toISOString().slice(0, 10);

  return (
    <Layout>
      <div className="p-6 lg:p-8 max-w-6xl">
        {/* Header */}
        <div className="mb-6">
          <div className="flex items-baseline gap-3">
            <span className="font-mono text-xs font-semibold text-orange-600 tracking-[0.12em]">00</span>
            <h1 className="aaris-display text-xl text-gray-100">Welcome, {user?.username}</h1>
          </div>
          <div className="flex items-center gap-4 mt-2 font-mono text-[11px] uppercase tracking-[0.1em]">
            <span className="text-gray-500">{today}</span>
            {status && (
              <span className={`flex items-center gap-1.5 ${overall.text}`}>
                <span className={`aaris-led ${overall.led}`} />
                {overall.label}
              </span>
            )}
          </div>
        </div>

        {loading ? (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
            {[1, 2, 3].map(i => (
              <div key={i} className="bg-gray-900 border border-gray-800 p-5 h-40 animate-pulse" />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 items-start">
            {/* Left column: status + notices */}
            <div className="lg:col-span-2 space-y-5">
              {/* System status */}
              <Panel label="System status">
                {statusError ? (
                  <p className="text-sm text-red-400 px-4 py-3">{statusError}</p>
                ) : (
                  <>
                    <div className="flex items-center justify-between px-4 py-3">
                      <span className={`flex items-center gap-2.5 font-mono text-xs uppercase tracking-[0.1em] ${overall.text}`}>
                        <span className={`aaris-led ${overall.led}`} />
                        {status?.overall === 'degraded'
                          ? `Degraded — ${status.hostsTotal - status.hostsOnline} of ${status.hostsTotal} hypervisors unreachable`
                          : overall.label}
                      </span>
                      <span className="font-mono text-[11px] uppercase tracking-[0.1em] text-gray-500">
                        Hypervisors {status?.hostsOnline ?? 0}/{status?.hostsTotal ?? 0} online
                      </span>
                    </div>

                    {/* Cluster-wide resource usage — visible to every user */}
                    {status?.usage && (
                      <div className="border-t border-gray-800 px-4 py-3 space-y-2.5">
                        <Meter
                          label="CPU"
                          pct={status.usage.cpuPct}
                          detail={`${status.usage.totalCores} cores`}
                        />
                        <Meter
                          label="Memory"
                          pct={status.usage.memPct}
                          detail={`${fmtBytes(status.usage.memUsed)} / ${fmtBytes(status.usage.memTotal)}`}
                        />
                      </div>
                    )}

                    {/* Node maintenance — amber, shown to every user. A drained
                        node is "maintenance", never a red "down"/"degraded" state. */}
                    {status?.maintenance?.length > 0 && (
                      <div className="border-t border-gray-800 px-4 py-3 space-y-2">
                        {status.maintenance.map(m => (
                          <div key={m.id} className="flex items-center gap-2.5 flex-wrap">
                            <span className="aaris-led aaris-led--warning" />
                            <span className="border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.12em] border-amber-500/40 text-amber-400">
                              Maintenance
                            </span>
                            <span className="font-mono text-xs text-gray-200 uppercase tracking-[0.08em]">{m.node}</span>
                            {m.untilLabel && (
                              <span className="font-mono text-[10px] text-gray-500 uppercase tracking-[0.1em]">until ~{m.untilLabel}</span>
                            )}
                            {m.reason && <span className="text-xs text-gray-500 truncate">— {m.reason}</span>}
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Admin-only: per-host breakdown + fleet totals */}
                    {isAdmin && status?.hosts?.length > 0 && (
                      <div className="border-t border-gray-800">
                        {status.hosts.map(h => (
                          <div key={h.id} className="flex items-center gap-3 px-4 py-2.5 border-b border-gray-800/60 last:border-b-0">
                            <span className={`aaris-led ${h.online ? 'aaris-led--ok' : 'aaris-led--error'}`} />
                            <span className="font-mono text-xs text-gray-200 uppercase tracking-[0.08em]">{h.name}</span>
                            {h.online ? (
                              <>
                                <span className="font-mono text-[10px] text-gray-500 uppercase tracking-[0.1em]">PVE {h.version}</span>
                                <span className="ml-auto font-mono text-[11px] text-gray-400 uppercase tracking-[0.1em]">
                                  <span className="text-green-400">{h.runningVms}</span>/{h.vmCount} VMs running
                                </span>
                              </>
                            ) : (
                              <span className="ml-auto font-mono text-[11px] text-red-400 uppercase tracking-[0.1em]">Unreachable</span>
                            )}
                          </div>
                        ))}
                        <div className="flex items-center gap-4 px-4 py-2.5 bg-gray-950/40 font-mono text-[11px] uppercase tracking-[0.1em] text-gray-500">
                          <span>Fleet total</span>
                          <span className="text-green-400">{status.runningVms} running</span>
                          <span>{status.totalVms} VMs</span>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </Panel>

              {/* Setup status — the prerequisite chain behind each feature.
                  Admin only: it names env vars and cross-domain infra state. */}
              {isAdmin && (readiness || readinessError) && (
                <Panel
                  label="Setup status"
                  action={readiness && checks.length > 0 && (
                    <PanelButton onClick={() => setShowAllChecks(v => !v)}>
                      {showAllChecks ? 'Only issues' : `All ${checks.length}`}
                    </PanelButton>
                  )}
                >
                  {readinessError ? (
                    <p className="text-sm text-red-400 px-4 py-3">{readinessError}</p>
                  ) : (
                    <>
                      <div className="flex items-center gap-4 px-4 py-2.5 border-b border-gray-800 font-mono text-[11px] uppercase tracking-[0.1em]">
                        {readiness.summary.missing > 0 && (
                          <span className="flex items-center gap-1.5 text-red-400">
                            <span className="aaris-led aaris-led--error" />{readiness.summary.missing} missing
                          </span>
                        )}
                        {readiness.summary.warn > 0 && (
                          <span className="flex items-center gap-1.5 text-amber-400">
                            <span className="aaris-led aaris-led--warning" />{readiness.summary.warn} to check
                          </span>
                        )}
                        <span className="flex items-center gap-1.5 text-gray-500">
                          <span className="aaris-led aaris-led--ok" />{readiness.summary.ok} of {readiness.summary.total} OK
                        </span>
                      </div>

                      {visibleChecks.length === 0 ? (
                        <p className="px-4 py-4 font-mono text-[11px] uppercase tracking-[0.1em] text-gray-600">
                          Every prerequisite is satisfied — nothing is waiting on setup.
                        </p>
                      ) : (
                        visibleChecks.map(check => {
                          const state = READINESS_STATES[check.status] || READINESS_STATES.ok;
                          return (
                            <div key={check.id} className="flex items-start gap-2.5 px-4 py-2.5 border-b border-gray-800/60 last:border-b-0">
                              <span className={`aaris-led ${state.led} mt-1.5 shrink-0`} />
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className="font-mono text-xs text-gray-200 uppercase tracking-[0.08em]">{check.label}</span>
                                  <span className={`border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.12em] ${state.tag}`}>
                                    {state.label}
                                  </span>
                                </div>
                                <p className="text-xs text-gray-500 mt-0.5">{check.detail}</p>
                              </div>
                              {check.href && (
                                <Link
                                  to={check.href}
                                  className="shrink-0 font-mono text-[10px] uppercase tracking-[0.1em] text-gray-500 hover:text-orange-500 transition-colors"
                                >
                                  Fix →
                                </Link>
                              )}
                            </div>
                          );
                        })
                      )}
                    </>
                  )}
                </Panel>
              )}

              {/* Notices */}
              <Panel
                label="Notices"
                action={isAdmin && !noticeForm && (
                  <PanelButton onClick={() => { setNoticeForm({ ...EMPTY_NOTICE }); setNoticeError(''); }}>
                    + New notice
                  </PanelButton>
                )}
              >
                {noticeError && <p className="text-sm text-red-400 px-4 pt-3">{noticeError}</p>}

                {isAdmin && noticeForm && (
                  <div className="px-4 py-3 border-b border-gray-800 space-y-2.5">
                    <div className="flex gap-2.5">
                      <select
                        value={noticeForm.level}
                        onChange={(e) => setNoticeForm({ ...noticeForm, level: e.target.value })}
                        className="bg-gray-950 border border-gray-700 px-2 py-1.5 font-mono text-[11px] uppercase tracking-[0.08em] text-gray-300 focus:outline-none focus:border-orange-600"
                      >
                        {Object.entries(NOTICE_LEVELS).map(([value, l]) => (
                          <option key={value} value={value}>{l.label}</option>
                        ))}
                      </select>
                      <input
                        type="text"
                        value={noticeForm.title}
                        onChange={(e) => setNoticeForm({ ...noticeForm, title: e.target.value })}
                        placeholder="Title — e.g. Maintenance Saturday 20:00"
                        className="flex-1 bg-gray-950 border border-gray-700 px-3 py-1.5 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:border-orange-600"
                      />
                    </div>
                    <textarea
                      value={noticeForm.body}
                      onChange={(e) => setNoticeForm({ ...noticeForm, body: e.target.value })}
                      placeholder="Details (optional)"
                      rows={2}
                      className="w-full bg-gray-950 border border-gray-700 px-3 py-1.5 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:border-orange-600 resize-y"
                    />
                    <div className="flex gap-2">
                      <PanelButton primary disabled={noticeSaving} onClick={saveNotice}>
                        {noticeForm.id ? 'Save' : 'Publish'}
                      </PanelButton>
                      <PanelButton onClick={() => { setNoticeForm(null); setNoticeError(''); }}>Cancel</PanelButton>
                    </div>
                  </div>
                )}

                {notices.length === 0 ? (
                  <p className="px-4 py-4 font-mono text-[11px] uppercase tracking-[0.1em] text-gray-600">
                    No notices — nothing planned, nothing broken.
                  </p>
                ) : (
                  notices.map(n => {
                    const level = NOTICE_LEVELS[n.level] || NOTICE_LEVELS.info;
                    return (
                      <div
                        key={n.id}
                        className={`px-4 py-3 border-l-2 ${level.accent} border-b border-gray-800/60 last:border-b-0 ${!n.active ? 'opacity-40' : ''}`}
                      >
                        <div className="flex items-center gap-2.5 flex-wrap">
                          <span className={`border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.12em] ${level.tag}`}>
                            {level.label}
                          </span>
                          <span className="text-sm font-medium text-gray-100">{n.title}</span>
                          <span className="ml-auto font-mono text-[10px] uppercase tracking-[0.1em] text-gray-600">
                            {(n.created_at || '').slice(0, 10)}
                          </span>
                        </div>
                        {n.body && <p className="text-sm text-gray-400 mt-1.5 whitespace-pre-wrap">{n.body}</p>}
                        {isAdmin && n.source === 'node_maintenance' ? (
                          <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.1em] text-gray-600">
                            Auto-managed — closes when the node leaves maintenance (PVE Hosts)
                          </p>
                        ) : isAdmin && (
                          <div className="flex gap-3 mt-2 font-mono text-[10px] uppercase tracking-[0.1em]">
                            <button onClick={() => { setNoticeForm({ id: n.id, title: n.title, body: n.body, level: n.level }); setNoticeError(''); }} className="text-gray-500 hover:text-gray-200 transition-colors">Edit</button>
                            <button onClick={() => toggleNotice(n)} className="text-gray-500 hover:text-gray-200 transition-colors">
                              {n.active ? 'Deactivate' : 'Activate'}
                            </button>
                            <button onClick={() => deleteNotice(n)} className="text-gray-500 hover:text-red-400 transition-colors">Delete</button>
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </Panel>
            </div>

            {/* Right column: your VMs + links */}
            <div className="space-y-5">
              {/* Your VMs */}
              <Panel label="Your VMs">
                {vmsError ? (
                  <p className="text-sm text-red-400 px-4 py-3">{vmsError}</p>
                ) : (
                  <>
                    <div className="grid grid-cols-3 border-b border-gray-800">
                      <Stat value={vms.length} label="Total" />
                      <Stat value={running} label="Running" valueClass="text-green-400" />
                      <Stat value={stopped} label="Stopped" valueClass="text-gray-500" />
                    </div>
                    {vmList.length === 0 ? (
                      <p className="px-4 py-4 font-mono text-[11px] uppercase tracking-[0.1em] text-gray-600">
                        No VMs assigned — contact an admin.
                      </p>
                    ) : (
                      <>
                        {vmList.map(vm => (
                          <button
                            key={`${vm.node}-${vm.vmid}`}
                            onClick={() => navigate(`/vm/${routeNode(vm)}/${vm.vmid}`)}
                            className="w-full flex items-center gap-2.5 px-4 py-2.5 border-b border-gray-800/60 last:border-b-0 text-left hover:bg-gray-800/60 transition-colors group"
                          >
                            <span className={`aaris-led ${vm.status === 'running' ? 'aaris-led--ok' : vm.status === 'error' ? 'aaris-led--error' : 'aaris-led--off'}`} />
                            <span className="text-sm text-gray-200 truncate group-hover:text-gray-100">{vm.name || `VM ${vm.vmid}`}</span>
                            <span className="ml-auto font-mono text-[10px] uppercase tracking-[0.1em] text-gray-600">{vm.vmid}</span>
                          </button>
                        ))}
                        {vms.length > vmList.length && (
                          <p className="px-4 py-2 font-mono text-[10px] uppercase tracking-[0.1em] text-gray-600">
                            +{vms.length - vmList.length} more
                          </p>
                        )}
                      </>
                    )}
                    <Link
                      to="/dashboard"
                      className="block px-4 py-2.5 border-t border-gray-800 font-mono text-[11px] uppercase tracking-[0.1em] text-gray-400 hover:text-orange-500 hover:bg-gray-800/60 transition-colors"
                    >
                      All VMs →
                    </Link>
                  </>
                )}
              </Panel>

              {/* Useful links */}
              <Panel
                label="Uplinks"
                action={isAdmin && !linkForm && (
                  <PanelButton onClick={() => { setLinkForm({ label: '', url: '', description: '' }); setLinkError(''); }}>
                    + Add
                  </PanelButton>
                )}
              >
                {linkError && <p className="text-sm text-red-400 px-4 pt-3">{linkError}</p>}

                {isAdmin && linkForm && (
                  <div className="px-4 py-3 border-b border-gray-800 space-y-2.5">
                    <input
                      type="text"
                      value={linkForm.label}
                      onChange={(e) => setLinkForm({ ...linkForm, label: e.target.value })}
                      placeholder="Label — e.g. Wiki"
                      className="w-full bg-gray-950 border border-gray-700 px-3 py-1.5 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:border-orange-600"
                    />
                    <input
                      type="text"
                      value={linkForm.url}
                      onChange={(e) => setLinkForm({ ...linkForm, url: e.target.value })}
                      placeholder="https://…"
                      className="w-full bg-gray-950 border border-gray-700 px-3 py-1.5 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:border-orange-600"
                    />
                    <input
                      type="text"
                      value={linkForm.description}
                      onChange={(e) => setLinkForm({ ...linkForm, description: e.target.value })}
                      placeholder="Description (optional)"
                      className="w-full bg-gray-950 border border-gray-700 px-3 py-1.5 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:border-orange-600"
                    />
                    <div className="flex gap-2">
                      <PanelButton primary disabled={linkSaving} onClick={saveLink}>Add</PanelButton>
                      <PanelButton onClick={() => { setLinkForm(null); setLinkError(''); }}>Cancel</PanelButton>
                    </div>
                  </div>
                )}

                {links.length === 0 ? (
                  <p className="px-4 py-4 font-mono text-[11px] uppercase tracking-[0.1em] text-gray-600">
                    No links yet.
                  </p>
                ) : (
                  links.map(link => (
                    <div key={link.id} className="group flex items-center border-b border-gray-800/60 last:border-b-0">
                      <a
                        href={link.url}
                        target="_blank"
                        rel="noreferrer"
                        className="flex-1 min-w-0 px-4 py-2.5 hover:bg-gray-800/60 transition-colors"
                      >
                        <span className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.08em] text-gray-300 group-hover:text-gray-100">
                          {link.label}
                          <span className="text-gray-600 group-hover:text-orange-500 transition-colors">↗</span>
                        </span>
                        <span className="block font-mono text-[10px] tracking-[0.02em] text-gray-600 truncate">
                          {link.description || link.url}
                        </span>
                      </a>
                      {isAdmin && (
                        <button
                          onClick={() => deleteLink(link)}
                          title="Remove link"
                          className="px-3 py-2.5 font-mono text-[10px] uppercase tracking-[0.1em] text-gray-700 hover:text-red-400 transition-colors"
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  ))
                )}
              </Panel>
            </div>
          </div>
        )}
      </div>
    </Layout>
  );
}

function Panel({ label, action, children }) {
  return (
    <section className="bg-gray-900 border border-gray-800">
      <div className="flex items-center justify-between px-4 py-2 border-b border-gray-800">
        <h2 className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-gray-500">{label}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function PanelButton({ primary, disabled, onClick, children }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`font-mono text-[10px] font-semibold uppercase tracking-[0.12em] px-2.5 py-1 border transition-colors disabled:opacity-50 ${
        primary
          ? 'text-gray-950 bg-orange-600 border-orange-600 hover:bg-orange-500 hover:border-orange-500'
          : 'text-gray-400 border-gray-700 hover:text-gray-100 hover:bg-gray-800'
      }`}
    >
      {children}
    </button>
  );
}

function fmtBytes(bytes) {
  if (!bytes) return '0';
  const gb = bytes / 1024 / 1024 / 1024;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

// Utilization meter: status color by load, but the value is always printed —
// state is never conveyed by color alone.
function Meter({ label, pct, detail }) {
  const clamped = Math.max(0, Math.min(100, pct || 0));
  const fill = clamped >= 90 ? 'bg-red-400' : clamped >= 70 ? 'bg-amber-400' : 'bg-green-400';
  return (
    <div className="flex items-center gap-3">
      <span className="w-14 shrink-0 font-mono text-[10px] uppercase tracking-[0.12em] text-gray-500">{label}</span>
      <div
        className="flex-1 h-1.5 bg-gray-800"
        role="meter"
        aria-valuenow={Math.round(clamped)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${label} usage`}
      >
        <div className={`h-full ${fill}`} style={{ width: `${clamped}%` }} />
      </div>
      <span className="w-12 shrink-0 text-right font-mono text-xs text-gray-200">{clamped.toFixed(0)}%</span>
      <span className="w-28 shrink-0 text-right font-mono text-[10px] uppercase tracking-[0.08em] text-gray-600">{detail}</span>
    </div>
  );
}

function Stat({ value, label, valueClass = 'text-gray-100' }) {
  return (
    <div className="px-4 py-3 border-r border-gray-800 last:border-r-0">
      <p className={`font-mono text-lg font-semibold ${valueClass}`}>{value}</p>
      <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-gray-600">{label}</p>
    </div>
  );
}
