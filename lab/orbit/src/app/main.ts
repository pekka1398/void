import * as THREE from 'three';
import { DEGREES, osculatingOrbit, Simulation, sub, type FrameSpec } from '../orbit';
import { CameraRig } from './CameraRig';
import { formatDistance, formatDuration, formatSpeed, formatWarp } from './Format';
import { Panel, TRAIL_SPANS, VESSEL_SPANS } from './Panel';
import { RENDER_SCALE, SceneView, type Focus } from './SceneView';
import { SYSTEM_PRESETS, type SystemPresetId } from './SystemPresets';

const WARPS = [1, 10, 100, 1e3, 1e4, 1e5, 1e6, 1e7] as const;
const MAX_VESSEL_STEPS_PER_FRAME = 20_000;
const RETENTION_MARGIN_SECONDS = 86_400;
const HOME_BODY: Record<SystemPresetId, string> = { sol: 'aurelia', binary: 'aurelia-veil' };

const root = document.querySelector<HTMLDivElement>('#app');
const overlay = document.querySelector<HTMLDivElement>('#overlay');
if (!root || !overlay) throw new Error('orbit lab: #app or #overlay missing');

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
  message.textContent = `ORBIT LAB PANIC\n${chain.join('\nCaused by:\n')}`;
  document.body.append(message);
  throw failure;
}
window.addEventListener('error', (e) => panic(e.error));
window.addEventListener('unhandledrejection', (e) => panic(e.reason));

const systemParam = new URLSearchParams(window.location.search).get('system') ?? 'sol';
if (!(systemParam in SYSTEM_PRESETS)) throw new RangeError(`unknown system preset "${systemParam}"`);
const systemId = systemParam as SystemPresetId;

let trailSpan = TRAIL_SPANS[2]![1];
let vesselSpan = VESSEL_SPANS[1]![1];
const sim = new Simulation({
  system: SYSTEM_PRESETS[systemId],
  stepsPerOrbit: 256,
  tolerances: { positionMeters: 1e-4, velocityMetersPerSecond: 1e-7 },
  vesselStart: { homeBodyId: HOME_BODY[systemId], altitudeMeters: 400e3, inclinationRadians: 0 * DEGREES },
  retentionSeconds: Math.max(trailSpan, vesselSpan) + RETENTION_MARGIN_SECONDS,
});
const home = sim.bodyIndex(HOME_BODY[systemId]);
let frame: FrameSpec = { kind: 'body-inertial', body: home };
let focus: Focus = { kind: 'body', index: home };
let warpIndex = 2;
let paused = false;

const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
renderer.setClearColor(0x03040a);
if (!(window.devicePixelRatio > 0)) throw new Error(`invalid devicePixelRatio ${window.devicePixelRatio}`);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
root.append(renderer.domElement);
const camera = new THREE.PerspectiveCamera(50, 1, 1, 2);
const rig = new CameraRig(renderer.domElement, 60_000, 5e10);
const view = new SceneView(sim, overlay, frame, trailSpan, vesselSpan, (picked) => setFocus(picked));

const panel = new Panel(document.body, sim.system.bodies, { frame, focus, trailSpan, vesselSpan, system: systemId }, {
  frame(spec) { frame = spec; view.setFrame(spec); },
  focus(next) { setFocus(next); },
  trailSpan(s) { trailSpan = s; view.setTrailSpan(s); updateRetention(); },
  vesselSpan(s) { vesselSpan = s; view.setVesselSpan(s); updateRetention(); },
  system(id) { window.location.search = `?system=${id}`; },
  resetVessel() { sim.resetVessel(); view.invalidatePaths(); },
});

function updateRetention(): void {
  sim.retentionSeconds = Math.max(trailSpan, vesselSpan) + RETENTION_MARGIN_SECONDS;
}

function setFocus(next: Focus): void {
  focus = next;
  panel.showFocus(next);
  if (next.kind === 'body') {
    const radiusKm = sim.system.bodies[next.index]!.radiusMeters * RENDER_SCALE;
    rig.minDistance = radiusKm * 1.05;
    rig.setDistance(radiusKm * 4);
  } else {
    rig.minDistance = 0.01;
    rig.setDistance(Math.min(rig.distance, 20_000));
  }
}
setFocus(focus);

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  if (e.code === 'Space') { paused = !paused; e.preventDefault(); }
  else if (e.code === 'Period') warpIndex = Math.min(WARPS.length - 1, warpIndex + 1);
  else if (e.code === 'Comma') warpIndex = Math.max(0, warpIndex - 1);
  else if (e.code === 'Tab') {
    e.preventDefault();
    const order: Focus[] = [{ kind: 'vessel' }, ...sim.system.bodies.map((b): Focus => ({ kind: 'body', index: b.index }))];
    const current = order.findIndex((f) => f.kind === focus.kind && (f.kind === 'vessel' || (focus.kind === 'body' && f.index === focus.index)));
    setFocus(order[(current + (e.shiftKey ? order.length - 1 : 1)) % order.length]!);
  }
});

