import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three/webgpu';
import type { Vec3 } from '../../landing/src/orbitCore';
import type { Quaternion } from '../../landing/src/physics/ContactWorld';
import { matVec, quatToMatrix, scaleMat, stepAttitude, transpose, type Mat3 } from '../../landing/src/vessel/Attitude';
import { PartJointRocket, STEERING_TORQUE } from '../../landing/src/vessel/PartJointRocket';
import { demoRocket } from '../../landing/src/vessel/DemoRocket';
import { pebble, planetEphemeris } from '../../landing/src/planet/Planets';
import { RocketVisual } from '../../landing/src/render/RocketVisual';
import { attitudeError, SAS_TUNING, StabilityAssist, type SasPhase, type SasTuning } from './StabilityAssist';
import './style.css';

let stopped = false;
function panic(error: unknown): never {
  const failure = error instanceof Error ? error : new Error(`Non-Error thrown: ${String(error)}`);
  if (stopped) throw failure;
  stopped = true;
  const message = document.createElement('pre');
  message.className = 'panic';
  message.textContent = `SAS LAB PANIC\n${failure.stack ?? failure.message}`;
  document.body.append(message);
  throw failure;
}
window.addEventListener('error', (e) => panic(e.error));
window.addEventListener('unhandledrejection', (e) => panic(e.reason));

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('sas lab: #app missing');

const DT = 1 / 60;
const DEG = 180 / Math.PI;
const HISTORY_SECONDS = 15;
const ZERO: Vec3 = { x: 0, y: 0, z: 0 };
const norm = (v: Vec3) => Math.hypot(v.x, v.y, v.z);

// The demo rocket's real inertias, from lab/landing's Rapier colliders.
await RAPIER.init();
const planet = pebble();
const { ephemeris, bodyIndex } = planetEphemeris(planet);
const demo = demoRocket(planet.terrain);
const pad = PartJointRocket.landed(RAPIER, ephemeris, bodyIndex, planet.terrain, demo.full, demo.upper, demo.booster, demo.options, demo.launchSite);
const INERTIA: Record<'stack' | 'upper', Mat3> = { stack: pad.controlledInertia(), upper: (pad.separate(), pad.controlledInertia()) };
const MASS = { upper: demo.upper.dryMassKg + demo.upper.fuelMassKg, booster: demo.booster.dryMassKg + demo.booster.fuelMassKg };
pad.free();

// --- Panel -------------------------------------------------------------------------------
const panel = document.createElement('aside');
panel.className = 'panel';
panel.innerHTML = `<div class="title">SAS LAB</div>
<div class="sas-row"><button id="sas" class="sas">SAS</button><span id="phase"></span></div>
<label>Vehicle<select id="vehicle"><option value="stack">Full stack</option><option value="upper">Upper stage</option></select></label>
<label>Inertia ×<input id="scale" type="range" min="-2" max="2" step="0.05" value="0"><output id="scale-value"></output></label>
<details class="tuning"><summary>Tuning (SAS_TUNING)</summary>
<label>rate s<input id="rate" type="range" min="0.05" max="0.6" step="0.01" value="${SAS_TUNING.rateSeconds}"><output id="rate-value"></output></label>
<label>attitude/rate<input id="ratio" type="range" min="4" max="12" step="0.1" value="${SAS_TUNING.attitudeSeconds / SAS_TUNING.rateSeconds}"><output id="ratio-value"></output></label>
<label>brake<input id="brake" type="range" min="0.1" max="1" step="0.05" value="${SAS_TUNING.brakeFraction}"><output id="brake-value"></output></label>
<label>lock rate<input id="lock" type="range" min="-4" max="-1" step="0.1" value="${Math.log10(SAS_TUNING.lockRate)}"><output id="lock-value"></output></label>
<pre id="tuning-text"></pre><button id="tuning-reset">Defaults</button></details>
<div class="buttons"><button id="kick">Kick 0.2 rad/s</button><button id="big-kick">Kick 1 rad/s</button><button id="reset">Reset</button></div>
<pre id="readout"></pre>
<canvas id="chart"></canvas>
<div class="legend"><span class="e">■ angle from lock (°)</span> <span class="w">■ spin (°/s)</span> <span class="u">■ |command|</span></div>
<div class="help"><kbd>T</kbd> SAS on/off · <kbd>W</kbd>/<kbd>S</kbd> pitch · <kbd>A</kbd>/<kbd>D</kbd> yaw · <kbd>Q</kbd>/<kbd>E</kbd> roll · <kbd>K</kbd> kick<br>
Keys use the game's steering torque (${STEERING_TORQUE} N·m). No damping: with SAS off a spin never stops.<br>
Grey arrow: locked attitude's nose. Chart: last ${HISTORY_SECONDS} s.</div>`;
document.body.append(panel);
function element<T extends HTMLElement>(selector: string): T {
  const found = panel.querySelector<T>(selector);
  if (!found) throw new Error(`sas lab: ${selector} missing`);
  return found;
}
const sasButton = element<HTMLButtonElement>('#sas');
const phaseLabel = element<HTMLSpanElement>('#phase');
const vehicleInput = element<HTMLSelectElement>('#vehicle');
const scaleInput = element<HTMLInputElement>('#scale');
const scaleOutput = element<HTMLOutputElement>('#scale-value');
const readout = element<HTMLPreElement>('#readout');
const chart = element<HTMLCanvasElement>('#chart');

