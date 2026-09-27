import * as THREE from 'three/webgpu';
import { SceneryPipeline } from './SceneryPipeline';
import { earthLikeAtmosphere, type Vec3 } from './Atmosphere';
import { AtmosphereShading } from './AtmosphereNodes';
import { CloudShading } from './CloudNodes';
import { Ground } from './Ground';
import { GroundMaterial } from './GroundMaterial';
import { StarField } from './Stars';
import { OrbitView } from './OrbitView';
import { sceneryTerrain } from './Terrains';
import './style.css';

const DEG = Math.PI / 180;
let frameDirty = true;
let renderedGroundRevision = -1;
let lastFrameHeight = Infinity;
let renderedFrames = 0;

function panic(error: unknown): never {
  const message = error instanceof Error ? `${error.message}\n\n${error.stack ?? ''}` : String(error);
  const box = document.createElement('pre');
  box.className = 'panic';
  box.textContent = `SCENERY LAB PANIC ${message}`;
  document.body.append(box);
  throw error instanceof Error ? error : new Error(message);
}
window.addEventListener('error', (event) => panic(event.error ?? event.message));
window.addEventListener('unhandledrejection', (event) => panic(event.reason));

function element<T extends HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`main.ts: missing element ${selector}`);
  return found;
}

const app = element<HTMLDivElement>('#app');
app.addEventListener('input', () => { frameDirty = true; });
app.addEventListener('click', (event) => {
  if (event.target instanceof Element && event.target.closest('button')) frameDirty = true;
});
app.innerHTML = `
  <div class="panel">
    <div class="title">SCENERY LAB</div>
    <label>terrain <select id="terrain"><option value="layered">layered (scenery)</option><option value="lod">lab/lod continents</option><option value="hills">Aurelia hills (flight)</option></select></label>
    <pre id="readout"></pre>
    <label>local time <span id="time-value"></span><input id="time" type="range" min="0" max="24" step="0.01" /></label>
    <label>time rate <select id="rate">
      <option value="0">stopped</option><option value="0.02">1 min/s</option><option value="0.25">15 min/s</option><option value="2">2 h/s</option>
    </select></label>
    <label>sun declination <span id="declination-value"></span><input id="declination" type="range" min="-30" max="30" step="0.5" value="10" /></label>
    <label>sea level <span id="sea-value"></span><input id="sea" type="range" min="0" step="10" /></label>
    <label>exposure <span id="exposure-value"></span><input id="exposure" type="range" min="-1" max="3" step="0.01" value="0.8" /></label>
    <label>tone mapping <select id="tone">
      <option value="aces">ACES filmic</option><option value="agx">AgX</option><option value="neutral">Neutral</option>
    </select></label>
    <div class="toggles">
      <label><input id="clouds" type="checkbox" checked /> clouds</label>
      <label><input id="weather-only" type="checkbox" /> weather only</label>
      <label><input id="air" type="checkbox" checked /> atmosphere</label>
      <label><input id="multiple" type="checkbox" checked /> multi-scatter</label>
      <label><input id="ocean" type="checkbox" checked /> ocean</label>
      <label><input id="stars" type="checkbox" checked /> stars</label>
    </div>
    <label>cloud coverage <span id="coverage-value"></span><input id="coverage" type="range" min="0" max="1" step="0.01" value="0.62" /></label>
    <div class="presets">
      <span data-preset="ground">ground</span><span data-preset="sunset">sunset</span><span data-preset="night">night</span>
      <span data-preset="cloud">cloud layer</span><span data-preset="plane">10 km</span><span data-preset="orbit">400 km</span><span data-preset="space">20,000 km</span>
    </div>
    <div class="help">left drag: pan · right drag: orbit · Shift + left drag: turn · wheel: zoom</div>
  </div>`;

