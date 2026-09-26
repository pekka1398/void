// Headless invariants for the lab's own LOD core and fixture.
import { HOLMAN_SPLIT_DISTANCE_RATIOS, PlanetLod, buildTileMesh, buildTileIndices, cubeToSphere, sphereToCube, tileContaining, tilesAround, tileUvBounds, FACE_EDGES, selectedNeighbor, neighborKey, parentKey, sameEdgeOnNeighbor, edgeReversedOnNeighbor, stitchEdges, type LodNode, type FaceEdge } from './src/lod';
import { DEMO_MAX_HEIGHT_METERS, DEMO_RADIUS_METERS, sampleDemoSurface, samplePlanetSurface } from './src/app/DemoSurface';
import { OrbitCamera } from './src/app/OrbitCamera';
import { SphericalProbe } from './src/app/SphericalProbe';
import { LANDING_TEST_PLANET } from './src/app/PlanetPresets';
import { tileId, type CubeFace, type TileKey } from './src/lod/TileKey';
import type { TileMeshData } from './src/lod/TileMeshBuilder';

const R = DEMO_RADIUS_METERS, N = 33;
const sampler = sampleDemoSurface;
let fail = 0; const check = (ok: boolean, msg: string) => { if (!ok) { fail++; console.log('FAIL', msg); } };

// Changing the measured mesh error cannot change LOD requests.
{
  const options = { radiusMeters: R, minSurfaceHeightMeters: 0, maxSurfaceHeightMeters: DEMO_MAX_HEIGHT_METERS,
    occluderRadiusMeters: R, lodSurfaceBandMeters: 0, resolution: N, maxLevel: 4, splitDistanceRatios: HOLMAN_SPLIT_DISTANCE_RATIOS };
  const normal = new PlanetLod(options);
  const exaggerated = new PlanetLod(options);
  const view = { observerPositions: [{ x: R * 1.4, y: 0, z: 0 }], distanceScale: 1, horizonCulling: true };
  for (const request of normal.select(view).requests) {
    const mesh = buildTileMesh(request.key, sampler, { radiusMeters: R, resolution: N });
    normal.acceptTile(mesh);
    exaggerated.acceptTile({ ...mesh, errorMeters: mesh.errorMeters * 1000,
      minHeightMeters: 0, maxHeightMeters: DEMO_MAX_HEIGHT_METERS });
  }
  const a = normal.select(view).requests.map((request) => `${request.key.face}/${request.key.level}/${request.key.x}/${request.key.y}`).sort();
  const b = exaggerated.select(view).requests.map((request) => `${request.key.face}/${request.key.level}/${request.key.x}/${request.key.y}`).sort();
  check(JSON.stringify(a) === JSON.stringify(b), `LOD changed with mesh error: normal=${JSON.stringify(a)} exaggerated=${JSON.stringify(b)}`);
  const drawnA = normal.select(view).render.map((node) => node.id).sort();
  const drawnB = exaggerated.select(view).render.map((node) => node.id).sort();
  check(JSON.stringify(drawnA) === JSON.stringify(drawnB), `horizon culling changed with tile mesh heights: normal=${JSON.stringify(drawnA)} exaggerated=${JSON.stringify(drawnB)}`);
  for (const node of normal.roots) {
    const bounds = tileUvBounds(node.key);
    for (let j = 0; j <= 10; j++) for (let i = 0; i <= 10; i++) {
      const direction = cubeToSphere(node.key.face, bounds.u0 + (bounds.u1 - bounds.u0) * i / 10,
        bounds.v0 + (bounds.v1 - bounds.v0) * j / 10);
      const angle = Math.acos(Math.max(-1, Math.min(1,
        direction.x * node.centerDirection.x + direction.y * node.centerDirection.y + direction.z * node.centerDirection.z)));
      check(angle <= node.angularRadius + 1e-12, `horizon angular cap missed tile direction; tile=${node.id}; i=${i}; j=${j}; angle=${angle}; cap=${node.angularRadius}`);
    }
  }
}

const edgeVertex = (edge: FaceEdge, s: number) => edge === 'u-' ? s * N : edge === 'u+' ? s * N + N - 1 : edge === 'v-' ? s : (N - 1) * N + s;
// Check the stitched edge against the actual coarse segment across every cube face edge.
for (let face = 0; face < 6; face++) for (const edge of FACE_EDGES) for (const along of [1, 2]) {
  const key = { face: face as 0 | 1 | 2 | 3 | 4 | 5, level: 2, x: edge === 'u-' ? 0 : edge === 'u+' ? 3 : along,
    y: edge === 'v-' ? 0 : edge === 'v+' ? 3 : along };
  const coarseKey = parentKey(neighborKey(key, edge));
  const fine = buildTileMesh(key, sampler, { radiusMeters: R, resolution: N });
  const coarse = buildTileMesh(coarseKey, sampler, { radiusMeters: R, resolution: N });
  const stitched = stitchEdges(fine, { [edge]: { id: coarse.id, key: coarseKey, data: coarse } as LodNode }, N);
  const coarseEdge = sameEdgeOnNeighbor(key, edge);
  const reversed = edgeReversedOnNeighbor(key, edge);
  const sameLevel = neighborKey(key, edge);
  const half = (coarseEdge[0] === 'u' ? sameLevel.y : sameLevel.x) % 2;
  for (let s = 1; s < N - 1; s++) {
    const position = half * (N - 1) / 2 + (reversed ? N - 1 - s : s) / 2;
    const a = edgeVertex(coarseEdge, Math.floor(position));
    const b = edgeVertex(coarseEdge, Math.ceil(position));
    const blend = position - Math.floor(position);
    const vertex = edgeVertex(edge, s);
    let squared = 0;
    for (let axis = 0; axis < 3; axis++) {
      const fineOrigin = [fine.origin.x, fine.origin.y, fine.origin.z][axis];
      const coarseOrigin = [coarse.origin.x, coarse.origin.y, coarse.origin.z][axis];
      const actual = fineOrigin! + stitched.positions[vertex * 3 + axis]!;
      const expected = coarseOrigin! + coarse.positions[a * 3 + axis]! * (1 - blend) + coarse.positions[b * 3 + axis]! * blend;
      squared += (actual - expected) ** 2;
    }
    check(Math.sqrt(squared) < 0.2, `stitched edge mismatch face=${face} edge=${edge} along=${along} vertex=${s} error=${Math.sqrt(squared)}`);
  }
}