// --- Simulation ----------------------------------------------------------------------------
const tuningInputs = { rate: element<HTMLInputElement>('#rate'), ratio: element<HTMLInputElement>('#ratio'),
  brake: element<HTMLInputElement>('#brake'), lock: element<HTMLInputElement>('#lock') };
function tuning(): SasTuning {
  const rateSeconds = Number(tuningInputs.rate.value);
  return { rateSeconds, attitudeSeconds: rateSeconds * Number(tuningInputs.ratio.value), brakeFraction: Number(tuningInputs.brake.value),
    lockRate: 10 ** Number(tuningInputs.lock.value) };
}
// Changing the tuning makes a new controller; SAS stays on or off and locks afresh.
let sas = new StabilityAssist(STEERING_TORQUE, tuning());
function retune(): void {
  const on = sas.enabled;
  sas = new StabilityAssist(STEERING_TORQUE, tuning());
  sas.setEnabled(on);
  const t = sas.tuning;
  element('#rate-value').textContent = t.rateSeconds.toFixed(2);
  element('#ratio-value').textContent = (t.attitudeSeconds / t.rateSeconds).toFixed(1);
  element('#brake-value').textContent = t.brakeFraction.toFixed(2);
  element('#lock-value').textContent = t.lockRate.toExponential(0);
  element('#tuning-text').textContent = `{ rateSeconds: ${t.rateSeconds}, attitudeSeconds: ${+t.attitudeSeconds.toFixed(3)}, brakeFraction: ${t.brakeFraction}, lockRate: ${+t.lockRate.toPrecision(2)} }`;
}
for (const input of Object.values(tuningInputs)) input.addEventListener('input', retune);
// Sliders give the keyboard back once released, so T and the steering keys keep working.
for (const input of panel.querySelectorAll<HTMLInputElement>('input[type=range]')) input.addEventListener('change', () => input.blur());
element<HTMLButtonElement>('#tuning-reset').addEventListener('click', () => {
  tuningInputs.rate.value = String(SAS_TUNING.rateSeconds);
  tuningInputs.ratio.value = String(SAS_TUNING.attitudeSeconds / SAS_TUNING.rateSeconds);
  tuningInputs.brake.value = String(SAS_TUNING.brakeFraction);
  tuningInputs.lock.value = String(Math.log10(SAS_TUNING.lockRate));
  retune();
});
retune();
let rotation: Quaternion = { x: 0, y: 0, z: 0, w: 1 };
let angularVelocity: Vec3 = ZERO;
let lastCommand: Vec3 = ZERO;
let elapsed = 0;
const history: { t: number; error: number; spin: number; command: number }[] = [];

const vehicle = () => vehicleInput.value as 'stack' | 'upper';
const inertiaScale = () => 2 ** Number(scaleInput.value);
const inertia = (): Mat3 => scaleMat(INERTIA[vehicle()], inertiaScale());

const keys = new Set<string>();
const axis = (positive: string, negative: string) => Number(keys.has(positive)) - Number(keys.has(negative));
const pilot = (): Vec3 => ({ x: axis('KeyS', 'KeyW'), y: axis('KeyE', 'KeyQ'), z: axis('KeyD', 'KeyA') });

