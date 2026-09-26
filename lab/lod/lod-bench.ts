// Headless timing of PlanetLod.select on scripted probe and camera paths.
// Tiles are stubs: this measures selection (walk, balance, evict), not tile building or drawing.
//   npm run bench                        table of all scenarios, both build models
//   npm run bench -- --json > run.json   the same results as JSON instead
import { PlanetLod, type LodCamera, type LodSelection } from './src/lod';
import { LANDING_TEST_PLANET } from './src/app/PlanetPresets';
import { tileId, type TileKey } from './src/lod/TileKey';
import type { TileMeshData } from './src/lod/TileMeshBuilder';
import { BENCH_SCENARIOS, type BenchFrame, type BenchScenario } from './src/app/BenchScenarios';

// Only argv is needed from Node; the lab has no @types/node.
declare const process: { readonly argv: readonly string[] };
const json = process.argv.includes('--json');
const p = LANDING_TEST_PLANET;
const SCENARIOS = BENCH_SCENARIOS;
type Scenario = BenchScenario;

/** How ready tiles arrive: all requests by the next frame, or the highest-priority few per frame. */
const BUILD_MODELS = [
  { name: 'unlimited', perFrame: Infinity },
  { name: '6/frame', perFrame: 6 },
] as const;

const stub = (key: TileKey): TileMeshData => ({ id: tileId(key), key, origin: { x: 0, y: 0, z: 0 },
  positions: new Float32Array(), normals: new Float32Array(), colors: new Float32Array(), grid: new Float32Array(),
  minHeightMeters: 0, maxHeightMeters: 0, errorMeters: 0, skirtDepthMeters: 0, buildMilliseconds: 0, sampleMilliseconds: 0, finishMilliseconds: 0 });

function newLod(): PlanetLod {
  return new PlanetLod({ radiusMeters: p.radiusMeters, minSurfaceHeightMeters: p.minSurfaceHeightMeters,
    maxSurfaceHeightMeters: p.maxSurfaceHeightMeters, occluderRadiusMeters: p.occluderRadiusMeters,
    lodSurfaceBandMeters: p.lodSurfaceBandMeters, resolution: p.tileResolution, maxLevel: p.maxLevel,
    splitDistanceRatios: p.splitDistanceRatios, maxCachedTiles: p.maxCachedTiles });
}

function select(lod: PlanetLod, frame: BenchFrame): LodSelection {
  const camera: LodCamera = { position: frame.camera, ...p.lodCamera };
  return lod.select({ observerPositions: [frame.probe], camera, distanceScale: 1, horizonCulling: true });
}

function accept(lod: PlanetLod, selection: LodSelection, perFrame: number): void {
  const requests = perFrame === Infinity ? selection.requests
    : [...selection.requests].sort((a, b) => b.priority - a.priority).slice(0, perFrame);
  for (const request of requests) lod.acceptTile(stub(request.key));
}

interface Stat { p50: number; p95: number; max: number; mean: number }
function stat(values: readonly number[]): Stat {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  return { p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1]!, mean: values.reduce((a, b) => a + b, 0) / values.length };
}

interface Result {
  scenario: string; build: string; frames: number;
  selectMs: Stat; walkMs: Stat; balanceMs: Stat; evictMs: Stat;
  drawn: Stat; visited: Stat; requests: Stat;
  collapseFrames: number; settleFrames: number | null; cachedTiles: number; nodes: number;
}

function run(scenario: Scenario, build: (typeof BUILD_MODELS)[number]): Result {
  const lod = newLod();
  // Settle at the first frame with instant builds; that start-up is not measured.
  let selection = select(lod, scenario.at(0));
  for (let i = 0; selection.requests.length > 0 && i < 200; i++) {
    accept(lod, selection, Infinity);
    selection = select(lod, scenario.at(0));
  }
  if (selection.requests.length > 0) throw new Error(`lod-bench.ts: ${scenario.name} did not settle at frame 0`);
  const columns = { select: [] as number[], walk: [] as number[], balance: [] as number[], evict: [] as number[],
    drawn: [] as number[], visited: [] as number[], requests: [] as number[] };
  let collapseFrames = 0;
  for (let frame = 1; frame <= scenario.frames; frame++) {
    selection = select(lod, scenario.at(frame));
    columns.select.push(selection.selectMilliseconds);
    columns.walk.push(selection.traversalMilliseconds);
    columns.balance.push(selection.balanceMilliseconds);
    columns.evict.push(selection.evictionMilliseconds);
    columns.drawn.push(selection.render.length);
    columns.visited.push(selection.visited);
    columns.requests.push(selection.requests.length);
    if (selection.balanceCollapses.length > 0) collapseFrames++;
    accept(lod, selection, build.perFrame);
  }
  // Frames after the path ends until nothing is requested.
  let settleFrames: number | null = null;
  const last = scenario.at(scenario.frames);
  for (let frame = 0; frame < 5000; frame++) {
    selection = select(lod, last);
    if (selection.requests.length === 0) { settleFrames = frame; break; }
    accept(lod, selection, build.perFrame);
  }
  return { scenario: scenario.name, build: build.name, frames: scenario.frames,
    selectMs: stat(columns.select), walkMs: stat(columns.walk), balanceMs: stat(columns.balance), evictMs: stat(columns.evict),
    drawn: stat(columns.drawn), visited: stat(columns.visited), requests: stat(columns.requests),
    collapseFrames, settleFrames, cachedTiles: lod.cachedTileCount, nodes: lod.nodeCount };
}

// JIT warm-up so the first scenario is not charged for compilation.
run(SCENARIOS[0]!, BUILD_MODELS[0]);

const results: Result[] = [];
const ms = (s: Stat) => `${s.p50.toFixed(2)}/${s.p95.toFixed(2)}/${s.max.toFixed(2)}`;
const log = (line: string) => { if (!json) console.log(line); };
log(`preset ${p.name}; times are p50/p95/max ms; camera cap L${p.lodCamera.maxLevel}`);
log(['scenario'.padEnd(14), 'build'.padEnd(9), 'select'.padEnd(17), 'walk'.padEnd(17), 'balance'.padEnd(17), 'evict'.padEnd(17),
  'drawn p50/max'.padEnd(14), 'req max'.padEnd(8), 'collapse'.padEnd(9), 'settle'].join(' '));
for (const scenario of SCENARIOS) {
  for (const build of BUILD_MODELS) {
    const r = run(scenario, build);
    results.push(r);
    log([r.scenario.padEnd(14), r.build.padEnd(9), ms(r.selectMs).padEnd(17), ms(r.walkMs).padEnd(17), ms(r.balanceMs).padEnd(17),
      ms(r.evictMs).padEnd(17), `${r.drawn.p50}/${r.drawn.max}`.padEnd(14), String(r.requests.max).padEnd(8),
      String(r.collapseFrames).padEnd(9), r.settleFrames === null ? '>5000' : String(r.settleFrames)].join(' '));
  }
}

if (json) console.log(JSON.stringify({ preset: p.name, date: new Date().toISOString(), results }, null, 2));
