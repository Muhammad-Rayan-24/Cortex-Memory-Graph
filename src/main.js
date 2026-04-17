import { Viewer } from './viewer.js';
import { TileManager } from './tiles.js';

// Brain regions (clusters) and colors
export const CLUSTERS = [
  { name: 'Frontal Lobe', color: 0x7C3AED },
  { name: 'Temporal Lobe', color: 0x06B6D4 },
  { name: 'Parietal Lobe', color: 0xF59E0B },
  { name: 'Occipital Lobe', color: 0x10B981 },
  { name: 'Limbic System', color: 0xEF4444 },
];

// Virtual graph size
const VIRTUAL_NODE_COUNT = 10_000_000;
// Initial GPU budget (number of points resident on GPU). Tune per machine.
let GPU_POINTS = 1_000; // default small demo size; user can raise later

// Brain ellipsoid bounds (approximate head-centered coords)
const BOUNDS = { a: 180, b: 120, c: 100 };
const CENTROIDS = [
  [+0.45*BOUNDS.a, +0.15*BOUNDS.b, +0.05*BOUNDS.c],
  [+0.05*BOUNDS.a, -0.25*BOUNDS.b, -0.20*BOUNDS.c],
  [-0.10*BOUNDS.a, +0.30*BOUNDS.b, +0.10*BOUNDS.c],
  [-0.55*BOUNDS.a, +0.00*BOUNDS.b, +0.00*BOUNDS.c],
  [-0.05*BOUNDS.a, +0.00*BOUNDS.b, -0.25*BOUNDS.c],
];

// HUD elements
const nodeCountEl = document.getElementById('nodeCount');
const shownCountEl = document.getElementById('shownCount');
const budgetEl = document.getElementById('budget');
const budgetRange = document.getElementById('budgetRange');
const budgetInput = document.getElementById('budgetInput');
const showEdgesEl = document.getElementById('showEdges');
const edgePctRange = document.getElementById('edgePctRange');
const edgePctInput = document.getElementById('edgePctInput');
const edgeFracRange = document.getElementById('edgeFracRange');
const edgeFracInput = document.getElementById('edgeFracInput');
const edgesPerNodeRange = document.getElementById('edgesPerNodeRange');
const edgesPerNodeInput = document.getElementById('edgesPerNodeInput');
const reseedEdgesBtn = document.getElementById('reseedEdges');
const hoverInfoEl = document.getElementById('hoverInfo');
const selectInfoEl = document.getElementById('selectInfo');
const legendRows = document.getElementById('legendRows');
const resetBtn = document.getElementById('resetBtn');

nodeCountEl.textContent = `Neurons (Virtual): ${VIRTUAL_NODE_COUNT.toLocaleString()}`;
budgetEl.textContent = GPU_POINTS.toLocaleString();
budgetRange.value = String(GPU_POINTS);
budgetInput.value = String(GPU_POINTS);
// Edge UI defaults
let SHOW_EDGES = true;
let EDGES_PER_NODE = 1;
let EDGE_NODE_FRACTION = 0.05;
let EDGE_SEED = 1;
const MAX_EDGE_SEGMENTS = 50_000; // low cap for demo performance
let EDGE_PERCENT = 30; // default 30% of node count
showEdgesEl.checked = SHOW_EDGES;
edgePctRange.value = String(EDGE_PERCENT);
edgePctInput.value = String(EDGE_PERCENT);
edgeFracRange.value = String(EDGE_NODE_FRACTION);
edgeFracInput.value = String(EDGE_NODE_FRACTION);
edgesPerNodeRange.value = String(EDGES_PER_NODE);
edgesPerNodeInput.value = String(EDGES_PER_NODE);

// Legend
function hexToCss(hex) {
  return '#' + (hex >>> 0).toString(16).padStart(6, '0');
}
CLUSTERS.forEach(c => {
  const row = document.createElement('div');
  row.className = 'row';
  row.innerHTML = `<span class="swatch" style="background:${hexToCss(c.color)}"></span> ${c.name}`;
  legendRows.appendChild(row);
});

// Viewer
const viewer = new Viewer({
  maxPoints: GPU_POINTS,
  fogColor: 0x0f1021,
  clusters: CLUSTERS,
  bounds: BOUNDS,
});

// Worker-driven point generation with LOD (resolve relative to this module URL so it works on GitHub Pages subpaths)
const workerUrl = new URL('../workers/tileWorker.js', import.meta.url);
const worker = new Worker(workerUrl, { type: 'module' });

let pending = false;
let lastFrameTime = 0;
const FRAME_INTERVAL = 800; // ms between refreshes
const DYNAMIC_LOD = false; // keep rendered nodes fixed; don't refresh on camera moves
let lastCamTarget = null;
let lastCamDist = null;

