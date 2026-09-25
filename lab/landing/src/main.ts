import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three/webgpu';
import { bodyOrientation, buildSystem, Ephemeris, type Vec3 } from './orbitCore';
import { PLANETS, planetById } from './planet/Planets';
import { levelForTileSize } from './terrain/TerrainTiles';
import { TerrainView } from './terrain/TerrainView';
import { LabLog } from './debug/LabLog';
import { tileContaining, tileId } from './lodCore';
import { predictCoast, type CoastPrediction } from './vessel/CoastPrediction';
import { type LanderControl, type LanderOptions, type LanderSpec } from './vessel/Lander';
import { PartJointRocket } from './vessel/PartJointRocket';
import type { BodyShape, TileCollider } from './physics/ContactWorld';
import type { Terrain } from './terrain/Surface';
import './style.css';

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `<canvas id="view"></canvas><aside class="panel"><div class="eyebrow">VOID / PHYSICS LAB 03</div><h1>Landing</h1><p>Land and launch on a rotating planet.</p><div class="readout" id="readout"></div><label>Throttle <strong id="throttleValue">0%</strong><input id="throttle" type="range" min="0" max="100" value="0"></label><div class="buttons"><button id="launch">Stage</button><button id="cut">Throttle 0</button><button id="reset">Reset</button></div><label>Camera frame<select id="frame"><option value="surface">Rotating surface</option><option value="inertial">Inertial</option></select></label><label>Planet<select id="planet">${Object.keys(PLANETS).map((id) => `<option value="${id}">${id}</option>`).join('')}</select></label><label>Time rate<select id="rate"><option value="1">1×</option><option value="5">5×</option><option value="20">20×</option></select></label><label class="check"><input id="meshLines" type="checkbox" checked> Mesh edges (white)</label><label class="check"><input id="colliderLines" type="checkbox" checked> Colliders (green)</label><label class="check"><input id="tileBoundaries" type="checkbox" checked> Tile boundaries (red)</label><p class="hint">Space: ignite booster, then separate and ignite upper stage · Shift / Ctrl: throttle · W / S: pitch · A / D: yaw · Q / E: roll. Drag to orbit camera · scroll to zoom. White lines are drawn mesh edges, green lines are Rapier colliders (terrain tiles and rocket parts), red lines are tile boundaries; cyan is the engine-off coast forecast.</p><div id="error"></div></aside><div class="badge" id="badge"></div>`;
const canvas = document.querySelector<HTMLCanvasElement>('#view')!;
const readout = document.querySelector<HTMLElement>('#readout')!;
const throttleInput = document.querySelector<HTMLInputElement>('#throttle')!;
const throttleValue = document.querySelector<HTMLElement>('#throttleValue')!;
const frameInput = document.querySelector<HTMLSelectElement>('#frame')!;
const rateInput = document.querySelector<HTMLSelectElement>('#rate')!;
const planetInput = document.querySelector<HTMLSelectElement>('#planet')!;
const meshLinesInput = document.querySelector<HTMLInputElement>('#meshLines')!;
const colliderLinesInput = document.querySelector<HTMLInputElement>('#colliderLines')!;
const tileBoundariesInput = document.querySelector<HTMLInputElement>('#tileBoundaries')!;
const error = document.querySelector<HTMLElement>('#error')!;
// ?planet=<id> picks the planet; changing it reloads the page so workers, tiles and physics all start fresh.
const planetId = new URLSearchParams(window.location.search).get('planet') ?? 'pebble';
const planet = planetById(planetId);
const terrain = planet.terrain;
planetInput.value = planetId;
planetInput.addEventListener('change', () => {
  const next = new URL(window.location.href);
  next.searchParams.set('planet', planetInput.value);
  window.location.assign(next.href);
});
document.querySelector<HTMLElement>('#badge')!.textContent = planet.label;
/** Farthest camera distance from the rocket: a few planet radii, at least 300 km. */
const maxCameraDistance = Math.max(300_000, 3 * terrain.radiusMeters);
const eph = new Ephemeris(buildSystem(planet.system), { stepSeconds: 60, chunkSteps: 1024 });
eph.extendTo(60);
type Piece = Extract<BodyShape, { kind: 'compound' }>['parts'][number];
const upperPieces: Piece[] = [
  { shape: { kind: 'cylinder', radius: 1.05, halfHeight: 0.875 }, position: { x: 0, y: 0.175, z: 0 } },
  { shape: { kind: 'cone', radius: 0.9, halfHeight: 0.5 }, position: { x: 0, y: 1.55, z: 0 } },
  { shape: { kind: 'cone', radius: 0.43, halfHeight: 0.185 }, position: { x: 0, y: -0.86, z: 0 } },
];
const boosterPieces: Piece[] = [
  { shape: { kind: 'cylinder', radius: 1.25, halfHeight: 1.175 }, position: { x: 0, y: 0.175, z: 0 } },
  { shape: { kind: 'cone', radius: 0.58, halfHeight: 0.185 }, position: { x: 0, y: -1.21, z: 0 } },
];
for (const x of [-1, 1]) for (const z of [-1, 1]) {
  const root = new THREE.Vector3(x * 0.72, 0.05, z * 0.72);
  const foot = new THREE.Vector3(x * 1.28, -1.37, z * 1.28);
  const span = foot.clone().sub(root);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), span.clone().normalize());
  const middle = root.add(foot).multiplyScalar(0.5);
  boosterPieces.push({ shape: { kind: 'cylinder', radius: 0.1, halfHeight: span.length() / 2 }, position: { x: middle.x, y: middle.y, z: middle.z }, rotation: { x: q.x, y: q.y, z: q.z, w: q.w } });
  boosterPieces.push({ shape: { kind: 'box', halfExtents: { x: 0.21, y: 0.05, z: 0.21 } }, position: { x: foot.x, y: foot.y, z: foot.z } });
}
const boosterShape: BodyShape = { kind: 'compound', parts: boosterPieces };
const upperShape: BodyShape = { kind: 'compound', parts: upperPieces };
const spec: LanderSpec = { thrustNewtons: 28_000, specificImpulseSeconds: 280, dryMassKg: 1000, fuelMassKg: 900,
  // Reference point is the attached parts' centre of mass; feet are about 2 m below it.
  halfExtents: { x: 1.5, y: 2.05, z: 1.5 }, friction: 0.8 };
