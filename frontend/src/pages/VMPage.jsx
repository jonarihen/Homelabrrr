import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import Layout from '../components/Layout.jsx';
import StatusBadge from '../components/StatusBadge.jsx';
import LeaseBadge from '../components/LeaseBadge.jsx';
import VLANModal from '../components/VLANModal.jsx';
import VMHardwareModal from '../components/VMHardwareModal.jsx';
import VMScheduleModal from '../components/VMScheduleModal.jsx';
import VMIPManagementPanel from '../components/VMIPManagementPanel.jsx';
import useDocumentTitle from '../hooks/useDocumentTitle.js';
import useSSHConfig from '../hooks/useSSHConfig.js';
import { useConsoleSessions } from '../contexts/ConsoleSessionsContext.jsx';
import { useAuth } from '../contexts/AuthContext.jsx';
import api from '../api.js';
import { displayNode, routeNode } from '../utils/nodeRef.js';
import { sleepLabel, describeDays } from '../utils/schedule.js';
import { useConfirm } from '../contexts/FeedbackContext.jsx';
import { bootDiskKeys } from '../utils/diskLabel.js';
import { fmt, fmtRate, fmtUptime } from './vm/format.js';
import { MiniChart, ProgressBar, StatCard, MiniStat, SectionLabel, Divider, ActionBtn, InputField } from './vm/widgets.jsx';
import CloudInitCredentialsModal from './vm/CloudInitCredentialsModal.jsx';
import DeleteVMModal from './vm/DeleteVMModal.jsx';
import SnapshotsSection from './vm/SnapshotsSection.jsx';
import BackupsSection from './vm/BackupsSection.jsx';

// ── Page ─────────────────────────────────────────────────────────────────────