// Real kilometer-scale geometry at the landing level. Check all cube-face
// transitions in both edge orientations, including L18-to-L17 interpolation.
{
  const level = LANDING_TEST_PLANET.maxLevel;
  const side = 2 ** level;
  const build = (key: TileKey) => buildTileMesh(key,
    (direction) => samplePlanetSurface(direction, LANDING_TEST_PLANET), { radiusMeters: R, resolution: N });
  const world = (tile: TileMeshData, index: number, positions = tile.positions) => [
    tile.origin.x + positions[index * 3]!,
    tile.origin.y + positions[index * 3 + 1]!,
    tile.origin.z + positions[index * 3 + 2]!,
  ];
  const gap = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
  let sameLevelWorst = 0;
  let coarseWorst = 0;
  let comparisons = 0;
  const verifyEdge = (key: TileKey, edge: FaceEdge) => {
    const adjacentKey = neighborKey(key, edge);
    const coarseKey = parentKey(adjacentKey);
    const fine = build(key);
    const adjacent = build(adjacentKey);
    const coarse = build(coarseKey);
    const coarseEdge = sameEdgeOnNeighbor(key, edge);
    const reversed = edgeReversedOnNeighbor(key, edge);
    const stitched = stitchEdges(fine, { [edge]: { id: coarse.id, key: coarseKey, data: coarse } as LodNode }, N);
    const half = (coarseEdge[0] === 'u' ? adjacentKey.y : adjacentKey.x) % 2;
    for (let s = 0; s < N; s++) {
      const neighborS = reversed ? N - 1 - s : s;
      const finePoint = world(fine, edgeVertex(edge, s));
      const adjacentPoint = world(adjacent, edgeVertex(coarseEdge, neighborS));
      sameLevelWorst = Math.max(sameLevelWorst, gap(finePoint, adjacentPoint));
      if (s === 0 || s === N - 1) continue;
      const coarsePosition = half * (N - 1) / 2 + neighborS / 2;
      const lower = Math.floor(coarsePosition);
      const upper = Math.ceil(coarsePosition);
      const blend = coarsePosition - lower;
      const a = world(coarse, edgeVertex(coarseEdge, lower));
      const b = world(coarse, edgeVertex(coarseEdge, upper));
      const expected = a.map((value, axis) => value * (1 - blend) + b[axis]! * blend);
      const actual = world(fine, edgeVertex(edge, s), stitched.positions);
      coarseWorst = Math.max(coarseWorst, gap(actual, expected));
      comparisons++;
    }
  };
  for (let face = 0; face < 6; face++) for (const edge of FACE_EDGES) {
    for (const fraction of [0, 0.27, 0.73, 1]) {
      const along = Math.min(side - 1, Math.floor(side * fraction));
      const key: TileKey = { face: face as CubeFace, level,
        x: edge === 'u-' ? 0 : edge === 'u+' ? side - 1 : along,
        y: edge === 'v-' ? 0 : edge === 'v+' ? side - 1 : along };
      verifyEdge(key, edge);
    }
  }
  verifyEdge({ face: 4, level, x: Math.floor(side * 0.31), y: Math.floor(side * 0.57) }, 'u+');
  check(sameLevelWorst < 0.01, `L18 same-level seam gap=${sameLevelWorst} m`);
  check(coarseWorst < 0.01, `L18/L17 seam gap=${coarseWorst} m`);
  console.log(`L18 seams ${comparisons} stitched points: same=${sameLevelWorst.toExponential(2)} m coarse=${coarseWorst.toExponential(2)} m`);
}

{
  const probe = new SphericalProbe(R, 10_000, { r: 0, theta: 1.1, phi: 0.8 });
  const center = probe.position;
  check(center.x === 0 && center.y === 0 && center.z === 0, `r=0 should be planet center: ${JSON.stringify(center)}`);
  probe.set({ r: R / 2, theta: 1.1, phi: 0.8 });
  check(Math.abs(Math.hypot(probe.position.x, probe.position.y, probe.position.z) - R / 2) < 1e-6,
    'probe radius should ignore ground and allow the planet interior');
  probe.dispose();
}

