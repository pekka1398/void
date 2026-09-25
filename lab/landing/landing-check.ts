import RAPIER from '@dimforge/rapier3d-compat';
import {
  buildSystem, distance, Ephemeris, PropagationRun, suggestedStepSeconds, VesselPropagator, type ThrustControl, type Vec3,
} from './src/orbitCore';
import { Lander, type LanderControl, type LanderOptions, type LanderSpec } from './src/vessel/Lander';
import { PartJointRocket } from './src/vessel/PartJointRocket';
import { matMul, matVec, quatToMatrix, stepAttitude, transpose } from './src/vessel/Attitude';
import { EncounterPhysicsGate } from './src/vessel/EncounterPhysics';
import { predictCoast } from './src/vessel/CoastPrediction';
import { ANGULAR_DAMPING, ContactWorld, type ContactWorldOptions } from './src/physics/ContactWorld';
import { PlanetFrame, type FrameState } from './src/physics/PlanetFrame';
import type { Terrain } from './src/terrain/Surface';
import { PLANETS, pebble } from './src/planet/Planets';
import { cubeToSphere, FACE_EDGES, neighborKey, PlanetLod, sphereToCube, tileContaining, tileId, tilesAround, type TileMeshData } from './src/lodCore';
import { landingLodOptions } from './src/terrain/TerrainView';
import { terrainFromConfig } from './src/terrain/TerrainConfig';
import { buildTerrainTile, levelForTileSize, surfaceIndices, surfacePositions } from './src/terrain/TerrainTiles';
import { hillsTerrain } from './src/terrain/HillsTerrain';
import { checkTerrainContract, latticeDirections } from './src/terrain/SurfaceContract';

const ZERO_VEC = { x: 0, y: 0, z: 0 };
declare const process: { exit(code: number): never };

