import * as THREE from 'three/webgpu';
import { PlanetLod, TileRenderer, type LodSelection, type Vec3 } from '../lod';
import { DebugPanel } from './DebugPanel';
import { DEMO_MAX_HEIGHT_METERS, DEMO_RADIUS_METERS, sampleDemoSurface } from './DemoSurface';
import { OrbitCamera } from './OrbitCamera';
import { TileWorkerPool } from './TileWorkerPool';

const root = document.querySelector<HTMLDivElement>('#app');
if (!root) throw new Error('LOD lab root is missing');

const radius = DEMO_RADIUS_METERS;
const resolution = 33;
const metersPerRenderUnit = 10_000;
const lod = new PlanetLod({
  radiusMeters: radius,
  minSurfaceHeightMeters: 0,
  maxSurfaceHeightMeters: DEMO_MAX_HEIGHT_METERS,
  occluderRadiusMeters: radius,
  resolution,
  maxLevel: 13,
  maxCachedTiles: 1800,
});
const orbit = new OrbitCamera({
  radiusMeters: radius,
  groundHeightMeters: (direction) => sampleDemoSurface(direction).heightMeters,
  minClearanceMeters: 5,
}, { x: 0.48, y: 0.33, z: 0.81 }, radius * 1.7);
const tiles = new TileRenderer({ resolution, metersPerRenderUnit });
const scene = new THREE.Scene();
scene.add(tiles.group);
scene.add(new THREE.HemisphereLight(0xd6edff, 0x354963, 2));
const sun = new THREE.DirectionalLight(0xffe1ba, 3);
sun.position.set(700, 850, 1000);
scene.add(sun);

const camera = new THREE.PerspectiveCamera(60, 1, 0.0001, 30000);
const renderer = new THREE.WebGPURenderer({
  antialias: true,
  logarithmicDepthBuffer: true,
  forceWebGL: true,
});
renderer.setClearColor(0x05060a);
if (!Number.isFinite(window.devicePixelRatio) || window.devicePixelRatio <= 0) {
  throw new Error(`main.ts: invalid devicePixelRatio=${window.devicePixelRatio}`);
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
root.append(renderer.domElement);
let disposed = false;
function panic(error: unknown): never {
  disposed = true;
  const failure = error instanceof Error ? error : new Error(`Non-Error thrown: ${String(error)}`);
  const message = document.createElement('pre');
  const chain: string[] = [];
  let current: unknown = failure;
  while (current instanceof Error) {
    chain.push(current.stack ?? `${current.name}: ${current.message}`);
    current = current.cause;
  }
  if (current !== undefined) chain.push(`Non-Error cause: ${String(current)}`);
  message.textContent = `LOD LAB PANIC\n${chain.join('\nCaused by:\n')}`;
  message.style.cssText = 'position:fixed;inset:12px;z-index:9999;overflow:auto;margin:0;padding:20px;background:#260d14;color:#ffe0e5;white-space:pre-wrap;';
  root!.append(message);
  throw failure;
}
const workers = new TileWorkerPool({ radiusMeters: radius, resolution }, (data) => lod.acceptTile(data), panic, 4);

let frozen = false;
let gridErrorPixels = 4;
let horizonCulling = true;
let frustumCulling = true;
let selection: LodSelection | undefined;
const panel = new DebugPanel(root, {
  onFreeze: (value) => { frozen = value; },
  onColorMode: (value) => tiles.setColorMode(value),
  onGridLines: (value) => tiles.setGridLines(value),
  onTileBorders: (value) => tiles.setTileBorders(value),
  onSkirts: (value) => tiles.setSkirts(value),
  onSkirtHighlight: (value) => tiles.setSkirtHighlight(value),
  onHorizonCulling: (value) => { horizonCulling = value; },
  onFrustumCulling: (value) => { frustumCulling = value; },
  onScreenError: (value) => { gridErrorPixels = value; },
}, gridErrorPixels);

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

let pointer: { x: number; y: number; turning: boolean } | undefined;
const canvas = renderer.domElement;
canvas.addEventListener('contextmenu', (event) => event.preventDefault());
canvas.addEventListener('pointerdown', (event) => {
  canvas.setPointerCapture(event.pointerId);
  pointer = { x: event.clientX, y: event.clientY, turning: event.button === 2 || event.shiftKey };
});
canvas.addEventListener('pointerup', () => { pointer = undefined; });
canvas.addEventListener('pointercancel', () => { pointer = undefined; });
canvas.addEventListener('pointermove', (event) => {
  if (!pointer) return;
  const dx = event.clientX - pointer.x;
  const dy = event.clientY - pointer.y;
  if (pointer.turning || event.shiftKey) orbit.turn(-dx * 0.005, dy * 0.005);
  else {
    const meters = orbit.metersPerPixel(camera.fov * Math.PI / 180, root.clientHeight);
    orbit.pan(dy * meters, -dx * meters);
  }
  pointer.x = event.clientX;
  pointer.y = event.clientY;
});
canvas.addEventListener('wheel', (event) => {
  event.preventDefault();
  orbit.zoom(Math.exp(event.deltaY * 0.001));
}, { passive: false });
window.addEventListener('keydown', (event) => {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
  panel.handleKey(event.code);
});

let previous = performance.now();
let lastPanelUpdate = 0;
async function renderFrame(now: number): Promise<void> {
  if (disposed) return;
  const frameMilliseconds = now - previous;
  previous = now;
  const pose = orbit.pose();
  camera.position.set(0, 0, 0);
  camera.up.set(pose.up.x, pose.up.y, pose.up.z);
  camera.lookAt(pose.forward.x, pose.forward.y, pose.forward.z);
  camera.updateMatrixWorld();
  const frustum = new THREE.Frustum().setFromProjectionMatrix(
    new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
  );
  if (!frozen || !selection) {
    selection = lod.select({
      cameraPosition: pose.position,
      viewportHeightPixels: root!.clientHeight,
      fovYRadians: camera.fov * Math.PI / 180,
      maxScreenErrorPixels: gridErrorPixels,
      horizonCulling,
      isSphereVisible: frustumCulling ? (center: Vec3, boundRadius: number) => frustum.intersectsSphere(
        new THREE.Sphere(new THREE.Vector3(
          (center.x - pose.position.x) / metersPerRenderUnit,
          (center.y - pose.position.y) / metersPerRenderUnit,
          (center.z - pose.position.z) / metersPerRenderUnit,
        ), boundRadius / metersPerRenderUnit),
      ) : undefined,
    });
    workers.setWanted(selection.requests);
  }
  tiles.sync(selection.render, pose.position);
  await renderer.renderAsync(scene, camera);
  if (now - lastPanelUpdate > 150) {
    lastPanelUpdate = now;
    panel.update({
      frameMilliseconds,
      clearanceMeters: orbit.clearanceMeters,
      altitudeMeters: Math.hypot(pose.position.x, pose.position.y, pose.position.z) - radius,
      tiltDegrees: orbit.tiltRadians * 180 / Math.PI,
      selection,
      drawn: tiles.drawnTileCount,
      cachedTiles: lod.cachedTileCount,
      nodes: lod.nodeCount,
      workers: workers.workerCount,
      queued: workers.queuedCount,
      inFlight: workers.inFlightCount,
      built: workers.totalBuilt,
      averageBuildMilliseconds: workers.averageBuildMilliseconds,
      spacingMeters: (level) => lod.spacingMeters(level),
      frozen,
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
  renderer.dispose();
});
