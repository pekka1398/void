import * as THREE from 'three/webgpu';
import {
  bodyOrientation, normalize, osculatingOrbit, Simulation, spinAxis, sub, SYSTEM_PRESETS,
  type AttitudeMode, type CelestialBody, type Vec3,
} from './orbitCore';
import { LabLog, levelForTileSize, terrainFromConfig, TerrainView, type ContactWorldOptions, type TerrainConfig } from './planetCore';
import { MapLayer, toThree, type Focus } from './MapLayer';
import { OrbitCamera, viewState, type FocusGeometry, type ViewMode, type ViewState } from './ViewCamera';
import './style.css';

const HOME_BODY = 'aurelia';
const WARPS = [1, 10, 100, 1e3, 1e4, 1e5] as const;
const MAX_VESSEL_STEPS_PER_FRAME = 20_000;
const MAX_PREDICTION_STEPS_PER_FRAME = 4_000;
const THROTTLE_RATE_PER_SECOND = 0.5;
const ATTITUDE_KEYS: Record<string, AttitudeMode> = {
  Digit1: 'prograde', Digit2: 'retrograde', Digit3: 'normal', Digit4: 'antinormal',
  Digit5: 'radial-out', Digit6: 'radial-in', Digit7: 'hold',
};

const app = document.querySelector<HTMLDivElement>('#app');
const overlay = document.querySelector<HTMLDivElement>('#overlay');
if (!app || !overlay) throw new Error('view lab: #app or #overlay missing');

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
  message.textContent = `VIEW LAB PANIC\n${chain.join('\nCaused by:\n')}`;
  document.body.append(message);
  throw failure;
}
window.addEventListener('error', (e) => panic(e.error));
window.addEventListener('unhandledrejection', (e) => panic(e.reason));

// ?view=single|split picks the trade-off under test; ?altitude=<km> the vessel's start orbit.
const params = new URLSearchParams(window.location.search);
const viewParam = params.get('view') ?? 'single';
if (viewParam !== 'single' && viewParam !== 'split') throw new RangeError(`?view must be single or split, got ${JSON.stringify(viewParam)}`);
const mode: ViewMode = viewParam;
const altitudeKm = Number(params.get('altitude') ?? '100');
if (!(altitudeKm > 0)) throw new RangeError(`?altitude must be a positive number of km, got ${JSON.stringify(params.get('altitude'))}`);

const sim = new Simulation({
  system: SYSTEM_PRESETS.sol,
  stepsPerOrbit: 256,
  tolerances: { positionMeters: 1e-4, velocityMetersPerSecond: 1e-7 },
  vesselStart: { homeBodyId: HOME_BODY, altitudeMeters: altitudeKm * 1000, plane: { kind: 'equatorial', inclinationRadians: 0 } },
  // The orbit lab's chemical stage: 250 kN, Isp 350 s, 10 t dry + 30 t propellant.
  engine: { thrustNewtons: 250e3, specificImpulseSeconds: 350, dryMassKg: 10e3, fuelMassKg: 30e3 },
  retentionSeconds: 86_400,
  predictionHorizonSeconds: 3 * 3600,
  planCoastSeconds: 86_400,
});
const bodies = sim.system.bodies;
const home = bodies[sim.bodyIndex(HOME_BODY)]!;
const eph = sim.ephemeris;
const bodyPositions = new Float64Array(eph.bodyCount * 3);
const bodyVelocities = new Float64Array(eph.bodyCount * 3);
const bodyPosition = (i: number): Vec3 => ({ x: bodyPositions[i * 3]!, y: bodyPositions[i * 3 + 1]!, z: bodyPositions[i * 3 + 2]! });
const bodyVelocity = (i: number): Vec3 => ({ x: bodyVelocities[i * 3]!, y: bodyVelocities[i * 3 + 1]!, z: bodyVelocities[i * 3 + 2]! });