function requestFrame(force = false) {
  if (pending) return;
  const now = performance.now();
  if (!force && now - lastFrameTime < FRAME_INTERVAL) return;
  const cam = viewer.getCameraState();
  const cx = cam.position[0] - cam.target[0];
  const cy = cam.position[1] - cam.target[1];
  const cz = cam.position[2] - cam.target[2];
  const dist = Math.sqrt(cx*cx+cy*cy+cz*cz);
  if (lastCamTarget) {
    const dx = cam.target[0]-lastCamTarget[0];
    const dy = cam.target[1]-lastCamTarget[1];
    const dz = cam.target[2]-lastCamTarget[2];
    const move = Math.sqrt(dx*dx+dy*dy+dz*dz);
    const zoomChange = Math.abs(dist - lastCamDist);
    if (!force && move < 40 && zoomChange < 40 && shownCountEl.textContent !== '0') {
      return; // small movement; skip refresh
    }
  }
  lastCamTarget = cam.target.slice();
  lastCamDist = dist;
  lastFrameTime = now;
  pending = true;
  worker.postMessage({
    type: 'requestPoints',
    maxPoints: GPU_POINTS,
    bounds: BOUNDS,
    clusters: CLUSTERS.map((c, i) => ({ id: i, color: c.color })),
    camera: cam,
    showEdges: SHOW_EDGES,
    edgesPerNode: EDGES_PER_NODE,
    edgeNodeFraction: EDGE_NODE_FRACTION,
    edgeSeed: EDGE_SEED,
    edgePercent: EDGE_PERCENT,
    maxEdgeSegments: MAX_EDGE_SEGMENTS,
  });
}

worker.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'pointsFrame') {
    const { positions, colors, clusterIds, count, edgePositions, edgeColors, edgeCount } = msg;
    viewer.updatePoints(count, positions, colors, clusterIds);
    viewer.updateLines(edgeCount || 0, edgePositions || null, edgeColors || null);
    shownCountEl.textContent = count.toLocaleString();
    // lightweight debug for visibility when needed
    // console.debug('[Cortex LOD] received points:', count, 'edges:', edgeCount||0);
    pending = false;
  }
};

worker.onerror = (e) => {
  console.error('[Cortex LOD] Worker error:', e.message || e);
  pending = false;
};
worker.onmessageerror = (e) => {
  console.error('[Cortex LOD] Worker message error:', e);
  pending = false;
};

// Interactions: hover & click
viewer.onHover = (hit) => {
  if (!hit) {
    hoverInfoEl.textContent = 'None';
    return;
  }
  const { index, clusterId, position } = hit;
  const name = CLUSTERS[clusterId]?.name || 'Unknown';
  hoverInfoEl.textContent = `#${index} • ${name} • (${position.x.toFixed(1)}, ${position.y.toFixed(1)}, ${position.z.toFixed(1)})`;
};

viewer.onSelect = (hit) => {
  if (!hit) {
    selectInfoEl.textContent = 'None';
    return;
  }
  const { index, clusterId, position } = hit;
  const name = CLUSTERS[clusterId]?.name || 'Unknown';
  // distance to nearest centroid as an interpretive length metric
  let minD = Infinity;
  for (const c of CENTROIDS) {
    const dx = position.x - c[0];
    const dy = position.y - c[1];
    const dz = position.z - c[2];
    const d = Math.sqrt(dx*dx+dy*dy+dz*dz);
    if (d < minD) minD = d;
  }
  selectInfoEl.textContent = `#${index} • ${name} • (${position.x.toFixed(1)}, ${position.y.toFixed(1)}, ${position.z.toFixed(1)}) • d=${minD.toFixed(1)}`;
};

resetBtn?.addEventListener('click', () => viewer.resetView());

// Request LOD frames based on navigation
viewer.onViewChanged = () => { if (DYNAMIC_LOD) requestFrame(false); };

// Kick off first frame
requestFrame(true);

// Budget controls
function applyBudget(value) {
  const parsed = Number(value);
  const v = Math.max(0, Math.min(2_000_000, Number.isFinite(parsed) ? parsed : GPU_POINTS));
  if (v === GPU_POINTS) return;
  GPU_POINTS = v;
  budgetEl.textContent = GPU_POINTS.toLocaleString();
  budgetRange.value = String(GPU_POINTS);
  budgetInput.value = String(GPU_POINTS);
  viewer.setMaxPoints(GPU_POINTS);
  requestFrame(true);
}

budgetRange?.addEventListener('input', (e) => applyBudget(e.target.value));
budgetInput?.addEventListener('change', (e) => applyBudget(e.target.value));
console.log('[Cortex LOD] v0.2 starting...');

// Edge controls
function syncPair(rangeEl, inputEl, parser, onChange){
  const parse = parser || (v => Number(v));
  rangeEl?.addEventListener('input', (e) => { const v = parse(e.target.value); inputEl.value = String(v); onChange(v); });
  inputEl?.addEventListener('change', (e) => { const v = parse(e.target.value); rangeEl.value = String(v); onChange(v); });
}

showEdgesEl?.addEventListener('change', () => { SHOW_EDGES = !!showEdgesEl.checked; viewer.updateLines(0, null); requestFrame(true); });
syncPair(edgeFracRange, edgeFracInput, v => Math.max(0, Math.min(0.5, Number(v) || 0)), (v) => { EDGE_NODE_FRACTION = v; requestFrame(true); });
syncPair(edgesPerNodeRange, edgesPerNodeInput, v => Math.max(0, Math.min(4, Math.round(Number(v)||0))), (v) => { EDGES_PER_NODE = v; requestFrame(true); });
reseedEdgesBtn?.addEventListener('click', () => { EDGE_SEED = (EDGE_SEED + 1) >>> 0; requestFrame(true); });
syncPair(edgePctRange, edgePctInput, v => Math.max(0, Math.min(100, Math.round(Number(v)||0))), (v) => { EDGE_PERCENT = v; requestFrame(true); });
