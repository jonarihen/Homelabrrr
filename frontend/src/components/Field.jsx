import { Children, cloneElement, isValidElement, useId } from 'react';

const CONTROLS = new Set(['input', 'select', 'textarea']);

// Labelled form row. The label is tied (htmlFor/id) to the first direct
// <input>/<select>/<textarea> child so screen readers announce it and clicking
// the label focuses the control.
export default function Field({ label, children }) {
  const autoId = useId();
  let id;
  const kids = Children.map(children, (child) => {
    if (id || !isValidElement(child) || !CONTROLS.has(child.type)) return child;
    id = child.props.id ?? autoId;
    return cloneElement(child, { id });
  });
  return (
    <div>
      <label htmlFor={id} className="block text-xs text-gray-400 mb-1.5">{label}</label>
      {kids}
    </div>
  );
}