// ?terrain=layered (default), lod or hills; changing it reloads the page so workers and tile caches start clean.
const terrainId = new URLSearchParams(window.location.search).get('terrain') ?? 'layered';
const terrain = sceneryTerrain(terrainId);
const radius = terrain.radiusMeters;
const terrainInput = element<HTMLSelectElement>('#terrain');
terrainInput.value = terrainId;
terrainInput.addEventListener('change', () => {
  const next = new URL(window.location.href);
  next.searchParams.set('terrain', terrainInput.value);
  window.location.assign(next.href);
});

const renderer = new THREE.WebGPURenderer({ antialias: false, forceWebGL: true, logarithmicDepthBuffer: true });
if (!(window.devicePixelRatio > 0)) throw new Error(`invalid devicePixelRatio ${window.devicePixelRatio}`);
renderer.setPixelRatio(1);
renderer.setClearColor(0x000000);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
app.append(renderer.domElement);

// Render space: the planet's body-fixed axes, camera at the origin.
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1e14);

const atmosphere = new AtmosphereShading(earthLikeAtmosphere(radius));
const clouds = new CloudShading(atmosphere);
const ground = new Ground(terrain, Math.min(2, navigator.hardwareConcurrency), (e) => panic(e));
const groundMaterial = new GroundMaterial(atmosphere, terrain.rockHeight, terrain.snowHeight);
ground.tiles.setMaterial(groundMaterial.material);
scene.add(ground.tiles.group);
const stars = new StarField();
const sky = new THREE.Group();
sky.add(stars.points);
scene.add(sky);

const pipeline = new SceneryPipeline(renderer, atmosphere, clouds);

// ?at=latitude,longitude in degrees picks the spot the camera starts over.
const at = new URLSearchParams(window.location.search).get('at');
const [startLatitude, startLongitude] = at === null ? [0.3, 0.5] : parseAt(at);
function parseAt(text: string): [number, number] {
  const parts = text.split(',').map(Number);
  if (parts.length !== 2 || !parts.every(Number.isFinite) || Math.abs(parts[0]!) > 90) throw new Error(`?at=${text}: expected latitude,longitude in degrees`);
  return [parts[0]! * DEG, parts[1]! * DEG];
}
const view = new OrbitView({ x: Math.cos(startLatitude) * Math.cos(startLongitude), y: Math.cos(startLatitude) * Math.sin(startLongitude), z: Math.sin(startLatitude) },
  radius + terrain.maxHeightMeters + 2e6, 0, 200e6);

/** Where the camera is: body-fixed position, its unit up, and the ground or sea height and camera height above it. */
function where(): { position: Vec3; up: Vec3; surface: number; height: number; latitude: number; longitude: number } {
  const position = view.pose().position;
  const r = Math.hypot(position.x, position.y, position.z);
  const up = { x: position.x / r, y: position.y / r, z: position.z / r };
  const surface = surfaceHeight(up);
  return { position, up, surface, height: r - radius - surface, latitude: Math.asin(up.z), longitude: Math.atan2(up.y, up.x) };
}
/** Lifts the camera back to MIN_HEIGHT when a pan, orbit or zoom took it under the ground or sea. */
function keepAboveSurface(): void {
  const here = where();
  if (here.height < OrbitView.MIN_HEIGHT) view.setRadius(radius + here.surface + OrbitView.MIN_HEIGHT);
}

/** Longitude where the sun is overhead; the sky turns with it. */
let subSolarLongitude = startLongitude + 2 * 15 * DEG;
let seconds = 0;