// Right-drag moves the camera around the planet center while looking at it.
{
  const orbit = new OrbitCamera({ maxDistanceMeters: R * 31 }, { x: 0.48, y: 0.33, z: 0.81 }, R);
  const before = orbit.pose();
  orbit.panScreen(100, -40, Math.PI / 3, 900);
  const panned = orbit.pose();
  const panTravel = Math.hypot(panned.position.x - before.position.x, panned.position.y - before.position.y, panned.position.z - before.position.z);
  const forwardChange = Math.hypot(panned.forward.x - before.forward.x, panned.forward.y - before.forward.y, panned.forward.z - before.forward.z);
  check(panTravel > 100, `left pan did not translate camera: travel=${panTravel}`);
  check(forwardChange < 1e-12, `left pan rotated camera: forwardChange=${forwardChange}`);
  const centerScreenRatioBefore = Math.hypot(panned.position.x, panned.position.y, panned.position.z) / orbit.distanceMeters;
  orbit.zoom(0.8);
  const zoomed = orbit.pose();
  const centerScreenRatioAfter = Math.hypot(zoomed.position.x, zoomed.position.y, zoomed.position.z) / orbit.distanceMeters;
  check(Math.abs(centerScreenRatioAfter - centerScreenRatioBefore) < 1e-12,
    `zoom shifted camera relative to planet center: before=${centerScreenRatioBefore} after=${centerScreenRatioAfter}`);
  orbit.setDistance(R / 2);
  check(Math.abs(orbit.distanceMeters - R / 2) < 1e-9, `zoom cannot pass reference sphere: centerDistance=${orbit.distanceMeters}`);
  const beforeR = Math.hypot(orbit.pose().position.x, orbit.pose().position.y, orbit.pose().position.z);
  orbit.orbitAroundCenter(0.3, -0.2);
  const after = orbit.pose();
  const afterR = Math.hypot(after.position.x, after.position.y, after.position.z);
  const travel = Math.hypot(after.position.x - zoomed.position.x, after.position.y - zoomed.position.y, after.position.z - zoomed.position.z);
  const viewDirectionChange = Math.hypot(after.forward.x - zoomed.forward.x, after.forward.y - zoomed.forward.y, after.forward.z - zoomed.forward.z);
  check(travel > R * 0.1, `orbit camera did not move around center: travel=${travel}`);
  check(Math.abs(afterR - beforeR) < 1e-6, `orbit camera radius changed: before=${beforeR} after=${afterR}`);
  check(viewDirectionChange > 0.1, `right orbit did not rotate camera view: change=${viewDirectionChange}`);
}

// 1. winding: grid triangle normals point outward; skirt triangles point away from tile center
{
  const key = { face: 2 as const, level: 3, x: 3, y: 5 };
  const t = buildTileMesh(key, sampler, { radiusMeters: R, resolution: N });
  const { indices, gridIndexCount } = buildTileIndices(N);
  const P = (i: number) => [t.positions[i*3]!+t.origin.x, t.positions[i*3+1]!+t.origin.y, t.positions[i*3+2]!+t.origin.z];
  const c = [t.origin.x, t.origin.y, t.origin.z];
  let badGrid = 0, badSkirt = 0;
  for (let k = 0; k < indices.length; k += 3) {
    const a = P(indices[k]!), b = P(indices[k+1]!), d = P(indices[k+2]!);
    const u = [b[0]!-a[0]!, b[1]!-a[1]!, b[2]!-a[2]!], v = [d[0]!-a[0]!, d[1]!-a[1]!, d[2]!-a[2]!];
    const n = [u[1]!*v[2]!-u[2]!*v[1]!, u[2]!*v[0]!-u[0]!*v[2]!, u[0]!*v[1]!-u[1]!*v[0]!];
    const m = [(a[0]!+b[0]!+d[0]!)/3, (a[1]!+b[1]!+d[1]!)/3, (a[2]!+b[2]!+d[2]!)/3];
    if (k < gridIndexCount) { if (n[0]!*m[0]!+n[1]!*m[1]!+n[2]!*m[2]! <= 0) badGrid++; }
    else { const o = [m[0]!-c[0]!, m[1]!-c[1]!, m[2]!-c[2]!]; if (n[0]!*o[0]!+n[1]!*o[1]!+n[2]!*o[2]! <= 0) badSkirt++; }
  }
  check(badGrid === 0, `grid triangles facing inward: ${badGrid}`);
  check(badSkirt === 0, `skirt triangles facing inward: ${badSkirt}`);
  console.log('tile L3 error', t.errorMeters.toFixed(1), 'm  skirt', t.skirtDepthMeters.toFixed(1), 'm  build', t.buildMilliseconds.toFixed(1), 'ms');
}

// 2. seams: shared edge vertices between same-level neighbours (same face and across faces) match
{
  const worldEdge = (key: any) => {
    const t = buildTileMesh(key, sampler, { radiusMeters: R, resolution: N });
    const pts: number[][] = [];
    for (let g = 0; g < N*N; g++) {
      const i = g % N, j = Math.floor(g / N);
      if (i === 0 || j === 0 || i === N-1 || j === N-1)
        pts.push([t.positions[g*3]!+t.origin.x, t.positions[g*3+1]!+t.origin.y, t.positions[g*3+2]!+t.origin.z]);
    }
    return pts;
  };
  const worstMatch = (A: number[][], B: number[][]) => {
    let shared = 0, worst = 0;
    for (const a of A) { let best = Infinity; for (const b of B) best = Math.min(best, Math.hypot(a[0]!-b[0]!, a[1]!-b[1]!, a[2]!-b[2]!));
      if (best < 5) { shared++; worst = Math.max(worst, best); } }
    return { shared, worst };
  };
  const same = worstMatch(worldEdge({ face: 4, level: 4, x: 5, y: 7 }), worldEdge({ face: 4, level: 4, x: 6, y: 7 }));
  check(same.shared === N && same.worst < 0.2, `same-face seam shared=${same.shared} worst=${same.worst}`);
  // +Z face right edge (u=1) meets +X face left edge (u=-1)
  const cross = worstMatch(worldEdge({ face: 4, level: 2, x: 3, y: 1 }), worldEdge({ face: 0, level: 2, x: 0, y: 1 }));
  check(cross.shared === N && cross.worst < 0.2, `cross-face seam shared=${cross.shared} worst=${cross.worst}`);
  console.log('seam same-face worst', same.worst.toExponential(2), 'm; cross-face worst', cross.worst.toExponential(2), 'm');
}

