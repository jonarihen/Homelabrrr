import { Link } from 'react-router-dom';

/**
 * Prerequisite callout — the shape the "External IP not configured" block on
 * the Port Forwarding page established: amber warning glyph, a one-line reason,
 * and exactly one action.
 *
 * The rule it exists to enforce: an empty state must always say what to do next
 * AND who can do it. When the viewer cannot fix it themselves, pass `fallback`
 * ("Ask an admin to …") instead of an action — "no items found" is never an
 * acceptable empty state.
 *
 * @param {string}  title       Headline, e.g. "No cloud images available".
 * @param {string}  detail      One line explaining the consequence / the fix.
 * @param {string}  [to]        Router path for the action button.
 * @param {func}    [onAction]  Click handler for the action button (used when
 *                              the fix is on the current page).
 * @param {string}  [actionLabel]
 * @param {string}  [fallback]  Shown instead of the action when `to`/`onAction`
 *                              are absent — say who *can* do it.
 * @param {boolean} [card=true] Wrap in the standard panel chrome. Pass false
 *                              when the callout already sits inside a panel.
 */
export default function PrereqCallout({
  title,
  detail,
  to,
  onAction,
  actionLabel = 'Fix this',
  fallback,
  card = true,
}) {
  const actionCls = 'inline-block px-4 py-2 bg-yellow-600 hover:bg-yellow-500 text-white text-sm font-medium rounded-lg transition-colors';

  const body = (
    <div className="text-center py-6">
      <svg className="w-8 h-8 mx-auto text-yellow-500/60 mb-3" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
      </svg>
      <p className="text-yellow-400 text-sm font-medium mb-1">{title}</p>
      {detail && <p className="text-gray-500 text-xs mb-4 max-w-md mx-auto">{detail}</p>}
      {to ? (
        <Link to={to} className={actionCls}>{actionLabel}</Link>
      ) : onAction ? (
        <button type="button" onClick={onAction} className={actionCls}>{actionLabel}</button>
      ) : fallback ? (
        <p className="text-xs text-gray-600">{fallback}</p>
      ) : null}
    </div>
  );

  if (!card) return body;
  return <div className="bg-gray-900 border border-gray-800 rounded-2xl px-6">{body}</div>;
}