const timeInput = element<HTMLInputElement>('#time');
const rateInput = element<HTMLSelectElement>('#rate');
const declinationInput = element<HTMLInputElement>('#declination');
const seaInput = element<HTMLInputElement>('#sea');
seaInput.max = String(terrain.maxHeightMeters);
seaInput.value = String(terrain.defaultSeaLevel);
const exposureInput = element<HTMLInputElement>('#exposure');
const toneInput = element<HTMLSelectElement>('#tone');
const cloudsInput = element<HTMLInputElement>('#clouds');
const weatherOnlyInput = element<HTMLInputElement>('#weather-only');
const coverageInput = element<HTMLInputElement>('#coverage');
const airInput = element<HTMLInputElement>('#air');
const multipleInput = element<HTMLInputElement>('#multiple');
const oceanInput = element<HTMLInputElement>('#ocean');
const starsInput = element<HTMLInputElement>('#stars');
const readout = element<HTMLPreElement>('#readout');

/** Local solar time at the camera, hours. */
function localTime(): number {
  const hours = 12 + (where().longitude - subSolarLongitude) / (15 * DEG);
  return ((hours % 24) + 24) % 24;
}
function setLocalTime(hours: number): void {
  subSolarLongitude = where().longitude + (12 - hours) * 15 * DEG;
}
timeInput.addEventListener('input', () => setLocalTime(Number(timeInput.value)));

function applySettings(): void {
  groundMaterial.seaLevel.value = Number(seaInput.value);
  groundMaterial.oceanEnabled.value = oceanInput.checked ? 1 : 0;
  clouds.enabled.value = cloudsInput.checked ? 1 : 0;
  clouds.weatherOnly.value = weatherOnlyInput.checked ? 1 : 0;
  clouds.coverage.value = Number(coverageInput.value);
  clouds.seaLevel.value = Number(seaInput.value);
  element('#coverage-value').textContent = coverageInput.value;
  atmosphere.enabled.value = airInput.checked ? 1 : 0;
  atmosphere.multipleEnabled.value = multipleInput.checked ? 1 : 0;
  stars.points.visible = starsInput.checked;
  renderer.toneMappingExposure = 10 ** Number(exposureInput.value);
  const tone = toneInput.value;
  renderer.toneMapping = tone === 'aces' ? THREE.ACESFilmicToneMapping : tone === 'agx' ? THREE.AgXToneMapping
    : tone === 'neutral' ? THREE.NeutralToneMapping : panic(new Error(`unknown tone mapping ${tone}`));
  pipeline.needsUpdate = true;
  element('#declination-value').textContent = `${Number(declinationInput.value).toFixed(1)}°`;
  element('#sea-value').textContent = `${Number(seaInput.value).toFixed(0)} m`;
  element('#exposure-value').textContent = `×${renderer.toneMappingExposure.toFixed(2)}`;
}
for (const input of [declinationInput, seaInput, exposureInput, toneInput, cloudsInput, weatherOnlyInput, coverageInput, airInput, multipleInput, oceanInput, starsInput]) {
  input.addEventListener('input', applySettings);
}
applySettings();

/** Height above the surface, pitch above the horizon, local time and (optionally) heading from north, over the current spot. */
const PRESETS: Record<string, { height: number; pitch: number; hours: number; heading?: number }> = {
  ground: { height: 2, pitch: 0.05, hours: 10 },
  sunset: { height: 300, pitch: 0.03, hours: 18.1, heading: 270 * DEG },
  night: { height: 2, pitch: 0.4, hours: 23 },
  cloud: { height: 0, pitch: 0, hours: 12 },
  plane: { height: 10e3, pitch: -0.08, hours: 15 },
  orbit: { height: 400e3, pitch: -0.3, hours: 9 },
  space: { height: 20e6, pitch: -Math.PI / 2, hours: 15 },
};
for (const button of document.querySelectorAll<HTMLElement>('[data-preset]')) {
  button.addEventListener('click', () => {
    const preset = PRESETS[button.dataset.preset ?? ''];
    if (!preset) throw new Error(`unknown preset ${button.dataset.preset}`);
    const here = where();
    const presetRadius = button.dataset.preset === 'cloud'
      ? radius + Math.max(Number(seaInput.value) + 3000, here.surface + OrbitView.MIN_HEIGHT)
      : radius + here.surface + preset.height;
    view.place(here.up, presetRadius, preset.heading ?? 0, Math.PI / 2 + preset.pitch);
    setLocalTime(preset.hours);
  });
}

