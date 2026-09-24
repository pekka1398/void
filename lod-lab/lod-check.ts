// Headless invariants for the lab's own LOD core and fixture.
import { PlanetLod, buildTileMesh, buildTileIndices, tileUvBounds, type LodNode } from './src/lod';
import { DEMO_MAX_HEIGHT_METERS, DEMO_RADIUS_METERS, sampleDemoSurface } from './src/app/DemoSurface';

const R = DEMO_RADIUS_METERS, N = 33;
const sampler = sampleDemoSurface;
let fail = 0; const check = (ok: boolean, msg: string) => { if (!ok) { fail++; console.log('FAIL', msg); } };

// 1. winding: grid triangle normals point outward; skirt triangles point away from tile center
{
  const key = { face: 2 as const, level: 3, x: 3, y: 5 };
  const t = buildTileMesh(key, sampler, { radiusMeters: R, resolution: N });
  const { indices, gridIndexCount } = buildTileIndices(N);
  const P = (i: number) => [t.positions[i*3]+t.origin.x, t.positions[i*3+1]+t.origin.y, t.positions[i*3+2]+t.origin.z];
  const c = [t.origin.x, t.origin.y, t.origin.z];
  let badGrid = 0, badSkirt = 0;
  for (let k = 0; k < indices.length; k += 3) {
    const a = P(indices[k]), b = P(indices[k+1]), d = P(indices[k+2]);
    const u = [b[0]-a[0], b[1]-a[1], b[2]-a[2]], v = [d[0]-a[0], d[1]-a[1], d[2]-a[2]];
    const n = [u[1]*v[2]-u[2]*v[1], u[2]*v[0]-u[0]*v[2], u[0]*v[1]-u[1]*v[0]];
    const m = [(a[0]+b[0]+d[0])/3, (a[1]+b[1]+d[1])/3, (a[2]+b[2]+d[2])/3];
    if (k < gridIndexCount) { if (n[0]*m[0]+n[1]*m[1]+n[2]*m[2] <= 0) badGrid++; }
    else { const o = [m[0]-c[0], m[1]-c[1], m[2]-c[2]]; if (n[0]*o[0]+n[1]*o[1]+n[2]*o[2] <= 0) badSkirt++; }
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
        pts.push([t.positions[g*3]+t.origin.x, t.positions[g*3+1]+t.origin.y, t.positions[g*3+2]+t.origin.z]);
    }
    return pts;
  };
  const worstMatch = (A: number[][], B: number[][]) => {
    let shared = 0, worst = 0;
    for (const a of A) { let best = Infinity; for (const b of B) best = Math.min(best, Math.hypot(a[0]-b[0], a[1]-b[1], a[2]-b[2]));
      if (best < 5) { shared++; worst = Math.max(worst, best); } }
    return { shared, worst };
  };
  const same = worstMatch(worldEdge({ face: 4, level: 4, x: 5, y: 7 }), worldEdge({ face: 4, level: 4, x: 6, y: 7 }));
  check(same.shared === N && same.worst < 0.05, `same-face seam shared=${same.shared} worst=${same.worst}`);
  // +Z face right edge (u=1) meets +X face left edge (u=-1)
  const cross = worstMatch(worldEdge({ face: 4, level: 2, x: 3, y: 1 }), worldEdge({ face: 0, level: 2, x: 0, y: 1 }));
  check(cross.shared === N && cross.worst < 0.1, `cross-face seam shared=${cross.shared} worst=${cross.worst}`);
  console.log('seam same-face worst', same.worst.toExponential(2), 'm; cross-face worst', cross.worst.toExponential(2), 'm');
}

// 3. selection: full coverage without holes/overlaps, refinement grows as camera approaches
const lod = new PlanetLod({ radiusMeters: R, minSurfaceHeightMeters: 0, maxSurfaceHeightMeters: DEMO_MAX_HEIGHT_METERS,
  occluderRadiusMeters: R, resolution: N, maxLevel: 19 });
const area = (n: LodNode) => { const { u0, v0, u1, v1 } = tileUvBounds(n.key); return (u1-u0)*(v1-v0); };
let built = 0;
function settle(cam: {x:number,y:number,z:number}, culling: boolean, maxIter = 200) {
  let sel;
  for (let it = 0; it < maxIter; it++) {
    sel = lod.select({ cameraPosition: cam, viewportHeightPixels: 1000, fovYRadians: 55*Math.PI/180, maxScreenErrorPixels: 3, horizonCulling: culling });
    if (!sel.requests.length) return { sel, it };
    for (const r of sel.requests.slice(0, 64)) { lod.acceptTile(buildTileMesh(r.key, sampler, { radiusMeters: R, resolution: N })); built++; }
  }
  return { sel: sel!, it: maxIter };
}
const dir = (() => { const v = { x: 0.22, y: 0.13, z: 0.97 }; const l = Math.hypot(v.x, v.y, v.z); return { x: v.x/l, y: v.y/l, z: v.z/l }; })();
const ground = sampleDemoSurface(dir).heightMeters;
for (const clearance of [R*2, 1e6, 1e5, 1e4, 1e3, 100, 10]) {
  const r = R + ground + clearance, cam = { x: dir.x*r, y: dir.y*r, z: dir.z*r };
  const t0 = performance.now();
  const noCull = settle(cam, false);
  const cover = noCull.sel.render.reduce((s, n) => s + area(n), 0);
  check(Math.abs(cover - 24) < 1e-9, `coverage ${cover} != 24 (6 faces x 4) at clearance ${clearance}`);
  const ids = new Set(noCull.sel.render.map(n => n.id));
  // no node and its ancestor both rendered
  let overlap = 0; for (const n of noCull.sel.render) { let p = n.parent; while (p) { if (ids.has(p.id)) overlap++; p = p.parent; } }
  check(overlap === 0, `overlap ${overlap}`);
  const culled = settle(cam, true);
  const fin = Math.max(...culled.sel.render.map(n => n.key.level));
  console.log(`clearance ${String(clearance).padStart(9)} m: tiles(noCull)=${noCull.sel.render.length} tiles(horizon)=${culled.sel.render.length} finest L${fin} (${lod.spacingMeters(fin).toFixed(1)} m/cell) horizonCulled=${culled.sel.culled.horizon} iters=${noCull.it} select=${culled.sel.selectMilliseconds.toFixed(2)}ms wall=${(performance.now()-t0).toFixed(0)}ms`);
}
console.log('tiles built total', built, 'cached', lod.cachedTileCount, 'nodes', lod.nodeCount);
console.log(fail ? `${fail} FAILURES` : "ALL CHECKS PASSED");
if (fail) throw new Error(`${fail} LOD checks failed`);