function kick(size: number): void {
  const d = { x: Math.random() - 0.5, y: Math.random() - 0.5, z: Math.random() - 0.5 };
  const l = norm(d);
  angularVelocity = { x: angularVelocity.x + (d.x / l) * size, y: angularVelocity.y + (d.y / l) * size, z: angularVelocity.z + (d.z / l) * size };
}
function reset(): void {
  rotation = { x: 0, y: 0, z: 0, w: 1 };
  angularVelocity = ZERO;
  history.length = 0;
  if (sas.enabled) sas.setEnabled(true);
}

function step(): void {
  const I = inertia();
  lastCommand = sas.command({ rotation, angularVelocity, inertiaLocal: I }, pilot(), DT);
  const torque = { x: lastCommand.x * STEERING_TORQUE, y: lastCommand.y * STEERING_TORQUE, z: lastCommand.z * STEERING_TORQUE };
  const next = stepAttitude(rotation, angularVelocity, I, torque, DT);
  rotation = next.rotation;
  angularVelocity = next.angularVelocity;
  elapsed += DT;
  const target = sas.target;
  history.push({ t: elapsed, error: target ? norm(attitudeError(target, rotation)) * DEG : NaN, spin: norm(angularVelocity) * DEG,
    command: Math.max(Math.abs(lastCommand.x), Math.abs(lastCommand.y), Math.abs(lastCommand.z)) });
  while (history.length > 0 && history[0]!.t < elapsed - HISTORY_SECONDS) history.shift();
}

sasButton.addEventListener('click', () => sas.toggle());
element<HTMLButtonElement>('#kick').addEventListener('click', () => kick(0.2));
element<HTMLButtonElement>('#big-kick').addEventListener('click', () => kick(1));
element<HTMLButtonElement>('#reset').addEventListener('click', reset);
vehicleInput.addEventListener('change', () => { layoutRocket(); vehicleInput.blur(); });
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  if (['KeyW', 'KeyS', 'KeyA', 'KeyD', 'KeyQ', 'KeyE', 'KeyT', 'KeyK'].includes(e.code)) e.preventDefault();
  keys.add(e.code);
  if (e.repeat) return;
  if (e.code === 'KeyT') sas.toggle();
  if (e.code === 'KeyK') kick(0.2);
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());

// --- Scene -------------------------------------------------------------------------------
const renderer = new THREE.WebGPURenderer({ antialias: true, forceWebGL: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
app.append(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x03040a);
const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 500);
camera.position.set(9, 4, 13);
camera.lookAt(0, 0, 0);
scene.add(new THREE.HemisphereLight(0xbfd2ff, 0x1a1410, 1.2));
const sun = new THREE.DirectionalLight(0xffffff, 2.4);
sun.position.set(10, 12, 6);
scene.add(sun);
// A fixed wire sphere and axes, so any turning of the rocket is visible against them.
scene.add(new THREE.Mesh(new THREE.SphereGeometry(40, 24, 16), new THREE.MeshBasicMaterial({ color: 0x1c2436, wireframe: true })));
scene.add(new THREE.AxesHelper(1.5));

const craft = new THREE.Group();
scene.add(craft);
const visual = new RocketVisual(demo.upperShape, demo.boosterShape);
visual.setColliderLines(false);
visual.upperEngine.plume.visible = false;
visual.boosterEngine.plume.visible = false;
visual.upperEngine.light.visible = false;
visual.boosterEngine.light.visible = false;
craft.add(visual.upper, visual.booster);
// Part centres of mass relative to the stack's root, as PartJointRocket stacks them.
const UPPER_OFFSET = 1.1, BOOSTER_OFFSET = -1.3;
function layoutRocket(): void {
  const stack = vehicle() === 'stack';
  visual.booster.visible = stack;
  const centre = stack ? (MASS.upper * UPPER_OFFSET + MASS.booster * BOOSTER_OFFSET) / (MASS.upper + MASS.booster) : UPPER_OFFSET;
  visual.upper.position.y = UPPER_OFFSET - centre;
  visual.booster.position.y = BOOSTER_OFFSET - centre;
}
layoutRocket();
const noseArrow = new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), new THREE.Vector3(), 5, 0x6fd3ff, 0.5, 0.3);
const lockArrow = new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), new THREE.Vector3(), 5, 0x8a8f9c, 0.5, 0.3);
scene.add(noseArrow, lockArrow);

