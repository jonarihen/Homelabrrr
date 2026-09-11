import Modal from './Modal.jsx';
import { displayNode } from '../utils/nodeRef.js';
import useMigrateVM from './useMigrateVM.js';

const inputCls = 'w-full bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-3 py-2 focus:ring-1 focus:ring-blue-500 focus:border-blue-500';
const labelCls = 'block text-xs text-gray-500 uppercase tracking-wider mb-1';
const diskSelectCls = 'w-40 shrink-0 bg-gray-800 border border-gray-700 text-gray-200 text-xs font-mono rounded px-2 py-1 focus:ring-1 focus:ring-blue-500 focus:border-blue-500';

const ACTION_BADGE = {
  remount: { text: 'remount — no copy', cls: 'bg-green-500/10 text-green-400 border-green-500/20' },
  copy: { text: 'copy', cls: 'bg-blue-500/10 text-blue-400 border-blue-500/20' },
  recreate: { text: 'recreate', cls: 'bg-gray-700/40 text-gray-400 border-gray-600/40' },
  detach: { text: 'detached', cls: 'bg-amber-500/10 text-amber-400 border-amber-500/20' },
};

const STEP_ICON = {
  pending: 'text-gray-600',
  active: 'text-blue-400',
  done: 'text-green-500',
  error: 'text-red-500',
  skipped: 'text-gray-600',
};

function TransferProgress({ percent, detail }) {
  const pct = Math.min(100, Math.max(0, percent));
  return (
    <div className="mt-1.5 mb-1">
      <div className="w-full bg-gray-800 rounded-full h-1.5 overflow-hidden">
        <div className="bg-blue-500 h-1.5 rounded-full transition-all duration-500" style={{ width: `${pct}%` }} />
      </div>
      <div className="flex items-center justify-between mt-1 text-[11px] font-mono text-gray-500">
        <span className="truncate">{detail || 'transferring…'}</span>
        <span className="text-gray-400 shrink-0 ml-2">{pct.toFixed(pct < 10 ? 1 : 0)}%</span>
      </div>
    </div>
  );
}