const failures: string[] = [];
function check(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${detail}`);
  if (!ok) failures.push(name);
}
const fmt = (x: number) => x.toExponential(2);

const TILE_SIZE_METERS = 300;
const RESOLUTION = 33;
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

function absolute(tile: TileMeshData, i: number): Vec3 {
  const v = tile.positions;
  return { x: tile.origin.x + v[i * 3]!, y: tile.origin.y + v[i * 3 + 1]!, z: tile.origin.z + v[i * 3 + 2]! };
}

for (const terrain of [small, earthSize]) {
  const level = levelForTileSize(terrain.radiusMeters, TILE_SIZE_METERS);
  const label = `${terrain.name}, level ${level}`;

  // --- Tiles: determinism and heights ----------------------------------------------
  {
    const key = tileContaining({ x: 0.3, y: -0.5, z: Math.sqrt(1 - 0.34) }, level);
    const a = buildTerrainTile(key, terrain, RESOLUTION);
    const b = buildTerrainTile({ ...key }, terrain, RESOLUTION);
    const pa = surfacePositions(a, RESOLUTION), pb = surfacePositions(b, RESOLUTION);
    const same = pa.every((x, i) => x === pb[i]) && a.origin.x === b.origin.x && a.origin.y === b.origin.y && a.origin.z === b.origin.z;
    let worstHeight = 0;
    let span = 0;
    for (let i = 0; i < pa.length / 3; i += 1) {
      const p = absolute(a, i);
      const r = Math.hypot(p.x, p.y, p.z);
      const h = terrain.sample({ x: p.x / r, y: p.y / r, z: p.z / r }).heightMeters;
      worstHeight = Math.max(worstHeight, Math.abs(r - terrain.radiusMeters - h));
      span = Math.max(span, Math.hypot(pa[i * 3]!, pa[i * 3 + 1]!, pa[i * 3 + 2]!));
    }
    // Rapier's trimesh must face outward, like the drawn surface.
    const indices = surfaceIndices(RESOLUTION);
    let inward = 0;
    for (let t = 0; t < indices.length; t += 3) {
      const p0 = absolute(a, indices[t]!), p1 = absolute(a, indices[t + 1]!), p2 = absolute(a, indices[t + 2]!);
      const u = { x: p1.x - p0.x, y: p1.y - p0.y, z: p1.z - p0.z }, w = { x: p2.x - p0.x, y: p2.y - p0.y, z: p2.z - p0.z };
      const n = { x: u.y * w.z - u.z * w.y, y: u.z * w.x - u.x * w.z, z: u.x * w.y - u.y * w.x };
      if (n.x * p0.x + n.y * p0.y + n.z * p0.z <= 0) inward += 1;
    }
    check(`tile determinism and heights (${label})`, same && worstHeight < 1e-3 && inward === 0,
      `${tileId(key)}: rebuilt bit-identical; vertices within ${fmt(worstHeight)} m of the terrain (float32 relative to a tile origin, farthest vertex ${span.toFixed(0)} m from it); ${indices.length / 3} surface triangles, ${inward} facing inward`);
  }

  // --- Seams, including a cube corner where three faces meet ------------------------
  for (const [where, point] of [['cube corner', { x: 1, y: 1, z: 1 }], ['face interior', { x: 0.2, y: 0.9, z: -0.3 }]] as const) {
    const l = Math.hypot(point.x, point.y, point.z);
    const centre = { x: (point.x / l) * terrain.radiusMeters, y: (point.y / l) * terrain.radiusMeters, z: (point.z / l) * terrain.radiusMeters };
    const tiles = tilesAround(centre, 3 * TILE_SIZE_METERS, level, terrain.radiusMeters).map((k) => buildTerrainTile(k, terrain, RESOLUTION));
    const faces = new Set(tiles.map((t) => t.key.face));
    let unmatched = 0, tested = 0, worstGap = 0;
    const side = RESOLUTION, last = RESOLUTION - 1;
    // Every vertex, bucketed in 1 m cells: a match is within 0.1 mm, and vertices are metres apart,
    // so the 27 cells around a point hold every candidate the exhaustive search would find.
    const cell = (p: Vec3) => [Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)] as const;
    const buckets = new Map<string, { tile: number; p: Vec3 }[]>();
    tiles.forEach((t, index) => {
      for (let k = 0; k < RESOLUTION * RESOLUTION; k += 1) {
        const p = absolute(t, k);
        const key = cell(p).join(',');
        const list = buckets.get(key);
        if (list) list.push({ tile: index, p }); else buckets.set(key, [{ tile: index, p }]);
      }
    });
    for (const [index, tile] of tiles.entries()) {
      for (let j = 0; j <= last; j += 1) {
        for (let i = 0; i <= last; i += 1) {
          if (i !== 0 && j !== 0 && i !== last && j !== last) continue;
          const p = absolute(tile, j * side + i);
          const r = Math.hypot(p.x, p.y, p.z);
          // Only edges well inside the tested patch have every neighbour loaded.
          if (distance({ x: (p.x / r) * terrain.radiusMeters, y: (p.y / r) * terrain.radiusMeters, z: (p.z / r) * terrain.radiusMeters }, centre) > 1.5 * TILE_SIZE_METERS) continue;
          tested += 1;
          let best = Infinity;
          const [cx, cy, cz] = cell(p);
          for (let dx = -1; dx <= 1; dx += 1) for (let dy = -1; dy <= 1; dy += 1) for (let dz = -1; dz <= 1; dz += 1) {
            for (const candidate of buckets.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) {
              if (candidate.tile !== index) best = Math.min(best, distance(p, candidate.p));
            }
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
  stepSeconds: 1 / 60, tileLevel: levelForTileSize(100e3, TILE_SIZE_METERS), tileResolution: RESOLUTION,
  tileReachMeters: 300, tileKeepMeters: 600, recenterMeters: 1000,
};

{
  // Rapier free flight (leapfrog convention) against the same reference.
  const env = harshPebble();
  const start = hopStart(env.frame);
  const times = [30, 60, 90, 120, 150];
  const reference = inertialReference(env, start, times);
  const world = new ContactWorld(RAPIER, env.frame, env.terrain, CONTACT_OPTIONS, 0, start.position);
  const body = world.addBody({ shape: { kind: 'ball', radius: 1 }, massKg: 1000, friction: 0.5, restitution: 0, lockRotations: false }, start);
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
  const box = world.addBody({ shape: { kind: 'box', halfExtents: { x: 1, y: 1, z: 1 } }, massKg: 5000, friction: 0.8, restitution: 0, lockRotations: false }, { position: at, velocity: { x: 0, y: 0, z: 0 } });
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
  const ball = world.addBody({ shape: { kind: 'ball', radius: 1 }, massKg: 500, friction: 0.6, restitution: 0.2, lockRotations: false },
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
  const ball = world.addBody({ shape: { kind: 'ball', radius: 1 }, massKg: 500, friction: 0.6, restitution: 0.2, lockRotations: false }, { position: at, velocity: { x: 3, y: -2, z: 1 } });
  for (let i = 0; i < 100; i += 1) world.step();
  const before = world.state(ball);
  world.recenter({ x: world.origin.x + 700, y: world.origin.y - 300, z: world.origin.z + 200 });
  const after = world.state(ball);
  const dp = distance(before.position, after.position), dv = distance(before.velocity, after.velocity);
  check('floating origin move', dp < 1e-3 && dv < 1e-9, `moving the origin 800 m changes the state by ${fmt(dp)} m, ${fmt(dv)} m/s (float32 rounding)`);
}

// === P3: hand-off between free flight and contacts ==================================
const LANDER_SPEC: LanderSpec = {
  thrustNewtons: 20e3, specificImpulseSeconds: 300, dryMassKg: 1000, fuelMassKg: 1000,
  halfExtents: { x: 1.5, y: 1, z: 1.5 }, friction: 0.8,
};
const LANDER_OPTIONS: LanderOptions = {
  contact: CONTACT_OPTIONS, tolerances: FRAME_TOLERANCES,
  bandEnterMeters: 200, bandExitMeters: 400,
};
const LAUNCH_SITE = { x: 0.8, y: 0.55, z: 0.25 };
const UP: LanderControl = { throttle: 1, up: 1, prograde: 0 };
const COAST: LanderControl = { throttle: 0, up: 1, prograde: 0 };

{
  // A 10 km hop from the ground: contact -> flight -> contact, against the orbit
  // lab's integrator flying the same burn and coast with no terrain at all.
  const env = plainPebble();
  const lander = Lander.landed(RAPIER, env.ephemeris, 0, env.terrain, LANDER_SPEC, LANDER_OPTIONS, 0, LAUNCH_SITE);
  const start = env.frame.toInertial(0, lander.bodyFixedState());
  const run = new PropagationRun({ time: 0, position: start.position, velocity: start.velocity, massKg: lander.massKg });
  const propagator = new VesselPropagator(env.ephemeris, FRAME_TOLERANCES);
  const thrust: ThrustControl = {
    thrustNewtons: LANDER_SPEC.thrustNewtons, exhaustVelocity: lander.exhaustVelocity, minimumMassKg: LANDER_SPEC.dryMassKg,
    attitude: { kind: 'surface', referenceBody: 0, up: 1, prograde: 0 },
  };
  propagator.advance(run, 20, 1e7, null, thrust);
  lander.advance(20, UP);
  let worst = 0, worstAt = 0, highest = 0, compared = 0;
  const massError = Math.abs(lander.massKg - run.state.massKg);
  while (lander.time < 600) {
    if (lander.time > 60 && lander.mode === 'contact' && lander.clearance() < 3) break;
    lander.advance(1, COAST);
    if (!run.impact) propagator.advance(run, lander.time, 1e7, null, null);
    highest = Math.max(highest, lander.clearance());
    // Compare while the lander is clear of the ground (the reference has none).
    if (lander.clearance() > 20 && !run.impact) {
      const reference = env.frame.toBodyFixed(lander.time, { position: run.state.position, velocity: run.state.velocity });
      const e = distance(lander.bodyFixedState().position, reference.position);
      if (e > worst) { worst = e; worstAt = lander.time; }
      compared += 1;
    }
  }
  const sequence = ['contact', ...lander.modeChanges.slice(1).map((c) => c.to)].join(' -> ');
  check('hand-off consistency', worst < 0.1 && massError < 1e-6 && sequence === 'contact -> flight -> contact',
    `${sequence}; top ${(highest / 1e3).toFixed(2)} km above the terrain; over ${compared} samples the lander stays within ${fmt(worst)} m of the orbit lab's integration (worst at T+${worstAt.toFixed(0)} s); fuel differs by ${fmt(massError)} kg`);

  // Touchdown remains a live rigid body, so collision can turn and move it.
  const atTouchdown = lander.bodyFixedState().position;
  lander.advance(10, COAST);
  const afterContact = lander.bodyFixedState().position;
  check('live ground contact', lander.mode === 'contact' && distance(atTouchdown, afterContact) > 0,
    `ten seconds after touchdown the unpinned craft moved ${fmt(distance(atTouchdown, afterContact))} m`);
}

