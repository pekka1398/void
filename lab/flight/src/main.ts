import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three/webgpu';
import { bodyOrientation, DominanceTree, normalize, osculatingOrbit, spinAxis, sub, type CelestialBody, type Vec3 } from './orbitCore';
import {
  demoRocket, LabLog, PartJointRocket, PLANETS, planetById, planetEphemeris, predictCoast, RocketVisual, TerrainColliderLines, TerrainView,
  type CoastPrediction, type LanderControl, type RocketPart,
} from './landingCore';
import { MapLayer, OrbitCamera, toThree, viewState, type Focus, type FocusGeometry, type ViewState } from './viewCore';
import { bodyFixedToRender, quatMultiply } from './FlightFrame';
import './style.css';

const PARTS: readonly RocketPart[] = ['upper', 'booster'];
/** The coast forecast is recomputed this often in simulated time, and at every staging. */
const PREDICTION_INTERVAL_SECONDS = 2;
/** Long enough for one low orbit; a suborbital coast ends at the ground first. */
const PREDICTION_HORIZON_SECONDS = 6000;
const THROTTLE_RATE_PERCENT_PER_SECOND = 50;

const app = document.querySelector<HTMLDivElement>('#app');
const overlay = document.querySelector<HTMLDivElement>('#overlay');
if (!app || !overlay) throw new Error('flight lab: #app or #overlay missing');

let stopped = false;
function panic(error: unknown): never {
  const failure = error instanceof Error ? error : new Error(`Non-Error thrown: ${String(error)}`);
  if (stopped) throw failure;
  stopped = true;
  const chain: string[] = [];
  let current: unknown = failure;
  while (current instanceof Error) {
    chain.push(current.stack ?? `${current.name}: ${current.message}`);
    current = current.cause;
  }
  const message = document.createElement('pre');
  message.className = 'panic';
  message.textContent = `FLIGHT LAB PANIC\n${chain.join('\nCaused by:\n')}`;
  document.body.append(message);
  throw failure;
}
window.addEventListener('error', (e) => panic(e.error));
window.addEventListener('unhandledrejection', (e) => panic(e.reason));

// ?planet=<id> picks the planet (default Aurelia in the full solar system); changing it reloads the page.
const planetId = new URLSearchParams(window.location.search).get('planet') ?? 'aurelia';
const planet = planetById(planetId);
const terrain = planet.terrain;
const { ephemeris: eph, bodyIndex } = planetEphemeris(planet);
const bodies = eph.bodies;
const home = bodies[bodyIndex]!;
const dominance = new DominanceTree(bodies);
const rocket = demoRocket(terrain);
await RAPIER.init();
const launch = () => PartJointRocket.landed(RAPIER, eph, bodyIndex, terrain, rocket.full, rocket.upper, rocket.booster, rocket.options, rocket.launchSite);
let lander = launch();
let stageNumber = 0;
let engineArmed = false;
let throttlePercent = 0;
let paused = false;
let prediction: CoastPrediction | null = null;
let predictionAt = -Infinity;
let predictionGeneration = 0;

const panel = document.createElement('aside');
panel.className = 'panel';
panel.innerHTML = `<div class="title">FLIGHT LAB <small>landing + orbit + single view</small></div>
<div class="help" id="badge"></div>
<label>Planet<select id="planet">${Object.keys(PLANETS).map((id) => `<option value="${id}">${id}</option>`).join('')}</select></label>
<label>Time rate<select id="rate"><option value="1">1×</option><option value="5">5×</option><option value="20">20×</option></select></label>
<label class="check"><input id="wire" type="checkbox"> Mesh edges (white)</label>
<label class="check"><input id="bounds" type="checkbox"> Tile boundaries (red)</label>
<label class="check"><input id="colliders" type="checkbox"> Colliders: terrain and rocket (green)</label>
<pre class="status" id="status"></pre><pre id="readout"></pre>
<div class="help"><kbd>Space</kbd> ignite booster, then separate and ignite the upper stage · <kbd>Shift</kbd>/<kbd>Ctrl</kbd> throttle · <kbd>X</kbd> cut<br>
<kbd>W</kbd>/<kbd>S</kbd> pitch · <kbd>A</kbd>/<kbd>D</kbd> yaw · <kbd>Q</kbd>/<kbd>E</kbd> roll · <kbd>P</kbd> pause · <kbd>R</kbd> reset<br>
Drag: orbit camera · wheel: zoom out into the map · <kbd>Tab</kbd> or a label: focus</div>`;
document.body.append(panel);
const planetInput = panel.querySelector<HTMLSelectElement>('#planet')!;
const rateInput = panel.querySelector<HTMLSelectElement>('#rate')!;
const wireInput = panel.querySelector<HTMLInputElement>('#wire')!;
const boundsInput = panel.querySelector<HTMLInputElement>('#bounds')!;
const collidersInput = panel.querySelector<HTMLInputElement>('#colliders')!;
const statusText = panel.querySelector<HTMLElement>('#status')!;
const readoutText = panel.querySelector<HTMLElement>('#readout')!;
panel.querySelector<HTMLElement>('#badge')!.textContent = planet.label;
planetInput.value = planetId;
planetInput.addEventListener('change', () => {
  const next = new URL(window.location.href);
  next.searchParams.set('planet', planetInput.value);
  window.location.assign(next.href);
});