const upperSpec: LanderSpec = { thrustNewtons: 8_000, specificImpulseSeconds: 330, dryMassKg: 300, fuelMassKg: 200,
  halfExtents: { x: 1.05, y: 1.15, z: 1.05 }, contactShape: upperShape, friction: 0.8, crashToleranceMetersPerSecond: 10 };
const boosterSpec: LanderSpec = { thrustNewtons: spec.thrustNewtons, specificImpulseSeconds: spec.specificImpulseSeconds,
  dryMassKg: 500, fuelMassKg: 900, halfExtents: { x: 1.5, y: 1.42, z: 1.5 }, contactShape: boosterShape, friction: 0.8, crashToleranceMetersPerSecond: 10 };
const options: LanderOptions = { contact: { stepSeconds: 1 / 60, tileLevel: levelForTileSize(terrain.radiusMeters, 300), tileResolution: 33,
  tileReachMeters: 300, tileKeepMeters: 600, recenterMeters: 1000 }, tolerances: { positionMeters: 1e-6, velocityMetersPerSecond: 1e-9 },
  bandEnterMeters: 200, bandExitMeters: 400 };
const launchSite = { x: 0.8, y: 0.55, z: 0.25 };
await RAPIER.init();
let lander = PartJointRocket.landed(RAPIER, eph, terrain, spec, upperSpec, boosterSpec, options, launchSite);
let prediction: CoastPrediction | null = null;
let predictionAt = -Infinity;
let paused = false;
let stageNumber = 0;