export default function VMPage() {
  const { node, vmid } = useParams();
  const navigate = useNavigate();

  const [vm, setVm] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionLoading, setActionLoading] = useState(false);
  const [pendingAction, setPendingAction] = useState('');
  const [actionError, setActionError] = useState('');
  const confirm = useConfirm();

  const [rrd, setRrd] = useState(null);
  const [rrdLoading, setRrdLoading] = useState(true);
  const [timeframe, setTimeframe] = useState('hour');
  const { openSshSession, openVncSession } = useConsoleSessions();

  const { sshCfg, setSshCfg, sshSaved, sshSavingError, scanningFingerprint, saveSshConfig, scanSshFingerprint } = useSSHConfig(node, vmid);

  const [disks, setDisks] = useState([]);
  const [vlanModal, setVlanModal] = useState(false);
  const [hardwareModal, setHardwareModal] = useState(false);
  const [scheduleModal, setScheduleModal] = useState(false);
  const [schedule, setSchedule] = useState(null);
  const [deleteModal, setDeleteModal] = useState(false);
  const [credModal, setCredModal] = useState(false);
  const [cloudInit, setCloudInit] = useState({ canReset: false, ciuser: '' });
  const [detectedIp, setDetectedIp] = useState('');
  const [ipCopied, setIpCopied] = useState(false);
  const stickyRef = useRef(null);
  const { user } = useAuth();
  const canEditHw = !!(user?.isAdmin || user?.permissions?.canEditVmHardware);

  useDocumentTitle(vm ? (vm.name || `VM ${vm.vmid}`) : 'VM Details');

  const loadVm = useCallback(async () => {
    try {
      const r = await api.get(`/vms/${node}/${vmid}/status`);
      setVm({
        ...r.data,
        nodeRef: r.data.nodeRef || node,
        node: r.data.node || displayNode(node),
        vmid: parseInt(vmid, 10),
      });
      setError('');
    } catch (e) {
      if (e.response?.status === 403) setError('VM not found or not assigned to you');
      else setError(e.response?.data?.error || 'Failed to load VM');
    } finally { setLoading(false); }
  }, [node, vmid]);

  useEffect(() => {
    loadVm();
    const interval = setInterval(loadVm, 15000);
    return () => clearInterval(interval);
  }, [loadVm]);


  const loadDisks = useCallback(() => {
    api.get(`/vms/${node}/${vmid}/config`).then(r => {
      const cfg = r.data;
      const diskKeys = Object.keys(cfg).filter(k =>
        /^(scsi|virtio|sata|ide|efidisk|tpmstate)\d+$/.test(k) && !cfg[k].includes('media=cdrom') && cfg[k] !== 'none'
      );
      const boot = bootDiskKeys(cfg);
      setDisks(diskKeys.map(k => {
        const val = cfg[k];
        const sizeMatch = val.match(/size=(\d+[A-Z]?)/i);
        const storageMatch = val.match(/^([^,]+)/);
        return { name: k, storage: storageMatch?.[1] || val, size: sizeMatch?.[1] || '—', boot: boot.has(k) };
      }));
    }).catch(() => {});
  }, [node, vmid]);

  useEffect(() => { loadDisks(); }, [loadDisks]);

  const loadSchedule = useCallback(() => {
    api.get(`/vms/${node}/${vmid}/schedule`)
      .then(r => setSchedule(r.data?.schedule || null))
      .catch(() => {});
  }, [node, vmid]);

  useEffect(() => { loadSchedule(); }, [loadSchedule]);
  // Whether a cloud-init credential reset is offered (owner + cloud-init drive).
  const loadCloudInit = useCallback(() => {
    api.get(`/vms/${node}/${vmid}/cloudinit`)
      .then(r => setCloudInit({ canReset: !!r.data?.canReset, ciuser: r.data?.ciuser || '' }))
      .catch(() => setCloudInit({ canReset: false, ciuser: '' }));
  }, [node, vmid]);

  useEffect(() => { loadCloudInit(); }, [loadCloudInit]);

  const vmStatus = vm?.status;
  useEffect(() => {
    setDetectedIp('');
    if (!vmStatus) return undefined;
    let cancelled = false;
    let retryTimer;
    let attempts = 0;
    const controller = new AbortController();
    const discover = async () => {
      attempts += 1;
      let ip = '';
      try {
        const r = await api.get(`/vms/${node}/${vmid}/detected-ips`, { signal: controller.signal });
        ip = r.data?.candidates?.[0]?.ip || '';
      } catch {}
      if (cancelled) return;
      setDetectedIp(ip);
      if (!ip && vmStatus === 'running' && attempts < 20) {
        retryTimer = setTimeout(discover, 15000);
      }
    };
    discover();
    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(retryTimer);
    };
  }, [node, vmid, vmStatus]);

  const copyIp = async () => {
    try {
      await navigator.clipboard.writeText(detectedIp);
      setIpCopied(true);
      setTimeout(() => setIpCopied(false), 1500);
    } catch { /* clipboard blocked (insecure context) — the IP is still selectable */ }
  };

  useEffect(() => {
    let cancelled = false;
    setRrdLoading(true);
    api.get(`/vms/${node}/${vmid}/rrddata?timeframe=${timeframe}`)
      .then(r => { if (!cancelled) setRrd(r.data); })
      .catch(() => { if (!cancelled) setRrd([]); })
      .finally(() => { if (!cancelled) setRrdLoading(false); });
    return () => { cancelled = true; };
  }, [node, vmid, timeframe]);

  const action = async (act) => {
    if (act === 'stop' && !await confirm({
      title: 'Stop VM',
      message: `Hard power-off ${vm?.name || `VM ${vmid}`}? Unsaved data in the guest is lost. Use Shutdown for a clean stop.`,
      confirmLabel: 'Stop',
      danger: true,
    })) return;
    setActionLoading(true); setActionError(''); setPendingAction(act);
    try {
      await api.post(`/vms/${node}/${vmid}/action`, { action: act });
      // Keep the pending label until the refreshed status lands.
      setTimeout(() => loadVm().finally(() => setPendingAction('')), 1500);
    } catch (e) {
      setActionError(e.response?.data?.error || 'Action failed');
      setPendingAction('');
    } finally { setActionLoading(false); }
  };

  const renewLease = async () => {
    setActionLoading(true); setActionError('');
    try {
      await api.post(`/vms/${node}/${vmid}/lease/renew`);
      await loadVm();
    } catch (e) {
      setActionError(e.response?.data?.error || 'Failed to renew lease');
    } finally { setActionLoading(false); }
  };

  const isRunning = vm?.status === 'running';

  // Anchor nav for the long single-scroll page; every panel stays mounted.
  const sections = [
    { id: 'vm-overview', label: 'Overview' },
    isRunning && { id: 'vm-performance', label: 'Performance' },
    { id: 'vm-snapshots', label: 'Snapshots' },
    { id: 'vm-backups', label: 'Backups' },
    { id: 'vm-ip', label: 'IP' },
    { id: 'vm-ssh', label: 'SSH' },
  ].filter(Boolean);

  const jumpTo = (e, id) => {
    e.preventDefault();
    const el = document.getElementById(id);
    if (!el) return;
    // Land below the sticky header, whose height varies as the action bar wraps.
    el.style.scrollMarginTop = `${(stickyRef.current?.offsetHeight || 0) + 16}px`;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
    el.focus({ preventScroll: true });
    // Keep the fragment so the section can be copied/reloaded; replace so Back isn't flooded.
    window.history.replaceState(window.history.state, '', `#${id}`);
  };
  const cpuData = rrd?.map(d => d.cpu != null ? d.cpu * 100 : null) || [];
  const memData = rrd?.map(d => d.mem != null && d.maxmem ? (d.mem / d.maxmem) * 100 : null) || [];
  const netInData = rrd?.map(d => d.netin ?? null) || [];
  const netOutData = rrd?.map(d => d.netout ?? null) || [];
  const diskReadData = rrd?.map(d => d.diskread ?? null) || [];
  const diskWriteData = rrd?.map(d => d.diskwrite ?? null) || [];

  // ── Loading state ──
  if (loading) {
    return (
      <Layout>
        <div className="p-6 lg:p-8 max-w-6xl mx-auto">
          <div className="animate-pulse space-y-6">
            <div className="h-10 bg-gray-800 rounded-xl w-64" />
            <div className="h-20 bg-gray-800 rounded-2xl" />
            <div className="grid grid-cols-4 gap-4">
              {[1,2,3,4].map(i => <div key={i} className="h-24 bg-gray-800 rounded-2xl" />)}
            </div>
          </div>
        </div>
      </Layout>
    );
  }

  // ── Error state ──
  if (error && !vm) {
    return (
      <Layout>
        <div className="p-6 lg:p-8 max-w-6xl mx-auto">
          <button onClick={() => navigate('/dashboard')} className="text-sm text-gray-400 hover:text-white mb-6 flex items-center gap-1.5 transition-colors">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" /></svg>
            Back to VMs
          </button>
          <div className="bg-red-900/20 border border-red-800/50 rounded-2xl p-6 text-red-400 text-sm">{error}</div>
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="p-6 lg:p-8 max-w-6xl mx-auto space-y-6">

        {/* ── Sticky header: identity, status, section nav (actions scroll away to keep it slim) ── */}
        <div ref={stickyRef} className="sticky top-0 z-20 -mx-6 lg:-mx-8 px-6 lg:px-8 py-3 bg-gray-950/95 backdrop-blur-sm border-b border-gray-800 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <button onClick={() => navigate('/dashboard')} className="text-gray-500 hover:text-white transition-colors p-2 rounded-xl hover:bg-gray-800">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" /></svg>
            </button>
            <div>
              <h1 className="aaris-display text-xl text-gray-100">{vm.name || `VM ${vm.vmid}`}</h1>
              <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-gray-500 mt-1.5">
                VMID {vm.vmid} / {displayNode(vm.node)}
                {vm.hostName && <span className="text-gray-400"> · host </span>}
                {vm.hostName && <span className="text-blue-400/80">{vm.hostName}</span>}
                {detectedIp && (
                  <>
                    <span className="text-gray-600"> · ip </span>
                    <span className="text-gray-300 normal-case select-all">{detectedIp}</span>
                    <button
                      type="button"
                      onClick={copyIp}
                      aria-label={ipCopied ? `Copied IP address ${detectedIp}` : `Copy IP address ${detectedIp}`}
                      className="ml-1.5 align-middle text-gray-500 hover:text-orange-400 transition-colors"
                    >
                      {ipCopied ? 'copied' : 'copy'}
                    </button>
                    <span role="status" aria-live="polite" className="sr-only">{ipCopied ? 'IP address copied' : ''}</span>
                  </>
                )}
              </p>
              {vm.lease && <LeaseBadge lease={vm.lease} className="mt-2" />}
            </div>
          </div>
          <div className="flex items-center gap-2.5">
            {schedule?.enabled && (
              <span
                title={`${sleepLabel(schedule)} · ${describeDays(schedule.days)} · ${schedule.timezone}${schedule.skipActive ? ' · skipping next shutdown' : ''}`}
                className="inline-flex items-center gap-1.5 px-2 py-1 border border-indigo-500/30 bg-indigo-500/10 font-mono text-[10px] uppercase tracking-wide text-indigo-300 whitespace-nowrap"
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M21.752 15.002A9.718 9.718 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 003 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 009.002-5.998z" /></svg>
                {sleepLabel(schedule)}
                {schedule.skipActive && <span className="text-yellow-300">· skip</span>}
              </span>
            )}
            <StatusBadge status={vm.status} />
          </div>
        </div>

        <nav aria-label="VM sections" className="flex flex-wrap gap-1.5 font-mono text-[11px] uppercase tracking-[0.12em]">
          {sections.map(s => (
            <a
              key={s.id}
              href={`#${s.id}`}
              onClick={e => jumpTo(e, s.id)}
              className="px-2.5 py-1 border border-gray-800 text-gray-400 hover:text-orange-400 hover:border-orange-600 transition-colors"
            >
              {s.label}
            </a>
          ))}
        </nav>
        </div>

        {/* ── Action Bar ── */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
          <div className="flex flex-wrap items-center gap-2.5">
            {/* Power */}
            <SectionLabel icon={
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M5.636 5.636a9 9 0 1012.728 0M12 3v9" /></svg>
            } text="Power" />
            {!isRunning && (
              <ActionBtn color="green" onClick={() => action('start')} disabled={actionLoading || !!pendingAction} icon={
                <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
              }>{pendingAction === 'start' ? 'Starting…' : 'Start'}</ActionBtn>
            )}
            {isRunning && (
              <>
                <ActionBtn color="yellow" onClick={() => action('reboot')} disabled={actionLoading || !!pendingAction} icon={
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                }>{pendingAction === 'reboot' ? 'Rebooting…' : 'Reboot'}</ActionBtn>
                <ActionBtn color="orange" onClick={() => action('shutdown')} disabled={actionLoading || !!pendingAction} icon={
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M5.636 5.636a9 9 0 1012.728 0M12 3v9" /></svg>
                }>{pendingAction === 'shutdown' ? 'Shutting down…' : 'Shutdown'}</ActionBtn>
                <ActionBtn color="red" onClick={() => action('stop')} disabled={actionLoading || !!pendingAction} icon={
                  <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="1" /></svg>
                }>{pendingAction === 'stop' ? 'Stopping…' : 'Stop'}</ActionBtn>
              </>
            )}

            <Divider />

            {/* Connect */}
              <SectionLabel icon={
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m9.86-2.54a4.5 4.5 0 00-6.364-6.364L4.5 8.257" /></svg>
            } text="Connect" />
            {isRunning ? (
              <>
                <ActionBtn color="blue" onClick={() => openVncSession(vm)} icon={
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" strokeLinecap="round" /></svg>
                }>VNC</ActionBtn>
                <ActionBtn color="blue" onClick={() => window.open(`/vnc/${routeNode(vm)}/${vm.vmid}${vm.name ? `?name=${encodeURIComponent(vm.name)}` : ''}`, '_blank', 'noopener')} icon={
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
                }>VNC Tab</ActionBtn>
                <ActionBtn color="blue" onClick={() => openSshSession(vm)} icon={
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6.75 7.5l3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0021 18V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v12a2.25 2.25 0 002.25 2.25z" /></svg>
                }>SSH</ActionBtn>
                <ActionBtn color="blue" onClick={() => window.open(`/ssh/${routeNode(vm)}/${vm.vmid}${vm.name ? `?name=${encodeURIComponent(vm.name)}` : ''}`, '_blank', 'noopener')} icon={
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" /></svg>
                }>SSH Tab</ActionBtn>
              </>
            ) : (
              <span className="text-xs text-gray-400 italic">Start VM to connect</span>
            )}

            <Divider />

            {/* Network */}
            <ActionBtn color="gray" onClick={() => setVlanModal(true)} icon={
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0112 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 013 12c0-1.605.42-3.113 1.157-4.418" /></svg>
            }>VLAN</ActionBtn>

            <ActionBtn color={schedule?.enabled ? 'blue' : 'gray'} onClick={() => setScheduleModal(true)} icon={
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
            }>Schedule</ActionBtn>
            {cloudInit.canReset && (
              <ActionBtn color="gray" onClick={() => setCredModal(true)} icon={
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z" /></svg>
              }>Credentials</ActionBtn>
            )}

            <>
                <Divider />
                <ActionBtn color="gray" onClick={() => setHardwareModal(true)} disabled={!canEditHw} title={canEditHw ? undefined : 'Requires the "edit VM hardware" permission — ask an admin'} icon={
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M8.25 3v1.5M4.5 8.25H3m18 0h-1.5M4.5 12H3m18 0h-1.5m-15 3.75H3m18 0h-1.5M8.25 19.5V21M12 3v1.5m0 15V21m3.75-18v1.5m0 15V21m-9-1.5h10.5a2.25 2.25 0 002.25-2.25V6.75a2.25 2.25 0 00-2.25-2.25H6.75A2.25 2.25 0 004.5 6.75v10.5a2.25 2.25 0 002.25 2.25z" /></svg>
                }>Hardware</ActionBtn>
            </>

            {vm.lease?.hasLease && !vm.lease.exempt && (
              <>
                <Divider />
                <SectionLabel icon={
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                } text="Lease" />
                <ActionBtn color="green" onClick={renewLease} disabled={actionLoading} icon={
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                }>Renew</ActionBtn>
              </>
            )}

            {vm.canDelete !== false && <>
            <Divider />

            <ActionBtn color="red" onClick={() => setDeleteModal(true)} icon={
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" /></svg>
            }>Delete</ActionBtn>
            </>}
          </div>
          {actionError && <p className="text-xs text-red-400 bg-red-900/20 rounded-lg p-2.5 mt-3">{actionError}</p>}
        </div>

        {/* ── Stats Grid ── */}
        <div id="vm-overview" tabIndex={-1} className="grid grid-cols-2 sm:grid-cols-4 gap-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-950">
          <StatCard
            label="vCPUs" value={vm.maxcpu || vm.cpus || '—'}
            icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M8.25 3v1.5M4.5 8.25H3m18 0h-1.5M4.5 12H3m18 0h-1.5m-15 3.75H3m18 0h-1.5M8.25 19.5V21M12 3v1.5m0 15V21m3.75-18v1.5m0 15V21m-9-1.5h10.5a2.25 2.25 0 002.25-2.25V6.75a2.25 2.25 0 00-2.25-2.25H6.75A2.25 2.25 0 004.5 6.75v10.5a2.25 2.25 0 002.25 2.25z" /></svg>}
            accent="blue"
          />
          <StatCard
            label="CPU Usage" value={vm.cpu !== undefined ? `${(vm.cpu * 100).toFixed(1)}%` : '—'}
            icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" /></svg>}
            accent="cyan"
          />
          <StatCard
            label="Uptime" value={fmtUptime(vm.uptime)}
            icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>}
            accent="green"
          />
          <StatCard
            label="Status" value={vm.status}
            icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M9.348 14.651a3.75 3.75 0 010-5.303m5.304 0a3.75 3.75 0 010 5.303m-7.425 2.122a6.75 6.75 0 010-9.546m9.546 0a6.75 6.75 0 010 9.546M5.106 18.894c-3.808-3.808-3.808-9.98 0-13.789m13.788 0c3.808 3.808 3.808 9.981 0 13.79M12 12h.008v.007H12V12zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" /></svg>}
            accent={isRunning ? 'green' : 'red'}
          />
        </div>

        {/* ── Memory + Disks ── */}
        {isRunning && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <ProgressBar label="Memory" value={vm.mem} max={vm.maxmem} color="purple" icon={
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 3h12l3 6-3 6H6L3 9l3-6z" /></svg>
            } />
            {disks.length > 0 && (
              <div className="bg-gray-800/50 border border-gray-700/30 rounded-xl p-4">
                <span className="flex items-center gap-2 text-xs text-gray-400 font-medium mb-3">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 0v3.75m-16.5-3.75v3.75m16.5 0v3.75C20.25 16.153 16.556 18 12 18s-8.25-1.847-8.25-4.125v-3.75m16.5 0c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125" /></svg>
                  Disks
                </span>
                <div className="space-y-2">
                  {disks.map(d => (
                    <div key={d.name} className="flex items-center justify-between bg-gray-900/50 rounded-lg px-3 py-2">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <span className="text-xs font-mono text-blue-400 font-semibold shrink-0">{d.name}</span>
                        <span className="text-xs text-gray-500 truncate" title={d.storage}>{d.storage}</span>
                      </div>
                      <span className="text-xs font-mono text-white font-semibold shrink-0 ml-3">{d.size}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Disks (when stopped) ── */}
        {!isRunning && disks.length > 0 && (
          <div className="bg-gray-800/50 border border-gray-700/30 rounded-xl p-4">
            <span className="flex items-center gap-2 text-xs text-gray-400 font-medium mb-3">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 0v3.75m-16.5-3.75v3.75m16.5 0v3.75C20.25 16.153 16.556 18 12 18s-8.25-1.847-8.25-4.125v-3.75m16.5 0c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125" /></svg>
              Disks
            </span>
            <div className="space-y-2">
              {disks.map(d => (
                <div key={d.name} className="flex items-center justify-between bg-gray-900/50 rounded-lg px-3 py-2">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span className="text-xs font-mono text-blue-400 font-semibold shrink-0">{d.name}</span>
                    <span className="text-xs text-gray-500 truncate" title={d.storage}>{d.storage}</span>
                  </div>
                  <span className="text-xs font-mono text-white font-semibold shrink-0 ml-3">{d.size}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── I/O Stats ── */}
        {isRunning && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <MiniStat label="Net In" value={fmt(vm.netin)} icon="↓" color="text-green-400" />
            <MiniStat label="Net Out" value={fmt(vm.netout)} icon="↑" color="text-orange-400" />
            <MiniStat label="Disk Read" value={fmt(vm.diskread)} icon="↓" color="text-cyan-400" />
            <MiniStat label="Disk Write" value={fmt(vm.diskwrite)} icon="↑" color="text-yellow-400" />
          </div>
        )}

        {/* ── Performance Charts ── */}
        {isRunning && (
          <div id="vm-performance" tabIndex={-1} className="space-y-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-950">
            <div className="flex items-center justify-between">
              <h2 className="aaris-display text-sm text-gray-100">Performance</h2>
              <div className="flex gap-1 bg-gray-800/50 rounded-lg p-0.5">
                {[
                  { key: 'hour', label: '1h' },
                  { key: 'day', label: '24h' },
                  { key: 'week', label: '7d' },
                ].map(tf => (
                  <button
                    key={tf.key}
                    onClick={() => setTimeframe(tf.key)}
                    className={`text-xs px-3 py-1.5 rounded-md transition-all ${
                      timeframe === tf.key
                        ? 'bg-blue-600 text-gray-950 shadow-sm'
                        : 'text-gray-400 hover:text-white'
                    }`}
                  >
                    {tf.label}
                  </button>
                ))}
              </div>
            </div>

            {rrdLoading ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {[1,2,3,4].map(i => <div key={i} className="bg-gray-800/50 rounded-xl h-28 animate-pulse" />)}
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <MiniChart data={cpuData}       token="--accent"       label="CPU"         formatValue={v => v != null ? `${v.toFixed(1)}%` : '—'} />
                <MiniChart data={memData}        token="--accent-hover" label="Memory"      formatValue={v => v != null ? `${v.toFixed(1)}%` : '—'} />
                <MiniChart data={netInData}      token="--ok"           label="Network In"  formatValue={fmtRate} />
                <MiniChart data={netOutData}     token="--warning"      label="Network Out" formatValue={fmtRate} />
                <MiniChart data={diskReadData}   token="--muted"        label="Disk Read"   formatValue={fmtRate} />
                <MiniChart data={diskWriteData}  token="--ink"          label="Disk Write"  formatValue={fmtRate} />
              </div>
            )}
          </div>
        )}

        {/* ── Snapshots ── */}
        <div id="vm-snapshots" tabIndex={-1} className="focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-950">
          <SnapshotsSection node={node} vmid={vmid} />
        </div>

        {/* ── Backups ── */}
        <div id="vm-backups" tabIndex={-1} className="focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-950">
          <BackupsSection node={node} vmid={vmid} />
        </div>

        {/* ── IP Management ── */}
        <div id="vm-ip" tabIndex={-1} className="focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-950">
          <VMIPManagementPanel
            node={node}
            vmid={vmid}
            currentSshHost={sshCfg.host}
            onSshHostUpdate={(host) => setSshCfg((current) => ({ ...current, host }))}
          />
        </div>

        {/* ── SSH Config ── */}
        <div id="vm-ssh" tabIndex={-1} className="space-y-3 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-950">
          <h2 className="aaris-display text-sm text-gray-100">SSH Configuration</h2>
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <InputField label="Host / IP" value={sshCfg.host} onChange={v => setSshCfg(c => ({ ...c, host: v }))} placeholder="192.168.1.100" />
              <InputField label="Port" type="number" value={sshCfg.port} onChange={v => setSshCfg(c => ({ ...c, port: parseInt(v) || 22 }))} />
              <InputField label="Username" value={sshCfg.username} onChange={v => setSshCfg(c => ({ ...c, username: v }))} />
            </div>
            <div className="mt-4">
              <div className="flex items-center justify-between mb-1.5">
                <label className="block text-xs text-gray-500">Host Key Fingerprint</label>
                <button
                  onClick={scanSshFingerprint}
                  disabled={scanningFingerprint}
                  className="text-xs text-blue-400 hover:text-blue-300 disabled:opacity-50 transition-colors"
                >
                  {scanningFingerprint ? 'Scanning...' : 'Scan fingerprint'}
                </button>
              </div>
              <input
                type="text"
                value={sshCfg.hostFingerprint}
                onChange={e => setSshCfg(c => ({ ...c, hostFingerprint: e.target.value }))}
                placeholder="SHA256:..."
                className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 transition-colors"
              />
              <p className="mt-1.5 text-xs text-gray-500">
                This pinned fingerprint is required so the backend can verify the SSH server identity before connecting.
              </p>
            </div>
            <div className="flex items-center gap-3 mt-4">
              <button
                onClick={saveSshConfig}
                disabled={!sshCfg.host || !sshCfg.hostFingerprint}
                className="text-xs px-5 py-2 btn-primary disabled:opacity-40 rounded-lg font-medium"
              >
                Save Config
              </button>
              {sshSaved && (
                <span className="text-xs text-green-400 flex items-center gap-1">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>
                  Saved
                </span>
              )}
            </div>
            {sshSavingError && (
              <p className="mt-3 text-xs text-red-400 bg-red-900/20 rounded-lg p-3">{sshSavingError}</p>
            )}
          </div>
        </div>
      </div>

      {vlanModal && <VLANModal vm={vm} onClose={() => setVlanModal(false)} onSaved={loadVm} />}
      {hardwareModal && <VMHardwareModal vm={vm} disks={disks} onClose={() => setHardwareModal(false)} onSaved={() => { loadVm(); loadDisks(); }} />}
      {scheduleModal && <VMScheduleModal vm={vm} node={node} vmid={vmid} onClose={() => setScheduleModal(false)} onSaved={(s) => setSchedule(s)} />}
      {deleteModal && <DeleteVMModal vm={vm} node={node} onClose={() => setDeleteModal(false)} />}
      {credModal && (
        <CloudInitCredentialsModal
          vm={vm}
          node={node}
          vmid={vmid}
          ciuser={cloudInit.ciuser}
          onClose={() => setCredModal(false)}
          onApplied={loadVm}
        />
      )}
    </Layout>
  );
}