// WebGPU renderer on its WebGL2 backend, as lab/lod, lab/landing and lab/view use, for lab/lod's node-material tiles.
const renderer = new THREE.WebGPURenderer({ antialias: true, forceWebGL: true, logarithmicDepthBuffer: true });
if (!(window.devicePixelRatio > 0)) throw new Error(`invalid devicePixelRatio ${window.devicePixelRatio}`);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(0x03040a);
app.append(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(58, 1, 1, 2);
// Enough ambient light to fly on the night side.
scene.add(new THREE.AmbientLight(0xcbe7ff, 0.35));
const sunLight = new THREE.DirectionalLight(0xfff0dc, 3);
scene.add(sunLight);

// Tiles and rocket attitudes come in the planet's body-fixed axes; this group turns tiles into the inertial scene.
const bodyFixedGroup = new THREE.Group();
scene.add(bodyFixedGroup);
const terrainView = new TerrainView(terrain, planet.terrainConfig, rocket.options.contact, Math.max(1, navigator.hardwareConcurrency - 1), (e) => panic(e));
bodyFixedGroup.add(terrainView.tiles.group);
terrainView.tiles.setMeshWireframe(wireInput.checked);
terrainView.tiles.setTileBoundaries(boundsInput.checked);
wireInput.addEventListener('change', () => terrainView.tiles.setMeshWireframe(wireInput.checked));
boundsInput.addEventListener('change', () => terrainView.tiles.setTileBoundaries(boundsInput.checked));

const visual = new RocketVisual(rocket.upperShape, rocket.boosterShape);
const colliderLines = new TerrainColliderLines();
bodyFixedGroup.add(colliderLines.group);
const showColliders = () => { visual.setColliderLines(collidersInput.checked); colliderLines.setVisible(collidersInput.checked); };
showColliders();
collidersInput.addEventListener('change', showColliders);
scene.add(visual.upper, visual.booster);
const partMeshes: Record<RocketPart, THREE.Group> = { upper: visual.upper, booster: visual.booster };

let focus: Focus = { kind: 'vessel' };
const map = new MapLayer(scene, overlay, eph, [bodyIndex], (picked) => setFocus(picked));
// Start looking at the rocket from the side, a little above the horizon.
const startRadial = normalize(sub(lander.frame.toInertial(0, lander.partState('upper')).position, eph.bodyPosition(bodyIndex, 0)));
const startSide = normalize({ x: -startRadial.y, y: startRadial.x, z: 0 });
const orbitCamera = new OrbitCamera(normalize({ x: startSide.x + 0.3 * startRadial.x, y: startSide.y + 0.3 * startRadial.y, z: startSide.z + 0.3 * startRadial.z }), 45);
let state: ViewState | null = null;

const bodyPositions = new Float64Array(eph.bodyCount * 3);
const bodyVelocities = new Float64Array(eph.bodyCount * 3);
const bodyPosition = (i: number): Vec3 => ({ x: bodyPositions[i * 3]!, y: bodyPositions[i * 3 + 1]!, z: bodyPositions[i * 3 + 2]! });
const bodyVelocity = (i: number): Vec3 => ({ x: bodyVelocities[i * 3]!, y: bodyVelocities[i * 3 + 1]!, z: bodyVelocities[i * 3 + 2]! });

const log = import.meta.env.DEV ? new LabLog('flight', (e) => panic(e)) : null;
log?.write({ event: 'session', planet: planetId, lod: terrainView.lod.options });

function focusName(f: Focus): string {
  return f.kind === 'vessel' ? 'vessel' : bodies[f.index]!.name;
}

function setFocus(next: Focus): void {
  focus = next;
  orbitCamera.distance = next.kind === 'vessel' ? 45 : bodies[next.index]!.radiusMeters * 4;
  log?.write({ event: 'focus', focus: focusName(next), distance: orbitCamera.distance, simTime: lander.time });
}

function stage(): void {
  if (stageNumber === 0) { stageNumber = 1; engineArmed = true; return; }
  if (stageNumber !== 1) return;
  lander.separate();
  stageNumber = 2;
  engineArmed = true;
  predictionAt = -Infinity;
}

function reset(): void {
  lander.free();
  lander = launch();
  stageNumber = 0; engineArmed = false; throttlePercent = 0; paused = false;
  prediction = null; predictionAt = -Infinity; predictionGeneration += 1;
  focus = { kind: 'vessel' };
  orbitCamera.distance = 45;
  log?.write({ event: 'reset' });
}

const keys = new Set<string>();
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  if (['Space', 'Tab', 'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'KeyW', 'KeyS', 'KeyA', 'KeyD', 'KeyQ', 'KeyE'].includes(e.code)) e.preventDefault();
  keys.add(e.code);
  if (e.repeat) return;
  if (e.code === 'Space') stage();
  else if (e.code === 'KeyX') throttlePercent = 0;
  else if (e.code === 'KeyP') paused = !paused;
  else if (e.code === 'KeyR') reset();
  else if (e.code === 'Tab') {
    const order: Focus[] = [{ kind: 'vessel' }, ...bodies.map((b): Focus => ({ kind: 'body', index: b.index }))];
    const current = order.findIndex((f) => f.kind === focus.kind && (f.kind === 'vessel' || (focus.kind === 'body' && f.index === focus.index)));
    setFocus(order[(current + (e.shiftKey ? order.length - 1 : 1)) % order.length]!);
  }
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());
const axis = (positive: string, negative: string) => Number(keys.has(positive)) - Number(keys.has(negative));
function command(): LanderControl {
  return { throttle: engineArmed ? throttlePercent / 100 : 0, up: 1, prograde: 0,
    turn: { x: axis('KeyS', 'KeyW'), y: axis('KeyE', 'KeyQ'), z: axis('KeyD', 'KeyA') } };
}

const canvas = renderer.domElement;
let dragging: { x: number; y: number } | null = null;
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => { canvas.setPointerCapture(e.pointerId); dragging = { x: e.clientX, y: e.clientY }; });
canvas.addEventListener('pointermove', (e) => {
  if (!dragging || !state) return;
  orbitCamera.drag(e.clientX - dragging.x, e.clientY - dragging.y, state.up);
  dragging = { x: e.clientX, y: e.clientY };
});
const endDrag = (e: PointerEvent) => { if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId); dragging = null; };
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (!state) return;
  orbitCamera.zoom(Math.exp(e.deltaY * 0.0012), state.minDistance, state.maxDistance);
}, { passive: false });

