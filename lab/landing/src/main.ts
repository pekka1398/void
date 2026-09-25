import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three/webgpu';
import { bodyOrientation, type Vec3 } from './orbitCore';
import { PLANETS, planetById, planetEphemeris } from './planet/Planets';
import { demoRocket } from './vessel/DemoRocket';
import { RocketVisual } from './render/RocketVisual';
import { TerrainColliderLines } from './render/TerrainColliderLines';
import { TerrainView } from './terrain/TerrainView';
import { LabLog } from './debug/LabLog';
import { tileContaining, tileId } from './lodCore';
import { predictCoast, type CoastPrediction } from './vessel/CoastPrediction';
import { type LanderControl } from './vessel/Lander';
import { PartJointRocket } from './vessel/PartJointRocket';
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
const { ephemeris: eph, bodyIndex } = planetEphemeris(planet);
const rocket = demoRocket(terrain);
const { full: spec, upper: upperSpec, booster: boosterSpec, options, launchSite } = rocket;
await RAPIER.init();
let lander = PartJointRocket.landed(RAPIER, eph, bodyIndex, terrain, spec, upperSpec, boosterSpec, options, launchSite);
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
const visual = new RocketVisual(rocket.upperShape, rocket.boosterShape);
const upperVisual = visual.upper;
const boosterGroup = visual.booster;
scene.add(upperVisual, boosterGroup);
// Tiles come in body-fixed axes; this group turns them into the rendered frame (x, z, -y) and the camera frame.
const bodyFixedGroup = new THREE.Group();
scene.add(bodyFixedGroup);
const bodyToRender = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
// One tile worker per core, leaving one for the page's own thread.
const terrainView = new TerrainView(terrain, planet.terrainConfig, options.contact, Math.max(1, navigator.hardwareConcurrency - 1), (e) => {
  paused = true; engineArmed = false; error.textContent = `Terrain failed: ${e.message}`;
});
bodyFixedGroup.add(terrainView.tiles.group);
const colliderLines = new TerrainColliderLines();
colliderLines.setVisible(colliderLinesInput.checked);
bodyFixedGroup.add(colliderLines.group);
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
document.querySelector('#reset')!.addEventListener('click', () => { lander.free(); lander = PartJointRocket.landed(RAPIER, eph, bodyIndex, terrain, spec, upperSpec, boosterSpec, options, launchSite); stageNumber = 0; throttlePercent = 0; throttleInput.value = '0'; engineArmed = false; predictionAt = -Infinity; prediction = null; paused = false; error.textContent = ''; });
meshLinesInput.addEventListener('change', () => terrainView.tiles.setMeshWireframe(meshLinesInput.checked));
tileBoundariesInput.addEventListener('change', () => terrainView.tiles.setTileBoundaries(tileBoundariesInput.checked));
colliderLinesInput.addEventListener('change', () => { visual.setColliderLines(colliderLinesInput.checked); colliderLines.setVisible(colliderLinesInput.checked); });
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
  RocketVisual.fire(visual.boosterEngine, stageNumber === 1, firing, lander.time);
  RocketVisual.fire(visual.upperEngine, stageNumber === 2, firing, lander.time);
  // Terrain is finest around every live part; tiles are placed relative to the upper stage, the scene origin.
  const observers = (['upper', 'booster'] as const).filter((which) => lander.partMode(which) !== 'destroyed')
    .map((which) => lander.partState(which).position);
  const lodStarted = performance.now();
  const selection = terrainView.update(observers, p);
  timePhase('lod', performance.now() - lodStarted);
  logLod(selection);
  colliderLines.sync(lander.contactWorlds(), p);
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
