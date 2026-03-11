import { useState, useEffect, useRef, useCallback } from 'react';
import api from '../../api.js';
import useDocumentTitle from '../../hooks/useDocumentTitle.js';
import { useAuth } from '../../contexts/AuthContext.jsx';

const SERVICES = [
  { name: 'ALL', label: 'All Traffic' },
  { name: 'HTTP', label: 'HTTP' },
  { name: 'HTTPS', label: 'HTTPS' },
  { name: 'SSH', label: 'SSH' },
  { name: 'RDP', label: 'RDP' },
  { name: 'DNS', label: 'DNS' },
  { name: 'PING', label: 'Ping' },
  { name: 'ALL_TCP', label: 'All TCP' },
  { name: 'ALL_UDP', label: 'All UDP' },
];

const SERVICE_LABELS = Object.fromEntries(SERVICES.map(service => [service.name, service.label]));

const SERVICE_COLORS = {
  ALL: '#22c55e',
  HTTP: '#3b82f6',
  HTTPS: '#8b5cf6',
  SSH: '#f59e0b',
  RDP: '#ec4899',
  DNS: '#06b6d4',
  PING: '#84cc16',
  ALL_TCP: '#6366f1',
  ALL_UDP: '#f97316',
};

const DENY_COLOR = '#ef4444';
const NODE_CARD_SIZE = 160;
const NODE_SAFETY_PADDING = 26;
const MIN_NODE_SPACING = 172;
const NODE_COLLISION_GAP = 18;

function vlanTagToSubnet(tag) {
  const s = String(tag).padStart(4, '0');
  return `10.${parseInt(s.substring(0, 2), 10)}.${parseInt(s.substring(2, 4), 10)}.0/24`;
}

function servicePalette(services = [], action = 'accept') {
  if (action !== 'accept') return [DENY_COLOR];

  const unique = Array.from(new Set(services.filter(Boolean)));
  if (unique.length === 0) return [SERVICE_COLORS.ALL];

  const ordered = unique.length > 1
    ? [...unique.filter(s => s !== 'ALL'), ...(unique.includes('ALL') ? ['ALL'] : [])]
    : unique;

  return ordered.slice(0, 4).map(s => SERVICE_COLORS[s] || '#94a3b8');
}

function badgeStyle(service, action = 'accept') {
  const color = action !== 'accept' ? DENY_COLOR : (SERVICE_COLORS[service] || '#94a3b8');
  return {
    color,
    backgroundColor: `${color}1a`,
    borderColor: `${color}33`,
  };
}

