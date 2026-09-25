import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { bodyOrientation, buildSystem, Ephemeris, type Vec3 } from './orbitCore';
import { pebble } from './planet/Planets';
import { buildCollisionTile, levelForTileSize, tileId, tilesAround } from './terrain/CollisionTiles';
import { predictCoast, type CoastPrediction } from './vessel/CoastPrediction';
import { Lander, type LanderControl, type LanderOptions, type LanderSpec } from './vessel/Lander';
import type { Terrain } from './terrain/Surface';
import './style.css';

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `<canvas id="view"></canvas><aside class="panel"><div class="eyebrow">VOID / PHYSICS LAB 03</div><h1>Landing</h1><p>Land and launch on a rotating planet.</p><div class="readout" id="readout"></div><label>Throttle <strong id="throttleValue">0%</strong><input id="throttle" type="range" min="0" max="100" value="0"></label><div class="buttons"><button id="launch">Stage engine</button><button id="cut">Throttle 0</button><button id="reset">Reset</button></div><label>Camera frame<select id="frame"><option value="surface">Rotating surface</option><option value="inertial">Inertial</option></select></label><label>Time rate<select id="rate"><option value="1">1×</option><option value="5">5×</option><option value="20">20×</option></select></label><label class="check"><input id="colliderLines" type="checkbox" checked> Show collision meshes</label><p class="hint">Space: stage engine · Shift / Ctrl: throttle · W / S: pitch · A / D: yaw · Q / E: roll. Drag to orbit camera · scroll to zoom. White lines show colliders; cyan is the engine-off coast forecast.</p><div id="error"></div></aside><div class="badge">PEBBLE · 100 km RADIUS · 3.5 h DAY</div>`;
const canvas = document.querySelector<HTMLCanvasElement>('#view')!;
const readout = document.querySelector<HTMLElement>('#readout')!;
const throttleInput = document.querySelector<HTMLInputElement>('#throttle')!;
const throttleValue = document.querySelector<HTMLElement>('#throttleValue')!;
const frameInput = document.querySelector<HTMLSelectElement>('#frame')!;
const rateInput = document.querySelector<HTMLSelectElement>('#rate')!;
const colliderLinesInput = document.querySelector<HTMLInputElement>('#colliderLines')!;
const error = document.querySelector<HTMLElement>('#error')!;
const planet = pebble();
const terrain = planet.terrain;
const eph = new Ephemeris(buildSystem(planet.system), { stepSeconds: 60, chunkSteps: 1024 });
eph.extendTo(60);
const spec: LanderSpec = { thrustNewtons: 20_000, specificImpulseSeconds: 300, dryMassKg: 1000, fuelMassKg: 1000,
  // The visual legs reach y=-2; the rigid body's box must reach them too.
  halfExtents: { x: 1.5, y: 2, z: 1.5 }, friction: 0.8 };
const options: LanderOptions = { contact: { stepSeconds: 1 / 60, tileLevel: levelForTileSize(terrain.radiusMeters, 300), tileCells: 32,
  tileReachMeters: 300, tileKeepMeters: 600, recenterMeters: 1000 }, tolerances: { positionMeters: 1e-6, velocityMetersPerSecond: 1e-9 },
  bandEnterMeters: 200, bandExitMeters: 400 };