function resize(): void {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
}
window.addEventListener('resize', resize);
resize();

const liveParts = () => PARTS.filter((which) => lander.partMode(which) !== 'destroyed');

/** Barycentric inertial state of a part now. */
function partInertial(which: RocketPart): { position: Vec3; velocity: Vec3 } {
  return lander.frame.toInertial(lander.time, lander.partState(which));
}

function updatePrediction(): void {
  if (lander.clearance() < lander.spec.halfExtents.y) { prediction = null; return; }
  if (lander.time - predictionAt < PREDICTION_INTERVAL_SECONDS) return;
  predictionAt = lander.time;
  prediction = predictCoast(eph, lander.frame, terrain, rocket.options.tolerances, lander.time, lander.bodyFixedState(), lander.massKg, PREDICTION_HORIZON_SECONDS);
  predictionGeneration += 1;
}

function focusGeometry(vessel: Vec3): { geometry: FocusGeometry; position: Vec3; reference: CelestialBody } {
  if (focus.kind === 'vessel') {
    const reference = bodies[dominance.dominant(bodyPositions, vessel)]!;
    const fromCentre = sub(vessel, bodyPosition(reference.index));
    const r = Math.hypot(fromCentre.x, fromCentre.y, fromCentre.z);
    return { position: vessel, reference, geometry: { kind: 'vessel', radial: normalize(fromCentre), north: spinAxis(reference),
      referenceRadius: reference.radiusMeters, altitude: r - reference.radiusMeters, focusRadius: 0 } };
  }
  const body = bodies[focus.index]!;
  return { position: bodyPosition(body.index), reference: body, geometry: { kind: 'body', radial: null, north: spinAxis(body),
    referenceRadius: body.radiusMeters, altitude: 0, focusRadius: body.radiusMeters } };
}