{
  const env = plainPebble();
  const lander = Lander.landed(RAPIER, env.ephemeris, 0, env.terrain, LANDER_SPEC, LANDER_OPTIONS, 0, LAUNCH_SITE);
  const q0 = lander.orientation();
  lander.advance(15, COAST);
  const q1 = lander.orientation();
  const alignment = Math.abs(q0.x * q1.x + q0.y * q1.y + q0.z * q1.z + q0.w * q1.w);
  check('unlocked ground rotation', lander.mode === 'contact' && alignment < 0.999,
    `the live craft tips on the slope: initial/final quaternion alignment ${alignment.toFixed(4)}`);
}

{
  // Hop and land: a burn to about 10 km, then a surface-retrograde landing burn.
  const env = plainPebble();
  const lander = Lander.landed(RAPIER, env.ephemeris, 0, env.terrain, LANDER_SPEC, LANDER_OPTIONS, 0, LAUNCH_SITE);
  const site = lander.bodyFixedState().position;
  const g = 1.6;
  lander.advance(20, UP);
  let peak = 0, touchdownSpeed = 0, lastSpeed = 0;
  while (lander.time < 1200) {
    if (lander.time > 60 && lander.mode === 'contact' && lander.clearance() < LANDER_SPEC.halfExtents.y + 0.3
      && Math.hypot(...Object.values(lander.bodyFixedState().velocity)) < 0.5) break;
    const s = lander.bodyFixedState();
    const r = Math.hypot(s.position.x, s.position.y, s.position.z);
    const vUp = (s.velocity.x * s.position.x + s.velocity.y * s.position.y + s.velocity.z * s.position.z) / r;
    const speed = Math.hypot(s.velocity.x, s.velocity.y, s.velocity.z);
    const h = lander.clearance() - LANDER_SPEC.halfExtents.y;
    peak = Math.max(peak, h);
    const accel = LANDER_SPEC.thrustNewtons / lander.massKg;
    let control = COAST;
    if (vUp < 0 && h > 30) {
      // Burn surface-retrograde once stopping takes most of the remaining height.
      if (speed * speed / (2 * (accel - g)) > 0.7 * h) control = { throttle: 1, up: 0, prograde: -1 };
    } else if (vUp < 0 || h <= 30) {
      // Final descent: hold 1.5 m/s down, cut the engine at touchdown.
      const want = h > 1.5 ? -1.5 : 0;
      const throttle = h > 0.2 ? Math.min(1, Math.max(0, (lander.massKg * (g + 2 * (want - vUp))) / LANDER_SPEC.thrustNewtons)) : 0;
      control = { throttle, up: 1, prograde: 0 };
    }
    lastSpeed = speed;
    if (h < 0.5) touchdownSpeed = Math.max(touchdownSpeed, speed);
    lander.advance(0.1, control);
  }
  const drift = distance(lander.bodyFixedState().position, site);
  const sequence = ['contact', ...lander.modeChanges.slice(1).map((c) => c.to)].join(' -> ');
  check('hop and land', lander.mode === 'contact' && peak > 9000 && touchdownSpeed < 3 && lander.fuelKg > 0,
    `${sequence}; peak ${(peak / 1e3).toFixed(1)} km, touchdown at ${touchdownSpeed.toFixed(2)} m/s, landed ${(drift / 1e3).toFixed(2)} km from the launch site after ${lander.time.toFixed(0)} s, ${lander.fuelKg.toFixed(0)} kg fuel left (last speed ${lastSpeed.toFixed(2)} m/s)`);
}

