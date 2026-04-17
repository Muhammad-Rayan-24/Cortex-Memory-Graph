// Worker that generates points in a brain-shaped ellipsoid with 5 clusters.
// It honors a maxPoints GPU budget and concentrates density near the camera target.

// Deterministic PRNG for stable positions per sample index
function mulberry32(a) {
  return function() {
    let t = a += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  }
}

function gaussian(rand) {
  // Box-Muller transform
  let u = 0, v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function colorToFloats(hex) {
  const r = ((hex >> 16) & 255) / 255;
  const g = ((hex >> 8) & 255) / 255;
  const b = (hex & 255) / 255;
  // Return slightly boosted linear-ish values for visibility
  const boost = 1.15;
  return [Math.min(1, r*boost), Math.min(1, g*boost), Math.min(1, b*boost)];
}

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'requestPoints') {
    const { maxPoints, bounds, clusters, camera, edgesPerNode = 2, edgeNodeFraction = 0.05, edgePercent = 30, maxEdgeSegments = 200000 } = msg;
    // Use a fixed seed so points are deterministic across frames
    const seed = 0xC0FFEE ^ Math.floor(bounds.a*7) ^ Math.floor(bounds.b*11) ^ Math.floor(bounds.c*13);
    const rand = mulberry32(seed);

    // Define cluster centroids in a brain ellipsoid (two hemispheres implied by spread)
    const a = bounds.a, b = bounds.b, c = bounds.c;
    const centroids = [
      [+0.45*a, +0.15*b, +0.05*c], // Frontal
      [+0.05*a, -0.25*b, -0.20*c], // Temporal
      [-0.10*a, +0.30*b, +0.10*c], // Parietal
      [-0.55*a, +0.00*b, +0.00*c], // Occipital
      [-0.05*a, +0.00*b, -0.25*c], // Limbic
    ];

    // Camera-weighted sampling: prefer points closer to controls target
    const target = camera.target || [0,0,0];
    const tx = target[0], ty = target[1], tz = target[2];
    const biasRadius = Math.max(60, Math.min(a, b));

    const positions = new Float32Array(maxPoints * 3);
    const colors = new Float32Array(maxPoints * 3);
    const clusterIds = new Uint8Array(maxPoints);

    // Precompute float colors
    const clusterRGB = clusters.map(c => colorToFloats(c.color));

    let count = 0;
    for (let i = 0; i < maxPoints; i++) {
      const ci = Math.floor(rand() * centroids.length);
      const [cx, cy, cz] = centroids[ci];

      // Sample around centroid with gaussian noise, mirrored hemispheres
      const spread = 36 + 20*rand();
      const x = cx + gaussian(rand) * spread * (rand() < 0.5 ? 1 : -1) * (0.9 + 0.2*rand());
      const y = cy + gaussian(rand) * spread * (0.9 + 0.2*rand());
      const z = cz + gaussian(rand) * (spread*0.8) * (0.9 + 0.2*rand());

      // Soft-reject points outside ellipsoid to keep brain outline
      const ex = x / a, ey = y / b, ez = z / c;
      if (ex*ex + ey*ey + ez*ez > 1.0) { i--; continue; }

      // Proximity bias to camera target: accept more nearby points
      const dx = x - tx, dy = y - ty, dz = z - tz;
      const d = Math.sqrt(dx*dx + dy*dy + dz*dz);
      // Keep probability centered but NOT view-dependent to avoid reshuffling between frames
      const keepProb = 0.85;
      if (rand() > keepProb) { i--; continue; }

      const pi = count*3;
      positions[pi] = x; positions[pi+1] = y; positions[pi+2] = z;
      const [cr,cg,cb] = clusterRGB[ci];
      colors[pi] = cr; colors[pi+1] = cg; colors[pi+2] = cb;
      clusterIds[count] = ci;

      count++;
      if (count >= maxPoints) break;
    }

    // Build sparse edges with voxel hash for near neighbors (deterministic)
    let edgePositions = new Float32Array(0);
    let edgeColors = new Float32Array(0);
    let edgeCount = 0;
    if (msg.showEdges && count > 0 && edgesPerNode > 0 && maxEdgeSegments > 0) {
      const edgeSeed = (msg.edgeSeed >>> 0) || 1;
      const randE = mulberry32(seed ^ (edgeSeed * 0x9E3779B1));
      // Simple grid hash
      const cell = 30; // grid size in world units
      const map = new Map();
      const key = (ix,iy,iz)=> ix+','+iy+','+iz;
      const ix = (x)=> Math.floor(x/cell);
      for (let i=0;i<count;i++){
        const x=positions[i*3], y=positions[i*3+1], z=positions[i*3+2];
        const k = key(ix(x), ix(y), ix(z));
        if (!map.has(k)) map.set(k, []);
        map.get(k).push(i);
      }
      const targetSegs = Math.max(0, Math.min(maxEdgeSegments, Math.floor(count * (Math.max(0, Math.min(100, edgePercent)) / 100))));
      if (targetSegs === 0) {
        // no edges requested
        self.postMessage({ type: 'pointsFrame', positions, colors, clusterIds, count, edgePositions, edgeColors, edgeCount }, [positions.buffer, colors.buffer, clusterIds.buffer]);
        return;
      }
      const maxSeg = targetSegs;
      edgePositions = new Float32Array(maxSeg * 6);
      edgeColors = new Float32Array(maxSeg * 6);
      const r2 = 45*45; // neighbor radius squared
      const neigh = [];
      const offsets = [-1,0,1];
      outer: for (let i=0;i<count;i++){
        // Only a fraction of nodes originate edges (saves GPU/memory and declutters)
        if (edgeNodeFraction < 1 && (randE() > edgeNodeFraction)) continue;
        neigh.length = 0;
        const x=positions[i*3], y=positions[i*3+1], z=positions[i*3+2];
        const xi=ix(x), yi=ix(y), zi=ix(z);
        // gather candidates from adjacent cells
        for (let dx of offsets){ for (let dy of offsets){ for (let dz of offsets){
          const arr = map.get(key(xi+dx, yi+dy, zi+dz));
          if (!arr) continue;
          for (let j of arr){ if (j===i) continue; neigh.push(j); }
        }}}
        if (neigh.length===0) continue;
        // pick up to edgesPerNode nearest deterministically by scanning
        let picked = 0;
        for (let j of neigh){
          const dx=x-positions[j*3], dy=y-positions[j*3+1], dz=z-positions[j*3+2];
          const d2 = dx*dx+dy*dy+dz*dz;
          if (d2>r2) continue;
          const base = edgeCount*6;
          edgePositions[base]=x; edgePositions[base+1]=y; edgePositions[base+2]=z;
          edgePositions[base+3]=positions[j*3]; edgePositions[base+4]=positions[j*3+1]; edgePositions[base+5]=positions[j*3+2];
          const ci = clusterIds[i];
          const col = clusterRGB[ci];
          edgeColors[base]=col[0]; edgeColors[base+1]=col[1]; edgeColors[base+2]=col[2];
          edgeColors[base+3]=col[0]; edgeColors[base+4]=col[1]; edgeColors[base+5]=col[2];
          edgeCount++;
          picked++;
          if (edgeCount>=maxSeg) break outer;
          if (picked>=edgesPerNode) break;
        }
      }
    }

    // Post back using transferable objects to avoid copies
    const transfer = [positions.buffer, colors.buffer, clusterIds.buffer];
    if (edgeCount>0) { transfer.push(edgePositions.buffer); transfer.push(edgeColors.buffer); }
    self.postMessage({ type: 'pointsFrame', positions, colors, clusterIds, count, edgePositions, edgeColors, edgeCount }, transfer);
  }
};
