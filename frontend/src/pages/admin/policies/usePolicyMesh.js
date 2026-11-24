import { useState, useEffect, useRef, useMemo } from 'react';
import { buildPolicyGraph, clamp, buildNodePositions, buildLineModels } from './graphLayout.js';

// Mesh canvas viewport: size, node layout and its animation, drag, pan, zoom,
// hover and the route popover. `loading` re-runs the canvas listeners once the
// canvas mounts after the page skeleton.
export default function usePolicyMesh({ vlans, policies, srcVlan, loading }) {
  const canvasRef = useRef(null);
  const [canvasSize, setCanvasSize] = useState({ width: 1180, height: 620 });
  const [hoveredLine, setHoveredLine] = useState(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });
  const [animatedNodePositions, setAnimatedNodePositions] = useState({});
  const animationFrameRef = useRef(null);
  const animatedPositionsRef = useRef({});
  const targetPositionsRef = useRef({});

  // ── Drag-to-move nodes ──────────────────────────────────────────────────────
  const [dragOverrides, setDragOverrides] = useState({});
  const dragRef = useRef(null); // { tag, startX, startY, origX, origY, moved }

  // ── Pan viewport ────────────────────────────────────────────────────────────
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const panRef = useRef(null); // { startX, startY, origPanX, origPanY }

  // ── Zoom viewport ───────────────────────────────────────────────────────────
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(1);
  zoomRef.current = zoom;
  const panOffsetRef = useRef(panOffset);
  panOffsetRef.current = panOffset;

  // ── Policy popover (click a route line) + VLAN search ──────────────────────
  const [linePopover, setLinePopover] = useState(null); // { id, x, y }
  const [searchTerm, setSearchTerm] = useState('');

  useEffect(() => {
    if (!canvasRef.current) return undefined;

    const updateSize = () => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      setCanvasSize({
        width: Math.max(360, rect.width),
        height: Math.max(560, rect.height),
      });
    };

    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(canvasRef.current);
    window.addEventListener('resize', updateSize);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updateSize);
    };
    // `loading` dep: the canvas div only mounts after the skeleton goes away
  }, [loading]);

  // Wheel zoom toward the cursor. Attached manually (non-passive) so
  // preventDefault can stop the page from scrolling.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return undefined;

    const onWheel = (e) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const current = zoomRef.current;
      const next = clamp(current * (e.deltaY < 0 ? 1.12 : 1 / 1.12), 0.4, 2.5);
      if (next === current) return;
      const pan = panOffsetRef.current;
      // Keep the point under the cursor stationary while scaling
      setPanOffset({
        x: mx - (((mx - pan.x) / current) * next),
        y: my - (((my - pan.y) / current) * next),
      });
      setZoom(next);
      setLinePopover(null); // anchored in screen coords — would detach from its line
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [loading]);

  const graph = useMemo(() => buildPolicyGraph(policies), [policies]);
  const degreeMap = graph.degree;
  const peerMap = graph.peers;
  const selectedTag = srcVlan?.tag || null;
  const peerTags = new Set(selectedTag ? Array.from(peerMap.get(selectedTag) || []) : []);
  const meshMinHeight = Math.max(620, 620 + (Math.max(0, vlans.length - 10) * 30));
  const targetNodePositions = useMemo(
    () => buildNodePositions(vlans, policies, selectedTag, canvasSize.width, canvasSize.height),
    [vlans, policies, selectedTag, canvasSize.width, canvasSize.height]
  );
  const basePositions = Object.keys(animatedNodePositions).length > 0 ? animatedNodePositions : targetNodePositions;
  const nodePositions = useMemo(() => {
    if (Object.keys(dragOverrides).length === 0) return basePositions;
    return { ...basePositions, ...dragOverrides };
  }, [basePositions, dragOverrides]);
  const lines = useMemo(() => buildLineModels(policies, nodePositions, selectedTag), [policies, nodePositions, selectedTag]);
  const selectedLineCount = selectedTag
    ? policies.filter(p => p.srcVlan?.tag === selectedTag || p.dstVlan?.tag === selectedTag).length
    : null;

  const handleNodePointerDown = (e, vlan) => {
    // Only primary button
    if (e.button !== 0) return;
    e.stopPropagation();
    const pos = nodePositions[vlan.tag];
    if (!pos) return;
    dragRef.current = {
      tag: vlan.tag,
      startX: e.clientX,
      startY: e.clientY,
      origX: pos.x,
      origY: pos.y,
      moved: false,
    };
  };

  const handleCanvasPointerDown = (e) => {
    // Only start pan if clicking on the canvas background (not on a node button)
    if (e.button !== 0) return;
    if (dragRef.current) return;
    if (e.target.closest('button')) return;
    if (e.target.closest('[data-mesh-overlay]')) return;
    if (linePopover) setLinePopover(null);
    panRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      origPanX: panOffset.x,
      origPanY: panOffset.y,
    };
  };

  useEffect(() => {
    const DRAG_THRESHOLD = 5;

    const onPointerMove = (e) => {
      // Node drag
      if (dragRef.current) {
        const dx = e.clientX - dragRef.current.startX;
        const dy = e.clientY - dragRef.current.startY;
        if (!dragRef.current.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        dragRef.current.moved = true;
        setDragOverrides(prev => ({
          ...prev,
          [dragRef.current.tag]: {
            // Node coordinates are pre-zoom, so screen deltas scale down
            x: dragRef.current.origX + (dx / zoomRef.current),
            y: dragRef.current.origY + (dy / zoomRef.current),
          },
        }));
        return;
      }
      // Canvas pan
      if (panRef.current) {
        const dx = e.clientX - panRef.current.startX;
        const dy = e.clientY - panRef.current.startY;
        setPanOffset({
          x: panRef.current.origPanX + dx,
          y: panRef.current.origPanY + dy,
        });
      }
    };

    const onPointerUp = () => {
      dragRef.current = null;
      panRef.current = null;
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };
  }, []);

  const recenterView = () => {
    setPanOffset({ x: 0, y: 0 });
    setDragOverrides({});
    setZoom(1);
  };

  // Zoom anchored on the canvas center (for the +/− buttons)
  const zoomBy = (factor) => {
    const current = zoomRef.current;
    const next = clamp(current * factor, 0.4, 2.5);
    if (next === current) return;
    const cx = canvasSize.width / 2;
    const cy = canvasSize.height / 2;
    const pan = panOffsetRef.current;
    setPanOffset({
      x: cx - (((cx - pan.x) / current) * next),
      y: cy - (((cy - pan.y) / current) * next),
    });
    setZoom(next);
  };

  // Keep targetPositionsRef in sync so the animation frame always reads fresh targets
  targetPositionsRef.current = targetNodePositions;

  useEffect(() => {
    const tags = Object.keys(targetNodePositions);

    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    if (tags.length === 0) {
      animatedPositionsRef.current = {};
      setAnimatedNodePositions({});
      return undefined;
    }

    const currentPositions = animatedPositionsRef.current;
    const hasExistingPositions = Object.keys(currentPositions).length > 0;

    if (!hasExistingPositions) {
      animatedPositionsRef.current = targetNodePositions;
      setAnimatedNodePositions(targetNodePositions);
      return undefined;
    }

    const startPositions = {};
    tags.forEach((tag) => {
      startPositions[tag] = currentPositions[tag] || targetNodePositions[tag];
    });

    const duration = 460;
    const startTime = performance.now();

    const step = (now) => {
      const progress = Math.min(1, (now - startTime) / duration);
      const eased = 1 - ((1 - progress) ** 3);
      const nextPositions = {};
      // Read from ref so mid-animation target changes are picked up immediately
      const latestTargets = targetPositionsRef.current;

      tags.forEach((tag) => {
        const start = startPositions[tag];
        const target = latestTargets[tag] || start;
        nextPositions[tag] = {
          x: start.x + ((target.x - start.x) * eased),
          y: start.y + ((target.y - start.y) * eased),
        };
      });

      animatedPositionsRef.current = nextPositions;
      setAnimatedNodePositions(nextPositions);

      if (progress < 1) {
        animationFrameRef.current = requestAnimationFrame(step);
      } else {
        animationFrameRef.current = null;
      }
    };

    animationFrameRef.current = requestAnimationFrame(step);

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
    };
  }, [targetNodePositions]);

  return {
    canvasRef, canvasSize, hoveredLine, setHoveredLine, tooltipPos, setTooltipPos,
    dragOverrides, setDragOverrides, dragRef, panOffset, panRef, zoom,
    linePopover, setLinePopover, searchTerm, setSearchTerm,
    degreeMap, peerMap, selectedTag, peerTags, meshMinHeight, nodePositions, lines, selectedLineCount,
    handleNodePointerDown, handleCanvasPointerDown, recenterView, zoomBy,
  };
}
