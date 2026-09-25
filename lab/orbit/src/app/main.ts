import * as THREE from 'three';
import { cross, DEGREES, dot, findApsides, length, osculatingOrbit, Simulation, spinAxis, sub, type AttitudeMode, type FrameSpec } from '../orbit';
import { CameraRig } from './CameraRig';
import { formatDistance, formatDuration, formatSpeed, formatWarp } from './Format';
import { Panel, PREDICTION_SPANS, TRAIL_SPANS, VESSEL_SPANS } from './Panel';
import { RENDER_SCALE, SceneView, type Focus, type TrajectoryEvent } from './SceneView';
import { SYSTEM_PRESETS, type SystemPresetId } from './SystemPresets';

const WARPS = [1, 10, 100, 1e3, 1e4, 1e5, 1e6, 1e7] as const;
const MAX_VESSEL_STEPS_PER_FRAME = 20_000;
const MAX_PREDICTION_STEPS_PER_FRAME = 4_000;
const RETENTION_MARGIN_SECONDS = 86_400;
const THROTTLE_RATE_PER_SECOND = 0.5;
const MAX_APSIDES = 6;
const HOME_BODY: Record<SystemPresetId, string> = { sol: 'aurelia', binary: 'aurelia-veil' };
const ATTITUDE_KEYS: Record<string, AttitudeMode> = {
  Digit1: 'prograde', Digit2: 'retrograde', Digit3: 'normal', Digit4: 'antinormal',
  Digit5: 'radial-out', Digit6: 'radial-in', Digit7: 'hold',
};

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
const predictionSpan = PREDICTION_SPANS[1]![1];
const sim = new Simulation({
  system: SYSTEM_PRESETS[systemId],
  stepsPerOrbit: 256,
  tolerances: { positionMeters: 1e-4, velocityMetersPerSecond: 1e-7 },
  vesselStart: { homeBodyId: HOME_BODY[systemId], altitudeMeters: 400e3, inclinationRadians: 0 * DEGREES },
  // Chemical stage: 250 kN, Isp 350 s, 10 t dry + 30 t propellant = 4.76 km/s.
  engine: { thrustNewtons: 250e3, specificImpulseSeconds: 350, dryMassKg: 10e3, fuelMassKg: 30e3 },
  retentionSeconds: Math.max(trailSpan, vesselSpan) + RETENTION_MARGIN_SECONDS,
  predictionHorizonSeconds: predictionSpan,
});
const home = sim.bodyIndex(HOME_BODY[systemId]);
let frame: FrameSpec = { kind: 'body-inertial', body: home };
let focus: Focus = { kind: 'body', index: home };
let warpIndex = 2;
let paused = false;
const held = new Set<string>();

const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
renderer.setClearColor(0x03040a);
if (!(window.devicePixelRatio > 0)) throw new Error(`invalid devicePixelRatio ${window.devicePixelRatio}`);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
root.append(renderer.domElement);
const camera = new THREE.PerspectiveCamera(50, 1, 1, 2);
const rig = new CameraRig(renderer.domElement, 60_000, 5e10);
const view = new SceneView(sim, overlay, frame, trailSpan, vesselSpan, (picked) => setFocus(picked));

const panel = new Panel(document.body, sim.system.bodies, { frame, focus, trailSpan, vesselSpan, predictionSpan, system: systemId }, {
  frame(spec) { frame = spec; view.setFrame(spec); },
  focus(next) { setFocus(next); },
  trailSpan(s) { trailSpan = s; view.setTrailSpan(s); updateRetention(); },
  vesselSpan(s) { vesselSpan = s; view.setVesselSpan(s); updateRetention(); },
  system(id) { window.location.search = `?system=${id}`; },
  resetVessel() { sim.resetVessel(); view.invalidatePaths(); },
  attitude(mode) { setAttitude(mode); },
  reference(index) { sim.referenceChoice = index; },
  predictionHorizon(s) { sim.predictionHorizonSeconds = s; },
});
panel.showAttitude(sim.attitudeMode);

function setAttitude(mode: AttitudeMode): void {
  sim.setAttitude(mode);
  panel.showAttitude(mode);
}

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

function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLSelectElement;
}

window.addEventListener('keydown', (e) => {
  if (isTyping(e.target)) return;
  held.add(e.code);
  const attitude = ATTITUDE_KEYS[e.code];
  if (attitude) setAttitude(attitude);
  else if (e.code === 'Space') { paused = !paused; e.preventDefault(); }
  else if (e.code === 'Period') warpIndex = Math.min(WARPS.length - 1, warpIndex + 1);
  else if (e.code === 'Comma') warpIndex = Math.max(0, warpIndex - 1);
  else if (e.code === 'KeyZ') sim.throttle = 1;
  else if (e.code === 'KeyX') sim.throttle = 0;
  else if (e.code === 'Tab') {
    e.preventDefault();
    const order: Focus[] = [{ kind: 'vessel' }, ...sim.system.bodies.map((b): Focus => ({ kind: 'body', index: b.index }))];
    const current = order.findIndex((f) => f.kind === focus.kind && (f.kind === 'vessel' || (focus.kind === 'body' && f.index === focus.index)));
    setFocus(order[(current + (e.shiftKey ? order.length - 1 : 1)) % order.length]!);
  }
});
window.addEventListener('keyup', (e) => held.delete(e.code));
window.addEventListener('blur', () => held.clear());

