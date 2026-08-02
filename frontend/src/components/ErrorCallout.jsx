import { Link } from 'react-router-dom';
import { normalizeApiError, errorHrefLabel } from '../utils/apiError.js';

/**
 * The one place a failure is rendered.
 *
 * Pass it whatever you have — the axios error, the response body, or the plain
 * string a component already keeps in state. Endpoints that return the
 * translated payload (backend/src/utils/upstreamError.js) render as
 * title + detail + a button to the page that fixes it; everything else renders
 * exactly the single line it rendered before, so call sites can be converted
 * one at a time.
 *
 *   <ErrorCallout error={err} fallback="Failed to load VMs" />
 */
export default function ErrorCallout({ error, fallback, className = '' }) {
  if (!error) return null;
  const { title, detail, action, href } = normalizeApiError(error, fallback);

  return (
    <div
      role="alert"
      className={`flex gap-2.5 rounded-xl border border-red-800/30 bg-red-900/20 p-3 text-red-400 ${className}`}
    >
      <svg
        aria-hidden="true"
        className="mt-px h-4 w-4 shrink-0 text-red-500/70"
        fill="none" stroke="currentColor" strokeWidth="1.75" viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round" strokeLinejoin="round"
          d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"
        />
      </svg>

      <div className="min-w-0 flex-1">
        <p className="break-words text-xs font-medium text-red-300">{title}</p>
        {detail && <p className="mt-1 break-words text-xs text-red-400/90">{detail}</p>}
        {action && <p className="mt-1 break-words text-xs text-red-400/70">{action}</p>}
        {href && (
          <div className="mt-2">
            {href.startsWith('/') ? (
              <Link
                to={href}
                className="inline-flex items-center rounded-lg border border-red-700/50 px-2.5 py-1 font-mono text-[11px] uppercase tracking-[0.08em] text-red-300 transition-colors hover:bg-red-500/10 hover:text-red-200"
              >
                Go to {errorHrefLabel(href)}
              </Link>
            ) : (
              <a
                href={href} target="_blank" rel="noreferrer"
                className="inline-flex items-center rounded-lg border border-red-700/50 px-2.5 py-1 font-mono text-[11px] uppercase tracking-[0.08em] text-red-300 transition-colors hover:bg-red-500/10 hover:text-red-200"
              >
                Open reference
              </a>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