// 3. selection: full coverage without holes/overlaps, refinement grows as camera approaches
const lod = new PlanetLod({ radiusMeters: R, minSurfaceHeightMeters: 0, maxSurfaceHeightMeters: DEMO_MAX_HEIGHT_METERS,
  occluderRadiusMeters: R, lodSurfaceBandMeters: 0, resolution: N, maxLevel: 6, splitDistanceRatios: HOLMAN_SPLIT_DISTANCE_RATIOS });
const area = (n: LodNode) => { const { u0, v0, u1, v1 } = tileUvBounds(n.key); return (u1-u0)*(v1-v0); };
let built = 0;
function settle(cam: {x:number,y:number,z:number}, culling: boolean, maxIter = 200) {
  let sel;
  for (let it = 0; it < maxIter; it++) {
    sel = lod.select({ observerPositions: [cam], distanceScale: 1, horizonCulling: culling });
    if (!sel.requests.length) return { sel, it };
    for (const r of sel.requests.slice(0, 64)) { lod.acceptTile(buildTileMesh(r.key, sampler, { radiusMeters: R, resolution: N })); built++; }
  }
  return { sel: sel!, it: maxIter };
}
const dir = (() => { const v = { x: 0.22, y: 0.13, z: 0.97 }; const l = Math.hypot(v.x, v.y, v.z); return { x: v.x/l, y: v.y/l, z: v.z/l }; })();
const ground = sampleDemoSurface(dir).heightMeters;
for (const clearance of [R*2, 1e6, 1e5]) {
  const r = R + ground + clearance, cam = { x: dir.x*r, y: dir.y*r, z: dir.z*r };
  const t0 = performance.now();
  const noCull = settle(cam, false);
  const cover = noCull.sel.render.reduce((s, n) => s + area(n), 0);
  check(Math.abs(cover - 24) < 1e-9, `coverage ${cover} != 24 (6 faces x 4) at clearance ${clearance}`);
  const ids = new Set(noCull.sel.render.map(n => n.id));
  const culled = settle(cam, true);
  for (const selection of [noCull.sel, culled.sel]) {
    const selected = new Map(selection.render.map((node) => [node.code, node]));
    for (const node of selection.render) for (const edge of FACE_EDGES) {
      check(!!node.data, `rendered tile lost its mesh before renderer sync; id=${node.id}; frame=${selection.frame}`);
      const neighbor = selectedNeighbor(selected, node.key, edge);
      check(!neighbor || node.key.level - neighbor.key.level <= 1,
        `adjacent LOD gap face=${node.key.face} tile=${node.id} edge=${edge} neighbor=${neighbor?.id}`);
    }
  }
  // no node and its ancestor both rendered
  let overlap = 0; for (const n of noCull.sel.render) { let p = n.parent; while (p) { if (ids.has(p.id)) overlap++; p = p.parent; } }
  check(overlap === 0, `overlap ${overlap}`);
  const fin = Math.max(...culled.sel.render.map(n => n.key.level));
  console.log(`clearance ${String(clearance).padStart(9)} m: tiles(noCull)=${noCull.sel.render.length} tiles(horizon)=${culled.sel.render.length} finest L${fin} (${lod.spacingMeters(fin).toFixed(1)} m/cell) horizonCulled=${culled.sel.culled.horizon} iters=${noCull.it} select=${culled.sel.selectMilliseconds.toFixed(2)}ms wall=${(performance.now()-t0).toFixed(0)}ms`);
}
// A worker result remains valid even if its request is no longer visible and cache pruning runs.
{
  const pending = new PlanetLod({ radiusMeters: R, minSurfaceHeightMeters: 0, maxSurfaceHeightMeters: DEMO_MAX_HEIGHT_METERS,
    occluderRadiusMeters: R, lodSurfaceBandMeters: 0, resolution: N, maxLevel: 2, splitDistanceRatios: HOLMAN_SPLIT_DISTANCE_RATIOS,
    maxCachedTiles: 6, retainFrames: 0 });
  const view = (error: number) => ({ observerPositions: [{ x: R * 2, y: 0, z: 0 }],
    distanceScale: error, horizonCulling: false });
  for (const request of pending.select(view(0.0001)).requests) pending.acceptTile(buildTileMesh(request.key, sampler, { radiusMeters: R, resolution: N }));
  const requests = pending.select(view(0.0001)).requests;
  check(requests.length > 1, `expected child requests for pin test; count=${requests.length}`);
  const pinned = requests[0];
  pending.pinBuild(`${pinned!.key.face}/${pinned!.key.level}/${pinned!.key.x}/${pinned!.key.y}`);
  pending.acceptTile(buildTileMesh(requests[1]!.key, sampler, { radiusMeters: R, resolution: N }));
  pending.select(view(1));
  pending.select(view(1));
  const built = buildTileMesh(pinned!.key, sampler, { radiusMeters: R, resolution: N });
  check(!!pending.getNode(built.id), `in-flight tile was pruned; id=${built.id}`);
  pending.acceptTile(built);
  pending.unpinBuild(built.id);
}
console.log('tiles built total', built, 'cached', lod.cachedTileCount, 'nodes', lod.nodeCount);