// The visual coast line uses the orbit integrator and must stop on sampled terrain.
{
  const env = plainPebble();
  const d = { x: 1, y: 0, z: 0 };
  const r = env.terrain.radiusMeters + env.terrain.sample(d).heightMeters + 100;
  const state = { position: { x: r, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 } };
  const path = predictCoast(env.ephemeris, env.frame, env.terrain, FRAME_TOLERANCES, 0, state, 2000, 100);
  const hit = path.impact;
  const p = hit?.position;
  const distanceToCentre = p ? Math.hypot(p.x, p.y, p.z) : Infinity;
  const direction = p ? { x: p.x / distanceToCentre, y: p.y / distanceToCentre, z: p.z / distanceToCentre } : d;
  const surface = env.terrain.radiusMeters + env.terrain.sample(direction).heightMeters;
  check('coast terrain impact', !!hit && hit.time > 5 && hit.time < 30 && Math.abs(distanceToCentre - surface) < 0.01,
    `100 m drop reaches sampled terrain after ${hit?.time.toFixed(2) ?? '—'} s, height error ${fmt(distanceToCentre - surface)} m`);
}

// Manual attitude must steer the actual thrust in both physics modes.
{
  const env = plainPebble();
  const p = { x: env.terrain.radiusMeters + env.terrain.maxHeightMeters + 5000, y: 0, z: 0 };
  const state = { position: p, velocity: { x: 0, y: 0, z: 0 } };
  const upright = Lander.flying(RAPIER, env.ephemeris, 0, env.terrain, LANDER_SPEC, LANDER_OPTIONS, 0, state);
  const tilted = Lander.flying(RAPIER, env.ephemeris, 0, env.terrain, LANDER_SPEC, LANDER_OPTIONS, 0, state);
  upright.advance(5, { throttle: 1, up: 1, prograde: 0, direction: { x: 1, y: 0, z: 0 } });
  tilted.advance(5, { throttle: 1, up: 1, prograde: 0, direction: { x: 0.6, y: 0.8, z: 0 } });
  const lateral = tilted.bodyFixedState().position.y - upright.bodyFixedState().position.y;
  check('manual thrust direction', lateral > 40 && tilted.mode === 'flight',
    `five-second tilted burn displaces the craft ${lateral.toFixed(2)} m sideways in the orbit propagator`);

  // One frame of input must be one angular impulse, not a force that keeps
  // accumulating after the key is released.
  const hoverState = { position: { x: env.terrain.radiusMeters + env.terrain.maxHeightMeters + 100, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 } };
  const pulse = Lander.flying(RAPIER, env.ephemeris, 0, env.terrain, LANDER_SPEC, LANDER_OPTIONS, 0, hoverState);
  const qStart = pulse.orientation();
  pulse.advance(1 / 60, { ...COAST, turn: { x: 0, y: 0, z: 1 } });
  pulse.advance(2, COAST);
  const qEnd = pulse.orientation();
  const dot = Math.abs(qStart.x * qEnd.x + qStart.y * qEnd.y + qStart.z * qEnd.z + qStart.w * qEnd.w);
  const angle = 2 * Math.acos(Math.min(1, dot));
  check('one-frame steering pulse', pulse.mode === 'contact' && angle > 0.001 && angle < 0.2,
    `one frame of yaw then two seconds released rotates ${((angle * 180) / Math.PI).toFixed(2)}° total`);

  const contactUp = Lander.landed(RAPIER, env.ephemeris, 0, env.terrain, LANDER_SPEC, LANDER_OPTIONS, 0, LAUNCH_SITE);
  const contactTilt = Lander.landed(RAPIER, env.ephemeris, 0, env.terrain, LANDER_SPEC, LANDER_OPTIONS, 0, LAUNCH_SITE);
  contactUp.advance(0.5, COAST);
  contactTilt.advance(0.5, { ...COAST, turn: { x: 1, y: 0, z: 0 } });
  contactUp.advance(2, { throttle: 1, up: 1, prograde: 0, direction: { x: 0.8, y: 0.55, z: 0.25 } });
  contactTilt.advance(2, { throttle: 1, up: 1, prograde: 0, direction: { x: 0.8, y: 0.55, z: 0.25 } });
  const contactSideways = distance(contactUp.bodyFixedState().position, contactTilt.bodyFixedState().position);
  check('contact thrust steering', contactSideways > 0.5 && contactTilt.mode === 'contact',
    `steering torque tilts the live body; a two-second burn separates it from upright by ${contactSideways.toFixed(2)} m in Rapier`);
}