// The home planet is the landing lab's terrain (Earth-size hills, as its terra planet) streamed by lab/lod.
const terrainConfig: TerrainConfig = { kind: 'hills', options: { name: `${home.name} hills`, radiusMeters: home.radiusMeters,
  maxHeightMeters: 8000, wavelengthMeters: 40_000, octaves: 8 } };
const terrain = terrainFromConfig(terrainConfig);
// The landing lab's tile options, so LOD levels near the vessel match the collision level there.
const contact: ContactWorldOptions = { stepSeconds: 1 / 60, tileLevel: levelForTileSize(home.radiusMeters, 300), tileResolution: 33,
  tileReachMeters: 300, tileKeepMeters: 600, recenterMeters: 1000 };

const panel = document.createElement('aside');
panel.className = 'panel';
panel.innerHTML = `<div class="title">VIEW LAB <small>one view or two</small></div>
<label>View<select id="mode"><option value="single">single: zoom out into the map</option><option value="split">split: M switches flight / map</option></select></label>
<label class="check"><input id="wire" type="checkbox"> Mesh edges (white)</label>
<label class="check"><input id="bounds" type="checkbox"> Tile boundaries (red)</label>
<pre class="status" id="status"></pre><pre id="readout"></pre>
<div class="help">Drag: orbit camera · wheel: zoom · <kbd>Tab</kbd> focus${mode === 'split' ? ' (map only)' : ''} · click a label to focus<br>
${mode === 'split' ? '<kbd>M</kbd> flight / map · ' : ''}<kbd>Space</kbd> pause · <kbd>,</kbd> <kbd>.</kbd> warp<br>
<kbd>Shift</kbd>/<kbd>Ctrl</kbd> throttle · <kbd>Z</kbd> full · <kbd>X</kbd> cut · <kbd>1</kbd>–<kbd>7</kbd> attitude</div>`;
document.body.append(panel);
const modeInput = panel.querySelector<HTMLSelectElement>('#mode')!;
const wireInput = panel.querySelector<HTMLInputElement>('#wire')!;
const boundsInput = panel.querySelector<HTMLInputElement>('#bounds')!;
const statusText = panel.querySelector<HTMLElement>('#status')!;
const readoutText = panel.querySelector<HTMLElement>('#readout')!;
modeInput.value = mode;
modeInput.addEventListener('change', () => {
  const next = new URL(window.location.href);
  next.searchParams.set('view', modeInput.value);
  window.location.assign(next.href);
});

// WebGPU renderer on its WebGL2 backend, as lab/lod and lab/landing use, for lab/lod's node-material tiles.
const renderer = new THREE.WebGPURenderer({ antialias: true, forceWebGL: true, logarithmicDepthBuffer: true });
if (!(window.devicePixelRatio > 0)) throw new Error(`invalid devicePixelRatio ${window.devicePixelRatio}`);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(0x03040a);
app.append(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, 1, 1, 2);
scene.add(new THREE.AmbientLight(0xffffff, 0.12));
const sunLight = new THREE.DirectionalLight(0xfff4e0, 3);
scene.add(sunLight);

// Tiles come in the home body's body-fixed axes; this group turns them into the rendered frame.
const bodyFixedGroup = new THREE.Group();
scene.add(bodyFixedGroup);
const terrainView = new TerrainView(terrain, terrainConfig, contact, Math.max(1, navigator.hardwareConcurrency - 1), (e) => panic(e));
bodyFixedGroup.add(terrainView.tiles.group);
terrainView.tiles.setMeshWireframe(wireInput.checked);
terrainView.tiles.setTileBoundaries(boundsInput.checked);
wireInput.addEventListener('change', () => terrainView.tiles.setMeshWireframe(wireInput.checked));
boundsInput.addEventListener('change', () => terrainView.tiles.setTileBoundaries(boundsInput.checked));