// The landing preset must reach its ground-resolution target even at the top
// of its declared terrain range, without consulting generated mesh heights.
{
  const p = LANDING_TEST_PLANET;
  const landing = new PlanetLod({ radiusMeters: p.radiusMeters, minSurfaceHeightMeters: p.minSurfaceHeightMeters,
    maxSurfaceHeightMeters: p.maxSurfaceHeightMeters, occluderRadiusMeters: p.occluderRadiusMeters,
    lodSurfaceBandMeters: p.lodSurfaceBandMeters, resolution: p.tileResolution, maxLevel: p.maxLevel,
    splitDistanceRatios: p.splitDistanceRatios, maxCachedTiles: p.maxCachedTiles });
  const view = { observerPositions: [{ x: p.radiusMeters + p.maxSurfaceHeightMeters, y: 0, z: 0 }],
    distanceScale: 1, horizonCulling: false };
  let selected = landing.select(view);
  for (let iteration = 0; selected.requests.length > 0 && iteration <= p.maxLevel + 1; iteration++) {
    for (const request of selected.requests) {
      const key = request.key;
      const tile: TileMeshData = { id: tileId(key), key, origin: { x: 0, y: 0, z: 0 },
        positions: new Float32Array(), normals: new Float32Array(), colors: new Float32Array(), grid: new Float32Array(),
        minHeightMeters: 0, maxHeightMeters: 0, errorMeters: 0, skirtDepthMeters: 0,
        buildMilliseconds: 0, sampleMilliseconds: 0, finishMilliseconds: 0 };
      landing.acceptTile(tile);
    }
    selected = landing.select(view);
  }
  const finest = Math.max(...selected.render.map((node) => node.key.level));
  check(selected.requests.length === 0, `landing selection did not settle; requests=${selected.requests.length}`);
  check(finest === p.maxLevel && landing.spacingMeters(finest) <= 2,
    `landing target missed; finest=${finest}; spacing=${landing.spacingMeters(finest)} m`);
  check(selected.render.length <= p.maxCachedTiles,
    `landing tiles exceed cache budget; drawn=${selected.render.length}; budget=${p.maxCachedTiles}`);
  console.log(`landing top-of-terrain: drawn=${selected.render.length} cached=${landing.cachedTileCount} finest=L${finest} spacing=${landing.spacingMeters(finest).toFixed(2)} m/cell`);
}
// Several observers: each gets the finest level under it, even on opposite sides with horizon culling on.
{
  const p = LANDING_TEST_PLANET;
  const multi = new PlanetLod({ radiusMeters: p.radiusMeters, minSurfaceHeightMeters: p.minSurfaceHeightMeters,
    maxSurfaceHeightMeters: p.maxSurfaceHeightMeters, occluderRadiusMeters: p.occluderRadiusMeters,
    lodSurfaceBandMeters: p.lodSurfaceBandMeters, resolution: p.tileResolution, maxLevel: p.maxLevel,
    splitDistanceRatios: p.splitDistanceRatios, maxCachedTiles: 10_000 });
  const top = p.radiusMeters + p.maxSurfaceHeightMeters;
  const observers = [{ x: top, y: 0, z: 0 }, { x: -top * 0.6, y: top * 0.8, z: 0 }];
  const view = { observerPositions: observers, distanceScale: 1, horizonCulling: true };
  let selected = multi.select(view);
  for (let iteration = 0; selected.requests.length > 0 && iteration <= 2 * p.maxLevel + 2; iteration++) {
    for (const request of selected.requests) {
      const key = request.key;
      multi.acceptTile({ id: tileId(key), key, origin: { x: 0, y: 0, z: 0 },
        positions: new Float32Array(), normals: new Float32Array(), colors: new Float32Array(), grid: new Float32Array(),
        minHeightMeters: 0, maxHeightMeters: 0, errorMeters: 0, skirtDepthMeters: 0,
        buildMilliseconds: 0, sampleMilliseconds: 0, finishMilliseconds: 0 });
    }
    selected = multi.select(view);
  }
  check(selected.requests.length === 0, `multi-observer selection did not settle; requests=${selected.requests.length}`);
  const rendered = new Set(selected.render.map((node) => node.id));
  const levels = observers.map((o) => {
    for (let level = p.maxLevel; level >= 0; level--) if (rendered.has(tileId(tileContaining(o, level)))) return level;
    return -1;
  });
  check(levels.every((level) => level === p.maxLevel), `multi-observer finest levels under observers=${levels.join(',')}; want ${p.maxLevel}`);
  const single = new PlanetLod({ ...multi.options, maxCachedTiles: 10_000 });
  let alone = single.select({ ...view, observerPositions: [observers[0]!] });
  for (let iteration = 0; alone.requests.length > 0 && iteration <= p.maxLevel + 1; iteration++) {
    for (const request of alone.requests) {
      const key = request.key;
      single.acceptTile({ id: tileId(key), key, origin: { x: 0, y: 0, z: 0 },
        positions: new Float32Array(), normals: new Float32Array(), colors: new Float32Array(), grid: new Float32Array(),
        minHeightMeters: 0, maxHeightMeters: 0, errorMeters: 0, skirtDepthMeters: 0,
        buildMilliseconds: 0, sampleMilliseconds: 0, finishMilliseconds: 0 });
    }
    alone = single.select({ ...view, observerPositions: [observers[0]!] });
  }
  const culledAlone = !alone.render.some((node) => tileId(tileContaining(observers[1]!, node.key.level)) === node.id);
  check(culledAlone, 'second observer ground should be behind the first observer horizon (test setup)');
  console.log(`multi-observer: drawn=${selected.render.length}; finest under each observer L${levels.join('/L')}; single observer culls the far side (${alone.culled.horizon} culled)`);
}

