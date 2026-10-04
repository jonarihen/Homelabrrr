import { panel, label, inputMono, btnGhost, defaultParams } from './workflowConstants.js';

// A single param field, typed from the catalog schema.
function ParamField({ spec, value, onChange, onFocusField }) {
  const common = { onFocus: onFocusField, 'aria-label': spec.name };

  if (spec.type === 'boolean') {
    return (
      <label className="flex items-center gap-2 py-1 text-sm text-gray-300">
        <input
          type="checkbox"
          checked={value === undefined ? !!spec.default : !!value}
          onChange={(e) => onChange(e.target.checked)}
          className="accent-orange-600"
        />
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
      <input
        {...common}
        type="text"
        value={display}
        onChange={(e) => {
          const t = e.target.value;
          onChange(/^\s*\{\{[^}]+\}\}\s*$/.test(t) ? t : t.split(',').map((x) => x.trim()).filter(Boolean));
        }}
        placeholder="comma,separated or {{token}}"
        className={inputMono}
      />
    );
  }

  if (spec.type === 'json') {
    return (
      <textarea
        {...common}
        rows={3}
        value={typeof value === 'string' ? value : JSON.stringify(value ?? '', null, 2)}
        onChange={(e) => onChange(e.target.value)}
        placeholder='{ "key": "value" }'
        className={`${inputMono} resize-y`}
      />
    );
  }

  return (
    <input
      {...common}
      type="text"
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value)}
      placeholder={spec.default !== undefined ? String(spec.default) : ''}
      className={inputMono}
    />
  );
}

export default function StepCard({
  step,
  index,
  count,
  actionDef,
  actions,
  onChange,
  onMove,
  onRemove,
  onDragStart,
  onDragOver,
  onDrop,
  onFocusField,
}) {
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
        <select
          value={step.action}
          onChange={(e) => onChange({ ...step, action: e.target.value, params: defaultParams(actions.find((a) => a.action === e.target.value)) })}
          className={`${inputMono} max-w-[16rem]`}
          aria-label="Step action"
        >
          {actions.map((a) => <option key={a.action} value={a.action}>{a.label}</option>)}
        </select>
        <input
          type="text"
          value={step.step_key || ''}
          onChange={(e) => onChange({ ...step, step_key: e.target.value })}
          placeholder="step key"
          aria-label="Step key"
          className={`${inputMono} w-28`}
        />
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
            <ParamField
              spec={spec}
              value={step.params?.[spec.name]}
              onChange={(v) => setParam(spec.name, v)}
              onFocusField={() => onFocusField(index, spec.name, spec.type)}
            />
          </div>
        ))}
        {(actionDef?.params || []).length === 0 && (
          <p className="text-xs text-gray-600 sm:col-span-2">This action takes no parameters.</p>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-4 border-t border-gray-800 pt-3">
        <div className="flex items-center gap-2">
          <span className={label}>condition</span>
          <input
            type="text"
            value={step.condition || ''}
            onChange={(e) => onChange({ ...step, condition: e.target.value })}
            placeholder="always"
            aria-label="Run condition"
            className={`${inputMono} w-48`}
            onFocus={() => onFocusField(index, '__condition', 'string')}
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-gray-300">
          <input
            type="checkbox"
            checked={step.enabled !== 0 && step.enabled !== false}
            onChange={(e) => onChange({ ...step, enabled: e.target.checked })}
            className="accent-orange-600"
          />
          <span className="font-mono text-[11px] uppercase tracking-wider">Enabled</span>
        </label>
        <label className="flex items-center gap-2 text-sm text-gray-300">
          <input
            type="checkbox"
            checked={!!step.continue_on_error}
            onChange={(e) => onChange({ ...step, continue_on_error: e.target.checked ? 1 : 0 })}
            className="accent-orange-600"
          />
          <span className="font-mono text-[11px] uppercase tracking-wider">Continue on error</span>
        </label>
      </div>
    </div>
  );
}