// Mouse, as lab/lod: left drag pans, right drag orbits the planet centre, Shift + left drag turns, the wheel zooms.
const canvas = renderer.domElement;
type DragMode = 'pan' | 'orbit' | 'look';
let pointer: { id: number; x: number; y: number; mode: DragMode } | undefined;
canvas.addEventListener('contextmenu', (event) => event.preventDefault());
canvas.addEventListener('pointerdown', (event) => {
  if (pointer) return;
  if (event.button !== 0 && event.button !== 2) return;
  const mode: DragMode = event.button === 2 ? 'orbit' : event.shiftKey ? 'look' : 'pan';
  canvas.setPointerCapture(event.pointerId);
  pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, mode };
});
const endDrag = (event: PointerEvent) => {
  if (pointer?.id !== event.pointerId) return;
  pointer = undefined;
  if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
};
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('lostpointercapture', (event) => { if (pointer?.id === event.pointerId) pointer = undefined; });
window.addEventListener('blur', () => { pointer = undefined; });
canvas.addEventListener('pointermove', (event) => {
  if (!pointer || pointer.id !== event.pointerId) return;
  const dx = event.clientX - pointer.x;
  const dy = event.clientY - pointer.y;
  if (dx === 0 && dy === 0) return;
  const height = where().height;
  // lab/lod's 0.005 rad per pixel, slowed near the ground so a pixel stays about a pixel of ground.
  const orbitRate = 0.005 * Math.min(1, height / radius);
  if (pointer.mode === 'orbit') view.orbitAroundCenter(-dx * orbitRate, -dy * orbitRate);
  else if (pointer.mode === 'look') view.turn(-dx * 0.005, dy * 0.005);
  else view.panScreen(dx, dy, camera.fov * DEG, canvas.clientHeight, height);
  keepAboveSurface();
  frameDirty = true;
  pointer.x = event.clientX;
  pointer.y = event.clientY;
});
canvas.addEventListener('wheel', (event) => {
  event.preventDefault();
  frameDirty = true;
  const deltaPixels = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY * 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? event.deltaY * canvas.clientHeight : event.deltaY;
  // Scales the height above the surface: about ×1.2 per 100 px notch.
  const here = where();
  view.setRadius(radius + here.surface + here.height * Math.exp(THREE.MathUtils.clamp(deltaPixels, -500, 500) * 0.0018));
  keepAboveSurface();
}, { passive: false });

