import * as THREE from 'three/webgpu';
import { PlanetLod, TileRenderer, TileWorkerPool, type LodSelection } from '../lod';
import { DebugPanel } from './DebugPanel';
import { planetPreset, type PlanetPresetId } from './PlanetPresets';
import { OrbitCamera } from './OrbitCamera';
import { SphericalProbe, type ProbeAxis, type ProbeDrag } from './SphericalProbe';
import { BENCH_SCENARIOS } from './BenchScenarios';
import { BrowserBench, type BenchScenarioResult } from './BrowserBench';
import type { Vec3 } from '../lod/Vec3';

const root = document.querySelector<HTMLDivElement>('#app');
if (!root) throw new Error('LOD lab root is missing');

const searchParams = new URLSearchParams(window.location.search);
const presetId = searchParams.get('preset') ?? 'seam';
const preset = planetPreset(presetId);
// ?bench=all or ?bench=ascent,low-traverse runs scripted scenarios (landing preset only) and logs the
// results to lab-log/lod-bench.jsonl through the dev server.
const benchParam = searchParams.get('bench');
const benchSlug = (name: string) => name.replaceAll(' ', '-');
const benchScenarios = benchParam === null ? [] : benchParam === 'all' ? BENCH_SCENARIOS
  : benchParam.split(',').map((slug) => {
    const scenario = BENCH_SCENARIOS.find((candidate) => benchSlug(candidate.name) === slug);
    if (!scenario) throw new Error(`main.ts: unknown bench scenario=${JSON.stringify(slug)}; valid=all,${BENCH_SCENARIOS.map((s) => benchSlug(s.name)).join(',')}`);
    return scenario;
  });
// ?aa=0 turns MSAA off, for measuring its cost.
const antialias = searchParams.get('aa') !== '0';
if (benchParam !== null && presetId !== 'landing') throw new Error(`main.ts: bench scenarios assume the landing preset; preset=${presetId}`);
const radius = preset.radiusMeters;
const resolution = preset.tileResolution;
const metersPerRenderUnit = preset.metersPerRenderUnit;
const lod = new PlanetLod({
  radiusMeters: radius,
  minSurfaceHeightMeters: preset.minSurfaceHeightMeters,
  maxSurfaceHeightMeters: preset.maxSurfaceHeightMeters,
  occluderRadiusMeters: preset.occluderRadiusMeters,
  lodSurfaceBandMeters: preset.lodSurfaceBandMeters,
  resolution,
  maxLevel: preset.maxLevel,
  splitDistanceRatios: preset.splitDistanceRatios,
  maxCachedTiles: preset.maxCachedTiles,
});
const orbit = new OrbitCamera({
  maxDistanceMeters: radius * preset.camera.maxDistanceRadii,
}, { x: preset.camera.initialDirection[0], y: preset.camera.initialDirection[1], z: preset.camera.initialDirection[2] }, radius * preset.camera.initialDistanceRadii);
const tiles = new TileRenderer({ resolution, metersPerRenderUnit });
const startDirection = new THREE.Vector3(...preset.camera.initialDirection).normalize();
const probe = new SphericalProbe(radius, metersPerRenderUnit, {
  r: radius * preset.probe.initialRadiusRadii,
  theta: Math.acos(startDirection.y),
  // Start off the camera's radial sightline so all three drag axes are visible.
  phi: Math.atan2(startDirection.z, startDirection.x) + preset.probe.initialPhiOffsetRadians,
});
const scene = new THREE.Scene();
scene.add(tiles.group);
scene.add(probe.group);
scene.add(new THREE.HemisphereLight(0xd6edff, 0x354963, 2));
const sun = new THREE.DirectionalLight(0xffe1ba, 3);
sun.position.set(700, 850, 1000);
scene.add(sun);

