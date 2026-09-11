import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import api from '../../api.js';
import useDocumentTitle from '../../hooks/useDocumentTitle.js';
import { useAuth } from '../../contexts/AuthContext.jsx';
import PoliciesPageView from './policies/PoliciesPageView.jsx';

import { describeServices, buildPolicyGraph, clamp, buildNodePositions, buildLineModels } from './policies/policyGraph.js';

export default function PoliciesPage() {
  useDocumentTitle('Policies');
  const { user } = useAuth();
  const canManageObjects = !!user?.isAdmin;
  const [firewalls, setFirewalls] = useState([]);
  const [selectedFw, setSelectedFw] = useState(null);
  const [vlans, setVlans] = useState([]);
  const [policies, setPolicies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [policiesLoading, setPoliciesLoading] = useState(false);

  const [srcVlan, setSrcVlan] = useState(null);
  const [dstVlan, setDstVlan] = useState(null);
  const [showModal, setShowModal] = useState(false);
  const [selectedServices, setSelectedServices] = useState(new Set(['ALL']));
  const [bidirectional, setBidirectional] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  const [activeTab, setActiveTab] = useState('rules');
  const [addressObjects, setAddressObjects] = useState([]);
  const [serviceObjects, setServiceObjects] = useState([]);
  const [objectsLoading, setObjectsLoading] = useState(false);
  const [showAddrForm, setShowAddrForm] = useState(false);
  const [showSvcForm, setShowSvcForm] = useState(false);
  const [addrForm, setAddrForm] = useState({ name: '', subnet: '', comment: '' });
  const [svcForm, setSvcForm] = useState({ name: '', tcpPortrange: '', udpPortrange: '', comment: '' });
  const [objectError, setObjectError] = useState('');

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
    api.get('/admin/firewalls').then(r => {
      setFirewalls(r.data || []);
      if (r.data.length > 0) setSelectedFw(r.data[0].id);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  const loadData = useCallback(() => {
    if (!selectedFw) return;
    setPoliciesLoading(true);
    Promise.all([
      api.get('/admin/vlans'),
      api.get(`/admin/policies?firewallId=${selectedFw}`),
    ]).then(([vlansRes, policiesRes]) => {
      const allVlans = vlansRes.data || [];
      const syncedVlans = allVlans.filter(v =>
        v.firewallSync?.some(s => String(s.firewallId) === String(selectedFw))
      );
      setVlans(syncedVlans);
      setPolicies(policiesRes.data || []);
    }).catch((err) => {
      console.error('Failed to load policy data:', err);
    }).finally(() => setPoliciesLoading(false));
  }, [selectedFw]);

  useEffect(() => {
    if (!selectedFw) return;
    loadData();
  }, [selectedFw, loadData]);

  const loadObjects = useCallback(() => {
    if (!selectedFw) return;
    setObjectsLoading(true);
    Promise.all([
      api.get(`/admin/objects/addresses?firewallId=${selectedFw}`),
      api.get(`/admin/objects/services?firewallId=${selectedFw}`),
    ]).then(([addrRes, svcRes]) => {
      setAddressObjects(addrRes.data || []);
      setServiceObjects(svcRes.data || []);
    }).catch((err) => {
      console.error('Failed to load objects:', err);
    }).finally(() => setObjectsLoading(false));
  }, [selectedFw]);

  useEffect(() => {
    if (!canManageObjects && activeTab !== 'rules') setActiveTab('rules');
  }, [activeTab, canManageObjects]);

  useEffect(() => {
    if (!canManageObjects) return;
    if ((activeTab === 'addresses' || activeTab === 'services') && selectedFw) loadObjects();
  }, [activeTab, canManageObjects, selectedFw, loadObjects]);

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

  // Esc walks back one step: modal → line popover → source selection
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key !== 'Escape') return;
      if (showModal) { cancelSelection(); return; }
      if (linePopover) { setLinePopover(null); return; }
      if (srcVlan) cancelSelection();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  const usedServices = useMemo(() => {
    const set = new Set();
    policies.forEach(p => (p.service || []).forEach(s => set.add(s)));
    return set;
  }, [policies]);
  const hasDeny = useMemo(() => policies.some(p => p.action !== 'accept'), [policies]);

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
  const selectedServiceList = Array.from(selectedServices);
  const serviceSummary = describeServices(selectedServiceList);
  const policyPreviewText = srcVlan && dstVlan
    ? `Allow ${serviceSummary.toLowerCase()} from ${srcVlan.name} to ${dstVlan.name}${bidirectional ? `, and mirror the same access back from ${dstVlan.name} to ${srcVlan.name}` : ''}.`
    : '';
  const policyCountPreview = bidirectional ? 2 : 1;

  const handleCardClick = (vlan) => {
    // Ignore click if user was dragging the node
    if (dragRef.current?.moved) return;
    if (!srcVlan) {
      setSrcVlan(vlan);
      setDragOverrides({});
      return;
    }
    if (srcVlan.tag === vlan.tag) {
      cancelSelection();
      return;
    }
    setDstVlan(vlan);
    setSelectedServices(new Set(['ALL']));
    setBidirectional(false);
    setError('');
    setShowModal(true);
  };

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

  const cancelSelection = () => {
    setSrcVlan(null);
    setDstVlan(null);
    setShowModal(false);
    setError('');
    setDragOverrides({});
  };

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

  const toggleService = (svc) => {
    setSelectedServices(prev => {
      const next = new Set(prev);
      if (svc === 'ALL') return new Set(['ALL']);
      next.delete('ALL');
      if (next.has(svc)) next.delete(svc);
      else next.add(svc);
      if (next.size === 0) next.add('ALL');
      return next;
    });
  };

  const createPolicy = async () => {
    setCreating(true);
    setError('');
    try {
      await api.post('/admin/policies', {
        firewallId: selectedFw,
        srcVlanTag: srcVlan.tag,
        dstVlanTag: dstVlan.tag,
        services: Array.from(selectedServices),
        action: 'accept',
        bidirectional,
      });
      cancelSelection();
      loadData();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to create policy');
    } finally {
      setCreating(false);
    }
  };

  const deletePolicy = async (policyId) => {
    if (!confirm('Delete this policy?')) return;
    try {
      await api.delete(`/admin/policies/${policyId}?firewallId=${selectedFw}`);
      setLinePopover(null);
      loadData();
    } catch (err) {
      alert(err.response?.data?.error || 'Failed to delete policy');
    }
  };

  const grouped = useMemo(() => {
    const g = {};
    policies.forEach((policy) => {
      const key = policy.globalLabel || policy.srcintf;
      if (!g[key]) g[key] = { label: key, policies: [] };
      g[key].policies.push(policy);
    });
    return g;
  }, [policies]);

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

  const model = {
    loading,
    showModal,
    srcVlan,
    dstVlan,
    firewalls,
    selectedFw,
    setSelectedFw,
    vlans,
    policies,
    policiesLoading,
    canManageObjects,
    activeTab,
    setActiveTab,
    addressObjects,
    serviceObjects,
    objectsLoading,
    showAddrForm,
    setShowAddrForm,
    showSvcForm,
    setShowSvcForm,
    addrForm,
    setAddrForm,
    svcForm,
    setSvcForm,
    objectError,
    setObjectError,
    canvasRef,
    canvasSize,
    hoveredLine,
    setHoveredLine,
    tooltipPos,
    setTooltipPos,
    dragOverrides,
    setDragOverrides,
    dragRef,
    panOffset,
    setPanOffset,
    panRef,
    zoom,
    setZoom,
    zoomRef,
    panOffsetRef,
    linePopover,
    setLinePopover,
    searchTerm,
    setSearchTerm,
    usedServices,
    hasDeny,
    degreeMap,
    peerMap,
    selectedTag,
    peerTags,
    meshMinHeight,
    nodePositions,
    lines,
    selectedLineCount,
    selectedServices,
    setSelectedServices,
    bidirectional,
    setBidirectional,
    creating,
    error,
    policyPreviewText,
    policyCountPreview,
    grouped,
    handleCardClick,
    handleNodePointerDown,
    handleCanvasPointerDown,
    cancelSelection,
    recenterView,
    zoomBy,
    toggleService,
    createPolicy,
    deletePolicy,
    loadObjects
  };

  return <PoliciesPageView model={model} />;
}