{
  // The two stages already have separate rigid bodies before staging. Removing
  // their joint must preserve both body identities, colliders, and momentum.
  const env = plainPebble();
  const upper: LanderSpec = { thrustNewtons: 8000, specificImpulseSeconds: 330, dryMassKg: 300, fuelMassKg: 200,
    halfExtents: { x: 1, y: 1.05, z: 1 }, friction: 0.8, contactShape: { kind: 'box', halfExtents: { x: 1, y: 1.05, z: 1 } }, crashToleranceMetersPerSecond: 10 };
  const booster: LanderSpec = { thrustNewtons: 28000, specificImpulseSeconds: 280, dryMassKg: 500, fuelMassKg: 900,
    halfExtents: { x: 1, y: 1.35, z: 1 }, friction: 0.8, contactShape: { kind: 'box', halfExtents: { x: 1, y: 1.35, z: 1 } }, crashToleranceMetersPerSecond: 10 };
  const full: LanderSpec = { ...booster, dryMassKg: 1000, fuelMassKg: 900, halfExtents: { x: 1, y: 2.05, z: 1 } };
  const rocket = PartJointRocket.landed(RAPIER, env.ephemeris, env.terrain, full, upper, booster, LANDER_OPTIONS, LAUNCH_SITE);
  rocket.advance(1, COAST);
  const upperBody = rocket.upper, boosterBody = rocket.booster;
  const upperCollider = upperBody.collider(0), boosterCollider = boosterBody.collider(0);
  const beforeUpper = rocket.partState('upper').position;
  const beforeBooster = rocket.partState('booster').position;
  const momentum = () => {
    const u = upperBody.linvel(), b = boosterBody.linvel();
    return { x: u.x * 500 + b.x * 1400, y: u.y * 500 + b.y * 1400, z: u.z * 500 + b.z * 1400 };
  };
  const beforeMomentum = momentum();
  const joined = rocket.world.world.impulseJoints.len() === 1;
  rocket.separate();
  const afterMomentum = momentum();
  const sameBodies = rocket.upper === upperBody && rocket.booster === boosterBody &&
    upperBody.collider(0) === upperCollider && boosterBody.collider(0) === boosterCollider;
  const positionJump = Math.max(distance(beforeUpper, rocket.partState('upper').position), distance(beforeBooster, rocket.partState('booster').position));
  const momentumJump = distance(beforeMomentum, afterMomentum);
  check('part-joint staging keeps both parts', joined && rocket.world.world.impulseJoints.len() === 0 && sameBodies && positionJump < 1e-8 && momentumJump < 0.1,
    `joint 1 -> 0; same bodies/colliders ${sameBodies}; position jump ${fmt(positionJump)} m; momentum jump ${fmt(momentumJump)} kg·m/s`);
  rocket.free();

  const powered = PartJointRocket.landed(RAPIER, env.ephemeris, env.terrain, full, upper, booster, LANDER_OPTIONS, LAUNCH_SITE);
  powered.advance(3, UP);
  const joinedDistance = distance(powered.partState('upper').position, powered.partState('booster').position);
  const burned = booster.fuelMassKg - powered.fuelKg;
  const attached = !powered.separated && powered.world.world.impulseJoints.len() === 1;
  powered.separate();
  const distanceAtSplit = distance(powered.partState('upper').position, powered.partState('booster').position);
  powered.advance(1, COAST);
  const distanceAfter = distance(powered.partState('upper').position, powered.partState('booster').position);
  check('part-joint burn and release', attached && burned > 20 && Math.abs(joinedDistance - 2.4) < 0.15 && distanceAfter > distanceAtSplit + 0.2,
    `attached distance ${joinedDistance.toFixed(3)} m, burned ${burned.toFixed(1)} kg, one second after release gap ${distanceAfter.toFixed(3)} m`);
  powered.free();

  const hybrid = PartJointRocket.landed(RAPIER, env.ephemeris, env.terrain, full, upper, booster, LANDER_OPTIONS, LAUNCH_SITE);
  hybrid.advance(15, UP);
  const reachedOrbitMode = hybrid.mode === 'flight' && hybrid.modeChanges[0]?.from === 'contact' && hybrid.modeChanges[0]?.to === 'flight';
  hybrid.separate();
  const boosterBeforeCoast = hybrid.partState('booster').position;
  hybrid.advance(2, COAST);
  const boosterAdvanced = distance(boosterBeforeCoast, hybrid.partState('booster').position) > 1;
  let samples = 0;
  while (hybrid.mode === 'flight' && hybrid.time < 500 && samples < 1000) { hybrid.advance(0.5, COAST); samples += 1; }
  const returnedToContact = hybrid.mode === 'contact' && hybrid.modeChanges.some((change) => change.from === 'flight' && change.to === 'contact');
  check('two-stage rocket switches between orbital and contact physics', reachedOrbitMode && boosterAdvanced && returnedToContact && hybrid.modeChanges.length === 2,
    `${hybrid.modeChanges.map((change) => change.from + '→' + change.to).join(' → ') || 'no transition'}; separated booster propagated independently; coasted ${samples * 0.5}s after ascent`);
  hybrid.free();

  // Staged in flight, the spent booster falls back into Rapier on its own while the burning upper stage stays in orbit mode.
  const split = PartJointRocket.landed(RAPIER, env.ephemeris, env.terrain, full, upper, booster, LANDER_OPTIONS, LAUNCH_SITE);
  split.crashDetection = true;
  split.advance(15, UP);
  split.separate();
  let waited = 0;
  while (split.partMode('booster') === 'flight' && waited < 600) { split.advance(0.5, UP); waited += 0.5; }
  const boosterInContact = split.partMode('booster') === 'contact';
  const upperInFlight = split.mode === 'flight';
  const oneWorld = split.contactWorlds().length === 1;
  split.advance(1, COAST);
  const stillFlying = split.mode === 'flight' && split.partMode('booster') !== 'flight';
  const upperClearance = split.clearance();
  check('staged parts switch physics independently', boosterInContact && upperInFlight && oneWorld && stillFlying &&
    split.modeChanges.length === 1,
    `booster entered contact after ${waited}s; upper stayed in ${split.mode} mode at ${(upperClearance / 1000).toFixed(1)} km; controlled-vessel transitions ${split.modeChanges.length}`);

  // The booster meets the ground at about 200 m/s: it must be destroyed, not bounced back up.
  let fell = 0;
  while (split.partMode('booster') === 'contact' && fell < 30) { split.advance(0.25, COAST); fell += 0.25; }
  const crash = split.crashes[0];
  check('high-speed impact destroys the part', split.partMode('booster') === 'destroyed' && crash?.part === 'booster' &&
    split.crashes.length === 1 && split.mode === 'flight' && split.contactWorlds().length === 0,
    `booster ${split.partMode('booster')} after ${fell}s in contact (speed change ${crash ? crash.deltaV.toFixed(1) : '—'} m/s); upper ${split.mode}`);
  split.free();

  const settled = PartJointRocket.landed(RAPIER, env.ephemeris, env.terrain, full, upper, booster, LANDER_OPTIONS, LAUNCH_SITE);
  settled.crashDetection = true;
  settled.advance(5, COAST);
  const settleDeltaV = Math.max(settled.world.lastContactDeltaV(settled.upper), settled.world.lastContactDeltaV(settled.booster));
  check('gentle touchdown survives', settled.crashes.length === 0 && settled.mode === 'contact',
    `1 m settle onto the pad: ${settled.crashes.length} crashes; resting contact speed change ${settleDeltaV.toFixed(3)} m/s per step`);
  settled.free();

  const angleBetween = (a: { x: number; y: number; z: number; w: number }, b: { x: number; y: number; z: number; w: number }) =>
    2 * Math.acos(Math.min(1, Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w)));
  const norm = (v: Vec3) => Math.hypot(v.x, v.y, v.z);

  // A. Flight attitude reproduces Rapier's angular step: same torque from rest, 1 s on then 1 s coasting, off-axis.
  {
    const high = { x: 0, y: 0, z: env.terrain.radiusMeters + 50_000 };
    const world = new ContactWorld(RAPIER, env.frame, env.terrain, CONTACT_OPTIONS, 0, high);
    const start = { x: 0.1, y: 0.2, z: 0.3, w: 0.93 };
    const l = Math.hypot(start.x, start.y, start.z, start.w);
    const q0 = { x: start.x / l, y: start.y / l, z: start.z / l, w: start.w / l };
    const body = world.addBody({ shape: upper.contactShape!, massKg: 500, friction: 0.8, restitution: 0, lockRotations: false },
      { position: high, velocity: ZERO_VEC }, q0);
    const principal = body.principalInertia();
    const frame = quatToMatrix(body.principalInertiaLocalFrame());
    const inertia = matMul(matMul(frame, [principal.x, 0, 0, 0, principal.y, 0, 0, 0, principal.z]), transpose(frame));
    // A light off-axis command (the rocket's steering torque on a lone 500 kg part spins it at several rad/s).
    const turn = { x: 0.06, y: 0.03, z: -0.08 };
    const dt = CONTACT_OPTIONS.stepSeconds;
    let flight = { rotation: q0, angularVelocity: ZERO_VEC as Vec3 };
    for (let k = 0; k < 120; k += 1) {
      const on = k < 60 ? 1 : 0;
      const torque = { x: turn.x * 6000 * on, y: turn.y * 6000 * on, z: turn.z * 6000 * on };
      const worldTorque = matVec(quatToMatrix(body.rotation()), torque);
      body.applyTorqueImpulse({ x: worldTorque.x * dt, y: worldTorque.y * dt, z: worldTorque.z * dt }, true);
      world.step();
      flight = stepAttitude(flight.rotation, flight.angularVelocity, inertia, torque, ANGULAR_DAMPING, dt);
    }
    const w = body.angvel();
    const angle = angleBetween(body.rotation(), flight.rotation);
    const spinGap = norm({ x: w.x - flight.angularVelocity.x, y: w.y - flight.angularVelocity.y, z: w.z - flight.angularVelocity.z });
    check('flight attitude matches Rapier', angle < 1e-6 && spinGap < 1e-3 * norm(w),
      `off-axis torque 1 s on, 1 s off: turned ${(angleBetween(q0, body.rotation()) * 180 / Math.PI).toFixed(1)}° in Rapier; flight attitude within ${(angle * 180 / Math.PI).toExponential(2)}°, spin within ${fmt(spinGap)} of ${fmt(norm(w))} rad/s`);
    world.free();
  }

  // B + C. Steering above the contact band, and angular velocity carried across both hand-offs.
  {
    const steer = { ...UP, turn: { x: 0.05, y: 0, z: 0 } };
    const craft = PartJointRocket.landed(RAPIER, env.ephemeris, env.terrain, full, upper, booster, LANDER_OPTIONS, LAUNCH_SITE);
    const dt = CONTACT_OPTIONS.stepSeconds;
    // Climb straight to just below the band exit, then steer lightly across it one physics step at a time.
    for (let g = 0; craft.mode === 'contact' && craft.clearance() < LANDER_OPTIONS.bandExitMeters - 60 && g < 60 * 40; g += 1) craft.advance(dt, UP);
    let before = craft.partAngularVelocity('upper'), exitJump = Infinity;
    for (let g = 0; craft.mode === 'contact' && g < 60 * 20; g += 1) {
      before = craft.partAngularVelocity('upper');
      craft.advance(dt, steer);
    }
    if ((craft.mode as string) === 'flight') {
      const after = craft.partAngularVelocity('upper');
      exitJump = norm({ x: after.x - before.x, y: after.y - before.y, z: after.z - before.z }) / Math.max(norm(before), 1e-9);
    }
    // In flight: one second of pitch turns the stack; releasing lets Rapier's damping take the spin down.
    const q1 = craft.orientation();
    craft.advance(1, { ...COAST, turn: { x: 1, y: 0, z: 0 } });
    const turned = angleBetween(q1, craft.orientation());
    const spinning = norm(craft.partAngularVelocity('upper'));
    craft.advance(2, COAST);
    const decayed = norm(craft.partAngularVelocity('upper'));
    const expectedDecay = (1 / (1 + dt * ANGULAR_DAMPING)) ** Math.round(2 / dt);
    const flying = craft.mode === 'flight';
    // Coast back down and step across the band entry.
    let returnJump = Infinity;
    for (let g = 0; craft.mode === 'flight' && g < 2000 && craft.clearance() > 400; g += 1) craft.advance(0.5, COAST);
    const lightSteer = { ...COAST, turn: { x: 0.05, y: 0, z: 0 } };
    let spinAtEntry = 0;
    for (let g = 0; craft.mode === 'flight' && g < 60 * 30; g += 1) {
      const w0 = craft.partAngularVelocity('upper');
      spinAtEntry = norm(w0);
      craft.advance(dt, lightSteer);
      if ((craft.mode as string) === 'contact') {
        const w1 = craft.partAngularVelocity('upper');
        returnJump = norm({ x: w1.x - w0.x, y: w1.y - w0.y, z: w1.z - w0.z }) / Math.max(norm(w0), 1e-9);
      }
    }
    check('steering in orbital flight', flying && turned > 5 * Math.PI / 180 && Math.abs(decayed / spinning - expectedDecay) < 0.02,
      `1 s of pitch above the band turned the stack ${(turned * 180 / Math.PI).toFixed(1)}°; released for 2 s, spin ${fmt(spinning)} -> ${fmt(decayed)} rad/s (x${(decayed / spinning).toFixed(3)}, Rapier damping gives x${expectedDecay.toFixed(3)})`);
    check('angular velocity carried across physics hand-offs', exitJump < 0.05 && returnJump < 0.05 && norm(before) > 0.01 && spinAtEntry > 0.01,
      `contact -> flight at ${fmt(norm(before))} rad/s: spin changed ${(exitJump * 100).toFixed(2)}% over the switching step; flight -> contact at ${fmt(spinAtEntry)} rad/s: ${(returnJump * 100).toFixed(2)}%`);
    craft.free();
  }
}

