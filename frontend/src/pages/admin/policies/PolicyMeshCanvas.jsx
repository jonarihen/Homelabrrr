import { MUTED_NODE_OPACITY } from './graphLayout.js';
import { tint } from './services.js';
import MeshRouteLines from './MeshRouteLines.jsx';
import { RouteTooltip, RoutePopover } from './MeshRouteCards.jsx';

// The pannable, zoomable VLAN mesh: overlays, route layer and VLAN nodes.
export default function PolicyMeshCanvas({ mesh, vlans, srcVlan, dstVlan, policiesLoading, onCardClick, onDeletePolicy }) {
  const {
    canvasRef, canvasSize, hoveredLine, dragOverrides, setHoveredLine, panOffset, panRef, zoom,
    linePopover, searchTerm, setSearchTerm, degreeMap, peerMap, selectedTag, peerTags, meshMinHeight, nodePositions,
    handleCanvasPointerDown, handleNodePointerDown, recenterView, zoomBy,
  } = mesh;
  return (
    <div
      ref={canvasRef}
      className="relative mt-6 overflow-hidden border border-slate-800 bg-gray-950 px-4 py-4 min-h-[620px]"
      style={{ minHeight: `${meshMinHeight}px`, cursor: panRef.current ? 'grabbing' : 'grab' }}
      onMouseLeave={() => setHoveredLine(null)}
      onPointerDown={handleCanvasPointerDown}
    >
      {/* Recenter button */}
      {(panOffset.x !== 0 || panOffset.y !== 0 || zoom !== 1 || Object.keys(dragOverrides).length > 0) && (
        <button
          onClick={(e) => { e.stopPropagation(); recenterView(); }}
          className="absolute top-3 right-3 z-20 flex items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-900/90 px-3 py-1.5 text-[11px] text-slate-300 backdrop-blur-sm transition-colors hover:bg-slate-800 hover:text-white"
        >
          <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 9V4.5M9 9H4.5M9 9L3.75 3.75M9 15v4.5M9 15H4.5M9 15l-5.25 5.25M15 9h4.5M15 9V4.5M15 9l5.25-5.25M15 15h4.5M15 15v4.5m0-4.5l5.25 5.25" />
          </svg>
          Recenter
        </button>
      )}
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(var(--line-soft)_1px,transparent_1px),linear-gradient(90deg,var(--line-soft)_1px,transparent_1px)] bg-[size:72px_72px]" style={{ transform: `translate(${panOffset.x}px, ${panOffset.y}px) scale(${zoom})`, transformOrigin: '0 0' }} />
      {selectedTag && (
        <div className="pointer-events-none absolute inset-0 z-[2] flex items-center justify-center" style={{ transform: `translate(${panOffset.x}px, ${panOffset.y}px) scale(${zoom})`, transformOrigin: '0 0' }}>
          <div
            className="absolute rounded-full border border-cyan-400/15"
            style={{
              width: `${Math.min(Math.max(canvasSize.width * 0.48, 240), 430)}px`,
              height: `${Math.min(Math.max(canvasSize.width * 0.48, 240), 430)}px`,
            }}
          />
          <div
            className="absolute rounded-full border border-dashed border-slate-500/15"
            style={{
              width: `${Math.min(Math.max(canvasSize.width * 0.78, 360), 680)}px`,
              height: `${Math.min(Math.max(canvasSize.width * 0.78, 360), 680)}px`,
            }}
          />
          <div className="absolute left-1/2 top-[22%] -translate-x-1/2 rounded-full border border-cyan-400/15 bg-cyan-500/5 px-3 py-1 text-[11px] uppercase tracking-[0.22em] text-cyan-200/80">
            Existing Paths
          </div>
          <div className="absolute left-1/2 top-[11%] -translate-x-1/2 rounded-full border border-slate-700 bg-slate-900/80 px-3 py-1 text-[11px] uppercase tracking-[0.22em] text-slate-400">
            Available Targets
          </div>
        </div>
      )}

      {policiesLoading && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm">
          <span className="text-sm text-slate-300">Refreshing policy mesh...</span>
        </div>
      )}

      {vlans.length === 0 ? (
        <div className="relative z-10 flex min-h-[560px] flex-col items-center justify-center text-center">
          <p className="text-base font-medium text-slate-200">No VLANs synced to this firewall yet.</p>
          <p className="mt-2 max-w-md text-sm text-slate-500">Sync VLANs from the VLAN page first, then the mesh will show relationships and policy paths here.</p>
        </div>
      ) : (
        <>
          {/* VLAN search */}
          <div data-mesh-overlay className="absolute left-3 top-3 z-20">
            <div className="flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-900/90 px-3 py-1.5 backdrop-blur-sm">
              <svg className="h-3.5 w-3.5 shrink-0 text-slate-500" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
              </svg>
              <input
                type="text"
                value={searchTerm}
                onChange={e => setSearchTerm(e.target.value)}
                placeholder="Find VLAN..."
                className="w-32 bg-transparent text-xs text-slate-200 placeholder-slate-600 focus:outline-none"
              />
              {searchTerm && (
                <button
                  onClick={() => setSearchTerm('')}
                  className="rounded p-0.5 text-slate-500 transition-colors hover:text-white"
                >
                  <svg className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
            </div>
          </div>

          {/* Zoom controls */}
          <div data-mesh-overlay className="absolute bottom-3 right-3 z-20 flex items-center gap-0.5 rounded-xl border border-slate-700 bg-slate-900/90 px-1.5 py-1 backdrop-blur-sm">
            <button
              onClick={() => zoomBy(1 / 1.25)}
              className="rounded-lg px-2 py-0.5 text-sm text-slate-300 transition-colors hover:bg-slate-800 hover:text-white"
              title="Zoom out"
            >
              −
            </button>
            <span className="w-11 text-center text-[11px] font-mono text-slate-400">{Math.round(zoom * 100)}%</span>
            <button
              onClick={() => zoomBy(1.25)}
              className="rounded-lg px-2 py-0.5 text-sm text-slate-300 transition-colors hover:bg-slate-800 hover:text-white"
              title="Zoom in"
            >
              +
            </button>
          </div>

          <MeshRouteLines mesh={mesh} />

          {hoveredLine && !linePopover && <RouteTooltip mesh={mesh} />}

          {linePopover && <RoutePopover mesh={mesh} onDelete={onDeletePolicy} />}

          <div className="relative z-[4] min-h-[588px]" style={{ transform: `translate(${panOffset.x}px, ${panOffset.y}px) scale(${zoom})`, transformOrigin: '0 0' }}>
            {vlans.map((vlan) => {
              const position = nodePositions[vlan.tag];
              if (!position) return null;

              const isSource = srcVlan?.tag === vlan.tag;
              const isDestination = dstVlan?.tag === vlan.tag;
              const isPeer = peerTags.has(vlan.tag);
              const isMuted = !!srcVlan && !isSource && !isPeer;
              const query = searchTerm.trim().toLowerCase();
              const matchesSearch = !query
                || vlan.name.toLowerCase().includes(query)
                || String(vlan.tag).includes(query);
              const routeCount = degreeMap.get(vlan.tag) || 0;
              const peerCount = (peerMap.get(vlan.tag) || new Set()).size;
              const scale = isSource ? 1.16 : isDestination ? 1.1 : isPeer ? 1.02 : isMuted ? 0.96 : 1;
              const statusLabel = isSource ? 'Source' : isDestination ? 'Target' : isPeer ? 'Linked' : 'Open';
              const statusTone = isSource
                ? 'border-cyan-400/25 bg-cyan-500/12 text-cyan-200'
                : isDestination
                  ? 'border-emerald-400/25 bg-emerald-500/12 text-emerald-200'
                  : isPeer
                    ? 'border-slate-500/40 bg-slate-700/50 text-slate-200'
                    : 'border-slate-700/80 bg-slate-900 text-slate-400';

              return (
                <button
                  key={vlan.tag}
                  onClick={() => onCardClick(vlan)}
                  onPointerDown={(e) => handleNodePointerDown(e, vlan)}
                  className={`absolute z-[5] h-36 w-36 cursor-grab rounded-[30px] border text-center transition-[transform,opacity,border-color,background-color,box-shadow] duration-300 active:cursor-grabbing sm:h-40 sm:w-40 ${
                    isSource
                      ? 'border-cyan-300/80 bg-cyan-500/10'
                      : isDestination
                        ? 'border-emerald-300/80 bg-emerald-500/10'
                        : isPeer
                          ? 'border-slate-500/80 bg-slate-800/92 hover:border-cyan-300/50'
                          : 'border-slate-800 bg-slate-900/88 hover:border-slate-600 hover:bg-slate-900'
                  }${query && matchesSearch ? ' ring-2 ring-amber-300/60' : ''}`}
                  style={{
                    left: `${position.x}px`,
                    top: `${position.y}px`,
                    opacity: query && !matchesSearch ? 0.22 : isMuted ? MUTED_NODE_OPACITY : 1,
                    transform: `translate(-50%, -50%) scale(${scale})`,
                  }}
                >
                  <div className="relative flex h-full flex-col items-center justify-center overflow-hidden rounded-[30px] px-4 py-4">
                    <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,_rgba(255,255,255,0.1),_transparent_48%)]" />
                    <div className="absolute inset-[8%] rounded-[24px] bg-slate-950/95 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]" />
                    <div className="absolute inset-[10%] rounded-[22px] border border-white/6" />
                    <div
                      className="absolute inset-[18%] rounded-[20px] opacity-80 blur-sm"
                      style={{
                        background: isSource
                          ? `radial-gradient(circle, ${tint('var(--accent)', 35)}, transparent 72%)`
                          : isDestination
                            ? `radial-gradient(circle, ${tint('var(--ok)', 35)}, transparent 72%)`
                            : isPeer
                              ? `radial-gradient(circle, ${tint('var(--muted)', 18)}, transparent 72%)`
                              : `radial-gradient(circle, ${tint('var(--accent)', 12)}, transparent 72%)`,
                      }}
                    />
                    <div className="relative z-[1] mx-auto flex w-full max-w-[72%] flex-col items-center justify-center text-center">
                      <div className="inline-flex max-w-full items-center justify-center whitespace-nowrap rounded-full border border-slate-700/80 bg-slate-900/95 px-1.5 py-0.5 text-[7px] font-semibold uppercase tracking-[0.06em] text-slate-400 sm:text-[8px]">
                        VLAN {vlan.tag}
                      </div>
                      <h3 className="mt-1 line-clamp-2 break-words text-[12px] font-semibold leading-[1.12] text-white [overflow-wrap:anywhere] sm:text-[14px]">
                        {vlan.name}
                      </h3>
                      <div className="mt-3 flex flex-wrap items-center justify-center gap-1 text-[8px] uppercase tracking-[0.1em] text-slate-400 sm:text-[11px]">
                        <span className="rounded-full border border-slate-700/80 bg-slate-950/70 px-2 py-0.5">
                          {routeCount} route{routeCount !== 1 ? 's' : ''}
                        </span>
                        <span className="rounded-full border border-slate-700/80 bg-slate-950/70 px-2 py-0.5">
                          {peerCount} peer{peerCount !== 1 ? 's' : ''}
                        </span>
                      </div>
                      <div className="mt-2 flex w-full justify-center">
                        <span className={`inline-flex max-w-full items-center justify-center whitespace-nowrap rounded-full border px-1.5 py-0.5 text-[7px] uppercase tracking-[0.06em] sm:text-[8px] ${statusTone}`}>
                          {statusLabel}
                        </span>
                      </div>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
