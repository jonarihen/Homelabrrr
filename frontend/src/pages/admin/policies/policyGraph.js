export const SERVICES = [
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

export const SERVICE_COLORS = {
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

export const DENY_COLOR = '#ef4444';
const NODE_CARD_SIZE = 160;
const NODE_SAFETY_PADDING = 26;
const MIN_NODE_SPACING = 172;
const NODE_COLLISION_GAP = 18;
export const MUTED_LINE_OPACITY = 0.44;
export const MUTED_NODE_OPACITY = 0.68;

export function vlanTagToSubnet(tag) {
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

export function badgeStyle(service, action = 'accept') {
  const color = action !== 'accept' ? DENY_COLOR : (SERVICE_COLORS[service] || '#94a3b8');
  return {
    color,
    backgroundColor: `${color}1a`,
    borderColor: `${color}33`,
  };
}

export function describeServices(services = []) {
  if (!services.length || services.includes('ALL')) return 'All traffic';
  const labels = services.map(service => SERVICE_LABELS[service] || service);
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(', ')}, and ${labels[labels.length - 1]}`;
}

export function buildPolicyGraph(policies) {
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

function placeOnEllipse(tags, {
  radiusX,
  radiusY,
  cx,
  cy,
  startAngle = -Math.PI / 2,
  spread = Math.PI * 2,
}) {
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
    placed.push(...placeOnEllipse(slice, { radiusX, radiusY, cx, cy, startAngle: startAngle + angleOffset }));

    bandIndex += 1;
    if (bandIndex > 8 && remaining.length > 0) {
      placed.push(...placeOnEllipse(remaining.splice(0), {
        radiusX: maxRadiusX,
        radiusY: maxRadiusY,
        cx,
        cy,
        startAngle: startAngle + 0.2,
      }));
      break;
    }
  }

  return placed;
}

export function clamp(value, min, max) {
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

export function buildNodePositions(vlans, policies, srcTag, width, height) {
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
    placeOnEllipse(sortedTags, {
      radiusX: Math.min(Math.max(safeRadiusX * 0.65, 160), safeRadiusX),
      radiusY: Math.min(Math.max(safeRadiusY * 0.6, 120), safeRadiusY),
      cx,
      cy,
    }).forEach(({ tag, x, y }) => {
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

export function buildLineModels(policies, positions, srcTag) {
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