const camera = new THREE.PerspectiveCamera(preset.camera.fovDegrees, 1, 0.0001, 30000);
const renderer = new THREE.WebGPURenderer({
  antialias,
  logarithmicDepthBuffer: true,
  forceWebGL: true,
  // Timer queries cost a little every frame; only the benchmark asks for them.
  trackTimestamp: benchParam !== null,
});
renderer.setClearColor(0x05060a);
// Three's internal animation loop resets info on every browser frame, which can land between an awaited
// renderAsync and reading its counts. Reset it right before each render instead.
renderer.info.autoReset = false;
if (!Number.isFinite(window.devicePixelRatio) || window.devicePixelRatio <= 0) {
  throw new Error(`main.ts: invalid devicePixelRatio=${window.devicePixelRatio}`);
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
root.append(renderer.domElement);
let disposed = false;
function panic(error: unknown): never {
  const failure = error instanceof Error ? error : new Error(`Non-Error thrown: ${String(error)}`);
  if (disposed) throw failure;
  disposed = true;
  workers.dispose();
  const message = document.createElement('pre');
  const chain: string[] = [];
  let current: unknown = failure;
  while (current instanceof Error) {
    chain.push(current.stack ?? `${current.name}: ${current.message}`);
    current = current.cause;
  }
  if (current !== undefined) chain.push(`Non-Error cause: ${String(current)}`);
  message.textContent = `LOD LAB PANIC\n${chain.join('\nCaused by:\n')}`;
  // Dev server only: keep a copy in lab-log/lod-panic.jsonl, where it can be read without the page.
  if (import.meta.env.DEV) {
    void fetch('/__lab-log/lod-panic', { method: 'POST', body: `${JSON.stringify({ date: new Date().toISOString(), href: window.location.href, chain })}\n` })
      .catch((postError: unknown) => console.error('main.ts panic: lab-log POST failed', postError));
  }
  message.style.cssText = 'position:fixed;inset:12px;z-index:9999;overflow:auto;margin:0;padding:20px;background:#260d14;color:#ffe0e5;white-space:pre-wrap;';
  root!.append(message);
  throw failure;
}
const workers = new TileWorkerPool(() => new Worker(new URL('./tile.worker.ts', import.meta.url), { type: 'module' }),
  { radiusMeters: radius, resolution }, presetId as PlanetPresetId, (data) => {
  lod.acceptTile(data);
  lod.unpinBuild(data.id);
}, panic, preset.workerCount, (id) => lod.pinBuild(id));

let frozen = false;
let lodDistanceScale: number = preset.initialDistanceScale;
let horizonCulling: boolean = preset.debug.horizonCulling;
let cameraLod: boolean = preset.debug.cameraLod;
let selection: LodSelection | undefined;
const panel = new DebugPanel(root, {
  onPreset: (nextId) => {
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set('preset', nextId);
    window.location.assign(nextUrl.href);
  },
  onFreeze: (value) => { frozen = value; },
  onColorMode: (value) => tiles.setColorMode(value),
  onGridLines: (value) => tiles.setGridLines(value),
  onMeshWireframe: (value) => tiles.setMeshWireframe(value),
  onTileBoundaries: (value) => tiles.setTileBoundaries(value),
  onSkirts: (value) => tiles.setSkirts(value),
  onSkirtHighlight: (value) => tiles.setSkirtHighlight(value),
  onCameraLod: (value) => { cameraLod = value; },
  onHorizonCulling: (value) => { horizonCulling = value; },
  onLodDistanceScale: (value) => { lodDistanceScale = value; },
}, lodDistanceScale, preset.debug, presetId as PlanetPresetId);

const resize = () => {
  const width = Math.max(1, root.clientWidth);
  const height = Math.max(1, root.clientHeight);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height);
};
const resizeObserver = new ResizeObserver(resize);
resizeObserver.observe(root);
resize();

type DragMode = 'pan' | 'orbit' | 'look' | ProbeAxis;
let pointer: { id: number; x: number; y: number; mode: DragMode; probeDrag?: ProbeDrag } | undefined;
const canvas = renderer.domElement;
canvas.addEventListener('contextmenu', (event) => event.preventDefault());
canvas.addEventListener('pointerdown', (event) => {
  if (pointer) return;
  if (event.button !== 0 && event.button !== 2) return;
  const axis = event.button === 0 ? probe.pick(event.clientX, event.clientY, canvas, camera) : undefined;
  const mode: DragMode = axis ?? (event.button === 2 ? 'orbit' : event.shiftKey ? 'look' : 'pan');
  const probeDrag = axis ? probe.beginDrag(axis, event.clientX, event.clientY, camera, canvas) : undefined;
  canvas.setPointerCapture(event.pointerId);
  pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, mode, probeDrag };
  event.preventDefault();
});
const endDrag = (event: PointerEvent) => {
  if (pointer?.id !== event.pointerId) return;
  pointer = undefined;
  if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
};
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('lostpointercapture', (event) => {
  if (pointer?.id === event.pointerId) pointer = undefined;
});
window.addEventListener('blur', () => { pointer = undefined; });
canvas.addEventListener('pointermove', (event) => {
  if (!pointer || pointer.id !== event.pointerId) return;
  event.preventDefault();
  const dx = event.clientX - pointer.x;
  const dy = event.clientY - pointer.y;
  if (pointer.mode === 'orbit') orbit.orbitAroundCenter(-dx * 0.005, -dy * 0.005);
  else if (pointer.mode === 'look') orbit.turn(-dx * 0.005, dy * 0.005);
  else if (pointer.mode === 'pan') orbit.panScreen(dx, dy, camera.fov * Math.PI / 180, root.clientHeight);
  else {
    if (!pointer.probeDrag) throw new Error(`main.ts pointermove: ${pointer.mode} drag has no captured probe state; pointerId=${pointer.id}`);
    probe.drag(pointer.probeDrag, event.clientX, event.clientY);
  }
  pointer.x = event.clientX;
  pointer.y = event.clientY;
});
canvas.addEventListener('wheel', (event) => {
  event.preventDefault();
  const deltaPixels = event.deltaY * (event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 :
    event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? root.clientHeight : 1);
  orbit.zoom(Math.exp(THREE.MathUtils.clamp(deltaPixels, -500, 500) * 0.0001));
}, { passive: false });
window.addEventListener('keydown', (event) => {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
  panel.handleKey(event.code);
});