/** Main-thread timings since the last flight-sample, ms. */
const timings = { frames: 0, frame: { sum: 0, max: 0 }, physics: { sum: 0, max: 0 }, lod: { sum: 0, max: 0 }, draw: { sum: 0, max: 0 } };
function timePhase(phase: 'frame' | 'physics' | 'lod' | 'draw', ms: number): void {
  timings[phase].sum += ms;
  timings[phase].max = Math.max(timings[phase].max, ms);
}
let lastSample = -Infinity;
let lastReadout = -Infinity;
let last = performance.now();
document.addEventListener('visibilitychange', () => { if (!document.hidden) last = performance.now(); });

function frameLoop(nowMs: number): void {
  if (stopped) return;
  try {
    timePhase('frame', nowMs - last);
    timings.frames += 1;
    // At most 50 ms of wall time per frame, as the landing lab: a stalled frame does not become a physics leap.
    const wall = Math.max(0, Math.min(0.05, (nowMs - last) / 1000));
    last = nowMs;
    const throttleDelta = Number(keys.has('ShiftLeft') || keys.has('ShiftRight')) - Number(keys.has('ControlLeft') || keys.has('ControlRight'));
    if (throttleDelta) throttlePercent = Math.max(0, Math.min(100, throttlePercent + throttleDelta * wall * THROTTLE_RATE_PERCENT_PER_SECOND));
    const before = lander.time;
    if (!paused) {
      const physicsStarted = performance.now();
      lander.advance(wall * Number(rateInput.value), command());
      timePhase('physics', performance.now() - physicsStarted);
    }
    // A booster lost while attached leaves the upper stage flying on its own.
    if (stageNumber === 1 && lander.separated) stageNumber = 2;
    const t = lander.time;
    eph.statesAt(t, bodyPositions, bodyVelocities);
    updatePrediction();

    const upper = partInertial('upper');
    const { geometry, position: origin, reference } = focusGeometry(upper.position);
    state = viewState('single', false, geometry, orbitCamera.distance);
    orbitCamera.distance = orbitCamera.clampDistance(orbitCamera.distance, state.minDistance, state.maxDistance);
    if (state.corotation > 0 && t > before) {
      orbitCamera.corotate(geometry.north, ((2 * Math.PI) / reference.rotation.periodSeconds) * (t - before) * state.corotation);
    }
    orbitCamera.clampToUp(state.up);
    const cameraOffset = { x: orbitCamera.direction.x * orbitCamera.distance, y: orbitCamera.direction.y * orbitCamera.distance, z: orbitCamera.direction.z * orbitCamera.distance };
    toThree(cameraOffset, camera.position);
    toThree(state.up, camera.up);
    camera.lookAt(0, 0, 0);
    camera.near = Math.max(0.05, orbitCamera.distance * 1e-3);
    camera.far = 1e14;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    toThree(normalize(sub(bodyPosition(map.starIndex), origin)), sunLight.position);

    const axes = bodyOrientation(home, t);
    const toRender = bodyFixedToRender(axes);
    bodyFixedGroup.quaternion.set(toRender.x, toRender.y, toRender.z, toRender.w);
    // lab/lod's observers: every live part (the probe) and the camera. Tiles are placed relative to the render origin.
    const cameraPosition = { x: origin.x + cameraOffset.x, y: origin.y + cameraOffset.y, z: origin.z + cameraOffset.z };
    const bodyFixed = (p: Vec3) => lander.frame.toBodyFixed(t, { position: p, velocity: { x: 0, y: 0, z: 0 } }).position;
    const observers = liveParts().map((which) => lander.partState(which).position);
    observers.push(bodyFixed(cameraPosition));
    const lodStarted = performance.now();
    const renderOrigin = bodyFixed(origin);
    const selection = terrainView.update(observers, renderOrigin);
    colliderLines.sync(lander.contactWorlds(), renderOrigin);
    timePhase('lod', performance.now() - lodStarted);

    for (const which of PARTS) {
      const mesh = partMeshes[which];
      mesh.visible = lander.partMode(which) !== 'destroyed';
      toThree(sub(partInertial(which).position, origin), mesh.position);
      const q = quatMultiply(toRender, lander.partOrientation(which));
      mesh.quaternion.set(q.x, q.y, q.z, q.w);
    }
    const firing = !paused && engineArmed && lander.fuelKg > 0 ? throttlePercent / 100 : 0;
    RocketVisual.fire(visual.boosterEngine, stageNumber === 1, firing, t);
    RocketVisual.fire(visual.upperEngine, stageNumber === 2, firing, t);

    const navigation = dominance.dominant(bodyPositions, upper.position);
    map.update({ time: t, bodyPositions, bodyVelocities, origin, vessel: upper.position, vesselVelocity: upper.velocity,
      path: prediction ? { trajectory: prediction.trajectory, generation: predictionGeneration, reference: navigation } : null,
      mapWeight: state.mapWeight, focus, camera, width: window.innerWidth, height: window.innerHeight });

    const drawStarted = performance.now();
    renderer.render(scene, camera);
    timePhase('draw', performance.now() - drawStarted);

    if (nowMs - lastReadout > 100) {
      lastReadout = nowMs;
      updateText(upper, navigation, reference, selection.render.length);
    }
    if (log && nowMs - lastSample >= 1000) {
      lastSample = nowMs;
      const phase = (p: { sum: number; max: number }) => ({ mean: timings.frames > 0 ? p.sum / timings.frames : null, max: p.max });
      log.write({ event: 'flight-sample', simTime: t, mode: lander.mode, stage: stageNumber, focus: focusName(focus), distance: orbitCamera.distance,
        mapWeight: state.mapWeight, corotation: state.corotation, altitude: geometry.kind === 'vessel' ? geometry.altitude : null,
        tiles: selection.render.length, culled: selection.culled.horizon, requests: selection.requests.length, queued: terrainView.queuedBuilds,
        perf: { frames: timings.frames, frameMs: phase(timings.frame), physicsMs: phase(timings.physics), lodMs: phase(timings.lod), drawMs: phase(timings.draw) } });
      timings.frames = 0;
      for (const p of [timings.frame, timings.physics, timings.lod, timings.draw]) { p.sum = 0; p.max = 0; }
    }
  } catch (error) {
    panic(error);
  }
  requestAnimationFrame(frameLoop);
}