{
  const gate = new EncounterPhysicsGate();
  const zero = { x: 0, y: 0, z: 0 };
  const first = { position: { x: 10_000, y: -50, z: 200 }, velocity: zero };
  const atRange = (distanceMeters: number) => ({ position: { x: first.position.x + distanceMeters, y: first.position.y, z: first.position.z }, velocity: zero });
  const far = gate.update('active', first, 'target', atRange(10_001), 0);
  const enter = gate.update('active', first, 'target', atRange(9_999), 0);
  const stay = gate.update('target', atRange(12_000), 'active', first, 0);
  const exit = gate.update('active', first, 'target', atRange(15_001), 0);
  const ok = !far.physics && enter.physics && stay.physics && exit.changed && !exit.physics &&
    !gate.isPhysicsActive('active') && gate.activePairs().length === 0;
  check('encounter physics range uses shared-frame positions and hysteresis', ok,
    `orbit mode outside 10 km; both vessels promoted inside 10 km; remain physical through 15 km; demote beyond 15 km`);

  const fastPass = gate.update('active',
    { position: first.position, velocity: { x: 30_000, y: 0, z: 0 } },
    'target',
    { position: { x: first.position.x, y: first.position.y + 20_000, z: first.position.z }, velocity: { x: 30_000, y: -30_000, z: 0 } },
    1);
  check('encounter gate predicts a high-speed pass from relative motion', fastPass.physics && fastPass.distanceMeters === 20_000 &&
    fastPass.closestApproachMeters < 1e-8 && fastPass.timeToClosestApproachSeconds > 0 && fastPass.timeToClosestApproachSeconds < 1,
    `common 30 km/s solar-frame motion cancels; predicted ${fastPass.closestApproachMeters.toFixed(3)} m miss in ${fastPass.timeToClosestApproachSeconds.toFixed(4)} s`);
}

