import { MUTED_LINE_OPACITY, clamp } from './graphLayout.js';

// SVG layer of policy routes: hit area, glow, flow particles and endpoints.
export default function MeshRouteLines({ mesh }) {
  const { canvasRef, canvasSize, hoveredLine, setHoveredLine, setTooltipPos, setLinePopover, panOffset, zoom, lines } = mesh;
  return (
    <svg className="absolute inset-0 z-[3] h-full w-full" style={{ overflow: 'visible' }}>
      <g transform={`translate(${panOffset.x}, ${panOffset.y}) scale(${zoom})`}>
      <defs>
        {lines.map(line => (
          <g key={`defs-${line.id}`}>
            <linearGradient
              id={`policy-gradient-${line.id}`}
              gradientUnits="userSpaceOnUse"
              x1={line.srcX}
              y1={line.srcY}
              x2={line.dstX}
              y2={line.dstY}
            >
              {line.colors.map((color, index) => (
                <stop
                  key={`${line.id}-${color}-${index}`}
                  offset={line.colors.length === 1 ? (index === 0 ? '0%' : '100%') : `${(index / (line.colors.length - 1)) * 100}%`}
                  stopColor={color}
                />
              ))}
            </linearGradient>
            <path id={`policy-motion-${line.id}`} d={line.pathD} fill="none" />
          </g>
        ))}
      </defs>

      {lines.map(line => {
        const isHovered = hoveredLine === line.id;
        const opacity = line.isFocused ? 1 : MUTED_LINE_OPACITY;
        return (
          <g key={line.id}>
            <path
              d={line.pathD}
              stroke="transparent"
              strokeWidth={24}
              fill="none"
              style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
              onClick={(e) => {
                e.stopPropagation();
                const canvasRect = canvasRef.current.getBoundingClientRect();
                setLinePopover({
                  id: line.id,
                  x: clamp(e.clientX - canvasRect.left, 140, Math.max(140, canvasSize.width - 140)),
                  y: e.clientY - canvasRect.top,
                });
                setHoveredLine(null);
              }}
              onMouseEnter={(e) => {
                setHoveredLine(line.id);
                const canvasRect = canvasRef.current.getBoundingClientRect();
                setTooltipPos({
                  x: e.clientX - canvasRect.left,
                  y: e.clientY - canvasRect.top - 16,
                });
              }}
              onMouseMove={(e) => {
                const canvasRect = canvasRef.current.getBoundingClientRect();
                setTooltipPos({
                  x: e.clientX - canvasRect.left,
                  y: e.clientY - canvasRect.top - 16,
                });
              }}
              onMouseLeave={() => setHoveredLine(null)}
            />

            <path
              d={line.pathD}
              stroke={`url(#policy-gradient-${line.id})`}
              strokeWidth={isHovered ? 14 : 11}
              strokeOpacity={0.12 * opacity}
              strokeLinecap="round"
              fill="none"
              filter={isHovered ? 'blur(8px)' : 'blur(4px)'}
            />
            <path
              d={line.pathD}
              stroke="var(--bg)"
              strokeWidth={isHovered ? 8.5 : 7}
              strokeLinecap="round"
              fill="none"
              opacity={opacity}
            />
            <path
              d={line.pathD}
              stroke={`url(#policy-gradient-${line.id})`}
              strokeWidth={isHovered ? 5 : 4}
              strokeLinecap="round"
              fill="none"
              opacity={0.92 * opacity}
            />
            {line.action === 'accept' && (
              <>
                <path
                  d={line.pathD}
                  stroke="rgba(255,255,255,0.12)"
                  strokeWidth={isHovered ? 1.8 : 1.4}
                  strokeLinecap="round"
                  fill="none"
                  opacity={0.7 * opacity}
                  strokeDasharray={isHovered ? '2 18' : '2 22'}
                >
                  <animate
                    attributeName="stroke-dashoffset"
                    from="0"
                    to="-48"
                    dur={isHovered ? '1.1s' : '1.45s'}
                    repeatCount="indefinite"
                  />
                </path>

                {[0, 1, 2].map((flowIndex) => {
                  const begin = `-${(flowIndex * 0.48) + ((line.id % 5) * 0.08)}s`;
                  const color = line.colors[flowIndex % line.colors.length] || line.colors[0];
                  const duration = isHovered ? '1.55s' : '2.05s';
                  return (
                    <g key={`flow-${line.id}-${flowIndex}`} opacity={0.92 * opacity}>
                      <ellipse
                        cx="0"
                        cy="0"
                        rx={isHovered ? 6 : 4.8}
                        ry={isHovered ? 2.5 : 2}
                        fill={color}
                        filter={isHovered ? 'blur(0.35px)' : undefined}
                      >
                        <animateMotion
                          dur={duration}
                          repeatCount="indefinite"
                          rotate="auto"
                          begin={begin}
                        >
                          <mpath href={`#policy-motion-${line.id}`} />
                        </animateMotion>
                        <animate
                          attributeName="opacity"
                          values="0;1;1;0"
                          keyTimes="0;0.12;0.88;1"
                          dur={duration}
                          repeatCount="indefinite"
                          begin={begin}
                        />
                      </ellipse>
                      <circle
                        cx="0"
                        cy="0"
                        r={isHovered ? 1.25 : 1}
                        fill="var(--ink)"
                      >
                        <animateMotion
                          dur={duration}
                          repeatCount="indefinite"
                          rotate="auto"
                          begin={begin}
                        >
                          <mpath href={`#policy-motion-${line.id}`} />
                        </animateMotion>
                        <animate
                          attributeName="opacity"
                          values="0;0.95;0.95;0"
                          keyTimes="0;0.12;0.88;1"
                          dur={duration}
                          repeatCount="indefinite"
                          begin={begin}
                        />
                      </circle>
                    </g>
                  );
                })}
              </>
            )}
            <circle cx={line.srcX} cy={line.srcY} r={isHovered ? 6 : 4.5} fill={line.colors[0]} opacity={0.85 * opacity} />
            <circle cx={line.dstX} cy={line.dstY} r={isHovered ? 6 : 4.5} fill={line.colors[line.colors.length - 1]} opacity={0.85 * opacity} />
          </g>
        );
      })}
      </g>
    </svg>
  );
}