function formatDistance(m: number): string {
  const a = Math.abs(m);
  if (a >= 1e9) return `${(m / 1e9).toFixed(3)} Gm`;
  if (a >= 1e4) return `${(m / 1e3).toFixed(1)} km`;
  return `${m.toFixed(1)} m`;
}

function updateText(upper: { position: Vec3; velocity: Vec3 }, navigation: number, reference: CelestialBody, tiles: number): void {
  if (!state) throw new Error('updateText before the first view state');
  const ground = lander.bodyFixedState().velocity;
  const body = bodies[navigation]!;
  const r = sub(upper.position, bodyPosition(navigation));
  const v = sub(upper.velocity, bodyVelocity(navigation));
  const osc = osculatingOrbit(r, v, body.gm);
  const stageText = stageNumber === 0 ? 'ready · booster' : stageNumber === 1 ? 'booster' : 'upper stage';
  statusText.textContent = `T+ ${lander.time.toFixed(1)} s   ${rateInput.value}×${paused ? '  PAUSED' : ''}\n${stageText} · ${lander.mode}${lander.partMode('booster') === 'destroyed' ? ' · booster lost' : ''}`;
  readoutText.textContent = [
    `throttle   ${throttlePercent.toFixed(0)}%${engineArmed ? (throttlePercent > 0 && lander.fuelKg > 0 ? ' firing' : ' staged') : ' unlit'} · fuel ${lander.fuelKg.toFixed(0)} kg`,
    `height AGL ${formatDistance(Math.max(0, lander.clearance() - lander.spec.halfExtents.y))}`,
    `ground spd ${Math.hypot(ground.x, ground.y, ground.z).toFixed(1)} m/s`,
    `orbit spd  ${Math.hypot(v.x, v.y, v.z).toFixed(1)} m/s about ${body.name}`,
    `Pe / Ap    ${formatDistance(osc.periapsisRadiusMeters - body.radiusMeters)} / ${Number.isFinite(osc.apoapsisRadiusMeters) ? formatDistance(osc.apoapsisRadiusMeters - body.radiusMeters) : 'escape'}`,
    `impact     ${prediction?.impact ? `in ${Math.max(0, prediction.impact.time - lander.time).toFixed(0)} s` : '—'}`,
    '',
    `focus      ${focusName(focus)}${focus.kind === 'vessel' ? ` (reference ${reference.name})` : ''}`,
    `camera     ${formatDistance(orbitCamera.distance)} · map ${(state.mapWeight * 100).toFixed(0)}% · co-rotate ${(state.corotation * 100).toFixed(0)}%`,
    `tiles      ${tiles} drawn, ${terrainView.queuedBuilds} building`,
  ].join('\n');
}

void renderer.init().then(() => {
  if (!('isWebGLBackend' in renderer.backend) || renderer.backend.isWebGLBackend !== true) {
    throw new Error(`flight lab: expected the WebGL2 backend; actual backend=${renderer.backend.constructor.name}`);
  }
  requestAnimationFrame(frameLoop);
});
