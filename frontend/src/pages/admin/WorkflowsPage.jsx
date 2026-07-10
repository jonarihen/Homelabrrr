import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import api from '../../api.js';
import Modal from '../../components/Modal.jsx';
import useDocumentTitle from '../../hooks/useDocumentTitle.js';

// ── AARIS operator-console styling ────────────────────────────────────────────
const panel = 'border border-gray-800 bg-gray-900/60';
const label = 'font-mono text-[10px] uppercase tracking-[0.14em] text-gray-500';
const input = 'w-full bg-gray-950 border border-gray-700 text-gray-100 text-sm px-2.5 py-1.5 focus:border-orange-600 focus:outline-none';
const inputMono = `${input} font-mono`;
const btnPrimary = 'border border-orange-600 bg-orange-600 px-4 py-2 font-mono text-xs font-semibold uppercase tracking-[0.12em] text-gray-950 transition-colors hover:bg-orange-500 disabled:opacity-40 disabled:cursor-not-allowed';
const btnGhost = 'border border-gray-700 px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.1em] text-gray-400 transition-colors hover:border-gray-500 hover:text-gray-100 disabled:opacity-40';

const STATUS_LED = {
  ok: 'aaris-led--ok', skipped: 'aaris-led--off', condition_skipped: 'aaris-led--off',
  error: 'aaris-led--error', error_ignored: 'aaris-led--warning', rolled_back: 'aaris-led--warning',
  success: 'aaris-led--ok', failed: 'aaris-led--error',
};

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

