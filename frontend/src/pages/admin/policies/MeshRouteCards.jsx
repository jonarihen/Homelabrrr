import { tint, badgeStyle } from './services.js';
import { clamp } from './graphLayout.js';

// Card that follows the cursor while hovering a route.
export function RouteTooltip({ mesh }) {
  const { hoveredLine, tooltipPos, canvasSize, lines } = mesh;
  const line = lines.find(item => item.id === hoveredLine);
  if (!line) return null;
  const edgeColor = line.colors[0];
  // Clamp inside the canvas; flip below the cursor near the top edge
  const flipBelow = tooltipPos.y < 150;
  return (
    <div
      className="pointer-events-none absolute z-10"
      style={{
        left: clamp(tooltipPos.x, 130, Math.max(130, canvasSize.width - 130)),
        top: tooltipPos.y,
        transform: flipBelow ? 'translate(-50%, 26px)' : 'translate(-50%, -100%)',
      }}
    >
      <div
        className="min-w-[220px] rounded-2xl border bg-slate-950/95 px-4 py-3 shadow-2xl backdrop-blur-sm"
        style={{ borderColor: tint(edgeColor, 25) }}
      >
        <div className="flex items-center gap-2 text-xs">
          <span className="font-medium text-cyan-300">{line.srcName}</span>
          <svg className="h-3.5 w-3.5 text-slate-500" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
          </svg>
          <span className="font-medium text-white">{line.dstName}</span>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {line.services.map(service => (
            <span
              key={`${line.id}-${service}`}
              className="rounded-full border px-2 py-0.5 text-[11px] font-medium uppercase tracking-[0.14em]"
              style={badgeStyle(service, line.action)}
            >
              {service}
            </span>
          ))}
        </div>
        <p className="mt-2 text-[11px] uppercase tracking-[0.18em] text-slate-500">
          {line.action === 'accept' ? 'Allowed traffic path' : 'Denied traffic path'}
        </p>
      </div>
      {!flipBelow && (
        <div
          className="mx-auto -mt-1 h-2 w-2 rotate-45 bg-slate-950"
          style={{ borderBottom: `1px solid ${tint(edgeColor, 25)}`, borderRight: `1px solid ${tint(edgeColor, 25)}` }}
        />
      )}
    </div>
  );
}

// Card pinned by clicking a route, with its delete action.
export function RoutePopover({ mesh, onDelete }) {
  const { linePopover, setLinePopover, lines } = mesh;
  const line = lines.find(item => item.id === linePopover.id);
  if (!line) return null;
  const edgeColor = line.colors[0];
  const flipBelow = linePopover.y < 210;
  return (
    <div
      data-mesh-overlay
      className="absolute z-30"
      style={{
        left: linePopover.x,
        top: linePopover.y,
        transform: flipBelow ? 'translate(-50%, 14px)' : 'translate(-50%, -100%)',
      }}
    >
      <div
        className="min-w-[250px] rounded-2xl border bg-slate-950/95 px-4 py-3 shadow-2xl backdrop-blur-sm"
        style={{ borderColor: tint(edgeColor, 25) }}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2 text-xs">
            <span className="font-medium text-cyan-300">{line.srcName}</span>
            <svg className="h-3.5 w-3.5 text-slate-500" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
            </svg>
            <span className="font-medium text-white">{line.dstName}</span>
          </div>
          <button
            onClick={() => setLinePopover(null)}
            className="-mr-1 -mt-1 rounded p-1 text-slate-500 transition-colors hover:bg-slate-800 hover:text-white"
          >
            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {line.services.map(service => (
            <span
              key={`popover-${line.id}-${service}`}
              className="rounded-full border px-2 py-0.5 text-[11px] font-medium uppercase tracking-[0.14em]"
              style={badgeStyle(service, line.action)}
            >
              {service}
            </span>
          ))}
        </div>
        <p className="mt-2 text-[11px] uppercase tracking-[0.18em] text-slate-500">
          {line.action === 'accept' ? 'Allowed traffic path' : 'Denied traffic path'}
        </p>
        <button
          onClick={() => onDelete(line.id)}
          className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-xl border border-red-800/40 bg-red-900/20 px-3 py-2 text-xs font-medium text-red-300 transition-colors hover:bg-red-900/40 hover:text-red-200"
        >
          <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
          </svg>
          Delete this policy
        </button>
      </div>
    </div>
  );
}