// Balancing coarsens the fine side next to an unbuilt coarse neighbor, and reports it.
{
  const balance = new PlanetLod({ radiusMeters: R, minSurfaceHeightMeters: 0, maxSurfaceHeightMeters: DEMO_MAX_HEIGHT_METERS,
    occluderRadiusMeters: R, lodSurfaceBandMeters: 0, resolution: N, maxLevel: 6, splitDistanceRatios: HOLMAN_SPLIT_DISTANCE_RATIOS });
  const l = Math.hypot(1, 0.98, 0.1);
  const observer = { x: R * 1.001 / l, y: R * 1.001 * 0.98 / l, z: R * 1.001 * 0.1 / l };
  const view = { observerPositions: [observer], distanceScale: 1, horizonCulling: false };
  const stub = (key: TileKey): TileMeshData => ({ id: tileId(key), key, origin: { x: 0, y: 0, z: 0 },
    positions: new Float32Array(), normals: new Float32Array(), colors: new Float32Array(), grid: new Float32Array(),
    minHeightMeters: 0, maxHeightMeters: 0, errorMeters: 0, skirtDepthMeters: 0, buildMilliseconds: 0, sampleMilliseconds: 0, finishMilliseconds: 0 });
  const underObserver = (selection: { render: readonly LodNode[] }) => {
    const ids = new Set(selection.render.map((node) => node.id));
    for (let level = 6; level >= 0; level--) if (ids.has(tileId(tileContaining(observer, level)))) return level;
    return -1;
  };
  // Build everything except face 2 (+Y, next to the observer) below its root.
  let selection = balance.select(view);
  for (let iteration = 0; iteration < 40; iteration++) {
    const buildable = selection.requests.filter((request) => request.key.face !== 2 || request.key.level === 0);
    if (buildable.length === 0) break;
    for (const request of buildable) balance.acceptTile(stub(request.key));
    selection = balance.select(view);
  }
  const starved = selection.balanceCollapses;
  // The unbuilt face forces the first collapses; those can force further ones (a cascade) on other faces.
  const toFace2 = starved.some((collapse) => collapse.coarseNeighbor.startsWith('2/')) &&
    starved.every((collapse) => collapse.finestReplacedLevel - collapse.coarseNeighborLevel > 1 && collapse.parentLevel > collapse.coarseNeighborLevel);
  const starvedLevel = underObserver(selection);
  // Once face 2 is built too, the settled selection needs no collapse.
  for (let iteration = 0; selection.requests.length > 0 && iteration < 40; iteration++) {
    for (const request of selection.requests) balance.acceptTile(stub(request.key));
    selection = balance.select(view);
  }
  const settledLevel = underObserver(selection);
  check(toFace2 && selection.balanceCollapses.length === 0 && starvedLevel < settledLevel,
    `balance collapse report: starved=${JSON.stringify(starved.slice(0, 2))} (${starved.length}); settled collapses=${selection.balanceCollapses.length}; level under observer starved=${starvedLevel} settled=${settledLevel}`);
  const cascaded = starved.filter((collapse) => !collapse.coarseNeighbor.startsWith('2/')).length;
  console.log(`balance collapse: ${starved.length} collapses next to an unbuilt neighbor face (${cascaded} cascaded from other collapses); level under the observer L${starvedLevel} until it is built, then L${settledLevel}`);
}

// Rising with horizon culling: tiles that come over the widening horizon must already exist, or their
// coarse parents (down to a whole face) are drawn for a frame and balancing collapses the fine ground.
{
  const radius = 100_000, maxHeight = 3000, maxLevel = 9;
  const ratios: number[] = [];
  for (let level = 0; level < maxLevel; level++) ratios.push(level < 3 ? Infinity : 1820 * 2 ** (maxLevel - 1 - level) / radius);
  const rising = new PlanetLod({ radiusMeters: radius, minSurfaceHeightMeters: 0, maxSurfaceHeightMeters: maxHeight,
    occluderRadiusMeters: radius, lodSurfaceBandMeters: maxHeight, resolution: N, maxLevel, splitDistanceRatios: ratios });
  const stub = (key: TileKey): TileMeshData => ({ id: tileId(key), key, origin: { x: 0, y: 0, z: 0 },
    positions: new Float32Array(), normals: new Float32Array(), colors: new Float32Array(), grid: new Float32Array(),
    minHeightMeters: 0, maxHeightMeters: 0, errorMeters: 0, skirtDepthMeters: 0, buildMilliseconds: 0, sampleMilliseconds: 0, finishMilliseconds: 0 });
  const at = (step: number) => {
    // A curved ascent: 0 to 60 km up while travelling 90 km downrange.
    const s = step / 3000;
    const angle = 0.9 * s, r = radius + 500 + 60_000 * s * s;
    const d = { x: Math.cos(angle) * 0.7, y: Math.sin(angle) * 0.7 + 0.1, z: 0.7 };
    const l = Math.hypot(d.x, d.y, d.z);
    return { x: d.x / l * r, y: d.y / l * r, z: d.z / l * r };
  };
  const levelUnder = (render: readonly LodNode[], p: { x: number; y: number; z: number }) => {
    const ids = new Set(render.map((node) => node.id));
    for (let level = maxLevel; level >= 0; level--) if (ids.has(tileId(tileContaining(p, level)))) return level;
    return -1;
  };
  // Settle on the ground first, as a craft sitting on the pad would.
  let selection = rising.select({ observerPositions: [at(0)], distanceScale: 1, horizonCulling: true });
  for (let iteration = 0; selection.requests.length > 0 && iteration < 60; iteration++) {
    for (const request of selection.requests) rising.acceptTile(stub(request.key));
    selection = rising.select({ observerPositions: [at(0)], distanceScale: 1, horizonCulling: true });
  }
  let collapses = 0, drops = 0, previous = levelUnder(selection.render, at(0)), fewest = Infinity;
  const firstProblems: string[] = [];
  for (let step = 1; step <= 3000; step++) {
    const observer = at(step);
    selection = rising.select({ observerPositions: [observer], distanceScale: 1, horizonCulling: true });
    const level = levelUnder(selection.render, observer);
    fewest = Math.min(fewest, selection.render.length);
    if (selection.balanceCollapses.length > 0) {
      collapses++;
      if (firstProblems.length < 3) firstProblems.push(`step ${step}: ${selection.balanceCollapses.length} collapses, first forced by ${selection.balanceCollapses[0]!.coarseNeighbor}`);
    }
    if (level <= previous - 2) drops++;
    previous = level;
    // Unlimited workers: everything requested this frame is ready for the next.
    for (const request of selection.requests) rising.acceptTile(stub(request.key));
  }
  check(collapses === 0 && drops === 0, `rising with horizon culling: ${collapses} frames with balance collapses, ${drops} drops of 2+ levels under the observer; ${firstProblems.join('; ')}`);
  console.log(`rising with horizon culling: 3000 frames from the pad to 60 km; ${collapses} collapse frames, ${drops} level drops, at least ${fewest} tiles drawn`);
}