function resize(): void {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
}
window.addEventListener('resize', resize);
resize();

let last = performance.now();
let lastReadout = 0;
let lastReport = { completed: true, steps: 0 };
let achievedWarp = 0;
document.addEventListener('visibilitychange', () => {
  // A hidden tab gets no frames; resume from now instead of replaying the gap.
  if (!document.hidden) last = performance.now();
});

function frameLoop(nowMs: number): void {
  if (stopped) return;
  try {
    const realDt = (nowMs - last) / 1000;
    last = nowMs;
    const warp = WARPS[warpIndex]!;
    const before = sim.time;
    if (!paused && realDt > 0) lastReport = sim.advance(realDt * warp, MAX_VESSEL_STEPS_PER_FRAME);
    achievedWarp = realDt > 0 ? (sim.time - before) / realDt : 0;
    rig.apply(camera);
    view.update(focus, camera, window.innerWidth, window.innerHeight);
    renderer.render(view.scene, camera);
    if (nowMs - lastReadout > 100) {
      lastReadout = nowMs;
      updateText(warp);
    }
  } catch (error) {
    panic(error);
  }
  requestAnimationFrame(frameLoop);
}

function updateText(warp: number): void {
  const lagging = !paused && !lastReport.completed;
  panel.setStatus([
    `T+ ${formatDuration(sim.time)}`,
    `warp ${formatWarp(warp)}${paused ? '  PAUSED' : ''}${lagging ? `  LAGGING (achieved ${achievedWarp.toExponential(1)}×)` : ''}`,
  ].join('\n'));

  const eph = sim.ephemeris;
  const lines = [
    `ephemeris  step ${eph.stepSeconds.toFixed(1)} s, ${(eph.retainedBytes / 2 ** 20).toFixed(1)} MiB`,
    `  from     T+ ${formatDuration(eph.startTime)}`,
    `  to       T+ ${formatDuration(eph.endTime)}`,
    `vessel     ${lastReport.steps} steps last frame`,
  ];
  if (sim.impact) {
    lines.push(`IMPACT on ${sim.system.bodies[sim.impact.bodyIndex]!.name} at T+ ${formatDuration(sim.impact.time)}`);
  } else {
    const positions = new Float64Array(eph.bodyCount * 3);
    const velocities = new Float64Array(eph.bodyCount * 3);
    eph.statesAt(sim.time, positions, velocities);
    const vessel = sim.vessel;
    const d = sim.dominance.dominant(positions, vessel.position);
    const body = sim.system.bodies[d]!;
    const r = sub(vessel.position, { x: positions[d * 3]!, y: positions[d * 3 + 1]!, z: positions[d * 3 + 2]! });
    const v = sub(vessel.velocity, { x: velocities[d * 3]!, y: velocities[d * 3 + 1]!, z: velocities[d * 3 + 2]! });
    const osc = osculatingOrbit(r, v, body.gm);
    const R = body.radiusMeters;
    lines.push(
      '',
      `reference  ${body.name} (sphere of influence)`,
      `altitude   ${formatDistance(Math.hypot(r.x, r.y, r.z) - R)}`,
      `speed      ${formatSpeed(Math.hypot(v.x, v.y, v.z))}`,
      `periapsis  ${formatDistance(osc.periapsisRadiusMeters - R)} alt`,
      `apoapsis   ${Number.isFinite(osc.apoapsisRadiusMeters) ? `${formatDistance(osc.apoapsisRadiusMeters - R)} alt` : 'none (escape)'}`,
      `ecc        ${osc.eccentricity.toFixed(6)}`,
      `incl       ${(osc.inclinationRadians / DEGREES).toFixed(3)}° to ecliptic`,
      `period     ${formatDuration(osc.periodSeconds)}`,
      '(osculating two-body values)',
    );
  }
  panel.setReadout(lines.join('\n'));
}

requestAnimationFrame(frameLoop);