function describeServices(services = []) {
  if (!services.length || services.includes('ALL')) return 'All traffic';
  const labels = services.map(service => SERVICE_LABELS[service] || service);
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(', ')}, and ${labels[labels.length - 1]}`;
}

function buildPolicyGraph(policies) {
  const degree = new Map();
  const peers = new Map();
  const interVlan = policies.filter(p => !p.isInternet && p.srcVlan && p.dstVlan);

  const touch = (a, b) => {
    degree.set(a, (degree.get(a) || 0) + 1);
    if (!peers.has(a)) peers.set(a, new Set());
    peers.get(a).add(b);
  };

  interVlan.forEach((p) => {
    touch(p.srcVlan.tag, p.dstVlan.tag);
    touch(p.dstVlan.tag, p.srcVlan.tag);
  });

  return { degree, peers, interVlan };
}

function ellipseCircumference(radiusX, radiusY) {
  if (radiusX <= 0 || radiusY <= 0) return 0;
  const h = ((radiusX - radiusY) ** 2) / ((radiusX + radiusY) ** 2 || 1);
  return Math.PI * (radiusX + radiusY) * (1 + ((3 * h) / (10 + Math.sqrt(4 - (3 * h)))));
}

function placeOnEllipse(tags, radiusX, radiusY, cx, cy, startAngle = -Math.PI / 2, spread = Math.PI * 2) {
  if (tags.length === 0) return [];
  return tags.map((tag, index) => {
    const angle = startAngle + (spread * index) / tags.length;
    return {
      tag,
      x: cx + Math.cos(angle) * radiusX,
      y: cy + Math.sin(angle) * radiusY,
    };
  });
}

function placeAcrossBands(tags, {
  baseRadiusX,
  baseRadiusY,
  maxRadiusX,
  maxRadiusY,
  cx,
  cy,
  spacing = MIN_NODE_SPACING,
  startAngle = -Math.PI / 2,
}) {
  if (tags.length === 0) return [];

  const placed = [];
  const remaining = [...tags];
  const gapX = Math.max(74, spacing * 0.72);
  const gapY = Math.max(42, spacing * 0.38);
  let bandIndex = 0;

  while (remaining.length > 0) {
    const radiusX = Math.min(maxRadiusX, baseRadiusX + (bandIndex * gapX));
    const radiusY = Math.min(maxRadiusY, baseRadiusY + (bandIndex * gapY));
    const circumference = ellipseCircumference(radiusX, radiusY);
    let capacity = Math.max(1, Math.floor(circumference / spacing));

    const atLimit = radiusX >= maxRadiusX - 1 && radiusY >= maxRadiusY - 1;
    if (atLimit) capacity = remaining.length;

    const count = Math.min(remaining.length, capacity);
    const slice = remaining.splice(0, count);
    const angleOffset = bandIndex % 2 === 0 ? 0 : Math.PI / Math.max(6, count);
    placed.push(...placeOnEllipse(slice, radiusX, radiusY, cx, cy, startAngle + angleOffset));

    bandIndex += 1;
    if (bandIndex > 8 && remaining.length > 0) {
      placed.push(...placeOnEllipse(remaining.splice(0), maxRadiusX, maxRadiusY, cx, cy, startAngle + 0.2));
      break;
    }
  }

  return placed;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function resolveSquareCollisions(initialPositions, width, height, fixedTags = new Set()) {
  const tags = Object.keys(initialPositions);
  if (tags.length <= 1) return initialPositions;

  const half = NODE_CARD_SIZE / 2;
  const minX = half + NODE_SAFETY_PADDING;
  const maxX = Math.max(minX, width - half - NODE_SAFETY_PADDING);
  const minY = half + NODE_SAFETY_PADDING;
  const maxY = Math.max(minY, height - half - NODE_SAFETY_PADDING);

  const positions = Object.fromEntries(
    tags.map(tag => [
      tag,
      {
        x: clamp(initialPositions[tag].x, minX, maxX),
        y: clamp(initialPositions[tag].y, minY, maxY),
      },
    ])
  );

  for (let iteration = 0; iteration < 90; iteration += 1) {
    let moved = false;
    const adjustments = Object.fromEntries(tags.map(tag => [tag, { x: 0, y: 0 }]));

    for (let i = 0; i < tags.length; i += 1) {
      for (let j = i + 1; j < tags.length; j += 1) {
        const tagA = tags[i];
        const tagB = tags[j];
        const a = positions[tagA];
        const b = positions[tagB];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const overlapX = (NODE_CARD_SIZE + NODE_COLLISION_GAP) - Math.abs(dx);
        const overlapY = (NODE_CARD_SIZE + NODE_COLLISION_GAP) - Math.abs(dy);

        if (overlapX <= 0 || overlapY <= 0) continue;

        moved = true;
        const pushAlongX = overlapX < overlapY;
        const fixedA = fixedTags.has(tagA);
        const fixedB = fixedTags.has(tagB);
        const dirX = dx === 0 ? (i % 2 === 0 ? -1 : 1) : Math.sign(dx);
        const dirY = dy === 0 ? (j % 2 === 0 ? -1 : 1) : Math.sign(dy);

        if (pushAlongX) {
          const amount = overlapX + 0.5;
          if (!fixedA && !fixedB) {
            adjustments[tagA].x -= dirX * (amount / 2);
            adjustments[tagB].x += dirX * (amount / 2);
          } else if (fixedA && !fixedB) {
            adjustments[tagB].x += dirX * amount;
          } else if (!fixedA && fixedB) {
            adjustments[tagA].x -= dirX * amount;
          }
        } else {
          const amount = overlapY + 0.5;
          if (!fixedA && !fixedB) {
            adjustments[tagA].y -= dirY * (amount / 2);
            adjustments[tagB].y += dirY * (amount / 2);
          } else if (fixedA && !fixedB) {
            adjustments[tagB].y += dirY * amount;
          } else if (!fixedA && fixedB) {
            adjustments[tagA].y -= dirY * amount;
          }
        }
      }
    }

    tags.forEach((tag) => {
      if (fixedTags.has(tag)) {
        positions[tag] = {
          x: clamp(initialPositions[tag].x, minX, maxX),
          y: clamp(initialPositions[tag].y, minY, maxY),
        };
        return;
      }

      positions[tag] = {
        x: clamp(positions[tag].x + (adjustments[tag].x * 0.92), minX, maxX),
        y: clamp(positions[tag].y + (adjustments[tag].y * 0.92), minY, maxY),
      };
    });

    if (!moved) break;
  }

  return positions;
}

function buildNodePositions(vlans, policies, srcTag, width, height) {
  const { degree, peers } = buildPolicyGraph(policies);
  const sortedTags = vlans
    .map(v => v.tag)
    .sort((a, b) => (degree.get(b) || 0) - (degree.get(a) || 0) || a - b);

  const cx = width / 2;
  const cy = height / 2;
  const safeRadiusX = Math.max(120, (width / 2) - ((NODE_CARD_SIZE / 2) + NODE_SAFETY_PADDING));
  const safeRadiusY = Math.max(100, (height / 2) - ((NODE_CARD_SIZE / 2) + NODE_SAFETY_PADDING));
  const positions = {};

  if (sortedTags.length === 1) {
    positions[sortedTags[0]] = { x: cx, y: cy };
    return resolveSquareCollisions(positions, width, height);
  }

  if (srcTag) {
    positions[srcTag] = { x: cx, y: cy };

    const peerTags = Array.from(peers.get(srcTag) || []).sort(
      (a, b) => (degree.get(b) || 0) - (degree.get(a) || 0) || a - b
    );
    const otherTags = sortedTags.filter(tag => tag !== srcTag && !peerTags.includes(tag));

    const innerBaseX = Math.min(Math.max(safeRadiusX * 0.42, 165), safeRadiusX);
    const innerBaseY = Math.min(Math.max(safeRadiusY * 0.3, 110), safeRadiusY);
    const innerMaxX = Math.min(safeRadiusX * 0.7, safeRadiusX - 26);
    const innerMaxY = Math.min(safeRadiusY * 0.58, safeRadiusY - 22);
    const outerBaseX = Math.min(Math.max(safeRadiusX * 0.7, innerMaxX + 32), safeRadiusX);
    const outerBaseY = Math.min(Math.max(safeRadiusY * 0.72, innerMaxY + 18), safeRadiusY);

    placeAcrossBands(peerTags, {
      baseRadiusX: innerBaseX,
      baseRadiusY: innerBaseY,
      maxRadiusX: Math.max(innerBaseX, innerMaxX),
      maxRadiusY: Math.max(innerBaseY, innerMaxY),
      cx,
      cy,
      spacing: MIN_NODE_SPACING - 8,
    }).forEach(({ tag, x, y }) => {
      positions[tag] = { x, y };
    });

    placeAcrossBands(otherTags, {
      baseRadiusX: outerBaseX,
      baseRadiusY: outerBaseY,
      maxRadiusX: safeRadiusX,
      maxRadiusY: safeRadiusY,
      cx,
      cy,
      startAngle: -Math.PI / 2 + 0.28,
    }).forEach(({ tag, x, y }) => {
      positions[tag] = { x, y };
    });

    return resolveSquareCollisions(positions, width, height, new Set([String(srcTag)]));
  }

  if (sortedTags.length <= 4) {
    placeOnEllipse(
      sortedTags,
      Math.min(Math.max(safeRadiusX * 0.65, 160), safeRadiusX),
      Math.min(Math.max(safeRadiusY * 0.6, 120), safeRadiusY),
      cx,
      cy
    ).forEach(({ tag, x, y }) => {
      positions[tag] = { x, y };
    });
    return resolveSquareCollisions(positions, width, height);
  }

  const innerCount = Math.max(2, Math.ceil(sortedTags.length / 3));
  const innerTags = sortedTags.slice(0, innerCount);
  const outerTags = sortedTags.slice(innerCount);

  placeAcrossBands(innerTags, {
    baseRadiusX: Math.min(Math.max(safeRadiusX * 0.34, 140), safeRadiusX),
    baseRadiusY: Math.min(Math.max(safeRadiusY * 0.28, 95), safeRadiusY),
    maxRadiusX: Math.min(safeRadiusX * 0.58, safeRadiusX - 32),
    maxRadiusY: Math.min(safeRadiusY * 0.5, safeRadiusY - 24),
    cx,
    cy,
    spacing: MIN_NODE_SPACING - 10,
  }).forEach(({ tag, x, y }) => {
    positions[tag] = { x, y };
  });

  placeAcrossBands(outerTags, {
    baseRadiusX: Math.min(Math.max(safeRadiusX * 0.72, 220), safeRadiusX),
    baseRadiusY: Math.min(Math.max(safeRadiusY * 0.72, 150), safeRadiusY),
    maxRadiusX: safeRadiusX,
    maxRadiusY: safeRadiusY,
    cx,
    cy,
    startAngle: -Math.PI / 2 + 0.18,
  }).forEach(({ tag, x, y }) => {
    positions[tag] = { x, y };
  });

  return resolveSquareCollisions(positions, width, height);
}

function buildLineModels(policies, positions, srcTag) {
  const pairCounts = new Map();

  return policies
    .filter(p => !p.isInternet && p.srcVlan && p.dstVlan)
    .map((p) => {
      const src = positions[p.srcVlan.tag];
      const dst = positions[p.dstVlan.tag];
      if (!src || !dst) return null;

      const dx = dst.x - src.x;
      const dy = dst.y - src.y;
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len;
      const ny = dx / len;
      const midX = (src.x + dst.x) / 2;
      const midY = (src.y + dst.y) / 2;
      const pairKey = [p.srcVlan.tag, p.dstVlan.tag].sort((a, b) => a - b).join('-');
      const pairIndex = pairCounts.get(pairKey) || 0;
      pairCounts.set(pairKey, pairIndex + 1);

      const bendBase = Math.max(30, Math.min(90, len * 0.16));
      const direction = pairIndex % 2 === 0 ? 1 : -1;
      const intensity = Math.floor(pairIndex / 2) + 1;
      const bend = (srcTag && (p.srcVlan.tag === srcTag || p.dstVlan.tag === srcTag))
        ? bendBase * 0.45 * direction * intensity
        : bendBase * direction * intensity;
      const controlX = midX + nx * bend;
      const controlY = midY + ny * bend;

      return {
        id: p.policyid,
        pathD: `M ${src.x} ${src.y} Q ${controlX} ${controlY} ${dst.x} ${dst.y}`,
        srcX: src.x,
        srcY: src.y,
        dstX: dst.x,
        dstY: dst.y,
        srcName: p.srcVlan.name,
        dstName: p.dstVlan.name,
        srcTag: p.srcVlan.tag,
        dstTag: p.dstVlan.tag,
        action: p.action,
        services: p.service || [],
        colors: servicePalette(p.service, p.action),
        isFocused: !srcTag || p.srcVlan.tag === srcTag || p.dstVlan.tag === srcTag,
      };
    })
    .filter(Boolean);
}

function GraphLegend() {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {SERVICES.map(service => (
        <span
          key={service.name}
          className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.16em]"
          style={badgeStyle(service.name)}
        >
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: SERVICE_COLORS[service.name] }}
          />
          {service.label}
        </span>
      ))}
    </div>
  );
}

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
  }, []);

  const graph = buildPolicyGraph(policies);
  const degreeMap = graph.degree;
  const peerMap = graph.peers;
  const selectedTag = srcVlan?.tag || null;
  const peerTags = new Set(selectedTag ? Array.from(peerMap.get(selectedTag) || []) : []);
  const meshMinHeight = Math.max(620, 620 + (Math.max(0, vlans.length - 10) * 30));
  const targetNodePositions = buildNodePositions(vlans, policies, selectedTag, canvasSize.width, canvasSize.height);
  const nodePositions = Object.keys(animatedNodePositions).length > 0 ? animatedNodePositions : targetNodePositions;
  const lines = buildLineModels(policies, nodePositions, selectedTag);
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
    if (!srcVlan) {
      setSrcVlan(vlan);
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

  const cancelSelection = () => {
    setSrcVlan(null);
    setDstVlan(null);
    setShowModal(false);
    setError('');
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
      loadData();
    } catch (err) {
      alert(err.response?.data?.error || 'Failed to delete policy');
    }
  };

  const grouped = {};
  policies.forEach((policy) => {
    const key = policy.globalLabel || policy.srcintf;
    if (!grouped[key]) grouped[key] = { label: key, policies: [] };
    grouped[key].policies.push(policy);
  });

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

      tags.forEach((tag) => {
        const start = startPositions[tag];
        const target = targetNodePositions[tag];
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
  }, [vlans, policies, selectedTag, canvasSize.width, canvasSize.height]);

  if (loading) {
    return (
      <div className="p-6 lg:p-8 max-w-7xl mx-auto">
        <div className="bg-gray-900 border border-gray-800 rounded-3xl h-[700px] animate-pulse" />
      </div>
    );
  }

  return (
    <div className="p-6 lg:p-8 max-w-7xl mx-auto space-y-6">
      <div className="space-y-4">
        <div className="rounded-3xl border border-gray-800 bg-[radial-gradient(circle_at_top,_rgba(59,130,246,0.16),_transparent_35%),linear-gradient(180deg,_rgba(15,23,42,0.98),_rgba(2,6,23,0.98))] p-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="space-y-3">
              <div>
                <h1 className="text-2xl font-bold tracking-tight text-white">Policy Mesh</h1>
                <p className="mt-1 text-sm text-slate-400">
                  {srcVlan
                    ? `Source locked on ${srcVlan.name}. Existing peers pull inward so you can see the neighborhood before choosing a destination.`
                    : 'Choose a source VLAN to pull its existing peers into focus, then click a destination to define the rule.'}
                </p>
              </div>
              <GraphLegend />
            </div>

            <div className="flex flex-col gap-3 sm:flex-row">
              <div className="rounded-2xl border border-slate-800 bg-slate-900/70 px-4 py-3 text-sm">
                <p className="text-[10px] uppercase tracking-[0.22em] text-slate-500">Selection</p>
                <p className="mt-1 font-medium text-white">
                  {srcVlan ? srcVlan.name : 'No source selected'}
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  {srcVlan
                    ? `${peerTags.size} linked VLANs, ${selectedLineCount || 0} visible routes`
                    : `${vlans.length} VLANs in this firewall mesh`}
                </p>
              </div>

              <div className="rounded-2xl border border-slate-800 bg-slate-900/70 px-4 py-3 text-sm">
                <p className="text-[10px] uppercase tracking-[0.22em] text-slate-500">Firewall</p>
                {firewalls.length > 1 ? (
                  <select
                    value={selectedFw || ''}
                    onChange={e => { setSelectedFw(parseInt(e.target.value, 10)); cancelSelection(); }}
                    className="mt-1 rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white"
                  >
                    {firewalls.map(fw => <option key={fw.id} value={fw.id}>{fw.name}</option>)}
                  </select>
                ) : (
                  <p className="mt-1 font-medium text-white">{firewalls[0]?.name || 'No firewall selected'}</p>
                )}
              </div>
            </div>
          </div>

          <div
            ref={canvasRef}
            className="relative mt-6 overflow-hidden rounded-[28px] border border-slate-800 bg-[radial-gradient(circle_at_center,_rgba(30,41,59,0.75),_rgba(2,6,23,0.98)_68%)] px-4 py-4 min-h-[620px]"
            style={{ minHeight: `${meshMinHeight}px` }}
            onMouseLeave={() => setHoveredLine(null)}
          >
            <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(148,163,184,0.05)_1px,transparent_1px),linear-gradient(90deg,rgba(148,163,184,0.05)_1px,transparent_1px)] bg-[size:72px_72px]" />
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_center,_rgba(56,189,248,0.12),_transparent_46%)]" />
            {selectedTag && (
              <div className="pointer-events-none absolute inset-0 z-[2] flex items-center justify-center">
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
                <div className="absolute left-1/2 top-[22%] -translate-x-1/2 rounded-full border border-cyan-400/15 bg-cyan-500/5 px-3 py-1 text-[10px] uppercase tracking-[0.22em] text-cyan-200/80">
                  Existing Paths
                </div>
                <div className="absolute left-1/2 top-[11%] -translate-x-1/2 rounded-full border border-slate-700 bg-slate-900/80 px-3 py-1 text-[10px] uppercase tracking-[0.22em] text-slate-400">
                  Available Targets
                </div>
              </div>
            )}

            {policiesLoading && (
              <div className="absolute inset-0 z-20 flex items-center justify-center rounded-[28px] bg-slate-950/70 backdrop-blur-sm">
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
                <svg className="absolute inset-0 z-[3] h-full w-full" style={{ overflow: 'visible' }}>
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
                    const opacity = line.isFocused ? 1 : 0.18;
                    return (
                      <g key={line.id}>
                        <path
                          d={line.pathD}
                          stroke="transparent"
                          strokeWidth={24}
                          fill="none"
                          style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
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
                          stroke="rgba(15,23,42,0.92)"
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
                                    fill="rgba(255,255,255,0.9)"
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
                </svg>

                {hoveredLine && (() => {
                  const line = lines.find(item => item.id === hoveredLine);
                  if (!line) return null;
                  const edgeColor = line.colors[0];
                  return (
                    <div
                      className="pointer-events-none absolute z-10"
                      style={{
                        left: tooltipPos.x,
                        top: tooltipPos.y,
                        transform: 'translate(-50%, -100%)',
                      }}
                    >
                      <div
                        className="min-w-[220px] rounded-2xl border bg-slate-950/95 px-4 py-3 shadow-2xl backdrop-blur-sm"
                        style={{ borderColor: `${edgeColor}40` }}
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
                              className="rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em]"
                              style={badgeStyle(service, line.action)}
                            >
                              {service}
                            </span>
                          ))}
                        </div>
                        <p className="mt-2 text-[10px] uppercase tracking-[0.18em] text-slate-500">
                          {line.action === 'accept' ? 'Allowed traffic path' : 'Denied traffic path'}
                        </p>
                      </div>
                      <div
                        className="mx-auto -mt-1 h-2 w-2 rotate-45 bg-slate-950"
                        style={{ borderBottom: `1px solid ${edgeColor}40`, borderRight: `1px solid ${edgeColor}40` }}
                      />
                    </div>
                  );
                })()}

                <div className="relative z-[4] min-h-[588px]">
                  {vlans.map((vlan) => {
                    const position = nodePositions[vlan.tag];
                    if (!position) return null;

                    const isSource = srcVlan?.tag === vlan.tag;
                    const isDestination = dstVlan?.tag === vlan.tag;
                    const isPeer = peerTags.has(vlan.tag);
                    const isMuted = !!srcVlan && !isSource && !isPeer;
                    const routeCount = degreeMap.get(vlan.tag) || 0;
                    const peerCount = (peerMap.get(vlan.tag) || new Set()).size;
                    const scale = isSource ? 1.16 : isDestination ? 1.1 : isPeer ? 1.02 : isMuted ? 0.9 : 1;
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
                        onClick={() => handleCardClick(vlan)}
                        className={`absolute z-[5] h-36 w-36 rounded-[30px] border text-center transition-[transform,opacity,border-color,background-color,box-shadow] duration-300 sm:h-40 sm:w-40 ${
                          isSource
                            ? 'border-cyan-300/80 bg-cyan-500/10 shadow-[0_0_0_1px_rgba(34,211,238,0.22),0_0_0_12px_rgba(8,145,178,0.08),0_26px_60px_rgba(8,145,178,0.24)]'
                            : isDestination
                              ? 'border-emerald-300/80 bg-emerald-500/10 shadow-[0_0_0_1px_rgba(16,185,129,0.2),0_0_0_10px_rgba(5,150,105,0.08),0_24px_60px_rgba(5,150,105,0.22)]'
                              : isPeer
                                ? 'border-slate-500/80 bg-slate-800/92 hover:border-cyan-300/50'
                                : 'border-slate-800 bg-slate-900/88 hover:border-slate-600 hover:bg-slate-900'
                        } ${isMuted ? 'opacity-30' : 'opacity-100'}`}
                        style={{
                          left: `${position.x}px`,
                          top: `${position.y}px`,
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
                                ? 'radial-gradient(circle, rgba(34,211,238,0.35), transparent 72%)'
                                : isDestination
                                  ? 'radial-gradient(circle, rgba(16,185,129,0.35), transparent 72%)'
                                  : isPeer
                                    ? 'radial-gradient(circle, rgba(148,163,184,0.18), transparent 72%)'
                                    : 'radial-gradient(circle, rgba(59,130,246,0.12), transparent 72%)',
                            }}
                          />
                          <div className="relative z-[1] mx-auto flex w-full max-w-[72%] flex-col items-center justify-center text-center">
                            <div className="inline-flex max-w-full items-center justify-center whitespace-nowrap rounded-full border border-slate-700/80 bg-slate-900/95 px-1.5 py-0.5 text-[7px] font-semibold uppercase tracking-[0.06em] text-slate-400 sm:text-[8px]">
                              VLAN {vlan.tag}
                            </div>
                            <h3 className="mt-1 line-clamp-2 break-words text-[12px] font-semibold leading-[1.12] text-white [overflow-wrap:anywhere] sm:text-[14px]">
                              {vlan.name}
                            </h3>
                            <div className="mt-3 flex flex-wrap items-center justify-center gap-1 text-[8px] uppercase tracking-[0.1em] text-slate-400 sm:text-[9px]">
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
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-3xl border border-gray-800 bg-gray-900/90 p-5">
            <p className="text-[10px] uppercase tracking-[0.24em] text-slate-500">How To Read It</p>
            <div className="mt-3 space-y-3 text-sm text-slate-300">
              <p>Pick a VLAN. It moves to the center.</p>
              <p>Existing neighbors pull into the inner ring so you can see what is already wired.</p>
              <p>Route colors reflect the allowed service mix on that policy.</p>
              <p>Outer-ring VLANs are still valid targets, but they are not currently linked to the selected source.</p>
            </div>
          </div>

          <div className="rounded-3xl border border-gray-800 bg-gray-900/90 p-5">
            <p className="text-[10px] uppercase tracking-[0.24em] text-slate-500">Current Focus</p>
            {srcVlan ? (
              <div className="mt-3">
                <div className="rounded-2xl border border-cyan-500/20 bg-cyan-500/5 px-4 py-3">
                  <p className="text-sm font-semibold text-white">{srcVlan.name}</p>
                  <p className="mt-1 text-xs font-mono text-slate-400">{vlanTagToSubnet(srcVlan.tag)}</p>
                  <p className="mt-3 text-xs text-slate-400">
                    {peerTags.size} linked VLANs already share a policy with this source.
                  </p>
                </div>
                <button
                  onClick={cancelSelection}
                  className="mt-3 w-full rounded-xl border border-slate-700 bg-slate-800 px-3 py-2.5 text-sm text-slate-200 transition-colors hover:bg-slate-700"
                >
                  Clear Selection
                </button>
              </div>
            ) : (
              <p className="mt-3 text-sm text-slate-500">No VLAN selected. Click any node in the mesh to start routing from that source.</p>
            )}
          </div>
        </div>
      </div>

      <div className="overflow-hidden rounded-3xl border border-gray-800 bg-gray-900">
        <div className="flex border-b border-gray-800">
          {[
            { id: 'rules', label: 'Policies', count: policies.length },
            ...(canManageObjects ? [
              { id: 'addresses', label: 'Address Objects' },
              { id: 'services', label: 'Service Objects' },
            ] : []),
          ].map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`relative px-5 py-3 text-sm font-medium transition-colors ${
                activeTab === tab.id ? 'text-white' : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              {tab.label}
              {tab.count > 0 && <span className="ml-1.5 text-[10px] text-gray-500">({tab.count})</span>}
              {activeTab === tab.id && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-cyan-400" />}
            </button>
          ))}
        </div>

        {activeTab === 'rules' && (
          Object.keys(grouped).length === 0 ? (
            <div className="py-12 text-center">
              <p className="text-sm text-gray-500">No policies yet. Pick a source VLAN in the mesh to start creating one.</p>
            </div>
          ) : (
            <div className="divide-y divide-gray-800/50">
              {Object.values(grouped).map(group => (
                <div key={group.label}>
                  <div className="bg-gray-800/30 px-5 py-2.5">
                    <span className="text-xs font-medium text-gray-400">{group.label}</span>
                  </div>
                  <div className="divide-y divide-gray-800/30">
                    {group.policies.map(policy => (
                      <div key={policy.policyid} className="flex items-center gap-4 px-5 py-3 transition-colors hover:bg-gray-800/20">
                        <div className="flex min-w-0 flex-1 items-center gap-2">
                          <span className="shrink-0 text-xs font-mono text-cyan-300">{policy.srcVlan?.name || policy.srcintf}</span>
                          <svg className="h-4 w-4 shrink-0 text-gray-600" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
                          </svg>
                          <span className={`shrink-0 text-xs font-mono ${policy.isInternet ? 'text-amber-400' : 'text-emerald-300'}`}>
                            {policy.isInternet ? 'Internet' : (policy.dstVlan?.name || policy.dstintf)}
                          </span>
                        </div>

                        <div className="flex flex-wrap items-center gap-1.5">
                          {policy.service.map(service => (
                            <span
                              key={`${policy.policyid}-${service}`}
                              className="rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em]"
                              style={badgeStyle(service, policy.action)}
                            >
                              {service}
                            </span>
                          ))}
                        </div>

                        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 ${
                          policy.action === 'accept'
                            ? 'bg-emerald-500/10 text-emerald-300 ring-emerald-500/20'
                            : 'bg-red-500/10 text-red-300 ring-red-500/20'
                        }`}>
                          {policy.action}
                        </span>

                        {!policy.isInternet && (
                          <button
                            onClick={() => deletePolicy(policy.policyid)}
                            className="shrink-0 rounded p-1 text-gray-600 transition-colors hover:bg-red-500/10 hover:text-red-400"
                          >
                            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                            </svg>
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )
        )}

        {activeTab === 'addresses' && (
          <div>
            <div className="flex items-center justify-between border-b border-gray-800/50 px-5 py-3">
              <span className="text-xs text-gray-500">{addressObjects.length} address objects</span>
              <button
                onClick={() => { setShowAddrForm(true); setAddrForm({ name: '', subnet: '', comment: '' }); setObjectError(''); }}
                className="flex items-center gap-1 text-xs text-cyan-400 transition-colors hover:text-cyan-300"
              >
                <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" /></svg>
                Add
              </button>
            </div>
            {objectsLoading ? (
              <div className="py-12 text-center"><span className="text-sm text-gray-500">Loading...</span></div>
            ) : (
              <div className="max-h-96 divide-y divide-gray-800/30 overflow-y-auto">
                {addressObjects.map(object => (
                  <div key={object.name} className="flex items-center gap-3 px-5 py-2.5 transition-colors hover:bg-gray-800/20">
                    <span className="flex-1 truncate text-xs font-medium text-white">{object.name}</span>
                    <span className="shrink-0 text-xs font-mono text-gray-400">{object.subnet || object.fqdn || ''}</span>
                    <span className="rounded bg-gray-800 px-1.5 py-0.5 text-[10px] text-gray-500">{object.type}</span>
                    <button
                      onClick={async () => {
                        if (!confirm(`Delete address object "${object.name}"?`)) return;
                        try {
                          await api.delete(`/admin/objects/addresses/${encodeURIComponent(object.name)}?firewallId=${selectedFw}`);
                          loadObjects();
                        } catch (err) {
                          alert(err.response?.data?.error || 'Failed to delete');
                        }
                      }}
                      className="shrink-0 rounded p-1 text-gray-600 transition-colors hover:bg-red-500/10 hover:text-red-400"
                    >
                      <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                      </svg>
                    </button>
                  </div>
                ))}
                {addressObjects.length === 0 && <div className="py-8 text-center text-sm text-gray-500">No address objects</div>}
              </div>
            )}

            {showAddrForm && (
              <div className="border-t border-gray-700 bg-gray-800/30 px-5 py-4">
                <div className="mb-3 grid grid-cols-3 gap-3">
                  <input
                    type="text"
                    placeholder="Name (e.g. NET-10.10.5.0_24)"
                    value={addrForm.name}
                    onChange={e => setAddrForm(f => ({ ...f, name: e.target.value }))}
                    className="rounded-lg border border-gray-700/50 bg-gray-800 px-3 py-2 text-xs text-white placeholder-gray-600 focus:border-cyan-500 focus:outline-none"
                  />
                  <input
                    type="text"
                    placeholder="Subnet (e.g. 10.10.5.0 255.255.255.0)"
                    value={addrForm.subnet}
                    onChange={e => setAddrForm(f => ({ ...f, subnet: e.target.value }))}
                    className="rounded-lg border border-gray-700/50 bg-gray-800 px-3 py-2 text-xs text-white placeholder-gray-600 focus:border-cyan-500 focus:outline-none"
                  />
                  <input
                    type="text"
                    placeholder="Comment (optional)"
                    value={addrForm.comment}
                    onChange={e => setAddrForm(f => ({ ...f, comment: e.target.value }))}
                    className="rounded-lg border border-gray-700/50 bg-gray-800 px-3 py-2 text-xs text-white placeholder-gray-600 focus:border-cyan-500 focus:outline-none"
                  />
                </div>
                {objectError && <p className="mb-2 text-xs text-red-400">{objectError}</p>}
                <div className="flex gap-2">
                  <button onClick={() => setShowAddrForm(false)} className="rounded-lg px-3 py-1.5 text-xs text-gray-400 transition-colors hover:bg-gray-700 hover:text-white">Cancel</button>
                  <button
                    onClick={async () => {
                      setObjectError('');
                      try {
                        await api.post('/admin/objects/addresses', { firewallId: selectedFw, name: addrForm.name, subnet: addrForm.subnet, comment: addrForm.comment });
                        setShowAddrForm(false);
                        loadObjects();
                      } catch (err) {
                        setObjectError(err.response?.data?.error || 'Failed to create');
                      }
                    }}
                    className="rounded-lg bg-cyan-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-cyan-500"
                  >
                    Create
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {activeTab === 'services' && (
          <div>
            <div className="flex items-center justify-between border-b border-gray-800/50 px-5 py-3">
              <span className="text-xs text-gray-500">{serviceObjects.length} service objects</span>
              <button
                onClick={() => { setShowSvcForm(true); setSvcForm({ name: '', tcpPortrange: '', udpPortrange: '', comment: '' }); setObjectError(''); }}
                className="flex items-center gap-1 text-xs text-cyan-400 transition-colors hover:text-cyan-300"
              >
                <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" /></svg>
                Add
              </button>
            </div>
            {objectsLoading ? (
              <div className="py-12 text-center"><span className="text-sm text-gray-500">Loading...</span></div>
            ) : (
              <div className="max-h-96 divide-y divide-gray-800/30 overflow-y-auto">
                {serviceObjects.map(object => (
                  <div key={object.name} className="flex items-center gap-3 px-5 py-2.5 transition-colors hover:bg-gray-800/20">
                    <span className="flex-1 truncate text-xs font-medium text-white">{object.name}</span>
                    {object.tcpPortrange && <span className="rounded px-1.5 py-0.5 text-[10px] font-mono text-blue-400" style={{ backgroundColor: `${SERVICE_COLORS.HTTP}14` }}>TCP {object.tcpPortrange}</span>}
                    {object.udpPortrange && <span className="rounded px-1.5 py-0.5 text-[10px] font-mono text-amber-400" style={{ backgroundColor: `${SERVICE_COLORS.SSH}14` }}>UDP {object.udpPortrange}</span>}
                    <span className="rounded bg-gray-800 px-1.5 py-0.5 text-[10px] text-gray-500">{object.protocol}</span>
                    <button
                      onClick={async () => {
                        if (!confirm(`Delete service object "${object.name}"?`)) return;
                        try {
                          await api.delete(`/admin/objects/services/${encodeURIComponent(object.name)}?firewallId=${selectedFw}`);
                          loadObjects();
                        } catch (err) {
                          alert(err.response?.data?.error || 'Failed to delete');
                        }
                      }}
                      className="shrink-0 rounded p-1 text-gray-600 transition-colors hover:bg-red-500/10 hover:text-red-400"
                    >
                      <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                      </svg>
                    </button>
                  </div>
                ))}
                {serviceObjects.length === 0 && <div className="py-8 text-center text-sm text-gray-500">No custom service objects</div>}
              </div>
            )}

            {showSvcForm && (
              <div className="border-t border-gray-700 bg-gray-800/30 px-5 py-4">
                <div className="mb-3 grid grid-cols-4 gap-3">
                  <input
                    type="text"
                    placeholder="Name"
                    value={svcForm.name}
                    onChange={e => setSvcForm(f => ({ ...f, name: e.target.value }))}
                    className="rounded-lg border border-gray-700/50 bg-gray-800 px-3 py-2 text-xs text-white placeholder-gray-600 focus:border-cyan-500 focus:outline-none"
                  />
                  <input
                    type="text"
                    placeholder="TCP ports (e.g. 8080)"
                    value={svcForm.tcpPortrange}
                    onChange={e => setSvcForm(f => ({ ...f, tcpPortrange: e.target.value }))}
                    className="rounded-lg border border-gray-700/50 bg-gray-800 px-3 py-2 text-xs text-white placeholder-gray-600 focus:border-cyan-500 focus:outline-none"
                  />
                  <input
                    type="text"
                    placeholder="UDP ports (e.g. 5060)"
                    value={svcForm.udpPortrange}
                    onChange={e => setSvcForm(f => ({ ...f, udpPortrange: e.target.value }))}
                    className="rounded-lg border border-gray-700/50 bg-gray-800 px-3 py-2 text-xs text-white placeholder-gray-600 focus:border-cyan-500 focus:outline-none"
                  />
                  <input
                    type="text"
                    placeholder="Comment"
                    value={svcForm.comment}
                    onChange={e => setSvcForm(f => ({ ...f, comment: e.target.value }))}
                    className="rounded-lg border border-gray-700/50 bg-gray-800 px-3 py-2 text-xs text-white placeholder-gray-600 focus:border-cyan-500 focus:outline-none"
                  />
                </div>
                {objectError && <p className="mb-2 text-xs text-red-400">{objectError}</p>}
                <div className="flex gap-2">
                  <button onClick={() => setShowSvcForm(false)} className="rounded-lg px-3 py-1.5 text-xs text-gray-400 transition-colors hover:bg-gray-700 hover:text-white">Cancel</button>
                  <button
                    onClick={async () => {
                      setObjectError('');
                      try {
                        await api.post('/admin/objects/services', { firewallId: selectedFw, ...svcForm });
                        setShowSvcForm(false);
                        loadObjects();
                      } catch (err) {
                        setObjectError(err.response?.data?.error || 'Failed to create');
                      }
                    }}
                    className="rounded-lg bg-cyan-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-cyan-500"
                  >
                    Create
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {showModal && srcVlan && dstVlan && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" onClick={(e) => { if (e.target === e.currentTarget) cancelSelection(); }}>
          <div className="w-full max-w-md rounded-3xl border border-gray-700 bg-gray-900 shadow-2xl">
            <div className="border-b border-gray-700 px-5 py-4">
              <h2 className="font-semibold text-white">Create Policy</h2>
            </div>

            <div className="space-y-5 p-5">
              <div className="flex items-center justify-center gap-3 rounded-2xl border border-slate-800 bg-slate-800/50 py-3">
                <div className="text-center">
                  <p className="text-xs text-slate-500">Source</p>
                  <p className="text-sm font-medium text-cyan-300">{srcVlan.name}</p>
                  <p className="text-[10px] font-mono text-slate-600">{vlanTagToSubnet(srcVlan.tag)}</p>
                </div>
                <svg className="h-8 w-8 text-slate-600" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
                </svg>
                <div className="text-center">
                  <p className="text-xs text-slate-500">Destination</p>
                  <p className="text-sm font-medium text-emerald-300">{dstVlan.name}</p>
                  <p className="text-[10px] font-mono text-slate-600">{vlanTagToSubnet(dstVlan.tag)}</p>
                </div>
              </div>

              <div>
                <label className="mb-2 block text-xs font-medium text-slate-400">Allowed Services</label>
                <div className="flex flex-wrap gap-2">
                  {SERVICES.map(service => {
                    const active = selectedServices.has(service.name);
                    const color = SERVICE_COLORS[service.name];
                    return (
                      <button
                        key={service.name}
                        type="button"
                        onClick={() => toggleService(service.name)}
                        className="rounded-full border px-3 py-1.5 text-xs font-medium uppercase tracking-[0.14em] transition-all"
                        style={active
                          ? { color: '#fff', backgroundColor: color, borderColor: color, boxShadow: `0 0 0 1px ${color}55` }
                          : { color: '#94a3b8', backgroundColor: '#1f2937', borderColor: '#334155' }}
                      >
                        {service.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4">
                <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Policy Preview</p>
                <p className="mt-2 text-sm text-slate-200">{policyPreviewText}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <span className="rounded-full border border-cyan-500/20 bg-cyan-500/10 px-2.5 py-1 text-[10px] uppercase tracking-[0.14em] text-cyan-200">
                    {policyCountPreview} firewall rule{policyCountPreview !== 1 ? 's' : ''}
                  </span>
                  <span className="rounded-full border border-slate-700 bg-slate-900 px-2.5 py-1 text-[10px] uppercase tracking-[0.14em] text-slate-300">
                    Direction: {bidirectional ? 'two-way' : 'one-way'}
                  </span>
                </div>
              </div>

              <label className="group flex cursor-pointer items-center gap-3">
                <div className={`relative h-5 w-9 rounded-full transition-colors ${bidirectional ? 'bg-cyan-600' : 'bg-slate-700'}`} onClick={() => setBidirectional(!bidirectional)}>
                  <div className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${bidirectional ? 'translate-x-4' : 'translate-x-0.5'}`} />
                </div>
                <div>
                  <span className="text-sm text-slate-300 transition-colors group-hover:text-white">Bidirectional</span>
                  <p className="text-[10px] text-slate-600">Also allow {dstVlan.name} to reach {srcVlan.name}</p>
                </div>
              </label>

              {error && <p className="rounded-xl border border-red-800/30 bg-red-900/20 p-3 text-xs text-red-400">{error}</p>}

              <div className="flex gap-3">
                <button onClick={cancelSelection} className="flex-1 rounded-xl bg-slate-700 py-2.5 text-sm text-white transition-colors hover:bg-slate-600">
                  Cancel
                </button>
                <button
                  onClick={createPolicy}
                  disabled={creating || selectedServices.size === 0}
                  className="flex-1 rounded-xl bg-cyan-600 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-cyan-500 disabled:opacity-50"
                >
                  {creating ? 'Creating...' : 'Create Rule'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