// The camera as a second detail source and the only horizon: whatever it can see is drawn, the probe
// keeps the finest level under it, and the camera's own detail stops at its level cap.
{
  const p = LANDING_TEST_PLANET;
  const options = { radiusMeters: p.radiusMeters, minSurfaceHeightMeters: p.minSurfaceHeightMeters,
    maxSurfaceHeightMeters: p.maxSurfaceHeightMeters, occluderRadiusMeters: p.occluderRadiusMeters,
    lodSurfaceBandMeters: p.lodSurfaceBandMeters, resolution: p.tileResolution, maxLevel: p.maxLevel,
    splitDistanceRatios: p.splitDistanceRatios, maxCachedTiles: 20_000 };
  const stub = (key: TileKey): TileMeshData => ({ id: tileId(key), key, origin: { x: 0, y: 0, z: 0 },
    positions: new Float32Array(), normals: new Float32Array(), colors: new Float32Array(), grid: new Float32Array(),
    minHeightMeters: 0, maxHeightMeters: 0, errorMeters: 0, skirtDepthMeters: 0, buildMilliseconds: 0, sampleMilliseconds: 0, finishMilliseconds: 0 });
  type View = Parameters<PlanetLod['select']>[0];
  const settle = (view: View) => {
    const lod = new PlanetLod(options);
    let selection = lod.select(view);
    for (let iteration = 0; selection.requests.length > 0 && iteration <= 2 * p.maxLevel + 2; iteration++) {
      for (const request of selection.requests) lod.acceptTile(stub(request.key));
      selection = lod.select(view);
    }
    check(selection.requests.length === 0, `camera LOD selection did not settle; requests=${selection.requests.length}`);
    return selection;
  };
  type Point = { x: number; y: number; z: number };
  const levelUnder = (render: readonly LodNode[], point: Point): number => {
    const ids = new Set(render.map((node) => node.id));
    for (let level = p.maxLevel; level >= 0; level--) if (ids.has(tileId(tileContaining(point, level)))) return level;
    return -1;
  };
  const angleBetween = (a: Point, b: Point) =>
    Math.acos(Math.max(-1, Math.min(1, (a.x * b.x + a.y * b.y + a.z * b.z) / (Math.hypot(a.x, a.y, a.z) * Math.hypot(b.x, b.y, b.z)))));
  let random = 777;
  const next = () => { random = (Math.imul(random, 1103515245) + 12345) >>> 0; return random / 2 ** 32; };
  // Ground directions the camera can see over the occluder (terrain that might hide some is ignored),
  // uniform over that cap, and how many have no drawn tile.
  const uncovered = (render: readonly LodNode[], camera: Point) => {
    const r = Math.hypot(camera.x, camera.y, camera.z);
    const c = { x: camera.x / r, y: camera.y / r, z: camera.z / r };
    const cosHorizon = p.occluderRadiusMeters / r;
    let missed = 0;
    const samples = 2000;
    for (let k = 0; k < samples; k++) {
      const o = { x: next() * 2 - 1, y: next() * 2 - 1, z: next() * 2 - 1 };
      const along = o.x * c.x + o.y * c.y + o.z * c.z;
      const t = { x: o.x - c.x * along, y: o.y - c.y * along, z: o.z - c.z * along };
      const tl = Math.hypot(t.x, t.y, t.z);
      const angle = Math.acos(1 - next() * (1 - cosHorizon)) * 0.999;
      const d = { x: c.x * Math.cos(angle) + t.x / tl * Math.sin(angle), y: c.y * Math.cos(angle) + t.y / tl * Math.sin(angle),
        z: c.z * Math.cos(angle) + t.z / tl * Math.sin(angle) };
      if (levelUnder(render, d) < 0) missed++;
    }
    return { samples, missed };
  };
  const top = p.radiusMeters + p.maxSurfaceHeightMeters;
  const probe = { x: top, y: 0, z: 0 };
  const lodCamera = p.lodCamera;
  const cases = [
    // Chasing the probe: 3 km behind and 1 km above it.
    { name: 'chase camera', camera: { x: top + 1000, y: 3000, z: 0 } },
    // At the top of the terrain a quarter of the way around the planet, past the probe's horizon.
    { name: 'low far camera', camera: { x: 0, y: 0.6 * top, z: 0.8 * top } },
    // Far out on the probe's far side: the whole visible face is behind the probe's horizon.
    { name: 'distant camera', camera: { x: -3 * p.radiusMeters, y: 0, z: 0.5 * p.radiusMeters } },
  ];
  const summaries: string[] = [];
  for (const { name, camera } of cases) {
    const withCamera = settle({ observerPositions: [probe], camera: { position: camera, ...lodCamera }, distanceScale: 1, horizonCulling: true });
    const probeOnly = settle({ observerPositions: [probe], distanceScale: 1, horizonCulling: true });
    const seen = uncovered(withCamera.render, camera);
    const before = uncovered(probeOnly.render, camera);
    const underProbe = levelUnder(withCamera.render, probe);
    const underCamera = levelUnder(withCamera.render, camera);
    const finest = Math.max(...withCamera.render.map((node) => node.key.level));
    const probeInView = angleBetween(probe, camera) < Math.acos(p.occluderRadiusMeters / Math.hypot(camera.x, camera.y, camera.z));
    check(seen.missed === 0, `${name}: ${seen.missed}/${seen.samples} ground directions the camera can see have no drawn tile`);
    check(withCamera.balanceCollapses.length === 0, `${name}: settled selection collapsed ${withCamera.balanceCollapses.length} times`);
    // The probe's ground is drawn at full detail when the camera can see it, and not drawn when it cannot.
    check(underProbe === (probeInView ? p.maxLevel : -1), `${name}: level under the probe L${underProbe}; probe in view=${probeInView}`);
    if (!probeInView) check(before.missed > 0, `${name}: probe horizon alone should hide ground the camera sees (test setup)`);
    summaries.push(`${name}: drawn=${withCamera.render.length} (probe only ${probeOnly.render.length}); under camera L${underCamera}; ` +
      `under probe ${probeInView ? `L${underProbe}` : 'not in view'}; probe horizon alone left ${before.missed}/${seen.samples} visible directions undrawn`);
    if (name === 'low far camera') {
      check(underCamera === lodCamera.maxLevel, `${name}: level under the camera L${underCamera}; want its cap L${lodCamera.maxLevel}`);
      // Nothing near the camera goes past its cap; finer tiles only surround the probe.
      check(finest === lodCamera.maxLevel, `${name}: finest drawn L${finest}; only the camera's capped detail is in view`);
    }
  }
  console.log(`camera LOD:\n  ${summaries.join('\n  ')}`);
}