// === Drawn terrain is the collision terrain ===========================================
{
  // Tile workers rebuild the terrain from its config; their tiles must equal the main thread's bit for bit.
  const planet = pebble();
  const key = tileContaining({ x: 0.6, y: -0.2, z: 0.77 }, CONTACT_OPTIONS.tileLevel);
  const main = buildTerrainTile(key, planet.terrain, RESOLUTION);
  const worker = buildTerrainTile(key, terrainFromConfig(planet.terrainConfig), RESOLUTION);
  const identical = main.positions.every((x, i) => x === worker.positions[i]) && main.origin.x === worker.origin.x &&
    main.origin.y === worker.origin.y && main.origin.z === worker.origin.z;
  check('worker terrain equals main-thread terrain', identical, `${tileId(key)} rebuilt from ${planet.terrainConfig.kind} config: ${identical ? 'bit-identical' : 'differs'}`);

  // Around every observer, every tile within the collision keep radius is drawn at the collision
  // level with same-level neighbours on all four edges, so the renderer never stitches it.
  for (const [planetId, make] of Object.entries(PLANETS)) {
    const terrain = make().terrain;
    const contact = { ...CONTACT_OPTIONS, tileLevel: levelForTileSize(terrain.radiusMeters, TILE_SIZE_METERS) };
    const lodOptions = landingLodOptions(terrain, contact);
    const directions = [{ x: 1, y: 1, z: 1 }, { x: 1, y: 0.001, z: 0.3 }, { x: -0.2, y: 0.5, z: -0.8 }].map((d) => {
      const l = Math.hypot(d.x, d.y, d.z); return { x: d.x / l, y: d.y / l, z: d.z / l };
    });
    const highest = terrain.radiusMeters + terrain.maxHeightMeters + contact.tileReachMeters;
    const at = (d: Vec3, r: number) => ({ x: d.x * r, y: d.y * r, z: d.z * r });
    const cases: { label: string; observers: Vec3[] }[] = [];
    for (const d of directions) {
      cases.push({ label: 'on the ground', observers: [at(d, terrain.radiusMeters + terrain.sample(d).heightMeters)] });
      cases.push({ label: 'at the top of collision range', observers: [at(d, highest)] });
    }
    // A second part 20 km along the surface from the first.
    const d0 = directions[2]!, angle = 20_000 / terrain.radiusMeters;
    const t = { x: -d0.y, y: d0.x, z: 0 }, tl = Math.hypot(t.x, t.y, t.z);
    const d1 = { x: d0.x * Math.cos(angle) + t.x / tl * Math.sin(angle), y: d0.y * Math.cos(angle) + t.y / tl * Math.sin(angle), z: d0.z * Math.cos(angle) };
    cases.push({ label: 'two parts 20 km apart', observers: [at(d0, highest), at(d1, highest)] });
    let covered = 0, bad = 0, worstDrawn = 0;
    const problems: string[] = [];
    for (const c of cases) {
      const lod = new PlanetLod({ ...lodOptions, maxCachedTiles: 50_000 });
      // Same view as TerrainView: the parts are the observers, horizon culling on.
      const view = { observerPositions: c.observers, distanceScale: 1, horizonCulling: true };
      let selected = lod.select(view);
      for (let iteration = 0; selected.requests.length > 0 && iteration < 4 * lodOptions.maxLevel; iteration += 1) {
        for (const request of selected.requests) {
          const k = request.key;
          lod.acceptTile({ id: tileId(k), key: k, origin: { x: 0, y: 0, z: 0 }, positions: new Float32Array(), normals: new Float32Array(),
            colors: new Float32Array(), grid: new Float32Array(), minHeightMeters: 0, maxHeightMeters: 0, errorMeters: 0,
            skirtDepthMeters: 0, buildMilliseconds: 0, sampleMilliseconds: 0, finishMilliseconds: 0 });
        }
        selected = lod.select(view);
      }
      worstDrawn = Math.max(worstDrawn, selected.render.length);
      const drawn = new Set(selected.render.map((node) => node.id));
      if (selected.requests.length > 0) { bad += 1; problems.push(`${c.label}: selection did not settle`); }
      for (const observer of c.observers) {
        for (const k of tilesAround(observer, contact.tileKeepMeters, contact.tileLevel, terrain.radiusMeters)) {
          covered += 1;
          const missing = [k, ...FACE_EDGES.map((edge) => neighborKey(k, edge))].filter((n) => !drawn.has(tileId(n)));
          if (missing.length > 0) { bad += 1; if (problems.length < 3) problems.push(`${c.label}: ${tileId(k)} lacks ${missing.map(tileId).join(',')}`); }
        }
      }
    }
    check(`drawn terrain equals collision terrain near every part (${planetId})`, bad === 0,
      bad === 0 ? `${cases.length} cases: ${covered} collision tiles within ${contact.tileKeepMeters} m all drawn at L${contact.tileLevel} with L${contact.tileLevel} neighbours (no stitched edge); at most ${worstDrawn} tiles drawn`
        : problems.join('; '));
  }
}