const bench = benchScenarios.length > 0 ? new BrowserBench(benchScenarios, (results) => { void reportBench(results).catch(panic); }) : undefined;

async function reportBench(results: readonly BenchScenarioResult[]): Promise<void> {
  const backend = renderer.backend as unknown as { gl?: WebGL2RenderingContext; disjoint?: unknown };
  const gl = backend.gl;
  const debugInfo = gl?.getExtension('WEBGL_debug_renderer_info');
  const report = {
    event: 'lod-bench', date: new Date().toISOString(), href: window.location.href, preset: presetId, userAgent: navigator.userAgent,
    gpu: gl && debugInfo ? String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)) : null,
    timerQuery: !!backend.disjoint, multiDraw: renderer.hasFeature('WEBGL_multi_draw'), pixelRatio: renderer.getPixelRatio(),
    canvas: [renderer.domElement.width, renderer.domElement.height], workers: workers.workerCount,
    antialias, cameraLod, horizonCulling, lodDistanceScale, results,
  };
  console.log('lod-bench', report);
  const response = await fetch('/__lab-log/lod-bench', { method: 'POST', body: `${JSON.stringify(report)}\n` });
  if (!response.ok) throw new Error(`main.ts reportBench: lab-log POST failed; status=${response.status}; ${await response.text()}`);
}

/** Camera pose looking from `eye` at `target`, up as close to the local vertical as the view allows. */
function lookPose(eye: Vec3, target: Vec3): { position: Vec3; forward: Vec3; up: Vec3 } {
  const unit = (v: Vec3) => { const l = Math.hypot(v.x, v.y, v.z); return { x: v.x / l, y: v.y / l, z: v.z / l }; };
  const forward = unit({ x: target.x - eye.x, y: target.y - eye.y, z: target.z - eye.z });
  for (const candidate of [unit(eye), { x: 0, y: 1, z: 0 }, { x: 1, y: 0, z: 0 }]) {
    const along = candidate.x * forward.x + candidate.y * forward.y + candidate.z * forward.z;
    const up = { x: candidate.x - forward.x * along, y: candidate.y - forward.y * along, z: candidate.z - forward.z * along };
    if (Math.hypot(up.x, up.y, up.z) > 1e-3) return { position: eye, forward, up: unit(up) };
  }
  throw new Error(`main.ts lookPose: no up vector; eye=${JSON.stringify(eye)}; target=${JSON.stringify(target)}`);
}

