import { useEffect, useMemo, useRef, useState } from 'react';
import { binLabel, buildTimeChart, nearestMark } from '../../utils/timeChart.js';

const HEIGHT = 220;
const MARGIN = { top: 12, right: 12, bottom: 26, left: 46 };
const AXIS_TEXT = { fill: '#9ca3af', fontSize: 11, fontFamily: 'var(--font-mono, ui-monospace, monospace)' };

// Bar with only its data end rounded; the foot stays flat on the baseline.
function barPath(left, right, top, bottom) {
  const radius = Math.min(2, (right - left) / 2, Math.max(0, bottom - top));
  return `M${left},${bottom} L${left},${top + radius} Q${left},${top} ${left + radius},${top} L${right - radius},${top} Q${right},${top} ${right},${top + radius} L${right},${bottom} Z`;
}

// One binned series over time as a line or as bars, with a crosshair and a
// readout that follow the pointer, a finger or the arrow keys. The readout
// sits in its own band above the plot so it never covers the data, and every
// value is also in the table the page renders below the chart.
export default function TimeSeriesChart({ points, field, from, through, binSeconds, kind = 'line', color, label, empty, formatValue, detail, faded, markers = [], markerText }) {
  const wrap = useRef(null);
  const [width, setWidth] = useState(640);
  const [active, setActive] = useState(null);
  useEffect(() => {
    const node = wrap.current;
    if (!node) return undefined;
    const measure = () => setWidth(Math.max(280, Math.round(node.clientWidth)));
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const chart = useMemo(() => buildTimeChart(points, field, from, through, binSeconds, { width, height: HEIGHT, margin: MARGIN, zero: kind === 'bar' }), [points, field, from, through, binSeconds, width, kind]);
  // A refresh of the same range keeps the reading position; a new range starts over.
  useEffect(() => { setActive(null); }, [binSeconds]);
  // The measured wrapper is always mounted, so a chart that appears after
  // an empty state still gets its real width.
  if (!chart) return <div ref={wrap} className="mt-4"><p className="text-sm text-gray-400">{empty}</p></div>;

  const { plot, marks } = chart;
  const lines = markers.map((marker) => ({ ...marker, time: Date.parse(marker.at) })).filter((marker) => Number.isFinite(marker.time)).map((marker) => ({ ...marker, x: chart.x(marker.time) }));
  const mark = active == null ? null : marks[Math.min(active, marks.length - 1)];
  const here = mark ? lines.filter((marker) => marker.time >= mark.at && marker.time < mark.to) : [];
  const point = (event) => {
    const box = event.currentTarget.getBoundingClientRect();
    setActive(nearestMark(marks, (event.clientX - box.left) / box.width * width));
  };
  const keys = (event) => {
    const last = marks.length - 1;
    const current = mark ? mark.index : null;
    const next = { ArrowLeft: Math.max(0, (current ?? marks.length) - 1), ArrowRight: Math.min(last, (current ?? -1) + 1), Home: 0, End: last }[event.key];
    if (next !== undefined) { event.preventDefault(); setActive(next); }
    else if (event.key === 'Escape') setActive(null);
  };
  const extra = mark ? [detail?.(mark.point), ...here.map((marker) => `Mode change: ${markerText(marker)}`)].filter(Boolean) : [];
  const readout = mark ? [`${binLabel(mark.at, mark.to)}: ${formatValue(mark.value)}`, ...extra].join(', ') : '';
  // Centred on the crosshair but kept inside the chart; full width when narrow.
  const narrow = width < 480;
  const place = narrow ? { left: 0, right: 0 } : { left: `clamp(11rem, ${mark?.x ?? 0}px, calc(100% - 11rem))`, transform: 'translateX(-50%)', maxWidth: '22rem', width: 'max-content' };
  // Room above the plot for a three-line readout (more lines wrap when narrow).
  const band = narrow ? 96 : 72;

  return <div ref={wrap} className="relative mt-4 focus-visible:outline-2 focus-visible:outline-orange-500" style={{ paddingTop: band }} tabIndex={0} role="group"
    aria-label={`${label}. Use the left and right arrow keys to read values.`} onKeyDown={keys} onFocus={() => setActive((current) => current ?? marks.length - 1)} onBlur={() => setActive(null)}>
    {mark ? <div className="pointer-events-none absolute z-10 border border-gray-700 bg-gray-950 px-3 py-1.5 text-xs" style={{ bottom: HEIGHT + 2, ...place }}>
      <p className="flex flex-wrap items-center gap-x-2 text-gray-400"><span aria-hidden="true" className="inline-block h-0.5 w-3 shrink-0" style={{ background: color }} />
        <span className="font-mono text-sm font-semibold tabular-nums text-gray-100">{formatValue(mark.value)}</span><span>{binLabel(mark.at, mark.to)}</span></p>
      {extra.map((text) => <p key={text} className="text-gray-400">{text}</p>)}
    </div> : <p aria-hidden="true" className="pointer-events-none absolute left-0 right-0 text-xs text-gray-500" style={{ bottom: HEIGHT + 8 }}>Hover or tap the chart, or focus it and use ← →, to read exact values.</p>}
    <svg width={width} height={HEIGHT} viewBox={`0 0 ${width} ${HEIGHT}`} role="img" aria-label={label} className="block max-w-full touch-pan-y select-none"
      onPointerMove={point} onPointerDown={point} onPointerLeave={(event) => { if (event.pointerType === 'mouse') setActive(null); }}>
      {chart.yTicks.map((tick, index) => <g key={tick.value}>
        <line x1={plot.left} x2={plot.right} y1={tick.y} y2={tick.y} stroke={index === 0 ? '#4b5563' : '#1f2937'} />
        <text x={plot.left - 8} y={tick.y} textAnchor="end" dominantBaseline="middle" {...AXIS_TEXT}>{tick.label}</text>
      </g>)}
      {chart.xTicks.map((tick) => <g key={tick.at}>
        <line x1={tick.x} x2={tick.x} y1={plot.bottom} y2={plot.bottom + 4} stroke="#4b5563" />
        <text x={tick.x} y={plot.bottom + 17} textAnchor={tick.x - plot.left < 24 ? 'start' : plot.right - tick.x < 24 ? 'end' : 'middle'} {...AXIS_TEXT}>{tick.label}</text>
      </g>)}
      {lines.map((marker, index) => <line key={`${marker.at}-${index}`} x1={marker.x} x2={marker.x} y1={plot.top} y2={plot.bottom} stroke="#6b7280" strokeDasharray="3 3" />)}
      {kind === 'bar'
        ? marks.map((item) => <path key={item.at} d={barPath(item.left + 1, Math.max(item.left + 2, item.right - 1), item.y, plot.bottom)} fill={color} fillOpacity={faded?.(item.point) ? 0.45 : 1}
          stroke={mark === item ? '#f9fafb' : 'none'} strokeWidth="1.5" />)
        : <>
          {chart.segments.map((d) => <path key={d} d={d} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />)}
          {chart.singles.map((item) => <circle key={item.at} cx={item.x} cy={item.y} r="3" fill={color} />)}
        </>}
      {mark && <>
        <line x1={mark.x} x2={mark.x} y1={plot.top} y2={plot.bottom} stroke="#d1d5db" strokeOpacity={kind === 'bar' ? 0 : 0.6} />
        {kind !== 'bar' && <circle cx={mark.x} cy={mark.y} r="5" fill={color} stroke="#111827" strokeWidth="2" />}
      </>}
    </svg>
    <p className="sr-only" aria-live="polite">{readout}</p>
  </div>;
}
