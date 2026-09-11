import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import api from '../../api.js';
import { defaultParams } from './WorkflowPageComponents.jsx';

export default function useWorkflowPage() {
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
  const dragFrom = useRef(null);
  const focusedField = useRef(null);
  const actionMap = useMemo(() => Object.fromEntries(catalog.actions.map((action) => [action.action, action])), [catalog]);
  const triggerMeta = useMemo(() => catalog.triggers.find((item) => item.trigger === trigger) || null, [catalog, trigger]);
  const variables = catalog.variables?.[trigger] || [];

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

  const loadWorkflows = useCallback(async (fwId) => {
    const response = await api.get('/workflows', { params: { firewallId: fwId } });
    setWorkflows(response.data);
    return response.data;
  }, []);

  useEffect(() => {
    if (!selectedFw) return;
    (async () => {
      try {
        const list = await loadWorkflows(selectedFw);
        setTrigger((current) => list.find((item) => item.trigger === current)?.trigger || list[0]?.trigger || null);
      } catch { setError('Failed to load workflows'); }
    })();
  }, [selectedFw, loadWorkflows]);

  const loadWorkflow = useCallback(async (fwId, selectedTrigger) => {
    const match = workflows.find((item) => item.trigger === selectedTrigger);
    if (!match) return;
    const response = await api.get(`/workflows/${match.id}`);
    setWorkflow(response.data);
    setDirty(false);
    setDryResult(null);
    setOpenRun(null);
    try {
      const runsResponse = await api.get('/workflows/runs', { params: { firewallId: fwId, trigger: selectedTrigger, limit: 25 } });
      setRuns(runsResponse.data);
    } catch { setRuns([]); }
  }, [workflows]);

  useEffect(() => {
    if (selectedFw && trigger && workflows.length) loadWorkflow(selectedFw, trigger).catch(() => setError('Failed to load workflow'));
  }, [selectedFw, trigger, workflows, loadWorkflow]);

  const updateSteps = (steps) => { setWorkflow((current) => ({ ...current, steps })); setDirty(true); };
  const updateStep = (index, next) => updateSteps(workflow.steps.map((step, stepIndex) => (stepIndex === index ? next : step)));
  const moveStep = (index, direction) => {
    const target = index + direction;
    if (target < 0 || target >= workflow.steps.length) return;
    const copy = [...workflow.steps];
    [copy[index], copy[target]] = [copy[target], copy[index]];
    updateSteps(copy);
  };
  const removeStep = (index) => updateSteps(workflow.steps.filter((_, stepIndex) => stepIndex !== index));
  const addStep = (action) => {
    const definition = actionMap[action];
    updateSteps([...(workflow.steps || []), { step_key: `${action}_${(workflow.steps?.length || 0) + 1}`, action, label: definition?.label || '', params: defaultParams(definition), condition: '', enabled: 1, continue_on_error: 0 }]);
  };
  const onDragStart = (event, index) => { dragFrom.current = index; event.dataTransfer.effectAllowed = 'move'; };
  const onDragOver = (event) => event.preventDefault();
  const onDrop = (event, index) => {
    event.preventDefault();
    const from = dragFrom.current;
    if (from === null || from === index) return;
    const copy = [...workflow.steps];
    const [moved] = copy.splice(from, 1);
    copy.splice(index, 0, moved);
    dragFrom.current = null;
    updateSteps(copy);
  };
  const onFocusField = (index, param, type) => { focusedField.current = { index, param, type }; };
  const insertVariable = (token) => {
    const focused = focusedField.current;
    if (!focused || !workflow) {
      navigator.clipboard?.writeText(token);
      setNotice(`Copied ${token} — focus a field to insert directly`);
      return;
    }
    const step = workflow.steps[focused.index];
    if (!step) return;
    if (focused.param === '__condition') {
      updateStep(focused.index, { ...step, condition: token });
      return;
    }
    const current = step.params?.[focused.param];
    const next = typeof current === 'string' && current ? `${current}${token}` : token;
    updateStep(focused.index, { ...step, params: { ...step.params, [focused.param]: next } });
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
    } catch (err) { setError(err.response?.data?.error || 'Failed to save workflow'); }
    finally { setSaving(false); }
  };
  const doReset = async () => {
    setResetOpen(false);
    try {
      await api.post(`/workflows/${workflow.id}/reset`);
      setNotice('Workflow reset to the built-in default.');
      const list = await loadWorkflows(selectedFw);
      const match = list.find((item) => item.trigger === trigger);
      if (match) {
        const response = await api.get(`/workflows/${match.id}`);
        setWorkflow(response.data);
        setDirty(false);
      }
    } catch (err) { setError(err.response?.data?.error || 'Failed to reset'); }
  };
  const runDryRun = async () => {
    setDryRunning(true); setError('');
    try { setDryResult((await api.post(`/workflows/${workflow.id}/dry-run`, { inputs: dryInputs })).data); }
    catch (err) { setError(err.response?.data?.error || 'Dry-run failed'); }
    finally { setDryRunning(false); }
  };
  const viewRun = async (id) => {
    try { setOpenRun((await api.get(`/workflows/runs/${id}`)).data); }
    catch { setError('Failed to load run log'); }
  };
  const setSetting = (path, value) => { setWorkflow((current) => ({ ...current, settings: { ...current.settings, ...path(current.settings || {}, value) } })); setDirty(true); };

  return {
    firewalls, selectedFw, setSelectedFw, catalog, workflows, trigger, setTrigger,
    workflow, setWorkflow, dirty, setDirty, loading, saving, error, setError,
    notice, setNotice, resetOpen, setResetOpen, dryInputs, setDryInputs,
    dryResult, dryRunning, runs, openRun, setOpenRun, actionMap, triggerMeta,
    variables, updateStep, moveStep, removeStep, addStep, onDragStart, onDragOver,
    onDrop, onFocusField, insertVariable, save, doReset, runDryRun, viewRun, setSetting,
  };
}