// A single param field, typed from the catalog schema.
function ParamField({ spec, value, onChange, onFocusField }) {
  const common = { onFocus: onFocusField, 'aria-label': spec.name };
  if (spec.type === 'boolean') {
    return (
      <label className="flex items-center gap-2 py-1 text-sm text-gray-300">
        <input type="checkbox" checked={value === undefined ? !!spec.default : !!value}
          onChange={(e) => onChange(e.target.checked)} className="accent-orange-600" />
        <span className="font-mono text-xs">{spec.name}</span>
      </label>
    );
  }
  if (spec.type === 'select') {
    return (
      <select {...common} value={value ?? spec.default ?? ''} onChange={(e) => onChange(e.target.value)} className={inputMono}>
        {(spec.options || []).map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  }
  if (spec.type === 'stringlist') {
    const display = Array.isArray(value) ? value.join(', ') : (value ?? '');
    return (
      <input {...common} type="text" value={display}
        onChange={(e) => {
          const t = e.target.value;
          // A single "{{token}}" is kept as a template string (resolves to a list);
          // otherwise split into an explicit list.
          onChange(/^\s*\{\{[^}]+\}\}\s*$/.test(t) ? t : t.split(',').map((x) => x.trim()).filter(Boolean));
        }}
        placeholder="comma,separated or {{token}}" className={inputMono} />
    );
  }
  if (spec.type === 'json') {
    return (
      <textarea {...common} rows={3} value={typeof value === 'string' ? value : JSON.stringify(value ?? '', null, 2)}
        onChange={(e) => onChange(e.target.value)} placeholder='{ "key": "value" }' className={`${inputMono} resize-y`} />
    );
  }
  return (
    <input {...common} type="text" value={value ?? ''} onChange={(e) => onChange(e.target.value)}
      placeholder={spec.default !== undefined ? String(spec.default) : ''} className={inputMono} />
  );
}

function StepCard({ step, index, count, actionDef, actions, onChange, onMove, onRemove, onDragStart, onDragOver, onDrop, onFocusField }) {
  const setParam = (name, v) => onChange({ ...step, params: { ...step.params, [name]: v } });
  return (
    <div
      draggable
      onDragStart={(e) => onDragStart(e, index)}
      onDragOver={(e) => onDragOver(e, index)}
      onDrop={(e) => onDrop(e, index)}
      className={`${panel} p-3`}
    >
      <div className="flex items-center gap-2">
        <span className="cursor-grab select-none px-1 font-mono text-gray-600" title="Drag to reorder" aria-hidden="true">⋮⋮</span>
        <span className={`${label} text-orange-500`}>{String(index + 1).padStart(2, '0')}</span>
        <select value={step.action} onChange={(e) => onChange({ ...step, action: e.target.value, params: defaultParams(actions.find((a) => a.action === e.target.value)) })}
          className={`${inputMono} max-w-[16rem]`} aria-label="Step action">
          {actions.map((a) => <option key={a.action} value={a.action}>{a.label}</option>)}
        </select>
        <input type="text" value={step.step_key || ''} onChange={(e) => onChange({ ...step, step_key: e.target.value })}
          placeholder="step key" aria-label="Step key" className={`${inputMono} w-28`} />
        <div className="ml-auto flex items-center gap-1">
          <button onClick={() => onMove(index, -1)} disabled={index === 0} className={btnGhost} aria-label="Move up">↑</button>
          <button onClick={() => onMove(index, 1)} disabled={index === count - 1} className={btnGhost} aria-label="Move down">↓</button>
          <button onClick={() => onRemove(index)} className="border border-red-600/50 px-2.5 py-1.5 font-mono text-[11px] uppercase text-red-400 hover:bg-red-600/10" aria-label="Remove step">Del</button>
        </div>
      </div>

      {actionDef?.description && <p className="mt-2 text-xs text-gray-500">{actionDef.description}</p>}

      <div className="mt-3 grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
        {(actionDef?.params || []).map((spec) => (
          <div key={spec.name} className={spec.type === 'json' || spec.type === 'stringlist' ? 'sm:col-span-2' : ''}>
            {spec.type !== 'boolean' && (
              <label className={`${label} mb-1 block`}>
                {spec.name}{spec.required && <span className="text-orange-500"> *</span>}
                {spec.help && <span className="ml-1 lowercase tracking-normal text-gray-600">— {spec.help}</span>}
              </label>
            )}
            <ParamField spec={spec} value={step.params?.[spec.name]}
              onChange={(v) => setParam(spec.name, v)}
              onFocusField={() => onFocusField(index, spec.name, spec.type)} />
          </div>
        ))}
        {(actionDef?.params || []).length === 0 && (
          <p className="text-xs text-gray-600 sm:col-span-2">This action takes no parameters.</p>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-4 border-t border-gray-800 pt-3">
        <div className="flex items-center gap-2">
          <span className={label}>condition</span>
          <input type="text" value={step.condition || ''} onChange={(e) => onChange({ ...step, condition: e.target.value })}
            placeholder="always" aria-label="Run condition" className={`${inputMono} w-48`}
            onFocus={() => onFocusField(index, '__condition', 'string')} />
        </div>
        <label className="flex items-center gap-2 text-sm text-gray-300">
          <input type="checkbox" checked={step.enabled !== 0 && step.enabled !== false} onChange={(e) => onChange({ ...step, enabled: e.target.checked ? 1 : 0 })} className="accent-orange-600" />
          <span className="font-mono text-[11px] uppercase tracking-wider">Enabled</span>
        </label>
        <label className="flex items-center gap-2 text-sm text-gray-300">
          <input type="checkbox" checked={!!step.continue_on_error} onChange={(e) => onChange({ ...step, continue_on_error: e.target.checked ? 1 : 0 })} className="accent-orange-600" />
          <span className="font-mono text-[11px] uppercase tracking-wider">Continue on error</span>
        </label>
      </div>
    </div>
  );
}

function defaultParams(actionDef) {
  const p = {};
  for (const spec of (actionDef?.params || [])) {
    if (spec.default !== undefined) p[spec.name] = spec.default;
  }
  return p;
}

function CallList({ calls }) {
  if (!calls || calls.length === 0) return null;
  return (
    <div className="mt-2 space-y-1">
      {calls.map((c, i) => (
        <div key={i} className="border border-gray-800 bg-gray-950 px-2.5 py-1.5 font-mono text-[11px]">
          <div className="flex items-center gap-2">
            <span className="text-orange-500">{c.method}</span>
            <span className="text-gray-300">/api/v2/{c.path}</span>
            {c.scope && <span className="text-gray-600">· {c.scope}</span>}
          </div>
          {c.summary && <div className="mt-0.5 text-gray-500">{c.summary}</div>}
          {c.body && <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all text-[10px] text-gray-400">{JSON.stringify(c.body)}</pre>}
        </div>
      ))}
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
  const [workflow, setWorkflow] = useState(null); // { id, trigger, name, enabled, settings, steps }
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

  const dragFrom = useRef(null);
  const focusedField = useRef(null); // { index, param }

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
    // Load recent runs for this firewall+trigger
    try {
      const runsRes = await api.get('/workflows/runs', { params: { firewallId: fwId, trigger: trg, limit: 25 } });
      setRuns(runsRes.data);
    } catch { setRuns([]); }
  }, [workflows]);

  useEffect(() => {
    if (selectedFw && trigger && workflows.length) loadWorkflow(selectedFw, trigger).catch(() => setError('Failed to load workflow'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFw, trigger, workflows]);

  const updateSteps = (steps) => { setWorkflow((w) => ({ ...w, steps })); setDirty(true); };
  const updateStep = (i, next) => updateSteps(workflow.steps.map((s, idx) => (idx === i ? next : s)));
  const moveStep = (i, dir) => {
    const j = i + dir;
    if (j < 0 || j >= workflow.steps.length) return;
    const copy = [...workflow.steps];
    [copy[i], copy[j]] = [copy[j], copy[i]];
    updateSteps(copy);
  };
  const removeStep = (i) => updateSteps(workflow.steps.filter((_, idx) => idx !== i));
  const addStep = (action) => {
    const def = actionMap[action];
    updateSteps([...(workflow.steps || []), {
      step_key: `${action}_${(workflow.steps?.length || 0) + 1}`,
      action, label: def?.label || '', params: defaultParams(def), condition: '', enabled: 1, continue_on_error: 0,
    }]);
  };

  const onDragStart = (e, i) => { dragFrom.current = i; e.dataTransfer.effectAllowed = 'move'; };
  const onDragOver = (e) => { e.preventDefault(); };
  const onDrop = (e, i) => {
    e.preventDefault();
    const from = dragFrom.current;
    if (from === null || from === i) return;
    const copy = [...workflow.steps];
    const [moved] = copy.splice(from, 1);
    copy.splice(i, 0, moved);
    dragFrom.current = null;
    updateSteps(copy);
  };

  const onFocusField = (index, param, type) => { focusedField.current = { index, param, type }; };
  const insertVariable = (token) => {
    const f = focusedField.current;
    if (!f || !workflow) { navigator.clipboard?.writeText(token); setNotice(`Copied ${token} — focus a field to insert directly`); return; }
    const step = workflow.steps[f.index];
    if (!step) return;
    if (f.param === '__condition') { updateStep(f.index, { ...step, condition: token }); return; }
    const cur = step.params?.[f.param];
    const next = typeof cur === 'string' && cur ? `${cur}${token}` : token;
    updateStep(f.index, { ...step, params: { ...step.params, [f.param]: next } });
  };

  const save = async () => {
    if (!workflow) return;
    setSaving(true); setError(''); setNotice('');
    try {
      await api.put(`/workflows/${workflow.id}`, { name: workflow.name, enabled: workflow.enabled ? 1 : 0, settings: workflow.settings || {} });
      await api.put(`/workflows/${workflow.id}/steps`, { steps: workflow.steps });
      setDirty(false);
      setNotice('Workflow saved. The next run uses the edited flow.');
      await loadWorkflows(selectedFw);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save workflow');
    } finally { setSaving(false); }
  };

  const doReset = async () => {
    setResetOpen(false);
    try {
      await api.post(`/workflows/${workflow.id}/reset`);
      setNotice('Workflow reset to the built-in default.');
      const list = await loadWorkflows(selectedFw);
      const wf = list.find((w) => w.trigger === trigger);
      if (wf) { const r = await api.get(`/workflows/${wf.id}`); setWorkflow(r.data); setDirty(false); }
    } catch (err) { setError(err.response?.data?.error || 'Failed to reset'); }
  };

  const runDryRun = async () => {
    setDryRunning(true); setError('');
    try {
      const r = await api.post(`/workflows/${workflow.id}/dry-run`, { inputs: dryInputs });
      setDryResult(r.data);
    } catch (err) { setError(err.response?.data?.error || 'Dry-run failed'); }
    finally { setDryRunning(false); }
  };

  const viewRun = async (id) => {
    try { const r = await api.get(`/workflows/runs/${id}`); setOpenRun(r.data); }
    catch { setError('Failed to load run log'); }
  };

  const settings = workflow?.settings || {};
  const setSetting = (path, value) => { setWorkflow((w) => ({ ...w, settings: { ...w.settings, ...path(w.settings || {}, value) } })); setDirty(true); };

  if (loading) return <div className="p-6 font-mono text-xs uppercase tracking-widest text-gray-500">Loading…</div>;

  return (
    <div className="mx-auto max-w-6xl space-y-5 p-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="aaris-display text-xl text-gray-100">Provisioning Workflows</h1>
          <p className="mt-1 text-sm text-gray-500">Configure the exact FortiGate steps each provisioning flow runs — reorder, toggle, parametrize, and preview. Defaults reproduce the built-in behavior.</p>
        </div>
        {firewalls.length > 1 && (
          <div className="flex items-center gap-2">
            <span className={label}>Firewall</span>
            <select value={selectedFw || ''} onChange={(e) => setSelectedFw(parseInt(e.target.value, 10))} className={inputMono}>
              {firewalls.map((fw) => <option key={fw.id} value={fw.id}>{fw.name}</option>)}
            </select>
          </div>
        )}
      </div>

      {error && <Banner kind="error" onClose={() => setError('')}>{error}</Banner>}
      {notice && <Banner kind="info" onClose={() => setNotice('')}>{notice}</Banner>}

      {firewalls.length === 0 ? (
        <div className={`${panel} p-10 text-center text-sm text-gray-500`}>Register a firewall first — workflows are configured per firewall.</div>
      ) : (
        <>
          {/* Trigger tabs */}
          <div className="flex flex-wrap gap-1.5 border-b border-gray-800 pb-3">
            {catalog.triggers.map((t) => {
              const wf = workflows.find((w) => w.trigger === t.trigger);
              const active = trigger === t.trigger;
              return (
                <button key={t.trigger} onClick={() => setTrigger(t.trigger)}
                  className={`border px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.1em] transition-colors ${active ? 'border-orange-600 bg-orange-600/10 text-orange-300' : 'border-gray-800 text-gray-500 hover:border-gray-600 hover:text-gray-300'}`}>
                  {t.label}{wf && wf.enabled === 0 ? ' · off' : ''}
                </button>
              );
            })}
          </div>

          {workflow && (
            <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_20rem]">
              {/* Editor column */}
              <div className="space-y-4">
                {/* Workflow header */}
                <div className={`${panel} p-4`}>
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="flex-1 min-w-[12rem]">
                      <label className={`${label} mb-1 block`}>Workflow name</label>
                      <input type="text" value={workflow.name} onChange={(e) => { setWorkflow((w) => ({ ...w, name: e.target.value })); setDirty(true); }} className={input} />
                    </div>
                    <label className="mt-5 flex items-center gap-2 text-sm text-gray-300">
                      <input type="checkbox" checked={!!workflow.enabled} onChange={(e) => { setWorkflow((w) => ({ ...w, enabled: e.target.checked ? 1 : 0 })); setDirty(true); }} className="accent-orange-600" />
                      <span className="font-mono text-[11px] uppercase tracking-wider">Enabled</span>
                    </label>
                  </div>
                  <p className="mt-2 text-xs text-gray-600">{triggerMeta?.description}{workflow.is_default ? ' · Currently the built-in default.' : ' · Customized.'}</p>

                  {/* Subnet derivation setting (VLAN provision only) */}
                  {trigger === 'vlan_provision' && (
                    <div className="mt-3 border-t border-gray-800 pt-3">
                      <label className={`${label} mb-1 block`}>Subnet derivation — first octet</label>
                      <div className="flex items-center gap-2">
                        <input type="number" min="0" max="255" placeholder="10 (default)"
                          value={settings.subnet?.firstOctet ?? ''}
                          onChange={(e) => setSetting((s, v) => ({ subnet: { ...(s.subnet || {}), firstOctet: v === '' ? undefined : parseInt(v, 10) } }), e.target.value)}
                          className={`${inputMono} w-32`} />
                        <span className="text-xs text-gray-600">Tag 1126 → {(settings.subnet?.firstOctet ?? 10)}.11.26.0/24 · blank keeps the default 10.x.y formula</span>
                      </div>
                    </div>
                  )}
                </div>

                {/* Steps */}
                <div className="space-y-3">
                  {(workflow.steps || []).map((s, i) => (
                    <StepCard key={i} step={s} index={i} count={workflow.steps.length}
                      actions={catalog.actions} actionDef={actionMap[s.action]}
                      onChange={(next) => updateStep(i, next)} onMove={moveStep} onRemove={removeStep}
                      onDragStart={onDragStart} onDragOver={onDragOver} onDrop={onDrop} onFocusField={onFocusField} />
                  ))}
                  {(workflow.steps || []).length === 0 && <div className={`${panel} p-6 text-center text-sm text-gray-500`}>No steps. Add one below.</div>}
                </div>

                {/* Add step */}
                <div className={`${panel} flex flex-wrap items-center gap-2 p-3`}>
                  <span className={label}>Add step</span>
                  <select id="add-step-action" defaultValue="" className={`${inputMono} max-w-[16rem]`} aria-label="Action to add">
                    <option value="" disabled>Select action…</option>
                    {catalog.actions.map((a) => <option key={a.action} value={a.action}>{a.label}</option>)}
                  </select>
                  <button className={btnGhost} onClick={() => { const el = document.getElementById('add-step-action'); if (el?.value) addStep(el.value); }}>+ Add</button>
                </div>

                {/* Actions */}
                <div className="flex flex-wrap items-center gap-2">
                  <button className={btnPrimary} disabled={!dirty || saving} onClick={save}>{saving ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}</button>
                  <button className={btnGhost} onClick={() => setResetOpen(true)}>Reset to default</button>
                  {dirty && <span className="font-mono text-[10px] uppercase tracking-wider text-orange-400">Unsaved changes</span>}
                </div>
              </div>

              {/* Side column: variables, dry-run, runs */}
              <div className="space-y-4">
                {/* Variable picker */}
                <div className={`${panel} p-4`}>
                  <h3 className={`${label} mb-2`}>Variables</h3>
                  {variables.length === 0 ? (
                    <p className="text-xs text-gray-600">This trigger performs artifact-based teardown — no template variables.</p>
                  ) : (
                    <>
                      <p className="mb-2 text-[11px] text-gray-600">Focus a field, then click to insert (or copy).</p>
                      <div className="flex flex-wrap gap-1.5">
                        {variables.map((v) => (
                          <button key={v} onClick={() => insertVariable(v)}
                            className="border border-gray-700 px-1.5 py-0.5 font-mono text-[10px] text-gray-400 hover:border-orange-600 hover:text-orange-300">
                            {v}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>

                {/* Dry-run */}
                <div className={`${panel} p-4`}>
                  <h3 className={`${label} mb-2`}>Dry-run preview</h3>
                  <DryRunInputs trigger={trigger} inputs={dryInputs} setInputs={setDryInputs} />
                  <button className={`${btnGhost} mt-2`} onClick={runDryRun} disabled={dryRunning}>{dryRunning ? 'Rendering…' : 'Preview calls'}</button>
                  {dryResult && (
                    <div className="mt-3 space-y-2">
                      {dryResult.preview.map((item) => (
                        <div key={item.position} className="border border-gray-800 bg-gray-950/60 p-2">
                          <div className="flex items-center gap-2">
                            <span className={`aaris-led ${item.error ? 'aaris-led--error' : item.skipped ? 'aaris-led--off' : 'aaris-led--ok'}`} />
                            <span className="font-mono text-[11px] text-gray-300">{item.label}</span>
                            {item.skipped && <span className="font-mono text-[10px] uppercase text-gray-600">{item.skipped}</span>}
                          </div>
                          {item.error && <p className="mt-1 text-[11px] text-red-400">{item.error}</p>}
                          <CallList calls={item.calls} />
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Recent runs */}
                <div className={`${panel} p-4`}>
                  <h3 className={`${label} mb-2`}>Recent runs</h3>
                  {runs.length === 0 ? (
                    <p className="text-xs text-gray-600">No runs recorded yet.</p>
                  ) : (
                    <div className="space-y-1">
                      {runs.map((r) => (
                        <button key={r.id} onClick={() => viewRun(r.id)} className="flex w-full items-center gap-2 border border-gray-800 px-2 py-1.5 text-left hover:border-gray-600">
                          <span className={`aaris-led ${STATUS_LED[r.status] || 'aaris-led--off'}`} />
                          <span className="font-mono text-[11px] text-gray-300">{r.subject_label || r.subject_id || r.subject_type}</span>
                          <span className="ml-auto font-mono text-[10px] uppercase text-gray-600">{r.status}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {/* Reset confirm */}
      {resetOpen && (
        <Modal title="Reset workflow" onClose={() => setResetOpen(false)} size="sm">
          <div className="space-y-5 p-5">
            <p className="text-sm text-gray-300">Reset <span className="font-mono text-orange-300">{triggerMeta?.label}</span> to the built-in default steps and settings? Your customizations for this workflow will be discarded.</p>
            <div className="flex justify-end gap-3">
              <button className={btnGhost} onClick={() => setResetOpen(false)}>Cancel</button>
              <button className={btnPrimary} onClick={doReset}>Reset</button>
            </div>
          </div>
        </Modal>
      )}

      {/* Run log viewer */}
      {openRun && (
        <Modal title={`Run log — ${openRun.subject_label || openRun.subject_type}`} onClose={() => setOpenRun(null)} size="xl">
          <div className="space-y-4 p-5">
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <span className={`aaris-led ${STATUS_LED[openRun.status] || 'aaris-led--off'}`} />
              <span className="font-mono uppercase tracking-wider text-gray-300">{openRun.status}</span>
              <span className="text-gray-600">·</span>
              <span className="text-gray-500">{openRun.trigger}</span>
              <span className="text-gray-600">·</span>
              <span className="text-gray-500">{openRun.created_at}</span>
            </div>

            <div className="space-y-2">
              {(openRun.log || []).map((entry, i) => (
                <div key={i} className={`${panel} p-3`}>
                  <div className="flex items-center gap-2">
                    <span className={`aaris-led ${STATUS_LED[entry.status] || 'aaris-led--off'}`} />
                    <span className="font-mono text-[11px] text-gray-300">{entry.label || entry.action}</span>
                    <span className="ml-auto font-mono text-[10px] uppercase text-gray-600">{entry.status}</span>
                  </div>
                  {entry.summary && <p className="mt-1 text-xs text-gray-500">{entry.summary}</p>}
                  {entry.error && <p className="mt-1 text-xs text-red-400">{entry.error}</p>}
                  {entry.artifacts?.length > 0 && <p className="mt-1 font-mono text-[10px] text-gray-600">created: {entry.artifacts.join(', ')}</p>}
                  <CallList calls={entry.calls} />
                  {entry.reverted && (
                    <div className="mt-1 space-y-0.5">
                      {entry.reverted.map((rv, j) => (
                        <p key={j} className={`font-mono text-[10px] ${rv.ok ? 'text-gray-500' : 'text-red-400'}`}>rollback: {rv.artifact} {rv.ok ? '✓' : `✗ ${rv.error}`}</p>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>

            {openRun.artifacts?.length > 0 && (
              <div>
                <h4 className={`${label} mb-1`}>Recorded artifacts ({openRun.artifacts.length})</h4>
                <pre className="overflow-x-auto border border-gray-800 bg-gray-950 p-2 font-mono text-[10px] text-gray-400">{JSON.stringify(openRun.artifacts, null, 2)}</pre>
              </div>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}

// Trigger-specific dry-run inputs.
function DryRunInputs({ trigger, inputs, setInputs }) {
  const set = (k, v) => setInputs((p) => ({ ...p, [k]: v }));
  const field = (k, ph, type = 'text') => (
    <input type={type} value={inputs[k] ?? ''} onChange={(e) => set(k, type === 'number' ? e.target.value : e.target.value)} placeholder={ph} className={`${inputMono} w-full`} aria-label={k} />
  );
  if (trigger === 'vlan_provision' || trigger === 'vlan_deprovision') {
    return (
      <div className="space-y-2">
        <div><label className={`${label} mb-1 block`}>VLAN tag</label>{field('tag', '1126', 'number')}</div>
        <div><label className={`${label} mb-1 block`}>Name</label>{field('name', 'lab-net')}</div>
        <div className="flex gap-4">
          <label className="flex items-center gap-1.5 text-xs text-gray-300"><input type="checkbox" checked={inputs.allowInternet !== false} onChange={(e) => set('allowInternet', e.target.checked)} className="accent-orange-600" />internet</label>
          <label className="flex items-center gap-1.5 text-xs text-gray-300"><input type="checkbox" checked={inputs.enableDhcp !== false} onChange={(e) => set('enableDhcp', e.target.checked)} className="accent-orange-600" />dhcp</label>
        </div>
      </div>
    );
  }
  if (trigger === 'port_forward_create' || trigger === 'port_forward_delete') {
    return (
      <div className="space-y-2">
        <div><label className={`${label} mb-1 block`}>Name</label>{field('name', 'web-http')}</div>
        <div className="grid grid-cols-2 gap-2">
          <div><label className={`${label} mb-1 block`}>Protocol</label>
            <select value={inputs.protocol || 'tcp'} onChange={(e) => set('protocol', e.target.value)} className={`${inputMono} w-full`}><option value="tcp">tcp</option><option value="udp">udp</option></select>
          </div>
          <div><label className={`${label} mb-1 block`}>Ext port</label>{field('externalPort', '8080', 'number')}</div>
          <div><label className={`${label} mb-1 block`}>Internal IP</label>{field('internalIp', '10.11.26.50')}</div>
          <div><label className={`${label} mb-1 block`}>Internal port</label>{field('internalPort', '80', 'number')}</div>
          <div className="col-span-2"><label className={`${label} mb-1 block`}>VLAN interface</label>{field('vlanInterface', 'vlan1126')}</div>
        </div>
      </div>
    );
  }
  if (trigger === 'policy_create' || trigger === 'policy_delete') {
    return (
      <div className="space-y-2">
        <div><label className={`${label} mb-1 block`}>Src interface</label>{field('srcInterface', 'vlan1126')}</div>
        <div><label className={`${label} mb-1 block`}>Dst interface</label>{field('dstInterface', 'vlan1127')}</div>
        <label className="flex items-center gap-1.5 text-xs text-gray-300"><input type="checkbox" checked={inputs.bidirectional === true} onChange={(e) => set('bidirectional', e.target.checked)} className="accent-orange-600" />bidirectional</label>
      </div>
    );
  }
  return <p className="text-xs text-gray-600">No inputs for this trigger.</p>;
}