function resize(): void {
  const width = app!.clientWidth, height = app!.clientHeight;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  const ratio = window.devicePixelRatio;
  chart.width = chart.clientWidth * ratio;
  chart.height = chart.clientHeight * ratio;
}
window.addEventListener('resize', resize);

// --- HUD -------------------------------------------------------------------------------------
const PHASE_TEXT: Record<SasPhase, string> = { off: 'off', pilot: 'pilot input: other axes damped', damping: 'stopping the spin', holding: 'holding attitude' };
function drawChart(): void {
  const c = chart.getContext('2d');
  if (!c) throw new Error('sas lab: no 2d context');
  const w = chart.width, h = chart.height;
  c.clearRect(0, 0, w, h);
  c.strokeStyle = '#2a3040';
  c.strokeRect(0.5, 0.5, w - 1, h - 1);
  if (history.length < 2) return;
  const t0 = elapsed - HISTORY_SECONDS;
  const x = (t: number) => ((t - t0) / HISTORY_SECONDS) * w;
  const top = Math.max(1, ...history.map((p) => Math.max(Number.isNaN(p.error) ? 0 : p.error, p.spin)));
  const series = (pick: (p: typeof history[number]) => number, color: string, scale: number) => {
    c.strokeStyle = color;
    c.lineWidth = 1.5 * window.devicePixelRatio;
    c.beginPath();
    let drawing = false;
    for (const p of history) {
      const v = pick(p);
      if (Number.isNaN(v)) { drawing = false; continue; }
      const y = h - 4 - (v / scale) * (h - 8);
      if (drawing) c.lineTo(x(p.t), y); else c.moveTo(x(p.t), y);
      drawing = true;
    }
    c.stroke();
  };
  series((p) => p.command, '#8a6cff', 1);
  series((p) => p.spin, '#ffb347', top);
  series((p) => p.error, '#6fd3ff', top);
  c.fillStyle = '#8892a6';
  c.font = `${10 * window.devicePixelRatio}px ui-monospace, monospace`;
  c.fillText(`${top.toFixed(top < 10 ? 2 : 0)}`, 4, 12 * window.devicePixelRatio);
}

function updateHud(): void {
  sasButton.classList.toggle('on', sas.enabled);
  phaseLabel.textContent = PHASE_TEXT[sas.phase];
  scaleOutput.textContent = inertiaScale().toFixed(2);
  const I = inertia();
  const local = matVec(transpose(quatToMatrix(rotation)), angularVelocity);
  const target = sas.target;
  const error = target ? norm(attitudeError(target, rotation)) * DEG : null;
  const accel = (d: number) => (STEERING_TORQUE / d).toFixed(3);
  readout.textContent = [
    `inertia   ${[I[0], I[4], I[8]].map((v) => v.toFixed(0).padStart(6)).join(' ')} kg m²  (pitch roll yaw)`,
    `max accel ${[I[0], I[4], I[8]].map((v) => accel(v).padStart(6)).join(' ')} rad/s²`,
    `spin      ${[local.x, local.y, local.z].map((v) => v.toFixed(3).padStart(6)).join(' ')} rad/s   |${norm(angularVelocity).toFixed(4)}|`,
    `command   ${[lastCommand.x, lastCommand.y, lastCommand.z].map((v) => v.toFixed(3).padStart(6)).join(' ')}`,
    `from lock ${error === null ? '     —' : `${error.toFixed(3)}°`}`,
  ].join('\n');
  const q = new THREE.Quaternion(rotation.x, rotation.y, rotation.z, rotation.w);
  craft.quaternion.copy(q);
  noseArrow.setDirection(new THREE.Vector3(0, 1, 0).applyQuaternion(q));
  lockArrow.visible = target !== null;
  if (target) lockArrow.setDirection(new THREE.Vector3(0, 1, 0).applyQuaternion(new THREE.Quaternion(target.x, target.y, target.z, target.w)));
  drawChart();
}

await renderer.init();
if (!('isWebGLBackend' in renderer.backend) || renderer.backend.isWebGLBackend !== true) throw new Error('sas lab: expected the WebGL2 backend');
resize();
let last = performance.now();
let owed = 0;
renderer.setAnimationLoop(() => {
  const now = performance.now();
  owed = Math.min(owed + (now - last) / 1000, 0.25);
  last = now;
  while (owed >= DT) { step(); owed -= DT; }
  updateHud();
  renderer.render(scene, camera);
});