export default function MigrateVMModal({ vm, onClose, onDone }) {
  const {
    adopt, blockedByRunning, bootIssue, bridge, bridges, deleteSource, diskTarget, error,
    fullCopy, info, isLxc, loadingTarget, migration, nodes, online, placeableDisks, plan,
    preparing, rebootToFix, running, setBridge, setDeleteSource, setDiskTarget, setFullCopy,
    setOnline, setStorage, setTargetNode, splitBlocked, splitSources, start, startDisabled,
    starting, stopAndMigrate, storage, storageIssue, storages, targetHostName, targetNode,
  } = useMigrateVM(vm, onDone);
  const showProgress = migration?.status === 'running' && typeof migration.progress === 'number';

  return (
    <Modal title={`Migrate ${vm.name || `VM ${vm.vmid}`}`} onClose={onClose} size="lg">
      <div className="p-5 space-y-4">
        <div className="bg-gray-950/60 border border-gray-800 rounded-lg px-4 py-3 text-sm">
          <div className="flex items-center justify-between font-mono text-xs">
            <span className="text-gray-400">{vm.hostName || displayNode(vm.node)} / {displayNode(vm.node)} / {vm.vmid}</span>
            <span className="text-gray-600">→</span>
            <span className={targetNode ? 'text-blue-400' : 'text-gray-600'}>
              {targetNode ? `${targetHostName} / ${displayNode(targetNode)}` : 'select target'}
            </span>
          </div>
        </div>

        {migration ? (
          <div className="space-y-3">
            {migration.status === 'running' && (
              <div className="flex items-center gap-3 text-sm text-gray-300">
                <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse shrink-0" />
                Migration running{migration.mode === 'adopt' ? ' — shared disks are re-referenced, not copied' : ''}.
                Closing this window is safe, it continues in the background.
              </div>
            )}
            {(migration.steps || []).length > 0 && (
              <div className="bg-gray-950/60 border border-gray-800 rounded-lg px-4 py-3 space-y-1.5">
                {migration.steps.map((s) => (
                  <div key={s.key}>
                    <div className="flex items-center gap-2 text-xs">
                      <span className={`font-mono ${STEP_ICON[s.status] || 'text-gray-600'}`}>
                        {s.status === 'done' ? '✓' : s.status === 'error' ? '✕' : s.status === 'active' ? '▸' : s.status === 'skipped' ? '–' : '·'}
                      </span>
                      <span className={s.status === 'active' ? 'text-gray-200' : 'text-gray-500'}>{s.label}</span>
                      {s.note && <span className="text-gray-600 font-mono truncate">{s.note}</span>}
                    </div>
                    {showProgress && s.status === 'active' && (
                      <TransferProgress percent={migration.progress} detail={migration.progress_detail} />
                    )}
                  </div>
                ))}
              </div>
            )}
            {showProgress && (migration.steps || []).length === 0 && (
              <div className="bg-gray-950/60 border border-gray-800 rounded-lg px-4 py-3">
                <TransferProgress percent={migration.progress} detail={migration.progress_detail} />
              </div>
            )}
            {migration.status === 'ok' && (
              <div className="space-y-2">
                <p className="text-sm text-green-400">
                  Migration finished. The portal now tracks this VM on {migration.targetHostName || targetHostName || 'the target host'}.
                </p>
                {migration.status_detail && (
                  <p className="text-xs text-gray-400 bg-gray-950/60 border border-gray-800 rounded-lg p-3 font-mono break-words">
                    {migration.status_detail}
                  </p>
                )}
              </div>
            )}
            {migration.status === 'error' && (
              <p className="text-sm text-red-400 break-words">
                Migration failed: {migration.status_detail || 'unknown error'} — check the task log in Proxmox.
              </p>
            )}
            <button
              onClick={onClose}
              className="w-full bg-gray-800 hover:bg-gray-700 text-gray-200 rounded-lg py-2.5 text-sm font-medium transition-colors"
            >
              Close
            </button>
          </div>
        ) : (
          <>
            {nodes.length === 0 && !error && (
              <p className="text-sm text-gray-500">No other online Proxmox host is registered — add one under Admin → PVE Hosts first.</p>
            )}

            <div>
              <label className={labelCls}>Target host / node</label>
              <select value={targetNode} onChange={(e) => setTargetNode(e.target.value)} className={inputCls}>
                <option value="">Select…</option>
                {nodes.map((n) => (
                  <option key={n.nodeRef} value={n.nodeRef}>{n.hostName} — {n.node}</option>
                ))}
              </select>
            </div>

            {plan && plan.disks?.length > 0 && (
              <div>
                <label className={labelCls}>Disk plan</label>
                <div className="bg-gray-950/60 border border-gray-800 rounded-lg divide-y divide-gray-800/60">
                  {plan.disks.map((d) => {
                    const placeable = placeableDisks.some((p) => p.key === d.key);
                    return (
                      <div key={d.key} className="flex items-center gap-2 px-3 py-2 text-xs">
                        <span className="font-mono text-gray-300 w-16 shrink-0">{d.key}</span>
                        <span className="font-mono text-gray-500 truncate flex-1 min-w-0">{d.storage}{d.sizeGb ? ` · ${d.sizeGb >= 1024 ? `${(d.sizeGb / 1024).toFixed(1)} TB` : `${Math.round(d.sizeGb)} GB`}` : ''}</span>
                        {placeable && (
                          <>
                            <span className="text-gray-600 shrink-0">→</span>
                            <select
                              value={diskTarget(d.key)}
                              onChange={(e) => setDiskTarget(d.key, e.target.value)}
                              disabled={loadingTarget}
                              className={diskSelectCls}
                              aria-label={`Target storage for ${d.key}`}
                            >
                              {adopt && <option value="">keep on shared storage</option>}
                              {storages.map((s) => (
                                <option key={s.storage} value={s.storage}>{s.storage}</option>
                              ))}
                            </select>
                          </>
                        )}
                        <span className={`shrink-0 px-1.5 py-0.5 rounded border ${(ACTION_BADGE[fullCopy && d.action === 'remount' ? 'copy' : d.action] || ACTION_BADGE.copy).cls}`}>
                          {(ACTION_BADGE[fullCopy && d.action === 'remount' ? 'copy' : d.action] || ACTION_BADGE.copy).text}
                        </span>
                      </div>
                    );
                  })}
                </div>
                {adopt && (
                  <p className="text-xs text-green-500/80 mt-1.5">
                    Shared storage detected ({plan.sharedStorages.map((s) => s.sourceId).join(', ')}) — those disks are adopted on the target, never copied.
                  </p>
                )}
                {splitSources.length > 0 && (
                  <p className={`text-xs mt-1.5 ${splitBlocked ? 'text-red-400' : 'text-amber-500/80'}`}>
                    {splitBlocked
                      ? `${splitSources.join(', ')} holds volumes you sent to different target storages. Proxmox copies a storage to one target, and a container's volumes can't be moved afterwards — send them to the same storage.`
                      : `${splitSources.join(', ')} holds disks you sent to different target storages. Proxmox copies a storage to one target, so the smaller ones are moved into place on the target once the copy finishes — that extra move is shown as its own step.`}
                  </p>
                )}
                {(plan.warnings || []).map((w) => (
                  <p key={w} className="text-xs text-amber-500/80 mt-1">{w}</p>
                ))}
              </div>
            )}

            <div>
              <label className={labelCls}>{adopt ? 'Target storage for boot / local disks' : 'Target storage'}</label>
              <select
                value={storage}
                onChange={(e) => setStorage(e.target.value)}
                className={inputCls}
                disabled={!targetNode || loadingTarget}
              >
                {adopt && <option value="">Keep everything on shared storage</option>}
                {storages.map((s) => (
                  <option key={s.storage} value={s.storage}>
                    {s.storage} ({((s.avail || 0) / 1024 ** 3).toFixed(0)} GB free)
                  </option>
                ))}
              </select>
              <p className="text-xs text-gray-600 mt-1">
                {placeableDisks.length > 1
                  ? 'Applies to every disk — override a single one in the disk plan above.'
                  : 'Where the disks land on the target host.'}
              </p>
              {storageIssue && (
                <p className="text-sm text-red-400 bg-red-900/20 border border-red-800/30 rounded-lg p-3 mt-2 break-words">
                  {storageIssue.reason}
                </p>
              )}
            </div>

            <div>
              <label className={labelCls}>Target network bridge</label>
              <select value={bridge} onChange={(e) => setBridge(e.target.value)} className={inputCls} disabled={!targetNode || loadingTarget}>
                {bridges.map((b) => (
                  <option key={b.iface} value={b.iface}>{b.iface}{b.comments ? ` — ${b.comments}` : ''}</option>
                ))}
              </select>
              <p className="text-xs text-gray-600 mt-1">VLAN tags on the NIC are kept — only the bridge is remapped.</p>
            </div>

            {blockedByRunning && (
              <p className="text-sm text-amber-400 bg-amber-900/15 border border-amber-800/30 rounded-lg p-3">
                Shared-storage migration runs offline — stop the VM first, then start the migration.
              </p>
            )}

            {adopt && (
              <p className="text-xs text-gray-500 bg-gray-950/60 border border-gray-800 rounded-lg p-3">
                Proxmox cannot make the source cluster forget a VM without destroying its disks, so the source
                config stays behind — stopped and protected. You get a one-line cleanup command when the
                migration finishes.
              </p>
            )}

            {plan?.mode === 'adopt' && (
              <label className="flex items-start gap-2 text-sm text-gray-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={fullCopy}
                  onChange={(e) => setFullCopy(e.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  Force full copy instead
                  <span className="block text-xs text-gray-600">Copies every disk over the network with remote_migrate — only useful if the shared storage should not be reused.</span>
                </span>
              </label>
            )}

            {!adopt && !isLxc && running && (
              <label className="flex items-start gap-2 text-sm text-gray-300 cursor-pointer">
                <input type="checkbox" checked={online} onChange={(e) => setOnline(e.target.checked)} className="mt-0.5" />
                <span>
                  Live migrate (keep running)
                  <span className="block text-xs text-gray-600">Needs compatible CPUs on both hosts. Uncheck and stop the VM first if the hardware differs a lot.</span>
                </span>
              </label>
            )}
            {isLxc && running && (
              <p className="text-xs text-amber-500/80">Containers can't live-migrate — this container will be stopped, moved and restarted on the target.</p>
            )}

            {!adopt && (
              <label className="flex items-start gap-2 text-sm text-gray-300 cursor-pointer">
                <input type="checkbox" checked={deleteSource} onChange={(e) => setDeleteSource(e.target.checked)} className="mt-0.5" />
                <span>
                  Delete source VM after successful migration
                  <span className="block text-xs text-gray-600">If unchecked, a stopped copy stays on the source host; the portal points at the migrated VM either way.</span>
                </span>
              </label>
            )}

            {info && <p className="text-sm text-cyan-300 bg-cyan-900/15 border border-cyan-800/30 rounded-lg p-3 break-words">{info}</p>}
            {error && <p className="text-sm text-red-400 bg-red-900/20 rounded-lg p-3 break-words">{error}</p>}

            {bootIssue ? (
              <div className="space-y-3 bg-amber-900/10 border border-amber-800/30 rounded-lg p-3">
                <p className="text-sm text-amber-300">
                  This VM's boot order lists a device that no longer exists (<span className="font-mono">{bootIssue.boot}</span>),
                  which the target host rejects. Proxmox only applies the correction (<span className="font-mono">{bootIssue.fixedBoot}</span>)
                  on the next start, so it can't be fixed while the VM runs. Pick one:
                </p>
                <div className="flex flex-col sm:flex-row gap-2">
                  <button
                    onClick={rebootToFix}
                    disabled={!!preparing}
                    className="flex-1 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white rounded-lg py-2 text-sm font-medium transition-colors"
                  >
                    {preparing === 'reboot' ? 'Rebooting…' : 'Reboot to apply fix (then migrate live)'}
                  </button>
                  <button
                    onClick={stopAndMigrate}
                    disabled={!!preparing}
                    className="flex-1 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white rounded-lg py-2 text-sm font-medium transition-colors"
                  >
                    {preparing === 'stop' ? 'Stopping…' : 'Stop & migrate offline now'}
                  </button>
                </div>
                <p className="text-xs text-gray-500">
                  Reboot = one short blip, then a live migration keeps it up during the copy. Stop &amp; migrate = down for the whole copy but no reboot.
                </p>
              </div>
            ) : (
              <button
                onClick={start}
                disabled={startDisabled}
                className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg py-2.5 text-sm font-medium transition-colors"
              >
                {starting ? 'Starting…' : adopt ? 'Start shared-storage migration' : 'Start migration'}
              </button>
            )}
            <p className="text-xs text-gray-600">
              Assignments, SSH settings and templates for this VM follow it to the new host automatically.
            </p>
          </>
        )}
      </div>
    </Modal>
  );
}