// === Every planet: launch, orbital flight, and back into the contact band =============
for (const [planetId, make] of Object.entries(PLANETS)) {
  const planet = make();
  const system = buildSystem(planet.system);
  const ephemeris = new Ephemeris(system, { stepSeconds: 60, chunkSteps: 1024 });
  ephemeris.extendTo(60);
  const contact = { ...CONTACT_OPTIONS, tileLevel: levelForTileSize(planet.terrain.radiusMeters, TILE_SIZE_METERS) };
  const options: LanderOptions = { ...LANDER_OPTIONS, contact };
  const upper: LanderSpec = { thrustNewtons: 8000, specificImpulseSeconds: 330, dryMassKg: 300, fuelMassKg: 200,
    halfExtents: { x: 1, y: 1.05, z: 1 }, friction: 0.8, contactShape: { kind: 'box', halfExtents: { x: 1, y: 1.05, z: 1 } }, crashToleranceMetersPerSecond: 10 };
  const booster: LanderSpec = { thrustNewtons: 28000, specificImpulseSeconds: 280, dryMassKg: 500, fuelMassKg: 900,
    halfExtents: { x: 1, y: 1.35, z: 1 }, friction: 0.8, contactShape: { kind: 'box', halfExtents: { x: 1, y: 1.35, z: 1 } }, crashToleranceMetersPerSecond: 10 };
  const full: LanderSpec = { ...booster, dryMassKg: 1000, fuelMassKg: 900, halfExtents: { x: 1, y: 2.05, z: 1 } };
  const rocket = PartJointRocket.landed(RAPIER, ephemeris, planet.terrain, full, upper, booster, options, LAUNCH_SITE);
  rocket.advance(2, COAST);
  rocket.advance(20, UP);
  let peak = rocket.clearance();
  for (let g = 0; rocket.mode === 'flight' && g < 4000; g += 1) { rocket.advance(0.5, COAST); peak = Math.max(peak, rocket.clearance()); }
  // A vertical burn at the stack's initial thrust-to-weight reaches at least this height; a stack that bends or tips does not.
  const gravity = planet.system.root.massKg * 6.6743e-11 / planet.terrain.radiusMeters ** 2;
  const burnOnly = 0.5 * (booster.thrustNewtons / (full.dryMassKg + full.fuelMassKg) - gravity) * 20 ** 2;
  const changes = rocket.modeChanges;
  const ok = changes[0]?.from === 'contact' && changes[0]?.to === 'flight' && changes[1]?.from === 'flight' && changes[1]?.to === 'contact' && peak > 0.9 * burnOnly;
  // After that the craft hits the ground at speed; with crash detection off Rapier may bounce it back out (not checked here).
  check(`launch and return on ${planetId}`, ok,
    `${planet.label}: ${changes.slice(0, 2).map((c) => `${c.from}→${c.to} at ${c.time.toFixed(0)} s`).join(', ')}; peak ${(peak / 1000).toFixed(2)} km (a vertical 20 s burn alone reaches ${(burnOnly / 1000).toFixed(2)} km)`);
  rocket.free();
}

if (failures.length > 0) {
  console.log(`\n${failures.length} CHECK(S) FAILED: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\nALL CHECKS PASSED');
