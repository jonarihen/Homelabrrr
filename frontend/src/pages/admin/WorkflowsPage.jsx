import { useState, useEffect, useCallback, useMemo } from 'react';
import api from '../../api.js';
import Modal from '../../components/Modal.jsx';
import useDocumentTitle from '../../hooks/useDocumentTitle.js';
import StepCard from './workflows/StepCard.jsx';
import RunLogModal from './workflows/RunLogModal.jsx';
import WorkflowSidePanel from './workflows/WorkflowSidePanel.jsx';
import { useWorkflowEditor } from './workflows/useWorkflowEditor.js';
import {
  panel,
  label,
  input,
  inputMono,
  btnPrimary,
  btnGhost,
} from './workflows/workflowConstants.js';

function Banner({ kind, children, onClose }) {
  const styles = kind === 'error'
    ? 'border-red-500/30 bg-red-500/10 text-red-300'
    : 'border-orange-500/30 bg-orange-500/10 text-orange-200';
  return (
    <div role={kind === 'error' ? 'alert' : 'status'} className={`flex items-start justify-between gap-4 border ${styles} px-4 py-2.5 text-sm`}>
      <span className="break-words">{children}</span>
      {onClose && <button onClick={onClose} aria-label="Dismiss" className="shrink-0 text-lg leading-none opacity-60 hover:opacity-100">&times;</button>}
    </div>
  );
}

function ResetConfirmModal({ open, triggerLabel, onClose, onReset }) {
  if (!open) return null;
  return (
    <Modal title="Reset workflow" onClose={onClose} size="sm">
      <div className="space-y-5 p-5">
        <p className="text-sm text-gray-300">
          Reset <span className="font-mono text-orange-300">{triggerLabel}</span> to the built-in default steps and settings? Your customizations for this workflow will be discarded.
        </p>
        <div className="flex justify-end gap-3">
          <button className={btnGhost} onClick={onClose}>Cancel</button>
          <button className={btnPrimary} onClick={onReset}>Reset</button>
        </div>
      </div>
    </Modal>
  );
}

function WorkflowTopBar({ firewalls, selectedFw, onSelectFw }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="aaris-display text-xl text-gray-100">Provisioning Workflows</h1>
        <p className="mt-1 text-sm text-gray-500">Configure the exact FortiGate steps each provisioning flow runs — reorder, toggle, parametrize, and preview. Defaults reproduce the built-in behavior.</p>
      </div>
      {firewalls.length > 1 && (
        <div className="flex items-center gap-2">
          <span className={label}>Firewall</span>
          <select value={selectedFw || ''} onChange={(e) => onSelectFw(parseInt(e.target.value, 10))} className={inputMono}>
            {firewalls.map((fw) => <option key={fw.id} value={fw.id}>{fw.name}</option>)}
          </select>
        </div>
      )}
    </div>
  );
}

function WorkflowTabs({ triggers, workflows, currentTrigger, onSelectTrigger }) {
  return (
    <div className="flex flex-wrap gap-1.5 border-b border-gray-800 pb-3">
      {triggers.map((t) => {
        const wf = workflows.find((w) => w.trigger === t.trigger);
        const active = currentTrigger === t.trigger;
        const offSuffix = wf && !wf.enabled ? ' · off' : '';
        const btnCls = active
          ? 'border-orange-600 bg-orange-600/10 text-orange-300'
          : 'border-gray-800 text-gray-500 hover:border-gray-600 hover:text-gray-300';
        return (
          <button
            key={t.trigger}
            onClick={() => onSelectTrigger(t.trigger)}
            className={`border px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.1em] transition-colors ${btnCls}`}
          >
            {t.label}{offSuffix}
          </button>
        );
      })}
    </div>
  );
}