// Direction -> face parameters -> tile, used by callers that stream tiles around a point.
{
  let random = 12345;
  const next = () => { random = (Math.imul(random, 1103515245) + 12345) >>> 0; return random / 2 ** 32; };
  let worstRoundTrip = 0;
  for (let k = 0; k < 20_000; k++) {
    const face = (k % 6) as CubeFace;
    const u = next() * 1.998 - 0.999, v = next() * 1.998 - 0.999;
    const back = sphereToCube(cubeToSphere(face, u, v));
    check(back.face === face, `sphereToCube face mismatch; face=${face}; u=${u}; v=${v}; got=${back.face}`);
    worstRoundTrip = Math.max(worstRoundTrip, Math.abs(back.u - u), Math.abs(back.v - v));
  }
  check(worstRoundTrip < 1e-14, `sphereToCube round trip worst=${worstRoundTrip}`);

  const level = 9;
  let wrongTile = 0;
  for (let k = 0; k < 5_000; k++) {
    const key: TileKey = { face: (k % 6) as CubeFace, level, x: Math.floor(next() * 512), y: Math.floor(next() * 512) };
    const b = tileUvBounds(key);
    const found = tileContaining(cubeToSphere(key.face, (b.u0 + b.u1) / 2, (b.v0 + b.v1) / 2), level);
    if (tileId(found) !== tileId(key)) wrongTile++;
  }
  check(wrongTile === 0, `tileContaining missed ${wrongTile}/5000 tile centres`);

  // Every ground point within reach lies in a returned tile, including across face edges and cube corners.
  const radius = 100_000, reach = 300;
  const centres = [{ x: 1, y: 1, z: 1 }, { x: 1, y: 0.0004, z: -0.0002 }, { x: -0.3, y: 0.7, z: 0.2 }];
  for (let k = 0; k < 20; k++) centres.push({ x: next() * 2 - 1, y: next() * 2 - 1, z: next() * 2 - 1 });
  let missed = 0, worstCount = 0;
  for (const c of centres) {
    const l = Math.hypot(c.x, c.y, c.z);
    const d = { x: c.x / l, y: c.y / l, z: c.z / l };
    const around = new Set(tilesAround({ x: d.x * radius * 1.01, y: d.y * radius * 1.01, z: d.z * radius * 1.01 }, reach, level, radius).map(tileId));
    worstCount = Math.max(worstCount, around.size);
    for (let s = 0; s < 400; s++) {
      const offset = { x: next() * 2 - 1, y: next() * 2 - 1, z: next() * 2 - 1 };
      const along = offset.x * d.x + offset.y * d.y + offset.z * d.z;
      const t = { x: offset.x - d.x * along, y: offset.y - d.y * along, z: offset.z - d.z * along };
      const tl = Math.hypot(t.x, t.y, t.z);
      const angle = reach * Math.sqrt(next()) / radius;
      const p = { x: d.x * Math.cos(angle) + t.x / tl * Math.sin(angle), y: d.y * Math.cos(angle) + t.y / tl * Math.sin(angle), z: d.z * Math.cos(angle) + t.z / tl * Math.sin(angle) };
      if (!around.has(tileId(tileContaining(p, level)))) missed++;
    }
  }
  check(missed === 0, `tilesAround missed ${missed} ground points within reach`);
  console.log(`tile search: round trip ${worstRoundTrip.toExponential(2)}; ${centres.length} centres x 400 points within ${reach} m all covered; at most ${worstCount} tiles`);
}

console.log(fail ? `${fail} FAILURES` : "ALL CHECKS PASSED");
if (fail) throw new Error(`${fail} LOD checks failed`);