function resize(): void {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
}
window.addEventListener('resize', resize);
resize();

let last = performance.now();
let lastReadout = 0;
let lastReport = { completed: true, steps: 0, thrusted: false };
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
    const up = Number(held.has('ShiftLeft') || held.has('ShiftRight'));
    const down = Number(held.has('ControlLeft') || held.has('ControlRight'));
    if (up !== down && !sim.impact) {
      sim.throttle = Math.min(1, Math.max(0, sim.throttle + (up - down) * THROTTLE_RATE_PER_SECOND * realDt));
    }
    const warp = WARPS[warpIndex]!;
    const before = sim.time;
    if (!paused && realDt > 0) lastReport = sim.advance(realDt * warp, MAX_VESSEL_STEPS_PER_FRAME);
    sim.extendPrediction(MAX_PREDICTION_STEPS_PER_FRAME);
    achievedWarp = realDt > 0 ? (sim.time - before) / realDt : 0;
    rig.apply(camera);
    view.update(focus, camera, window.innerWidth, window.innerHeight, rig.distance * 0.12);
    renderer.render(view.scene, camera);
    panel.setThrottle(sim.throttle, sim.throttle > 0 && sim.fuelKg > 0);
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
    '',
    `mass       ${(sim.vessel.massKg / 1000).toFixed(3)} t (fuel ${(sim.fuelKg / 1000).toFixed(3)} t)`,
    `Δv left    ${formatSpeed(sim.deltaVRemaining)}`,
    `accel      ${(sim.engine.thrustNewtons * sim.throttle / sim.vessel.massKg).toFixed(3)} m/s² `
      + `(full ${(sim.engine.thrustNewtons / sim.vessel.massKg).toFixed(2)})`,
  ];
  const events: TrajectoryEvent[] = [];
  if (sim.impact) {
    lines.push('', `IMPACT on ${sim.system.bodies[sim.impact.bodyIndex]!.name} at T+ ${formatDuration(sim.impact.time)}`);
  } else {
    const positions = new Float64Array(eph.bodyCount * 3);
    const velocities = new Float64Array(eph.bodyCount * 3);
    eph.statesAt(sim.time, positions, velocities);
    const vessel = sim.vessel;
    const ref = sim.navigationReference();
    const body = sim.system.bodies[ref]!;
    const r = sub(vessel.position, { x: positions[ref * 3]!, y: positions[ref * 3 + 1]!, z: positions[ref * 3 + 2]! });
    const v = sub(vessel.velocity, { x: velocities[ref * 3]!, y: velocities[ref * 3 + 1]!, z: velocities[ref * 3 + 2]! });
    const osc = osculatingOrbit(r, v, body.gm);
    const R = body.radiusMeters;
    const h = cross(r, v);
    const equatorialInclination = Math.acos(Math.max(-1, Math.min(1, dot(h, spinAxis(body)) / length(h))));
    lines.push(
      '',
      `reference  ${body.name}${sim.referenceChoice === null ? ' (sphere of influence)' : ''}`,
      `altitude   ${formatDistance(Math.hypot(r.x, r.y, r.z) - R)}`,
      `speed      ${formatSpeed(Math.hypot(v.x, v.y, v.z))}`,
      `osculating Pe ${formatDistance(osc.periapsisRadiusMeters - R)}`,
      `           Ap ${Number.isFinite(osc.apoapsisRadiusMeters) ? formatDistance(osc.apoapsisRadiusMeters - R) : 'none (escape)'}`,
      `           e ${osc.eccentricity.toFixed(6)}`,
      `           i ${(equatorialInclination / DEGREES).toFixed(3)}° to ${body.name} equator`,
      `             ${(osc.inclinationRadians / DEGREES).toFixed(3)}° to ecliptic`,
      `           period ${formatDuration(osc.periodSeconds)}`,
      '',
      `prediction to T+ ${formatDuration(sim.prediction.lastTime)} (${formatDuration(sim.prediction.lastTime - sim.time)} ahead)`,
    );
    for (const apsis of findApsides(sim.prediction, eph, ref, sim.time, MAX_APSIDES)) {
      const short = apsis.kind === 'periapsis' ? 'Pe' : 'Ap';
      const altitude = formatDistance(apsis.distanceMeters - R);
      lines.push(`  ${short} ${altitude.padStart(13)}  in ${formatDuration(apsis.time - sim.time)}`);
      events.push({ kind: apsis.kind, time: apsis.time, position: apsis.position, label: `${short} ${altitude}` });
    }
    const impact = sim.predictionImpact;
    if (impact) {
      const name = sim.system.bodies[impact.bodyIndex]!.name;
      lines.push(`  IMPACT on ${name} in ${formatDuration(impact.time - sim.time)}`);
      events.push({ kind: 'impact', time: impact.time, position: sim.prediction.position(sim.prediction.count - 1), label: `Impact ${name}` });
    }
  }
  view.setEvents(events);
  panel.setReadout(lines.join('\n'));
}

requestAnimationFrame(frameLoop);