let previous = performance.now();
let lastPanelUpdate = 0;
let latestGpuMilliseconds: number | null = null;
async function renderFrame(now: number): Promise<void> {
  if (disposed) return;
  const frameMilliseconds = now - previous;
  previous = now;
  const benchFrame = bench?.frame();
  if (benchFrame) {
    const { x, y, z } = benchFrame.probe;
    const r = Math.hypot(x, y, z);
    probe.set({ r, theta: Math.acos(y / r), phi: Math.atan2(z, x) });
  }
  const pose = benchFrame ? lookPose(benchFrame.camera, benchFrame.target) : orbit.pose();
  const probePosition = probe.position;
  camera.position.set(0, 0, 0);
  camera.up.set(pose.up.x, pose.up.y, pose.up.z);
  camera.lookAt(pose.forward.x, pose.forward.y, pose.forward.z);
  camera.updateMatrixWorld();
  probe.sync(pose.position);
  let queueMilliseconds = 0;
  if (!frozen || !selection || benchFrame) {
    selection = lod.select({
      observerPositions: [probePosition],
      camera: cameraLod ? { position: pose.position, ...preset.lodCamera } : undefined,
      distanceScale: lodDistanceScale,
      horizonCulling,
    });
    const queueStarted = performance.now();
    workers.setWanted(selection.requests);
    queueMilliseconds = performance.now() - queueStarted;
  }
  const syncStarted = performance.now();
  tiles.sync(selection.render, pose.position);
  const syncMilliseconds = performance.now() - syncStarted;
  const gpuCreated = tiles.createdLastSync;
  const gpuDisposed = tiles.disposedLastSync;
  renderer.info.reset();
  const renderStarted = performance.now();
  await renderer.renderAsync(scene, camera);
  const renderWaitMilliseconds = performance.now() - renderStarted;
  const drawCalls = renderer.info.render.drawCalls;
  const triangles = renderer.info.render.triangles;
  const lines = renderer.info.render.lines;
  if (bench && benchFrame) {
    // Not awaited: waiting for the query would hold this frame past the next vsync. The value
    // recorded is the latest resolved one, a frame or more late.
    void renderer.resolveTimestampsAsync('render').then((value) => {
      if (typeof value === 'number' && Number.isFinite(value)) latestGpuMilliseconds = value;
    }).catch(panic);
    const gpuMilliseconds = latestGpuMilliseconds;
    bench.record({
      rafMs: frameMilliseconds, selectMs: selection.selectMilliseconds, walkMs: selection.traversalMilliseconds,
      balanceMs: selection.balanceMilliseconds, evictMs: selection.evictionMilliseconds, queueMs: queueMilliseconds,
      syncMs: syncMilliseconds, renderCpuMs: renderWaitMilliseconds,
      gpuMs: gpuMilliseconds,
      drawCalls, triangles, drawn: selection.render.length,
      requests: selection.requests.length, collapses: selection.balanceCollapses.length,
    }, {
      requests: selection.requests.length, queued: workers.queuedCount, inFlight: workers.inFlightCount,
      built: workers.totalBuilt, buildMillisecondsTotal: workers.averageBuildMilliseconds * workers.totalBuilt,
    }, performance.now());
  }
  if (now - lastPanelUpdate > 150) {
    lastPanelUpdate = now;
    panel.update({
      frameMilliseconds,
      centerDistanceMeters: orbit.distanceMeters,
      altitudeMeters: Math.hypot(pose.position.x, pose.position.y, pose.position.z) - radius,
      tiltDegrees: orbit.tiltRadians * 180 / Math.PI,
      probeRadiusMeters: probe.spherical.r,
      probeAltitudeMeters: probe.spherical.r - radius,
      probeThetaDegrees: probe.spherical.theta * 180 / Math.PI,
      probePhiDegrees: probe.spherical.phi * 180 / Math.PI,
      probeDistanceMeters: Math.hypot(
        probePosition.x - pose.position.x,
        probePosition.y - pose.position.y,
        probePosition.z - pose.position.z,
      ),
      selection,
      drawn: tiles.drawnTileCount,
      cachedTiles: lod.cachedTileCount,
      cachedMeshBytes: lod.cachedMeshBytes,
      rendererCopyBytes: tiles.rendererCopyBytes,
      nodes: lod.nodeCount,
      workers: workers.workerCount,
      queued: workers.queuedCount,
      inFlight: workers.inFlightCount,
      built: workers.totalBuilt,
      averageBuildMilliseconds: workers.averageBuildMilliseconds,
      averageSampleMilliseconds: workers.averageSampleMilliseconds,
      averageFinishMilliseconds: workers.averageFinishMilliseconds,
      syncMilliseconds,
      renderWaitMilliseconds,
      gpuCreated,
      gpuDisposed,
      drawCalls,
      triangles,
      lines,
      spacingMeters: (level) => lod.spacingMeters(level),
      frozen,
      bench: bench?.status,
    });
  }
  requestAnimationFrame((time) => { void renderFrame(time).catch(panic); });
}

void renderer.init().then(() => {
  if (!('isWebGLBackend' in renderer.backend) || renderer.backend.isWebGLBackend !== true) {
    throw new Error(`main.ts: expected explicit WebGL2 backend; actual backend=${renderer.backend.constructor.name}`);
  }
  requestAnimationFrame((time) => { void renderFrame(time).catch(panic); });
}).catch(panic);

if (import.meta.hot) import.meta.hot.dispose(() => {
  disposed = true;
  resizeObserver.disconnect();
  workers.dispose();
  tiles.dispose();
  probe.dispose();
  renderer.dispose();
});