function WorkflowHeader({ workflow, trigger, triggerMeta, settings, setWorkflow, setSetting, setDirty }) {
  return (
    <div className={`${panel} p-4`}>
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex-1 min-w-[12rem]">
          <label className={`${label} mb-1 block`}>Workflow name</label>
          <input
            type="text"
            value={workflow.name}
            onChange={(e) => { setWorkflow((w) => ({ ...w, name: e.target.value })); setDirty(true); }}
            className={input}
          />
        </div>
        <label className="mt-5 flex items-center gap-2 text-sm text-gray-300">
          <input
            type="checkbox"
            checked={!!workflow.enabled}
            onChange={(e) => { setWorkflow((w) => ({ ...w, enabled: e.target.checked ? 1 : 0 })); setDirty(true); }}
            className="accent-orange-600"
          />
          <span className="font-mono text-[11px] uppercase tracking-wider">Enabled</span>
        </label>
      </div>
      <p className="mt-2 text-xs text-gray-600">
        {triggerMeta?.description}
        {workflow.is_default ? ' · Currently the built-in default.' : ' · Customized.'}
      </p>

      {trigger === 'vlan_provision' && (
        <div className="mt-3 border-t border-gray-800 pt-3">
          <label className={`${label} mb-1 block`}>Subnet derivation — first octet</label>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min="0"
              max="255"
              placeholder="10 (default)"
              value={settings.subnet?.firstOctet ?? ''}
              onChange={(e) => setSetting((s, v) => ({ subnet: { ...(s.subnet || {}), firstOctet: v === '' ? undefined : parseInt(v, 10) } }), e.target.value)}
              className={`${inputMono} w-32`}
            />
            <span className="text-xs text-gray-600">
              Tag 1126 → {(settings.subnet?.firstOctet ?? 10)}.11.26.0/24 · blank keeps the default 10.x.y formula
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

function WorkflowEditor({
  workflow,
  trigger,
  triggerMeta,
  settings,
  catalog,
  actionMap,
  dirty,
  saving,
  setWorkflow,
  setSetting,
  setDirty,
  editor,
  onOpenReset,
}) {
  return (
    <div className="space-y-4">
      <WorkflowHeader
        workflow={workflow}
        trigger={trigger}
        triggerMeta={triggerMeta}
        settings={settings}
        setWorkflow={setWorkflow}
        setSetting={setSetting}
        setDirty={setDirty}
      />

      {/* Steps */}
      <div className="space-y-3">
        {(workflow.steps || []).map((s, i) => (
          <StepCard
            key={i}
            step={s}
            index={i}
            count={workflow.steps.length}
            actions={catalog.actions}
            actionDef={actionMap[s.action]}
            onChange={(next) => editor.updateStep(i, next)}
            onMove={editor.moveStep}
            onRemove={editor.removeStep}
            onDragStart={editor.onDragStart}
            onDragOver={editor.onDragOver}
            onDrop={editor.onDrop}
            onFocusField={editor.onFocusField}
          />
        ))}
        {(workflow.steps || []).length === 0 && (
          <div className={`${panel} p-6 text-center text-sm text-gray-500`}>No steps. Add one below.</div>
        )}
      </div>

      {/* Add step */}
      <div className={`${panel} flex flex-wrap items-center gap-2 p-3`}>
        <span className={label}>Add step</span>
        <select id="add-step-action" defaultValue="" className={`${inputMono} max-w-[16rem]`} aria-label="Action to add">
          <option value="" disabled>Select action…</option>
          {catalog.actions.map((a) => <option key={a.action} value={a.action}>{a.label}</option>)}
        </select>
        <button
          className={btnGhost}
          onClick={() => {
            const el = document.getElementById('add-step-action');
            if (el?.value) editor.addStep(el.value);
          }}
        >
          + Add
        </button>
      </div>

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-2">
        <button className={btnPrimary} disabled={!dirty || saving} onClick={editor.save}>
          {saving ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}
        </button>
        <button className={btnGhost} onClick={onOpenReset}>Reset to default</button>
        {dirty && <span className="font-mono text-[10px] uppercase tracking-wider text-orange-400">Unsaved changes</span>}
      </div>
    </div>
  );
}

export default function WorkflowsPage() {
  useDocumentTitle('Workflows');

  const [firewalls, setFirewalls] = useState([]);
  const [selectedFw, setSelectedFw] = useState(null);
  const [catalog, setCatalog] = useState({ actions: [], triggers: [], variables: {} });
  const [workflows, setWorkflows] = useState([]);
  const [trigger, setTrigger] = useState(null);
  const [workflow, setWorkflow] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [resetOpen, setResetOpen] = useState(false);

  const [dryInputs, setDryInputs] = useState({});
  const [dryResult, setDryResult] = useState(null);
  const [dryRunning, setDryRunning] = useState(false);

  const [runs, setRuns] = useState([]);
  const [openRun, setOpenRun] = useState(null);

  const actionMap = useMemo(() => Object.fromEntries(catalog.actions.map((a) => [a.action, a])), [catalog]);
  const triggerMeta = useMemo(() => catalog.triggers.find((t) => t.trigger === trigger) || null, [catalog, trigger]);
  const variables = catalog.variables?.[trigger] || [];

  // Load firewalls + catalog
  useEffect(() => {
    Promise.all([api.get('/admin/firewalls'), api.get('/workflows/catalog')])
      .then(([fwRes, catRes]) => {
        setFirewalls(fwRes.data);
        setCatalog(catRes.data);
        if (fwRes.data.length > 0) setSelectedFw(fwRes.data[0].id);
      })
      .catch(() => setError('Failed to load firewalls or workflow catalog'))
      .finally(() => setLoading(false));
  }, []);

  // Load workflows for the selected firewall
  const loadWorkflows = useCallback(async (fwId) => {
    const r = await api.get('/workflows', { params: { firewallId: fwId } });
    setWorkflows(r.data);
    return r.data;
  }, []);

  useEffect(() => {
    if (!selectedFw) return;
    (async () => {
      try {
        const list = await loadWorkflows(selectedFw);
        const nextTrigger = list.find((w) => w.trigger === trigger)?.trigger || list[0]?.trigger || null;
        setTrigger(nextTrigger);
      } catch { setError('Failed to load workflows'); }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFw]);

  // Load the selected workflow bundle
  const loadWorkflow = useCallback(async (fwId, trg) => {
    const wf = workflows.find((w) => w.trigger === trg);
    if (!wf) return;
    const r = await api.get(`/workflows/${wf.id}`);
    setWorkflow(r.data);
    setDirty(false);
    setDryResult(null);
    setOpenRun(null);
    try {
      const runsRes = await api.get('/workflows/runs', { params: { firewallId: fwId, trigger: trg, limit: 25 } });
      setRuns(runsRes.data);
    } catch { setRuns([]); }
  }, [workflows]);

  useEffect(() => {
    if (selectedFw && trigger && workflows.length) loadWorkflow(selectedFw, trigger).catch(() => setError('Failed to load workflow'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFw, trigger, workflows]);

  const editor = useWorkflowEditor({
    workflow,
    setWorkflow,
    setDirty,
    actionMap,
    selectedFw,
    loadWorkflows,
    trigger,
    setNotice,
    setError,
    setSaving,
  });

  const runDryRun = async () => {
    setDryRunning(true);
    setError('');
    try {
      const r = await api.post(`/workflows/${workflow.id}/dry-run`, { inputs: dryInputs });
      setDryResult(r.data);
    } catch (err) {
      setError(err.response?.data?.error || 'Dry-run failed');
    } finally {
      setDryRunning(false);
    }
  };

  const viewRun = async (id) => {
    try {
      const r = await api.get(`/workflows/runs/${id}`);
      setOpenRun(r.data);
    } catch {
      setError('Failed to load run log');
    }
  };

  const settings = workflow?.settings || {};
  const setSetting = (path, value) => {
    setWorkflow((w) => ({ ...w, settings: { ...w.settings, ...path(w.settings || {}, value) } }));
    setDirty(true);
  };

  if (loading) return <div className="p-6 font-mono text-xs uppercase tracking-widest text-gray-500">Loading…</div>;

  return (
    <div className="mx-auto max-w-6xl space-y-5 p-6">
      <WorkflowTopBar firewalls={firewalls} selectedFw={selectedFw} onSelectFw={setSelectedFw} />

      {error && <Banner kind="error" onClose={() => setError('')}>{error}</Banner>}
      {notice && <Banner kind="info" onClose={() => setNotice('')}>{notice}</Banner>}

      {firewalls.length === 0 ? (
        <div className={`${panel} p-10 text-center text-sm text-gray-500`}>Register a firewall first — workflows are configured per firewall.</div>
      ) : (
        <>
          <WorkflowTabs
            triggers={catalog.triggers}
            workflows={workflows}
            currentTrigger={trigger}
            onSelectTrigger={setTrigger}
          />

          {workflow && (
            <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_20rem]">
              <WorkflowEditor
                workflow={workflow}
                trigger={trigger}
                triggerMeta={triggerMeta}
                settings={settings}
                catalog={catalog}
                actionMap={actionMap}
                dirty={dirty}
                saving={saving}
                setWorkflow={setWorkflow}
                setSetting={setSetting}
                setDirty={setDirty}
                editor={editor}
                onOpenReset={() => setResetOpen(true)}
              />

              <WorkflowSidePanel
                variables={variables}
                onInsertVariable={editor.insertVariable}
                trigger={trigger}
                dryInputs={dryInputs}
                setDryInputs={setDryInputs}
                onRunDryRun={runDryRun}
                dryRunning={dryRunning}
                dryResult={dryResult}
                runs={runs}
                onViewRun={viewRun}
              />
            </div>
          )}
        </>
      )}

      <ResetConfirmModal
        open={resetOpen}
        triggerLabel={triggerMeta?.label}
        onClose={() => setResetOpen(false)}
        onReset={() => editor.doReset(() => setResetOpen(false))}
      />

      <RunLogModal openRun={openRun} onClose={() => setOpenRun(null)} />
    </div>
  );
}