function resize(): void {
  frameDirty = true;
  const width = window.innerWidth, height = window.innerHeight;
  renderer.setPixelRatio(Math.min(1, 1920 / width, 1080 / height));
  renderer.setSize(width, height);
  pipeline.resize(renderer.domElement.width, renderer.domElement.height);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

/** Ground or sea height under the camera. */
function surfaceHeight(up: Vec3): number {
  const land = terrain.sample(up).heightMeters;
  return oceanInput.checked ? Math.max(land, Number(seaInput.value)) : land;
}

let last = performance.now();
let fps = 30;
let lastFrameTime = last;
const basisMatrix = new THREE.Matrix4();

await renderer.init();
const gl = (renderer.backend as unknown as { gl: WebGL2RenderingContext }).gl;
const gpuInfo = gl.getExtension('WEBGL_debug_renderer_info');
const gpuName: string = gl.getParameter(gpuInfo ? gpuInfo.UNMASKED_RENDERER_WEBGL : gl.RENDERER);

renderer.setAnimationLoop(() => {
  const now = performance.now();
  if (document.hidden || now - last < 1000 / 30) return;
  const animated = Number(rateInput.value) !== 0 || (oceanInput.checked && lastFrameHeight < 20000);
  const changed = frameDirty || renderedGroundRevision !== ground.revision;
  if (!changed && !animated) return;
  frameDirty = false;
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  fps += (1 / Math.max((now - lastFrameTime) / 1000, 1e-3) - fps) * 0.05;
  lastFrameTime = now;
  // High-orbit input redraws must not advance a paused ocean clock.
  if (oceanInput.checked && lastFrameHeight < 20000) seconds += dt;

  // The sun moves west as the planet turns east.
  subSolarLongitude -= Number(rateInput.value) * 15 * DEG * dt;
  if (document.activeElement !== timeInput) timeInput.value = localTime().toFixed(2);
  element('#time-value').textContent = formatHours(localTime());
  const declination = Number(declinationInput.value) * DEG;
  const sun: Vec3 = {
    x: Math.cos(declination) * Math.cos(subSolarLongitude),
    y: Math.cos(declination) * Math.sin(subSolarLongitude),
    z: Math.sin(declination),
  };

  // The sea slider or a terrain change may have put the surface above the camera.
  keepAboveSurface();
  const here = where();
  const { position, up } = here;
  const basis = view.basis();
  basisMatrix.makeBasis(
    new THREE.Vector3(basis.right.x, basis.right.y, basis.right.z),
    new THREE.Vector3(basis.up.x, basis.up.y, basis.up.z),
    new THREE.Vector3(basis.back.x, basis.back.y, basis.back.z));
  camera.quaternion.setFromRotationMatrix(basisMatrix);
  camera.updateMatrixWorld();

  const focalPixels = renderer.domElement.height / (2 * Math.tan((camera.fov * DEG) / 2));
  const selection = ground.update(position, focalPixels);
  atmosphere.update(position, sun, camera);
  clouds.update(position, focalPixels);
  lastFrameHeight = here.height;
  renderedGroundRevision = ground.revision;
  groundMaterial.update(position, seconds);

  // The sky turns with the sun. Stars fade where the camera is in sunlit air.
  sky.rotation.z = subSolarLongitude;
  const altitude = here.surface + here.height;
  const sunMu = up.x * sun.x + up.y * sun.y + up.z * sun.z;
  const daylight = smoothstep(-0.18, 0.02, sunMu) * (1 - smoothstep(0, 60e3, altitude)) * atmosphere.enabled.value;
  stars.brightness.value = 0.08 * (1 - daylight);

  pipeline.render(scene, camera);
  renderedFrames++;

  readout.textContent = [
    `height ${formatMeters(here.height)} AGL · ${formatMeters(altitude - Number(seaInput.value))} ASL`,
    `lat ${(here.latitude / DEG).toFixed(3)}° lon ${(here.longitude / DEG).toFixed(3)}° pitch ${((view.tiltRadians - Math.PI / 2) / DEG).toFixed(0)}°`,
    `sun ${(Math.asin(sunMu) / DEG).toFixed(1)}° above horizon`,
    `GPU ${gpuName}`,
    `render ${renderer.domElement.width}×${renderer.domElement.height} · air/cloud full size · ≤30 fps · idle stops · frame ${renderedFrames}`,
    `sky tables ${atmosphere.buildMilliseconds.toFixed(0)} ms · cloud noise ${clouds.buildMilliseconds.toFixed(0)} ms`,
    `tiles ${selection.render.length} drawn · ${ground.queuedBuilds} building · ${fps.toFixed(0)} fps`,
  ].join('\n');
});

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
function formatMeters(m: number): string {
  return m >= 1e5 ? `${(m / 1e3).toFixed(0)} km` : m >= 1e3 ? `${(m / 1e3).toFixed(2)} km` : `${m.toFixed(1)} m`;
}
function formatHours(h: number): string {
  const whole = Math.floor(h);
  return `${String(whole).padStart(2, '0')}:${String(Math.floor((h - whole) * 60)).padStart(2, '0')}`;
}