// WebGPU renderer on its WebGL2 backend, as lab/lod uses, so lab/lod's node-material tile renderer runs here.
const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, forceWebGL: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setClearColor(0x07101b);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(58, 1, 0.1, 1_000_000);
const worldGroup = new THREE.Group();
scene.add(worldGroup);
scene.add(new THREE.HemisphereLight(0xcbe7ff, 0x26313d, 2.2));
const sun = new THREE.DirectionalLight(0xffe7bb, 2.8); sun.position.set(3, 7, 4); scene.add(sun);
const upperVisual = new THREE.Group();
const hull = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.05, 1.75, 16), new THREE.MeshStandardMaterial({ color: 0xece7d4, metalness: 0.3, roughness: 0.55 }));
hull.position.y = 0.175;
upperVisual.add(hull);
const nose = new THREE.Mesh(new THREE.ConeGeometry(0.9, 1.0, 16), new THREE.MeshStandardMaterial({ color: 0xece7d4, metalness: 0.3, roughness: 0.55 }));
nose.position.y = 1.55; upperVisual.add(nose);
const trim = new THREE.MeshStandardMaterial({ color: 0x273947, metalness: 0.72, roughness: 0.34 });
const paleTrim = new THREE.MeshStandardMaterial({ color: 0xd1d6d0, metalness: 0.55, roughness: 0.42 });
const glass = new THREE.MeshStandardMaterial({ color: 0x214c63, emissive: 0x0a2632, emissiveIntensity: 0.45, metalness: 0.35, roughness: 0.18 });
const upperSkirt = new THREE.Mesh(new THREE.CylinderGeometry(1.02, 1.04, 0.28, 24), trim);
upperSkirt.position.y = -0.57; upperVisual.add(upperSkirt);
const noseRim = new THREE.Mesh(new THREE.CylinderGeometry(0.92, 0.92, 0.08, 24), trim);
noseRim.position.y = 1.06; upperVisual.add(noseRim);
for (let i = 0; i < 4; i += 1) {
  const angle = i * Math.PI / 2;
  const windowFrame = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.31, 0.035), trim);
  const windowPane = new THREE.Mesh(new THREE.BoxGeometry(0.39, 0.22, 0.045), glass);
  for (const piece of [windowFrame, windowPane]) {
    piece.position.set(Math.sin(angle) * 0.935, 0.5, Math.cos(angle) * 0.935);
    piece.rotation.y = angle;
    upperVisual.add(piece);
  }
  windowPane.position.add(new THREE.Vector3(Math.sin(angle) * 0.025, 0, Math.cos(angle) * 0.025));
}
scene.add(upperVisual);
const boosterGroup = new THREE.Group();
for (const x of [-1, 1]) for (const z of [-1, 1]) {
  const root = new THREE.Vector3(x * 0.72, -1.25, z * 0.72);
  const foot = new THREE.Vector3(x * 1.28, -2.67, z * 1.28);
  const between = new THREE.Vector3().subVectors(foot, root);
  const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.1, between.length(), 8), new THREE.MeshStandardMaterial({ color: 0x687381, metalness: 0.5 }));
  leg.position.copy(root).add(foot).multiplyScalar(0.5);
  leg.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), between.normalize());
  leg.position.y += 1.3;
  boosterGroup.add(leg);
  const pad = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.1, 0.42), new THREE.MeshStandardMaterial({ color: 0x687381, metalness: 0.5 }));
  pad.position.copy(foot); pad.position.y += 1.3; boosterGroup.add(pad);
}
scene.add(boosterGroup);
const colliderLineMaterial = new THREE.LineBasicMaterial({ color: 0x3dff6e, depthTest: true });
function shapeLines(shape: BodyShape): THREE.Group {
  const group = new THREE.Group();
  const pieces = shape.kind === 'compound' ? shape.parts : [{ shape, position: { x: 0, y: 0, z: 0 } }];
  for (const piece of pieces) {
    const s = piece.shape;
    const geometry = s.kind === 'box' ? new THREE.BoxGeometry(2 * s.halfExtents.x, 2 * s.halfExtents.y, 2 * s.halfExtents.z)
      : s.kind === 'ball' ? new THREE.SphereGeometry(s.radius, 12, 8)
      : s.kind === 'cone' ? new THREE.ConeGeometry(s.radius, 2 * s.halfHeight, 12)
      : new THREE.CylinderGeometry(s.radius, s.radius, 2 * s.halfHeight, 12);
    const lines = new THREE.LineSegments(new THREE.EdgesGeometry(geometry), colliderLineMaterial);
    lines.position.set(piece.position.x, piece.position.y, piece.position.z);
    if ('rotation' in piece && piece.rotation) lines.quaternion.set(piece.rotation.x, piece.rotation.y, piece.rotation.z, piece.rotation.w);
    lines.renderOrder = 2;
    group.add(lines);
  }
  return group;
}
const upperColliderLines = shapeLines(upperShape);
upperVisual.add(upperColliderLines);
const boosterVisual = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.25, 2.35, 16), new THREE.MeshStandardMaterial({ color: 0xd87543, metalness: 0.35, roughness: 0.6 }));
boosterVisual.position.y = 0.175;
boosterGroup.add(boosterVisual);
for (const y of [1.23, -0.93]) {
  const band = new THREE.Mesh(new THREE.CylinderGeometry(y > 0 ? 1.12 : 1.245, y > 0 ? 1.15 : 1.245, 0.1, 24), trim);
  band.position.y = y; boosterGroup.add(band);
}
for (let i = 0; i < 4; i += 1) {
  const angle = i * Math.PI / 2;
  const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 1.75, 8), paleTrim);
  pipe.position.set(Math.sin(angle) * 1.19, -0.05, Math.cos(angle) * 1.19);
  boosterGroup.add(pipe);
}
function addEngine(parent: THREE.Group, nozzleY: number, radius: number): { plume: THREE.Group; light: THREE.PointLight } {
  const mount = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.58, radius * 0.68, 0.16, 24), trim);
  mount.position.y = nozzleY + 0.18; parent.add(mount);
  const bell = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.58, radius, 0.37, 24, 1, true),
    new THREE.MeshStandardMaterial({ color: 0x778995, metalness: 0.85, roughness: 0.28, side: THREE.DoubleSide }));
  bell.position.y = nozzleY - 0.07; parent.add(bell);
  const lip = new THREE.Mesh(new THREE.TorusGeometry(radius, 0.045, 8, 24), trim);
  lip.rotation.x = Math.PI / 2;
  lip.position.y = nozzleY - 0.255; parent.add(lip);
  const plume = new THREE.Group();
  plume.position.y = nozzleY - 0.28;
  const outer = new THREE.Mesh(new THREE.ConeGeometry(radius * 0.9, 2.8, 20, 1, true),
    new THREE.MeshBasicMaterial({ color: 0xff8c43, transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
  outer.rotation.z = Math.PI;
  outer.position.y = -1.4;
  const core = new THREE.Mesh(new THREE.ConeGeometry(radius * 0.48, 1.9, 20, 1, true),
    new THREE.MeshBasicMaterial({ color: 0xbcefff, transparent: true, opacity: 0.75, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
  core.rotation.z = Math.PI;
  core.position.y = -0.95;
  plume.add(outer, core);
  plume.visible = false;
  parent.add(plume);
  const light = new THREE.PointLight(0xffb66d, 0, 16);
  light.position.y = nozzleY - 0.45; parent.add(light);
  return { plume, light };
}
const upperEngine = addEngine(upperVisual, -0.79, 0.43);
const boosterEngine = addEngine(boosterGroup, -1.14, 0.58);
const boosterColliderLines = shapeLines(boosterShape);
boosterGroup.add(boosterColliderLines);
// Tiles come in body-fixed axes; this group turns them into the rendered frame (x, z, -y) and the camera frame.
const bodyFixedGroup = new THREE.Group();
scene.add(bodyFixedGroup);
const bodyToRender = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
// One tile worker per core, leaving one for the page's own thread.
const terrainView = new TerrainView(terrain, planet.terrainConfig, options.contact, Math.max(1, navigator.hardwareConcurrency - 1), (e) => {
  paused = true; engineArmed = false; error.textContent = `Terrain failed: ${e.message}`;
});
bodyFixedGroup.add(terrainView.tiles.group);
terrainView.tiles.setMeshWireframe(meshLinesInput.checked);
terrainView.tiles.setTileBoundaries(tileBoundariesInput.checked);
// Dev sessions log LOD events to lab/landing/lab-log/lod.jsonl for later reading.
const lodLog = import.meta.env.DEV ? new LabLog('lod', (e) => { error.textContent = `Lab log failed: ${e.message}`; }) : null;
lodLog?.write({ event: 'session', lod: terrainView.lod.options });
const previousLevelUnder: Record<'upper' | 'booster', number> = { upper: -1, booster: -1 };
/** Per-frame main-thread timings since the last lod-sample, ms: whole frame interval and its phases. */
const frameTimes = { frames: 0, frame: { sum: 0, max: 0 }, physics: { sum: 0, max: 0 }, lod: { sum: 0, max: 0 }, draw: { sum: 0, max: 0 } };
function timePhase(phase: 'frame' | 'physics' | 'lod' | 'draw', ms: number): void {
  frameTimes[phase].sum += ms;
  frameTimes[phase].max = Math.max(frameTimes[phase].max, ms);
}
let previousBuild = terrainView.buildTotals();
let lastLodSample = -Infinity;
/** Finest drawn level containing a body-fixed point. */
function drawnLevelAt(ids: ReadonlySet<string>, p: Vec3): number {
  for (let level = terrainView.lod.options.maxLevel; level >= 0; level -= 1) if (ids.has(tileId(tileContaining(p, level)))) return level;
  return -1;
}
function logLod(selection: ReturnType<TerrainView['update']>): void {
  if (!lodLog) return;
  const ids = new Set(selection.render.map((node) => node.id));
  const parts = (['upper', 'booster'] as const).filter((which) => lander.partMode(which) !== 'destroyed').map((which) => {
    const state = lander.partState(which);
    const r = Math.hypot(state.position.x, state.position.y, state.position.z);
    return { which, mode: lander.partMode(which), altitude: r - terrain.radiusMeters, speed: Math.hypot(state.velocity.x, state.velocity.y, state.velocity.z),
      levelUnder: drawnLevelAt(ids, state.position), position: state.position };
  });
  const context = { frame: selection.frame, simTime: lander.time, rendered: selection.render.length, requests: selection.requests.length,
    queuedBuilds: terrainView.queuedBuilds, cached: terrainView.lod.cachedTileCount, culled: selection.culled.horizon, parts };
  if (selection.balanceCollapses.length > 0) {
    lodLog.write({ event: 'lod-collapse', ...context, collapses: selection.balanceCollapses.length,
      firstCollapses: selection.balanceCollapses.slice(0, 12) });
  }
  for (const part of parts) {
    const before = previousLevelUnder[part.which];
    if (before >= 0 && part.levelUnder <= before - 2) lodLog.write({ event: 'lod-drop', part: part.which, from: before, to: part.levelUnder, ...context });
    previousLevelUnder[part.which] = part.levelUnder;
  }
  const now = performance.now();
  if (now - lastLodSample >= 1000) {
    lastLodSample = now;
    const build = terrainView.buildTotals();
    const built = build.built - previousBuild.built;
    const perTile = (total: 'buildMs' | 'sampleMs' | 'finishMs') => built > 0 ? (build[total] - previousBuild[total]) / built : null;
    const phase = (p: { sum: number; max: number }) => ({ mean: frameTimes.frames > 0 ? p.sum / frameTimes.frames : null, max: p.max });
    lodLog.write({ event: 'lod-sample', ...context,
      perf: { frames: frameTimes.frames, frameMs: phase(frameTimes.frame), physicsMs: phase(frameTimes.physics), lodMs: phase(frameTimes.lod), drawMs: phase(frameTimes.draw),
        workers: build.workers, tilesBuilt: built, tileBuildMs: perTile('buildMs'), tileSampleMs: perTile('sampleMs'), tileFinishMs: perTile('finishMs') } });
    previousBuild = build;
    frameTimes.frames = 0;
    for (const p of [frameTimes.frame, frameTimes.physics, frameTimes.lod, frameTimes.draw]) { p.sum = 0; p.max = 0; }
  }
}
/** Green edges of the terrain triangles each loaded Rapier collider holds, keyed by tile id. */
const colliderTileLines = new Map<string, THREE.LineSegments>();
function uniqueEdges(triangles: Uint32Array): Uint32Array {
  const seen = new Set<string>();
  const edges: number[] = [];
  for (let i = 0; i < triangles.length; i += 3) {
    for (const [a, b] of [[triangles[i]!, triangles[i + 1]!], [triangles[i + 1]!, triangles[i + 2]!], [triangles[i + 2]!, triangles[i]!]] as [number, number][]) {
      const lo = Math.min(a, b), hi = Math.max(a, b);
      const id = `${lo}/${hi}`;
      if (!seen.has(id)) { seen.add(id); edges.push(lo, hi); }
    }
  }
  return new Uint32Array(edges);
}
function syncColliderLines(renderOrigin: Vec3): void {
  const live = new Map<string, TileCollider>();
  for (const world of lander.contactWorlds()) for (const [id, tile] of world.terrainColliders()) live.set(id, tile);
  for (const [id, lines] of colliderTileLines) {
    if (live.has(id)) continue;
    bodyFixedGroup.remove(lines);
    lines.geometry.dispose();
    colliderTileLines.delete(id);
  }
  for (const [id, tile] of live) {
    let lines = colliderTileLines.get(id);
    if (!lines) {
      // The collider's own triangles, relative to the tile origin (its translation in the contact world).
      const indices = tile.collider.indices();
      if (!indices) throw new Error(`main.ts: terrain collider ${id} has no triangle indices`);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(tile.collider.vertices(), 3));
      geometry.setIndex(new THREE.BufferAttribute(uniqueEdges(indices), 1));
      lines = new THREE.LineSegments(geometry, colliderLineMaterial);
      // Over the white mesh edges (1), under the red tile boundaries (2).
      lines.renderOrder = 1.5;
      bodyFixedGroup.add(lines);
      colliderTileLines.set(id, lines);
    }
    lines.position.set(tile.origin.x - renderOrigin.x, tile.origin.y - renderOrigin.y, tile.origin.z - renderOrigin.z);
    lines.visible = colliderLinesInput.checked;
  }
}
let pathLine: THREE.Line | null = null;
/** Body-fixed float64 point the prediction line's float32 vertices are relative to. */
let pathAnchor: Vec3 = { x: 0, y: 0, z: 0 };
function updatePrediction(): void {
  if (lander.clearance() < spec.halfExtents.y) { prediction = null; return; }
  if (lander.time - predictionAt < 2) return;
  predictionAt = lander.time;
  prediction = predictCoast(eph, lander.frame, terrain, options.tolerances, lander.time, lander.bodyFixedState(), lander.massKg, 600);
  if (pathLine) { bodyFixedGroup.remove(pathLine); pathLine.geometry.dispose(); }
  // Relative to a float64 anchor, like the tiles, so float32 vertices stay precise on any planet size.
  const anchor = prediction.points[0]!.position;
  pathAnchor = anchor;
  const points = prediction.points.map((q) => new THREE.Vector3(q.position.x - anchor.x, q.position.y - anchor.y, q.position.z - anchor.z));
  pathLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({ color: 0x59e9ed, depthTest: false }));
  bodyFixedGroup.add(pathLine);
}
let distance = 45;
let azimuth = 0.4;
let elevation = 0.3;
let dragging = false;
let lastX = 0, lastY = 0;
canvas.addEventListener('pointerdown', (e) => { dragging = true; lastX = e.clientX; lastY = e.clientY; canvas.setPointerCapture(e.pointerId); });
canvas.addEventListener('pointerup', () => { dragging = false; });
canvas.addEventListener('pointermove', (e) => { if (!dragging) return; azimuth -= (e.clientX - lastX) * 0.006; elevation = Math.max(-1.3, Math.min(1.3, elevation + (e.clientY - lastY) * 0.006)); lastX = e.clientX; lastY = e.clientY; });
canvas.addEventListener('wheel', (e) => { e.preventDefault(); distance = Math.max(10, Math.min(maxCameraDistance, distance * Math.exp(e.deltaY * 0.001))); }, { passive: false });
let engineArmed = false;
let throttlePercent = Number(throttleInput.value);
function stage(): void {
  if (stageNumber === 0) { stageNumber = 1; engineArmed = true; return; }
  if (stageNumber !== 1) return;
  lander.separate();
  stageNumber = 2;
  engineArmed = true;
  predictionAt = -Infinity;
}
throttleInput.addEventListener('input', () => { throttlePercent = Number(throttleInput.value); });
const keys = new Set<string>();
window.addEventListener('keydown', (e) => {
  if (['Space', 'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'KeyW', 'KeyS', 'KeyA', 'KeyD', 'KeyQ', 'KeyE'].includes(e.code)) e.preventDefault();
  if (e.code === 'Space' && !e.repeat) stage();
  keys.add(e.code);
});
window.addEventListener('keyup', (e) => { keys.delete(e.code); });
window.addEventListener('blur', () => keys.clear());
function axis(positive: string, negative: string): number { return Number(keys.has(positive)) - Number(keys.has(negative)); }
function steer(dt: number): void {
  const throttleDelta = Number(keys.has('ShiftLeft') || keys.has('ShiftRight')) - Number(keys.has('ControlLeft') || keys.has('ControlRight'));
  if (throttleDelta) {
    throttlePercent = Math.max(0, Math.min(100, throttlePercent + throttleDelta * dt * 50));
    throttleInput.value = String(Math.round(throttlePercent));
  }
}
function command(): LanderControl {
  return { throttle: engineArmed ? throttlePercent / 100 : 0, up: 1, prograde: 0,
    turn: { x: axis('KeyS', 'KeyW'), y: axis('KeyE', 'KeyQ'), z: axis('KeyD', 'KeyA') } };
}
document.querySelector('#launch')!.addEventListener('click', stage);
document.querySelector('#cut')!.addEventListener('click', () => { throttlePercent = 0; throttleInput.value = '0'; });
document.querySelector('#reset')!.addEventListener('click', () => { lander.free(); lander = PartJointRocket.landed(RAPIER, eph, terrain, spec, upperSpec, boosterSpec, options, launchSite); stageNumber = 0; throttlePercent = 0; throttleInput.value = '0'; engineArmed = false; predictionAt = -Infinity; prediction = null; paused = false; error.textContent = ''; });
meshLinesInput.addEventListener('change', () => terrainView.tiles.setMeshWireframe(meshLinesInput.checked));
tileBoundariesInput.addEventListener('change', () => terrainView.tiles.setTileBoundaries(tileBoundariesInput.checked));
colliderLinesInput.addEventListener('change', () => {
  upperColliderLines.visible = colliderLinesInput.checked;
  boosterColliderLines.visible = colliderLinesInput.checked;
});
function orientBody(p: Vec3, t: number): THREE.Vector3 {
  if (frameInput.value === 'surface') return new THREE.Vector3(p.x, p.z, -p.y);
  const a = bodyOrientation(lander.frame.body, t);
  return new THREE.Vector3(p.x * a.x.x + p.y * a.y.x + p.z * a.z.x,
    p.x * a.x.z + p.y * a.y.z + p.z * a.z.z,
    -(p.x * a.x.y + p.y * a.y.y + p.z * a.z.y));
}
function renderAttitude(q: { x: number; y: number; z: number; w: number }): THREE.Quaternion {
  const bodyQ = new THREE.Quaternion(q.x, q.y, q.z, q.w);
  const toRender = (v: THREE.Vector3) => new THREE.Vector3(v.x, v.z, -v.y);
  const x = toRender(new THREE.Vector3(1, 0, 0).applyQuaternion(bodyQ));
  const y = toRender(new THREE.Vector3(0, 1, 0).applyQuaternion(bodyQ));
  const z = toRender(new THREE.Vector3(0, 0, 1).applyQuaternion(bodyQ));
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}
function render(): void {
  const state = lander.bodyFixedState();
  // Keep the camera origin on the upper stage before and after separation.
  const p = lander.partState('upper').position;
  const origin = orientBody(p, lander.time);
  const x = orientBody({ x: 1, y: 0, z: 0 }, lander.time);
  const y = orientBody({ x: 0, y: 0, z: 1 }, lander.time);
  const z = orientBody({ x: 0, y: -1, z: 0 }, lander.time);
  const m = new THREE.Matrix4().makeBasis(x, y, z);
  worldGroup.quaternion.setFromRotationMatrix(m);
  worldGroup.position.copy(origin).multiplyScalar(-1);
  bodyFixedGroup.quaternion.copy(worldGroup.quaternion).multiply(bodyToRender);
  const up = origin.clone().normalize();
  let east = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), up).normalize();
  if (east.lengthSq() < 0.01) east = new THREE.Vector3(1, 0, 0);
  const north = new THREE.Vector3().crossVectors(up, east).normalize();
  camera.up.copy(up);
  camera.position.copy(up).multiplyScalar(Math.sin(elevation) * distance).addScaledVector(east, Math.cos(elevation) * Math.cos(azimuth) * distance).addScaledVector(north, Math.cos(elevation) * Math.sin(azimuth) * distance);
  camera.lookAt(0, 0, 0);
  camera.near = Math.max(0.1, distance * 0.001); camera.far = distance + 3 * terrain.radiusMeters; camera.updateProjectionMatrix();
  for (const [which, mesh] of [['upper', upperVisual], ['booster', boosterGroup]] as const) {
    const part = lander.partState(which);
    mesh.visible = lander.partMode(which) !== 'destroyed';
    mesh.position.copy(orientBody(part.position, lander.time)).sub(origin);
    mesh.quaternion.copy(worldGroup.quaternion).multiply(renderAttitude(lander.partOrientation(which)));
  }
  // A booster lost while attached leaves the upper stage flying on its own.
  if (stageNumber === 1 && lander.separated) stageNumber = 2;
  const firing = !paused && engineArmed && lander.fuelKg > 0 ? throttlePercent / 100 : 0;
  for (const [engine, active] of [[boosterEngine, stageNumber === 1], [upperEngine, stageNumber === 2]] as const) {
    engine.plume.visible = active && firing > 0;
    engine.plume.scale.y = 0.55 + firing * (0.8 + 0.04 * Math.sin(lander.time * 40));
    engine.light.intensity = active ? firing * 8 : 0;
  }
  // Terrain is finest around every live part; tiles are placed relative to the upper stage, the scene origin.
  const observers = (['upper', 'booster'] as const).filter((which) => lander.partMode(which) !== 'destroyed')
    .map((which) => lander.partState(which).position);
  const lodStarted = performance.now();
  const selection = terrainView.update(observers, p);
  timePhase('lod', performance.now() - lodStarted);
  logLod(selection);
  syncColliderLines(p);
  updatePrediction();
  if (pathLine) {
    pathLine.visible = prediction !== null;
    pathLine.position.set(pathAnchor.x - p.x, pathAnchor.y - p.y, pathAnchor.z - p.z);
  }
  const groundSpeed = Math.hypot(state.velocity.x, state.velocity.y, state.velocity.z);
  const eta = prediction?.impact ? `${Math.max(0, prediction.impact.time - lander.time).toFixed(0)} s` : '—';
  readout.innerHTML = `<div><span>Stage</span><b>${stageNumber === 0 ? 'Ready · booster' : stageNumber === 1 ? 'Booster' : 'Upper stage'}</b></div><div><span>Mode</span><b>${lander.mode}${lander.partMode('booster') === 'destroyed' ? ' · booster lost' : ''}</b></div><div><span>Time</span><b>${lander.time.toFixed(1)} s</b></div><div><span>Height AGL</span><b>${Math.max(0, lander.clearance() - lander.spec.halfExtents.y).toFixed(1)} m</b></div><div><span>Ground speed</span><b>${groundSpeed.toFixed(1)} m/s</b></div><div><span>Fuel</span><b>${lander.fuelKg.toFixed(1)} kg</b></div><div><span>Coast impact</span><b>${eta}</b></div>`;
  throttleValue.textContent = `${throttleInput.value}%${engineArmed ? (throttlePercent > 0 && lander.fuelKg > 0 ? ' · firing' : ' · staged') : ' · unlit'}`;
  (document.querySelector('#launch') as HTMLButtonElement).disabled = stageNumber === 2;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.floor(w * renderer.getPixelRatio()) || canvas.height !== Math.floor(h * renderer.getPixelRatio())) { renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); }
  const drawStarted = performance.now();
  renderer.render(scene, camera);
  timePhase('draw', performance.now() - drawStarted);
}
let last = performance.now();
function loop(now: number): void {
  requestAnimationFrame(loop);
  timePhase('frame', now - last);
  frameTimes.frames += 1;
  const wall = Math.max(0, Math.min(0.05, (now - last) / 1000)); last = now;
  if (!paused) {
    try {
      steer(wall);
      const physicsStarted = performance.now();
      lander.advance(wall * Number(rateInput.value), command());
      timePhase('physics', performance.now() - physicsStarted);
    } catch (e) { paused = true; error.textContent = `Simulation paused: ${e instanceof Error ? e.message : String(e)}`; engineArmed = false; }
  }
  render();
}
void renderer.init().then(() => {
  if (!('isWebGLBackend' in renderer.backend) || renderer.backend.isWebGLBackend !== true) {
    throw new Error(`main.ts: expected the WebGL2 backend; actual backend=${renderer.backend.constructor.name}`);
  }
  requestAnimationFrame(loop);
}).catch((e: unknown) => { error.textContent = `Renderer failed: ${e instanceof Error ? e.message : String(e)}`; });
