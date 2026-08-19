/**
 * Variable templating for workflow step params.
 *
 * Supports `{{path.to.value}}` interpolation against a run context. Paths are
 * resolved by walking dotted keys (e.g. `subnet.network`, `firewall.parent_interface`,
 * `steps.iface.interfaceName`).
 *
 * Two modes:
 *  - Whole-token: when a string is EXACTLY one `{{token}}`, the resolved value is
 *    returned with its native type (number, boolean, array, object). This lets a
 *    param like `vlanId: "{{tag}}"` yield the numeric tag, and `srcaddr: "{{srcAddresses}}"`
 *    yield the array.
 *  - Interpolation: any other string with embedded tokens is rebuilt as a string,
 *    with missing/undefined resolving to an empty string.
 */

const WHOLE_TOKEN = /^\s*\{\{\s*([^}]+?)\s*\}\}\s*$/;
const TOKEN_GLOBAL = /\{\{\s*([^}]+?)\s*\}\}/g;

export function resolvePath(context, path) {
  const parts = String(path).split('.').map((p) => p.trim()).filter(Boolean);
  let cur = context;
  for (const part of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[part];
  }
  return cur;
}

/**
 * Render a single value (string/array/object/primitive) against the context.
 */
export function renderValue(value, context) {
  if (typeof value === 'string') {
    const whole = value.match(WHOLE_TOKEN);
    if (whole) {
      const resolved = resolvePath(context, whole[1]);
      return resolved === undefined ? '' : resolved;
    }
    return value.replace(TOKEN_GLOBAL, (_m, path) => {
      const resolved = resolvePath(context, path);
      if (resolved === undefined || resolved === null) return '';
      return String(resolved);
    });
  }
  if (Array.isArray(value)) {
    return value.map((v) => renderValue(v, context));
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = renderValue(v, context);
    return out;
  }
  return value;
}

/**
 * Render a full params object.
 */
export function renderParams(params, context) {
  return renderValue(params || {}, context);
}

/**
 * Evaluate a step condition. Empty/whitespace conditions always run.
 * A condition is truthy unless it resolves to a falsy value or the literal
 * strings "false"/"0"/"no"/"" (so `{{vlanInterface}}` with an empty string skips).
 */
export function evaluateCondition(condition, context) {
  if (condition === undefined || condition === null) return true;
  const trimmed = String(condition).trim();
  if (!trimmed) return true;
  const rendered = renderValue(trimmed, context);
  if (rendered === false || rendered === null || rendered === undefined) return false;
  if (typeof rendered === 'number') return rendered !== 0;
  const s = String(rendered).trim().toLowerCase();
  return !(s === '' || s === 'false' || s === '0' || s === 'no');
}

/**
 * Collect the distinct template tokens referenced by a params object — used by
 * the dry-run preview to surface which variables a step consumes.
 */
export function collectTokens(value, out = new Set()) {
  if (typeof value === 'string') {
    let m;
    TOKEN_GLOBAL.lastIndex = 0;
    while ((m = TOKEN_GLOBAL.exec(value)) !== null) out.add(m[1].trim());
  } else if (Array.isArray(value)) {
    value.forEach((v) => collectTokens(v, out));
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach((v) => collectTokens(v, out));
  }
  return out;
}
