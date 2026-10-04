import { useRef, useCallback } from 'react';
import api from '../../../api.js';
import { defaultParams } from './workflowConstants.js';

export function moveStepInList(steps, i, dir) {
  if (!steps) return steps;
  const j = i + dir;
  if (j < 0 || j >= steps.length) return steps;
  const copy = [...steps];
  [copy[i], copy[j]] = [copy[j], copy[i]];
  return copy;
}

export function reorderStepsList(steps, from, to) {
  if (from === null || from === to || !steps) return steps;
  const copy = [...steps];
  const [moved] = copy.splice(from, 1);
  copy.splice(to, 0, moved);
  return copy;
}

export function applyVariableToStep(step, param, token) {
  if (param === '__condition') {
    return { ...step, condition: token };
  }
  const cur = step.params?.[param];
  const next = typeof cur === 'string' && cur ? `${cur}${token}` : token;
  return { ...step, params: { ...step.params, [param]: next } };
}

export function createStepFromAction(action, def, stepCount) {
  return {
    step_key: `${action}_${stepCount + 1}`,
    action,
    label: def?.label || '',
    params: defaultParams(def),
    condition: '',
    enabled: 1,
    continue_on_error: 0,
  };
}

export function useWorkflowEditor({
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
}) {
  const dragFrom = useRef(null);
  const focusedField = useRef(null);

  const updateStep = useCallback((i, next) => {
    setWorkflow((w) => ({ ...w, steps: w.steps.map((s, idx) => (idx === i ? next : s)) }));
    setDirty(true);
  }, [setWorkflow, setDirty]);

  const moveStep = useCallback((i, dir) => {
    setWorkflow((w) => ({ ...w, steps: moveStepInList(w.steps, i, dir) }));
    setDirty(true);
  }, [setWorkflow, setDirty]);

  const removeStep = useCallback((i) => {
    setWorkflow((w) => ({ ...w, steps: (w.steps || []).filter((_, idx) => idx !== i) }));
    setDirty(true);
  }, [setWorkflow, setDirty]);

  const addStep = useCallback((action) => {
    const def = actionMap[action];
    setWorkflow((w) => ({
      ...w,
      steps: [...(w.steps || []), createStepFromAction(action, def, w.steps?.length || 0)],
    }));
    setDirty(true);
  }, [actionMap, setWorkflow, setDirty]);

  const onDragStart = (e, i) => {
    dragFrom.current = i;
    e.dataTransfer.effectAllowed = 'move';
  };

  const onDragOver = (e) => {
    e.preventDefault();
  };

  const onDrop = (e, i) => {
    e.preventDefault();
    const from = dragFrom.current;
    dragFrom.current = null;
    setWorkflow((w) => ({ ...w, steps: reorderStepsList(w.steps, from, i) }));
    setDirty(true);
  };

  const onFocusField = (index, param, type) => {
    focusedField.current = { index, param, type };
  };

  const insertVariable = (token) => {
    const f = focusedField.current;
    if (!f || !workflow?.steps) {
      navigator.clipboard?.writeText(token);
      setNotice(`Copied ${token} — focus a field to insert directly`);
      return;
    }
    const step = workflow.steps[f.index];
    if (step) {
      updateStep(f.index, applyVariableToStep(step, f.param, token));
    }
  };

  const save = async () => {
    if (!workflow) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      await api.put(`/workflows/${workflow.id}`, {
        name: workflow.name,
        enabled: workflow.enabled ? 1 : 0,
        settings: workflow.settings || {},
      });
      await api.put(`/workflows/${workflow.id}/steps`, { steps: workflow.steps });
      setDirty(false);
      setNotice('Workflow saved. The next run uses the edited flow.');
      await loadWorkflows(selectedFw);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save workflow');
    } finally {
      setSaving(false);
    }
  };

  const doReset = async (onCloseModal) => {
    onCloseModal();
    try {
      await api.post(`/workflows/${workflow.id}/reset`);
      setNotice('Workflow reset to the built-in default.');
      const list = await loadWorkflows(selectedFw);
      const wf = list.find((w) => w.trigger === trigger);
      if (wf) {
        const r = await api.get(`/workflows/${wf.id}`);
        setWorkflow(r.data);
        setDirty(false);
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to reset');
    }
  };

  return {
    updateStep,
    moveStep,
    removeStep,
    addStep,
    onDragStart,
    onDragOver,
    onDrop,
    onFocusField,
    insertVariable,
    save,
    doReset,
  };
}
