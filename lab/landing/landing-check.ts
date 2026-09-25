import RAPIER from '@dimforge/rapier3d-compat';
import {
  buildSystem, distance, Ephemeris, PropagationRun, suggestedStepSeconds, VesselPropagator, type Vec3,
} from './src/orbitCore';
import { ContactWorld, type ContactWorldOptions } from './src/physics/ContactWorld';
import { PlanetFrame, type FrameState } from './src/physics/PlanetFrame';
import type { Terrain } from './src/terrain/Surface';
import { pebble } from './src/planet/Planets';
import { buildCollisionTile, levelForTileSize, tileContaining, tileId, tilesAround, type CollisionTile } from './src/terrain/CollisionTiles';
import { cubeToSphere, sphereToCube } from './src/terrain/CubeSphere';
import { hillsTerrain } from './src/terrain/HillsTerrain';
import { checkTerrainContract, latticeDirections } from './src/terrain/SurfaceContract';

declare const process: { exit(code: number): never };

const failures: string[] = [];
function check(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${detail}`);
  if (!ok) failures.push(name);
}
const fmt = (x: number) => x.toExponential(2);

const TILE_SIZE_METERS = 300;
const CELLS = 32;
const small = pebble().terrain;
const earthSize = hillsTerrain({ name: 'Earth-size hills', radiusMeters: 6.371e6, maxHeightMeters: 8000, wavelengthMeters: 40_000, octaves: 8 });

// --- Terrain contract --------------------------------------------------------------
for (const terrain of [small, earthSize]) {
  const broken = checkTerrainContract(terrain);
  check(`terrain contract: ${terrain.name}`, broken.length === 0,
    broken.length === 0 ? '20,000 directions: unit input enforced, deterministic, bounded, continuous' : broken.map((f) => `${f.rule}: ${f.detail}`).join('; '));
}

// --- Cube sphere ---------------------------------------------------------------------
{
  let worst = 0;
  for (const d of latticeDirections(5000)) {
    const { face, u, v } = sphereToCube(d);
    worst = Math.max(worst, distance(cubeToSphere(face, u, v), d));
  }
  check('cube sphere round trip', worst < 1e-14, `worst ${fmt(worst)}`);
}

function absolute(tile: CollisionTile, i: number): Vec3 {
  const v = tile.vertices;
  return { x: tile.origin.x + v[i * 3]!, y: tile.origin.y + v[i * 3 + 1]!, z: tile.origin.z + v[i * 3 + 2]! };
}

for (const terrain of [small, earthSize]) {
  const level = levelForTileSize(terrain.radiusMeters, TILE_SIZE_METERS);
  const label = `${terrain.name}, level ${level}`;

  // --- Tiles: determinism and heights ----------------------------------------------
  {
    const key = tileContaining({ x: 0.3, y: -0.5, z: Math.sqrt(1 - 0.34) }, level);
    const a = buildCollisionTile(key, terrain, CELLS);
    const b = buildCollisionTile({ ...key }, terrain, CELLS);
    const same = a.vertices.every((x, i) => x === b.vertices[i]) && a.indices.every((x, i) => x === b.indices[i]) && a.origin.x === b.origin.x;
    let worstHeight = 0;
    let span = 0;
    for (let i = 0; i < a.vertices.length / 3; i += 1) {
      const p = absolute(a, i);
      const r = Math.hypot(p.x, p.y, p.z);
      const h = terrain.sample({ x: p.x / r, y: p.y / r, z: p.z / r }).heightMeters;
      worstHeight = Math.max(worstHeight, Math.abs(r - terrain.radiusMeters - h));
      span = Math.max(span, Math.hypot(a.vertices[i * 3]!, a.vertices[i * 3 + 1]!, a.vertices[i * 3 + 2]!));
    }
    check(`tile determinism and heights (${label})`, same && worstHeight < 1e-3,
      `${tileId(key)}: rebuilt bit-identical; vertices within ${fmt(worstHeight)} m of the terrain (float32 relative to a tile origin, farthest vertex ${span.toFixed(0)} m from it)`);
  }

  // --- Seams, including a cube corner where three faces meet ------------------------
  for (const [where, point] of [['cube corner', { x: 1, y: 1, z: 1 }], ['face interior', { x: 0.2, y: 0.9, z: -0.3 }]] as const) {
    const l = Math.hypot(point.x, point.y, point.z);
    const centre = { x: (point.x / l) * terrain.radiusMeters, y: (point.y / l) * terrain.radiusMeters, z: (point.z / l) * terrain.radiusMeters };
    const tiles = tilesAround(centre, 3 * TILE_SIZE_METERS, level, terrain.radiusMeters).map((k) => buildCollisionTile(k, terrain, CELLS));
    const faces = new Set(tiles.map((t) => t.key.face));
    let unmatched = 0, tested = 0, worstGap = 0;
    const side = CELLS + 1;
    for (const tile of tiles) {
      for (let j = 0; j <= CELLS; j += 1) {
        for (let i = 0; i <= CELLS; i += 1) {
          if (i !== 0 && j !== 0 && i !== CELLS && j !== CELLS) continue;
          const p = absolute(tile, j * side + i);
          const r = Math.hypot(p.x, p.y, p.z);
          // Only edges well inside the tested patch have every neighbour loaded.
          if (distance({ x: (p.x / r) * terrain.radiusMeters, y: (p.y / r) * terrain.radiusMeters, z: (p.z / r) * terrain.radiusMeters }, centre) > 1.5 * TILE_SIZE_METERS) continue;
          tested += 1;
          let best = Infinity;
          for (const other of tiles) {
            if (other === tile) continue;
            for (let k = 0; k < other.vertices.length / 3; k += 1) best = Math.min(best, distance(p, absolute(other, k)));
          }
          if (best > 1e-4) unmatched += 1;
          else worstGap = Math.max(worstGap, best);
        }
      }
    }
    check(`seams at a ${where} (${label})`, unmatched === 0 && tested > 0,
      `${tiles.length} tiles on ${faces.size} face(s), ${tested - unmatched}/${tested} edge vertices shared within 0.1 mm, largest gap ${fmt(worstGap)} m (float32 rounding)`);
  }

  // --- Coverage of tilesAround --------------------------------------------------------
  {
    const reach = 500;
    let missing = 0, points = 0;
    for (const d of latticeDirections(40)) {
      const centre = { x: d.x * terrain.radiusMeters, y: d.y * terrain.radiusMeters, z: d.z * terrain.radiusMeters };
      const ids = new Set(tilesAround(centre, reach, level, terrain.radiusMeters).map(tileId));
      const t1n = Math.abs(d.z) < 0.9 ? { x: -d.y, y: d.x, z: 0 } : { x: 0, y: -d.z, z: d.y };
      const l1 = Math.hypot(t1n.x, t1n.y, t1n.z);
      const t1 = { x: t1n.x / l1, y: t1n.y / l1, z: t1n.z / l1 };
      const t2 = { x: d.y * t1.z - d.z * t1.y, y: d.z * t1.x - d.x * t1.z, z: d.x * t1.y - d.y * t1.x };
      for (let k = 0; k < 64; k += 1) {
        const angle = (k / 64) * 2 * Math.PI, s = (reach * ((k % 8) + 1)) / 8 / terrain.radiusMeters;
        const p = { x: d.x + (t1.x * Math.cos(angle) + t2.x * Math.sin(angle)) * s, y: d.y + (t1.y * Math.cos(angle) + t2.y * Math.sin(angle)) * s, z: d.z + (t1.z * Math.cos(angle) + t2.z * Math.sin(angle)) * s };
        points += 1;
        if (!ids.has(tileId(tileContaining(p, level)))) missing += 1;
      }
    }
    check(`tilesAround covers its reach (${label})`, missing === 0, `${points} surface points within ${reach} m of 40 centres, ${missing} outside the returned tiles`);
  }
}

// === P2: contacts in the rotating frame ============================================
await RAPIER.init();

/** Pebble with an exaggerated J2 and a small moon, so every frame term is exercised. */
function harshPebble(): { ephemeris: Ephemeris; frame: PlanetFrame; terrain: Terrain } {
  const base = pebble();
  const root = { ...base.system.root, gravityField: { j2: 0.01, referenceRadiusMeters: 100e3 },
    children: [{
      id: 'pip', name: 'Pip', color: '#999', massKg: 2e19, radiusMeters: 10e3,
      rotation: { periodSeconds: 36_000, obliquityRadians: 0, poleLongitudeRadians: 0, angleAtEpochRadians: 0 },
      orbit: { semiMajorAxisMeters: 400e3, eccentricity: 0, inclinationRadians: 0.3, longitudeOfAscendingNodeRadians: 0, argumentOfPeriapsisRadians: 0, meanAnomalyRadians: 1 },
      orbitPlane: 'ecliptic' as const, children: [],
    }] };
  const system = buildSystem({ name: 'harsh pebble', root });
  const ephemeris = new Ephemeris(system, { stepSeconds: suggestedStepSeconds(system.bodies, 256), chunkSteps: 1024 });
  ephemeris.extendTo(6000);
  return { ephemeris, frame: new PlanetFrame(ephemeris, 0), terrain: base.terrain };
}

function plainPebble(): { ephemeris: Ephemeris; frame: PlanetFrame; terrain: Terrain } {
  const base = pebble();
  const system = buildSystem(base.system);
  const ephemeris = new Ephemeris(system, { stepSeconds: 60, chunkSteps: 1024 });
  ephemeris.extendTo(60);
  return { ephemeris, frame: new PlanetFrame(ephemeris, 0), terrain: base.terrain };
}

const FRAME_TOLERANCES = { positionMeters: 1e-6, velocityMetersPerSecond: 1e-9 };
/** A hop from 4 km over the reference sphere (above the 3 km hills): 120 m/s up, 60 m/s east. */
function hopStart(frame: PlanetFrame): FrameState {
  const up = { x: Math.cos(0.4), y: Math.sin(0.4), z: 0.05 };
  const l = Math.hypot(up.x, up.y, up.z);
  const d = { x: up.x / l, y: up.y / l, z: up.z / l };
  const east = { x: -d.y, y: d.x, z: 0 };
  const el = Math.hypot(east.x, east.y);
  const r = frame.body.radiusMeters + 4000;
  return {
    position: { x: d.x * r, y: d.y * r, z: d.z * r },
    velocity: { x: d.x * 120 + (east.x / el) * 60, y: d.y * 120 + (east.y / el) * 60, z: d.z * 120 },
  };
}

/** The reference: the orbit lab's integrator in the inertial frame, sampled at times. */
function inertialReference(env: { ephemeris: Ephemeris; frame: PlanetFrame }, start: FrameState, times: number[]): FrameState[] {
  const inertial = env.frame.toInertial(0, start);
  const run = new PropagationRun({ time: 0, position: inertial.position, velocity: inertial.velocity, massKg: 1000 });
  const propagator = new VesselPropagator(env.ephemeris, FRAME_TOLERANCES);
  return times.map((t) => {
    if (propagator.advance(run, t, 1e7, null, null).kind !== 'reached') throw new Error('reference hop did not complete');
    return env.frame.toBodyFixed(t, { position: run.state.position, velocity: run.state.velocity });
  });
}

{
  const env = harshPebble();
  const s = hopStart(env.frame);
  let worst = 0;
  for (const t of [0, 123.4, 5000]) {
    const back = env.frame.toBodyFixed(t, env.frame.toInertial(t, s));
    worst = Math.max(worst, distance(back.position, s.position), distance(back.velocity, s.velocity));
  }
  check('frame transform round trip', worst < 1e-9, `body-fixed -> inertial -> body-fixed, worst ${fmt(worst)}`);
}

{
  // The frame's equations of motion, integrated finely with RK4, against the
  // orbit lab's inertial integration of the same hop.
  const env = harshPebble();
  const start = hopStart(env.frame);
  const times = [30, 60, 90, 120, 150];
  const reference = inertialReference(env, start, times);
  const h = 0.01;
  let t = 0, r = start.position, v = start.velocity, worst = 0;
  const add = (a: Vec3, b: Vec3, k: number): Vec3 => ({ x: a.x + b.x * k, y: a.y + b.y * k, z: a.z + b.z * k });
  times.forEach((target, i) => {
    while (t < target - 1e-9) {
      const k1v = env.frame.acceleration(t, r, v), k1r = v;
      const k2v = env.frame.acceleration(t + h / 2, add(r, k1r, h / 2), add(v, k1v, h / 2)), k2r = add(v, k1v, h / 2);
      const k3v = env.frame.acceleration(t + h / 2, add(r, k2r, h / 2), add(v, k2v, h / 2)), k3r = add(v, k2v, h / 2);
      const k4v = env.frame.acceleration(t + h, add(r, k3r, h), add(v, k3v, h)), k4r = add(v, k3v, h);
      r = add(r, add(add(k1r, k4r, 1), add(k2r, k3r, 1), 2), h / 6);
      v = add(v, add(add(k1v, k4v, 1), add(k2v, k3v, 1), 2), h / 6);
      t += h;
    }
    worst = Math.max(worst, distance(r, reference[i]!.position));
  });
  check('rotating-frame equations vs inertial', worst < 1e-3,
    `150 s hop with J2 = 0.01, a moon's tides, centrifugal and Coriolis: RK4 in the rotating frame within ${fmt(worst)} m of the orbit lab's inertial integration`);
}

const CONTACT_OPTIONS: ContactWorldOptions = {
  stepSeconds: 1 / 60, tileLevel: levelForTileSize(100e3, TILE_SIZE_METERS), tileCells: CELLS,
  tileReachMeters: 300, tileKeepMeters: 600, recenterMeters: 1000,
};

{
  // Rapier free flight (leapfrog convention) against the same reference.
  const env = harshPebble();
  const start = hopStart(env.frame);
  const times = [30, 60, 90, 120, 150];
  const reference = inertialReference(env, start, times);
  const world = new ContactWorld(RAPIER, env.frame, env.terrain, CONTACT_OPTIONS, 0, start.position);
  const body = world.addBody({ shape: { kind: 'ball', radius: 1 }, massKg: 1000, friction: 0.5, restitution: 0 }, start);
  let worstP = 0, worstV = 0;
  times.forEach((target, i) => {
    while (world.time < target - 1e-9) world.step();
    const s = world.state(body);
    worstP = Math.max(worstP, distance(s.position, reference[i]!.position));
    worstV = Math.max(worstV, distance(s.velocity, reference[i]!.velocity));
  });
  const firstOrder = 1.6 * 150 * CONTACT_OPTIONS.stepSeconds / 2;
  check('Rapier free flight vs inertial', worstP < 0.05 && worstV < 1e-3 && world.recenters > 0,
    `150 s at 60 Hz: within ${fmt(worstP)} m and ${fmt(worstV)} m/s (plain kick-drift would be off by about ${firstOrder.toFixed(1)} m); ${world.recenters} origin moves`);
}

/** A body-fixed point on the ground at a direction, lifted by some metres. */
function ground(terrain: Terrain, d: Vec3, lift: number): Vec3 {
  const l = Math.hypot(d.x, d.y, d.z);
  const u = { x: d.x / l, y: d.y / l, z: d.z / l };
  const r = terrain.radiusMeters + terrain.sample(u).heightMeters + lift;
  return { x: u.x * r, y: u.y * r, z: u.z * r };
}

function clearance(terrain: Terrain, p: Vec3): number {
  const r = Math.hypot(p.x, p.y, p.z);
  return r - terrain.radiusMeters - terrain.sample({ x: p.x / r, y: p.y / r, z: p.z / r }).heightMeters;
}

{
  // A box set down on the equator must come to rest and stay there.
  const env = plainPebble();
  const at = ground(env.terrain, { x: 1, y: 0.02, z: 0 }, 2);
  const world = new ContactWorld(RAPIER, env.frame, env.terrain, CONTACT_OPTIONS, 0, at);
  const box = world.addBody({ shape: { kind: 'box', halfExtents: { x: 1, y: 1, z: 1 } }, massKg: 5000, friction: 0.8, restitution: 0 }, { position: at, velocity: { x: 0, y: 0, z: 0 } });
  while (world.time < 30) world.step();
  const settled = world.state(box).position;
  let lowest = Infinity;
  while (world.time < 630) {
    world.step();
    lowest = Math.min(lowest, clearance(env.terrain, world.state(box).position));
  }
  const moved = distance(world.state(box).position, settled);
  check('rest on the ground', moved < 0.01 && lowest > 0.5,
    `a 2 m box on the equator, which moves at 50 m/s: after settling it moved ${fmt(moved)} m in 10 min; its centre stayed ${lowest.toFixed(2)} m above the terrain`);
}

{
  // A ball launched along the ground rolls and bounces across many tiles.
  const env = plainPebble();
  const at = ground(env.terrain, { x: 0.3, y: 0.6, z: 0.74 }, 3);
  const up = { x: at.x / Math.hypot(at.x, at.y, at.z), y: at.y / Math.hypot(at.x, at.y, at.z), z: at.z / Math.hypot(at.x, at.y, at.z) };
  const east = { x: -up.y, y: up.x, z: 0 };
  const el = Math.hypot(east.x, east.y);
  const world = new ContactWorld(RAPIER, env.frame, env.terrain, CONTACT_OPTIONS, 0, at);
  const ball = world.addBody({ shape: { kind: 'ball', radius: 1 }, massKg: 500, friction: 0.6, restitution: 0.2 },
    { position: at, velocity: { x: (east.x / el) * 30, y: (east.y / el) * 30, z: 0 } });
  let lowest = Infinity;
  while (world.time < 120) {
    world.step();
    lowest = Math.min(lowest, clearance(env.terrain, world.state(ball).position));
  }
  const travelled = distance(world.state(ball).position, at);
  // The ball's centre sits 1 m up; triangles between samples can cut below the smooth terrain slightly.
  check('rolling across tiles', lowest > 0.8 && travelled > 300 && world.tileUnloads > 0 && world.recenters > 0,
    `120 s from 30 m/s: ${travelled.toFixed(0)} m travelled, centre never below ${lowest.toFixed(2)} m over the terrain; ${world.tileLoads} tile loads, ${world.tileUnloads} unloads, ${world.recenters} origin moves, ${world.loadedTileCount} loaded now`);
}

{
  const env = plainPebble();
  const at = ground(env.terrain, { x: 0, y: 1, z: 0.1 }, 50);
  const world = new ContactWorld(RAPIER, env.frame, env.terrain, CONTACT_OPTIONS, 0, at);
  const ball = world.addBody({ shape: { kind: 'ball', radius: 1 }, massKg: 500, friction: 0.6, restitution: 0.2 }, { position: at, velocity: { x: 3, y: -2, z: 1 } });
  for (let i = 0; i < 100; i += 1) world.step();
  const before = world.state(ball);
  world.recenter({ x: world.origin.x + 700, y: world.origin.y - 300, z: world.origin.z + 200 });
  const after = world.state(ball);
  const dp = distance(before.position, after.position), dv = distance(before.velocity, after.velocity);
  check('floating origin move', dp < 1e-3 && dv < 1e-9, `moving the origin 800 m changes the state by ${fmt(dp)} m, ${fmt(dv)} m/s (float32 rounding)`);
}

if (failures.length > 0) {
  console.log(`\n${failures.length} CHECK(S) FAILED: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\nALL CHECKS PASSED');