const vesselGroup = new THREE.Group();
const hullMaterial = new THREE.MeshStandardMaterial({ color: 0xe8e4d8, metalness: 0.3, roughness: 0.5 });
const hull = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.4, 4, 20), hullMaterial);
const nose = new THREE.Mesh(new THREE.ConeGeometry(1.2, 1.8, 20), hullMaterial);
nose.position.y = 2.9;
const bell = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.9, 1, 20, 1, true),
  new THREE.MeshStandardMaterial({ color: 0x778995, metalness: 0.85, roughness: 0.3, side: THREE.DoubleSide }));
bell.position.y = -2.5;
const plume = new THREE.Mesh(new THREE.ConeGeometry(0.8, 5, 20, 1, true),
  new THREE.MeshBasicMaterial({ color: 0xff9a4a, transparent: true, opacity: 0.6, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
plume.rotation.z = Math.PI;
plume.position.y = -5.5;
vesselGroup.add(hull, nose, bell, plume);
scene.add(vesselGroup);

let focus: Focus = { kind: 'vessel' };
let mapOn = false;
const orbitCamera = new OrbitCamera(normalize({ x: 0.3, y: -1, z: 0.4 }), 30);
let state: ViewState | null = null;
let warpIndex = 0;
let paused = false;
const held = new Set<string>();

const map = new MapLayer(scene, overlay, eph, [home.index], (picked) => setFocus(picked));

const log = import.meta.env.DEV ? new LabLog('view', (e) => panic(e)) : null;
log?.write({ event: 'session', mode, altitudeKm, lod: terrainView.lod.options });

function focusName(f: Focus): string {
  return f.kind === 'vessel' ? 'vessel' : bodies[f.index]!.name;
}

function setFocus(next: Focus): void {
  if (mode === 'split' && !mapOn && next.kind !== 'vessel') return;
  focus = next;
  orbitCamera.distance = next.kind === 'vessel' ? (mapOn ? Math.max(orbitCamera.distance, 1e6) : 30) : bodies[next.index]!.radiusMeters * 4;
  log?.write({ event: 'focus', focus: focusName(next), distance: orbitCamera.distance, simTime: sim.time });
}

function toggleMap(): void {
  if (mode !== 'split') return;
  mapOn = !mapOn;
  // KSP's flight camera only looks at the vessel; leaving the map returns to it.
  if (!mapOn && focus.kind !== 'vessel') { focus = { kind: 'vessel' }; orbitCamera.distance = 30; }
  log?.write({ event: 'map-toggle', mapOn, distance: orbitCamera.distance, simTime: sim.time });
}

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  held.add(e.code);
  const attitude = ATTITUDE_KEYS[e.code];
  if (attitude) sim.setAttitude(attitude);
  else if (e.code === 'Space') { paused = !paused; e.preventDefault(); }
  else if (e.code === 'Period') warpIndex = Math.min(WARPS.length - 1, warpIndex + 1);
  else if (e.code === 'Comma') warpIndex = Math.max(0, warpIndex - 1);
  else if (e.code === 'KeyZ' && !sim.impact) sim.throttle = 1;
  else if (e.code === 'KeyX') sim.throttle = 0;
  else if (e.code === 'KeyM') toggleMap();
  else if (e.code === 'Tab') {
    e.preventDefault();
    const order: Focus[] = [{ kind: 'vessel' }, ...bodies.map((b): Focus => ({ kind: 'body', index: b.index }))];
    const current = order.findIndex((f) => f.kind === focus.kind && (f.kind === 'vessel' || (focus.kind === 'body' && f.index === focus.index)));
    setFocus(order[(current + (e.shiftKey ? order.length - 1 : 1)) % order.length]!);
  }
});
window.addEventListener('keyup', (e) => held.delete(e.code));
window.addEventListener('blur', () => held.clear());

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

/** Barycentric vessel position now (the history's last sample, or the impact site). */
function vesselPosition(): Vec3 {
  return sim.vesselPositionAt(sim.time);
}

function focusGeometry(vessel: Vec3): { geometry: FocusGeometry; position: Vec3; reference: CelestialBody } {
  if (focus.kind === 'vessel') {
    const reference = bodies[sim.navigationReference()]!;
    const fromCentre = sub(vessel, bodyPosition(reference.index));
    const r = Math.hypot(fromCentre.x, fromCentre.y, fromCentre.z);
    return { position: vessel, reference, geometry: { kind: 'vessel', radial: normalize(fromCentre), north: spinAxis(reference),
      referenceRadius: reference.radiusMeters, altitude: r - reference.radiusMeters, focusRadius: 0 } };
  }
  const body = bodies[focus.index]!;
  return { position: bodyPosition(body.index), reference: body, geometry: { kind: 'body', radial: null, north: spinAxis(body),
    referenceRadius: body.radiusMeters, altitude: 0, focusRadius: body.radiusMeters } };
}

/** A body-fixed point of the home body from a barycentric one. */
function homeBodyFixed(p: Vec3, axes: ReturnType<typeof bodyOrientation>): Vec3 {
  const d = sub(p, bodyPosition(home.index));
  return { x: d.x * axes.x.x + d.y * axes.x.y + d.z * axes.x.z, y: d.x * axes.y.x + d.y * axes.y.y + d.z * axes.y.z, z: d.x * axes.z.x + d.y * axes.z.y + d.z * axes.z.z };
}

/** Main-thread timings since the last view-sample, ms. */
const timings = { frames: 0, frame: { sum: 0, max: 0 }, lod: { sum: 0, max: 0 }, draw: { sum: 0, max: 0 } };
function timePhase(phase: 'frame' | 'lod' | 'draw', ms: number): void {
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
    const realDt = (nowMs - last) / 1000;
    timePhase('frame', nowMs - last);
    timings.frames += 1;
    last = nowMs;
    const up = Number(held.has('ShiftLeft') || held.has('ShiftRight'));
    const down = Number(held.has('ControlLeft') || held.has('ControlRight'));
    if (up !== down && !sim.impact) sim.throttle = Math.min(1, Math.max(0, sim.throttle + (up - down) * THROTTLE_RATE_PER_SECOND * realDt));
    const before = sim.time;
    if (!paused && realDt > 0) sim.advance(realDt * WARPS[warpIndex]!, MAX_VESSEL_STEPS_PER_FRAME);
    sim.extendPrediction(MAX_PREDICTION_STEPS_PER_FRAME);
    const t = sim.time;
    eph.statesAt(t, bodyPositions, bodyVelocities);

    const vessel = vesselPosition();
    const { geometry, position: origin, reference } = focusGeometry(vessel);
    state = viewState(mode, mapOn, geometry, orbitCamera.distance);
    orbitCamera.distance = orbitCamera.clampDistance(orbitCamera.distance, state.minDistance, state.maxDistance);
    // The camera turns with the reference body's spin by the co-rotation weight.
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
    bodyFixedGroup.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(toThree(axes.x), toThree(axes.y), toThree(axes.z)));
    // lab/lod's observers: the vessel (the probe) and the camera, so a camera far out sees the planet's face toward it.
    const cameraPosition = { x: origin.x + cameraOffset.x, y: origin.y + cameraOffset.y, z: origin.z + cameraOffset.z };
    const lodStarted = performance.now();
    const selection = terrainView.update([homeBodyFixed(vessel, axes), homeBodyFixed(cameraPosition, axes)], homeBodyFixed(origin, axes));
    timePhase('lod', performance.now() - lodStarted);

    toThree(sub(vessel, origin), vesselGroup.position);
    vesselGroup.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), toThree(sim.thrustDirection()).normalize());
    plume.visible = sim.effectiveThrottle > 0;
    plume.scale.y = 0.4 + 0.6 * sim.effectiveThrottle;

    const navigation = sim.navigationReference();
    map.update({ time: t, bodyPositions, bodyVelocities, origin, vessel, vesselVelocity: sim.vessel.velocity,
      path: sim.impact ? null : { trajectory: sim.prediction, generation: sim.predictionGeneration, reference: navigation },
      mapWeight: state.mapWeight, focus, camera, width: window.innerWidth, height: window.innerHeight });

    const drawStarted = performance.now();
    renderer.render(scene, camera);
    timePhase('draw', performance.now() - drawStarted);

    if (nowMs - lastReadout > 100) {
      lastReadout = nowMs;
      updateText(geometry, reference, navigation, selection.render.length, selection.culled.horizon);
    }
    if (log && nowMs - lastSample >= 1000) {
      lastSample = nowMs;
      const phase = (p: { sum: number; max: number }) => ({ mean: timings.frames > 0 ? p.sum / timings.frames : null, max: p.max });
      log.write({ event: 'view-sample', simTime: t, warp: WARPS[warpIndex], mapOn, focus: focusName(focus), distance: orbitCamera.distance,
        mapWeight: state.mapWeight, upWeight: state.upWeight, corotation: state.corotation, vesselAltitude: geometry.kind === 'vessel' ? geometry.altitude : null,
        tiles: selection.render.length, culled: selection.culled.horizon, requests: selection.requests.length, queued: terrainView.queuedBuilds,
        perf: { frames: timings.frames, frameMs: phase(timings.frame), lodMs: phase(timings.lod), drawMs: phase(timings.draw) } });
      timings.frames = 0;
      for (const p of [timings.frame, timings.lod, timings.draw]) { p.sum = 0; p.max = 0; }
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

function updateText(geometry: FocusGeometry, reference: CelestialBody, navigation: number, tiles: number, culled: number): void {
  if (!state) throw new Error('updateText before the first view state');
  const view = mode === 'single' ? 'single view' : mapOn ? 'split · MAP' : 'split · FLIGHT';
  statusText.textContent = [
    `${view}${paused ? '  PAUSED' : ''}`,
    `T+ ${sim.time.toFixed(0)} s   warp ${WARPS[warpIndex]}×`,
  ].join('\n');
  const vesselRef = bodies[navigation]!;
  const r = sub(vesselPosition(), bodyPosition(navigation));
  const v = sub(sim.vessel.velocity, bodyVelocity(navigation));
  const osc = osculatingOrbit(r, v, vesselRef.gm);
  readoutText.textContent = [
    `focus      ${focusName(focus)}${geometry.kind === 'vessel' ? ` (reference ${reference.name})` : ''}`,
    `distance   ${formatDistance(orbitCamera.distance)}  [${formatDistance(state.minDistance)} .. ${formatDistance(state.maxDistance)}]`,
    `map        ${(state.mapWeight * 100).toFixed(0)}%`,
    `up         ${(state.upWeight * 100).toFixed(0)}% toward north`,
    `co-rotate  ${(state.corotation * 100).toFixed(0)}% of ${reference.name}'s spin`,
    '',
    `vessel     about ${vesselRef.name}`,
    `altitude   ${formatDistance(Math.hypot(r.x, r.y, r.z) - vesselRef.radiusMeters)}`,
    `speed      ${Math.hypot(v.x, v.y, v.z).toFixed(1)} m/s`,
    `Pe / Ap    ${formatDistance(osc.periapsisRadiusMeters - vesselRef.radiusMeters)} / ${Number.isFinite(osc.apoapsisRadiusMeters) ? formatDistance(osc.apoapsisRadiusMeters - vesselRef.radiusMeters) : 'escape'}`,
    `throttle   ${(sim.effectiveThrottle * 100).toFixed(0)}%  ${sim.attitudeMode}  fuel ${(sim.fuelKg / 1000).toFixed(2)} t`,
    sim.impact ? `IMPACT on ${bodies[sim.impact.bodyIndex]!.name}` : '',
    '',
    `tiles      ${tiles} drawn, ${culled} culled, ${terrainView.queuedBuilds} building`,
  ].join('\n');
}

void renderer.init().then(() => {
  if (!('isWebGLBackend' in renderer.backend) || renderer.backend.isWebGLBackend !== true) {
    throw new Error(`view lab: expected the WebGL2 backend; actual backend=${renderer.backend.constructor.name}`);
  }
  requestAnimationFrame(frameLoop);
});