const launchSite = { x: 0.8, y: 0.55, z: 0.25 };
await RAPIER.init();
let lander = Lander.landed(RAPIER, eph, 0, terrain, spec, options, 0, launchSite);
let prediction: CoastPrediction | null = null;
let predictionAt = -Infinity;
let paused = false;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setClearColor(0x07101b);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(58, 1, 0.1, 1_000_000);
const worldGroup = new THREE.Group();
scene.add(worldGroup);
scene.add(new THREE.HemisphereLight(0xcbe7ff, 0x26313d, 2.2));
const sun = new THREE.DirectionalLight(0xffe7bb, 2.8); sun.position.set(3, 7, 4); scene.add(sun);
const craft = new THREE.Group();
const hull = new THREE.Mesh(new THREE.BoxGeometry(3, 2, 3), new THREE.MeshStandardMaterial({ color: 0xece7d4, metalness: 0.3, roughness: 0.55 }));
craft.add(hull);
for (const x of [-1, 1]) for (const z of [-1, 1]) {
  const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 1.2), new THREE.MeshStandardMaterial({ color: 0x687381 }));
  leg.position.set(x * 1.35, -1.4, z * 1.35); craft.add(leg);
}
scene.add(craft);
const hullColliderLines = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.BoxGeometry(2 * spec.halfExtents.x, 2 * spec.halfExtents.y, 2 * spec.halfExtents.z)),
  new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: true }),
);
hullColliderLines.renderOrder = 2;
craft.add(hullColliderLines);
const farGeometry = new THREE.SphereGeometry(terrain.radiusMeters, 64, 40);
const farColors: number[] = [];
const farPositions = farGeometry.attributes.position!;
for (let i = 0; i < farPositions.count; i += 1) {
  const v = new THREE.Vector3().fromBufferAttribute(farPositions, i).normalize();
  const s = terrain.sample({ x: v.x, y: -v.z, z: v.y });
  const backdropRadius = terrain.radiusMeters + s.heightMeters - 100;
  farPositions.setXYZ(i, v.x * backdropRadius, v.y * backdropRadius, v.z * backdropRadius);
  farColors.push(...s.color);
}
farGeometry.setAttribute('color', new THREE.Float32BufferAttribute(farColors, 3));
farGeometry.computeVertexNormals();
const planetMesh = new THREE.Mesh(farGeometry, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, side: THREE.DoubleSide }));
worldGroup.add(planetMesh);
const tileGroup = new THREE.Group(); worldGroup.add(tileGroup);
const visibleTiles = new Map<string, { mesh: THREE.Mesh; lines: THREE.LineSegments }>();
const colliderLineMaterial = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.72, depthTest: true });
function uniqueEdges(triangles: Uint32Array): Uint32Array {
  const seen = new Set<string>();
  const edges: number[] = [];
  for (let i = 0; i < triangles.length; i += 3) {
    for (const [a, b] of [[triangles[i]!, triangles[i + 1]!], [triangles[i + 1]!, triangles[i + 2]!], [triangles[i + 2]!, triangles[i]!] ] as [number, number][]) {
      const lo = Math.min(a, b), hi = Math.max(a, b);
      const id = `${lo}/${hi}`;
      if (!seen.has(id)) { seen.add(id); edges.push(lo, hi); }
    }
  }
  return new Uint32Array(edges);
}
let pathLine: THREE.Line | null = null;
function refreshTiles(p: Vec3): void {
  const clearance = lander.clearance();
  const wanted = new Set<string>();
  if (clearance < 1800) for (const key of tilesAround(p, 600, options.contact.tileLevel, terrain.radiusMeters)) {
    const id = tileId(key); wanted.add(id);
    if (visibleTiles.has(id)) continue;
    const tile = buildCollisionTile(key, terrain, 32);
    const geometry = new THREE.BufferGeometry();
    const displayVertices = new Float32Array(tile.vertices.length);
    for (let j = 0; j < tile.vertices.length; j += 3) {
      displayVertices[j] = tile.vertices[j]!;
      displayVertices[j + 1] = tile.vertices[j + 2]!;
      displayVertices[j + 2] = -tile.vertices[j + 1]!;
    }
    geometry.setAttribute('position', new THREE.BufferAttribute(displayVertices, 3));
    geometry.setIndex(new THREE.BufferAttribute(tile.indices, 1));
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0x91ac70, roughness: 1, side: THREE.DoubleSide }));
    mesh.position.set(tile.origin.x, tile.origin.z, -tile.origin.y);
    const wireGeometry = new THREE.BufferGeometry();
    wireGeometry.setAttribute('position', geometry.getAttribute('position'));
    wireGeometry.setIndex(new THREE.BufferAttribute(uniqueEdges(tile.indices), 1));
    const lines = new THREE.LineSegments(wireGeometry, colliderLineMaterial);
    lines.position.copy(mesh.position);
    lines.renderOrder = 1;
    lines.visible = colliderLinesInput.checked;
    tileGroup.add(mesh, lines); visibleTiles.set(id, { mesh, lines });
  }
  for (const [id, tile] of visibleTiles) if (!wanted.has(id)) {
    tileGroup.remove(tile.mesh, tile.lines);
    tile.mesh.geometry.dispose(); (tile.mesh.material as THREE.Material).dispose();
    tile.lines.geometry.dispose(); visibleTiles.delete(id);
  }
  // Keep the globe behind the local tiles so their streamed edge never opens
  // onto empty sky. Contact near the craft still uses the detailed tiles.
  planetMesh.visible = true;
}
function updatePrediction(): void {
  if (lander.clearance() < spec.halfExtents.y) { prediction = null; return; }
  if (lander.time - predictionAt < 2) return;
  predictionAt = lander.time;
  prediction = predictCoast(eph, lander.frame, terrain, options.tolerances, lander.time, lander.bodyFixedState(), lander.massKg, 600);
  if (pathLine) { worldGroup.remove(pathLine); pathLine.geometry.dispose(); }
  const points = prediction.points.map((q) => new THREE.Vector3(q.position.x, q.position.z, -q.position.y));
  pathLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({ color: 0x59e9ed, depthTest: false }));
  worldGroup.add(pathLine);
}
let distance = 45;
let azimuth = 0.4;
let elevation = 0.3;
let dragging = false;
let lastX = 0, lastY = 0;
canvas.addEventListener('pointerdown', (e) => { dragging = true; lastX = e.clientX; lastY = e.clientY; canvas.setPointerCapture(e.pointerId); });
canvas.addEventListener('pointerup', () => { dragging = false; });
canvas.addEventListener('pointermove', (e) => { if (!dragging) return; azimuth += (e.clientX - lastX) * 0.006; elevation = Math.max(-1.3, Math.min(1.3, elevation + (e.clientY - lastY) * 0.006)); lastX = e.clientX; lastY = e.clientY; });
canvas.addEventListener('wheel', (e) => { e.preventDefault(); distance = Math.max(10, Math.min(300_000, distance * Math.exp(e.deltaY * 0.001))); }, { passive: false });
let engineArmed = false;
let throttlePercent = Number(throttleInput.value);
throttleInput.addEventListener('input', () => { throttlePercent = Number(throttleInput.value); });
const keys = new Set<string>();
const shipAttitude = new THREE.Quaternion();
const shipAngularVelocity = new THREE.Vector3();
function resetAttitude(): void {
  const d = new THREE.Vector3(launchSite.x, launchSite.z, -launchSite.y).normalize();
  shipAttitude.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d);
}
resetAttitude();
window.addEventListener('keydown', (e) => {
  if (['Space', 'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'KeyW', 'KeyS', 'KeyA', 'KeyD', 'KeyQ', 'KeyE'].includes(e.code)) e.preventDefault();
  if (e.code === 'Space' && !e.repeat) engineArmed = true;
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
  if (lander.mode !== 'flight') return;
  const input = new THREE.Vector3(axis('KeyS', 'KeyW'), axis('KeyE', 'KeyQ'), axis('KeyD', 'KeyA'));
  shipAngularVelocity.addScaledVector(input, 1.4 * dt).multiplyScalar(Math.exp(-0.8 * dt));
  const angularStep = shipAngularVelocity.length() * dt;
  if (angularStep > 0) shipAttitude.multiply(new THREE.Quaternion().setFromAxisAngle(shipAngularVelocity.clone().normalize(), angularStep));
  shipAttitude.normalize();
}
function command(): LanderControl {
  const thrustAxis = new THREE.Vector3(0, 1, 0).applyQuaternion(shipAttitude);
  const basisX = new THREE.Vector3(1, 0, 0).applyQuaternion(shipAttitude);
  const basisY = thrustAxis;
  const basisZ = new THREE.Vector3(0, 0, 1).applyQuaternion(shipAttitude);
  const toBody = (v: THREE.Vector3) => new THREE.Vector3(v.x, -v.z, v.y);
  const qBody = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(toBody(basisX), toBody(basisY), toBody(basisZ)));
  const d = toBody(thrustAxis);
  return { throttle: engineArmed ? throttlePercent / 100 : 0, up: 1, prograde: 0,
    direction: { x: d.x, y: d.y, z: d.z }, rotation: { x: qBody.x, y: qBody.y, z: qBody.z, w: qBody.w },
    turn: { x: axis('KeyS', 'KeyW'), y: axis('KeyE', 'KeyQ'), z: axis('KeyD', 'KeyA') } };
}
document.querySelector('#launch')!.addEventListener('click', () => { engineArmed = true; });
document.querySelector('#cut')!.addEventListener('click', () => { throttlePercent = 0; throttleInput.value = '0'; });
document.querySelector('#reset')!.addEventListener('click', () => { lander = Lander.landed(RAPIER, eph, 0, terrain, spec, options, 0, launchSite); throttlePercent = 0; throttleInput.value = '0'; engineArmed = false; shipAngularVelocity.set(0, 0, 0); resetAttitude(); predictionAt = -Infinity; prediction = null; paused = false; error.textContent = ''; });
colliderLinesInput.addEventListener('change', () => {
  for (const tile of visibleTiles.values()) tile.lines.visible = colliderLinesInput.checked;
  hullColliderLines.visible = colliderLinesInput.checked;
});
function orientBody(p: Vec3, t: number): THREE.Vector3 {
  if (frameInput.value === 'surface') return new THREE.Vector3(p.x, p.z, -p.y);
  const a = bodyOrientation(lander.frame.body, t);
  return new THREE.Vector3(p.x * a.x.x + p.y * a.y.x + p.z * a.z.x,
    p.x * a.x.z + p.y * a.y.z + p.z * a.z.z,
    -(p.x * a.x.y + p.y * a.y.y + p.z * a.z.y));
}
function syncAttitudeFromPhysics(): void {
  const q = lander.orientation();
  const bodyQ = new THREE.Quaternion(q.x, q.y, q.z, q.w);
  const toRender = (v: THREE.Vector3) => new THREE.Vector3(v.x, v.z, -v.y);
  const x = toRender(new THREE.Vector3(1, 0, 0).applyQuaternion(bodyQ));
  const y = toRender(new THREE.Vector3(0, 1, 0).applyQuaternion(bodyQ));
  const z = toRender(new THREE.Vector3(0, 0, 1).applyQuaternion(bodyQ));
  shipAttitude.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}
let previousMode = lander.mode;
function render(): void {
  if (lander.mode === 'flight' && previousMode === 'contact') shipAngularVelocity.set(0, 0, 0);
  if (lander.mode !== 'flight' || previousMode !== 'flight') syncAttitudeFromPhysics();
  previousMode = lander.mode;
  const state = lander.bodyFixedState();
  const p = state.position;
  const origin = orientBody(p, lander.time);
  const x = orientBody({ x: 1, y: 0, z: 0 }, lander.time);
  const y = orientBody({ x: 0, y: 0, z: 1 }, lander.time);
  const z = orientBody({ x: 0, y: -1, z: 0 }, lander.time);
  const m = new THREE.Matrix4().makeBasis(x, y, z);
  worldGroup.quaternion.setFromRotationMatrix(m);
  worldGroup.position.copy(origin).multiplyScalar(-1);
  const up = origin.clone().normalize();
  let east = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), up).normalize();
  if (east.lengthSq() < 0.01) east = new THREE.Vector3(1, 0, 0);
  const north = new THREE.Vector3().crossVectors(up, east).normalize();
  camera.up.copy(up);
  camera.position.copy(up).multiplyScalar(Math.sin(elevation) * distance).addScaledVector(east, Math.cos(elevation) * Math.cos(azimuth) * distance).addScaledVector(north, Math.cos(elevation) * Math.sin(azimuth) * distance);
  camera.lookAt(0, 0, 0);
  camera.near = Math.max(0.1, distance * 0.001); camera.far = 600_000; camera.updateProjectionMatrix();
  craft.quaternion.copy(worldGroup.quaternion).multiply(shipAttitude);
  refreshTiles(p);
  updatePrediction();
  if (pathLine) pathLine.visible = prediction !== null;
  const groundSpeed = Math.hypot(state.velocity.x, state.velocity.y, state.velocity.z);
  const eta = prediction?.impact ? `${Math.max(0, prediction.impact.time - lander.time).toFixed(0)} s` : '—';
  readout.innerHTML = `<div><span>Mode</span><b>${lander.mode}</b></div><div><span>Time</span><b>${lander.time.toFixed(1)} s</b></div><div><span>Height AGL</span><b>${Math.max(0, lander.clearance() - spec.halfExtents.y).toFixed(1)} m</b></div><div><span>Ground speed</span><b>${groundSpeed.toFixed(1)} m/s</b></div><div><span>Fuel</span><b>${lander.fuelKg.toFixed(1)} kg</b></div><div><span>Coast impact</span><b>${eta}</b></div>`;
  throttleValue.textContent = `${throttleInput.value}%${engineArmed ? (throttlePercent > 0 ? ' · firing' : ' · staged') : ' · unlit'}`;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.floor(w * renderer.getPixelRatio()) || canvas.height !== Math.floor(h * renderer.getPixelRatio())) { renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); }
  renderer.render(scene, camera);
}
let last = performance.now();
function loop(now: number): void {
  requestAnimationFrame(loop);
  const wall = Math.max(0, Math.min(0.05, (now - last) / 1000)); last = now;
  if (!paused) {
    try {
      steer(wall);
      lander.advance(wall * Number(rateInput.value), command());
    } catch (e) { paused = true; error.textContent = `Simulation paused: ${e instanceof Error ? e.message : String(e)}`; engineArmed = false; }
  }
  render();
}
requestAnimationFrame(loop);
