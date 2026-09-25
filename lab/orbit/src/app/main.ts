import * as THREE from 'three';
import {
  cross, DEGREES, dot, findApsides, length, osculatingOrbit, Simulation, spinAxis, sub,
  type AttitudeMode, type FrameSpec, type ManeuverSpec, type StartPlane,
} from '../orbit';
import { CameraRig } from './CameraRig';
import { formatDistance, formatDuration, formatSpeed, formatWarp } from './Format';
import { Panel, PLAN_COAST_SPANS, PREDICTION_SPANS, TRAIL_SPANS, VESSEL_SPANS, type BurnEditor, type PlanRow } from './Panel';
import { RENDER_SCALE, SceneView, type Focus, type TrajectoryEvent } from './SceneView';
import { SYSTEM_PRESETS, type SystemPresetId } from './SystemPresets';

const WARPS = [1, 10, 100, 1e3, 1e4, 1e5, 1e6, 1e7] as const;
const MAX_VESSEL_STEPS_PER_FRAME = 20_000;
const MAX_PREDICTION_STEPS_PER_FRAME = 4_000;
const MAX_PLAN_STEPS_PER_FRAME = 4_000;
/** A new burn starts this long after now or after the last executable burn. */
const NEW_BURN_LEAD_SECONDS = 600;
/** Warp to burn stops this long before ignition. */
const WARP_LEAD_SECONDS = 30;
const PLAN_MESSAGE_SECONDS = 4;
const RETENTION_MARGIN_SECONDS = 86_400;
const THROTTLE_RATE_PER_SECOND = 0.5;
const MAX_APSIDES = 6;
const HOME_BODY: Record<SystemPresetId, string> = { sol: 'aurelia', binary: 'aurelia-veil' };
/** The start orbit lies in this moon's orbital plane, so a transfer to it needs no plane change. */
const HOME_MOON: Record<SystemPresetId, string> = { sol: 'selene', binary: 'lumen' };
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
const planCoast = PLAN_COAST_SPANS[3]![1];
const sim = new Simulation({
  system: SYSTEM_PRESETS[systemId],
  stepsPerOrbit: 256,
  tolerances: { positionMeters: 1e-4, velocityMetersPerSecond: 1e-7 },
  vesselStart: { homeBodyId: HOME_BODY[systemId], altitudeMeters: 400e3, plane: { kind: 'orbit-of', bodyId: HOME_MOON[systemId] } },
  // Chemical stage: 250 kN, Isp 350 s, 10 t dry + 30 t propellant = 4.76 km/s.
  engine: { thrustNewtons: 250e3, specificImpulseSeconds: 350, dryMassKg: 10e3, fuelMassKg: 30e3 },
  retentionSeconds: Math.max(trailSpan, vesselSpan) + RETENTION_MARGIN_SECONDS,
  predictionHorizonSeconds: predictionSpan,
  planCoastSeconds: planCoast,
});
const home = sim.bodyIndex(HOME_BODY[systemId]);
let frame: FrameSpec = { kind: 'body-inertial', body: home };
let focus: Focus = { kind: 'body', index: home };
let warpIndex = 2;
let paused = false;
/** Simulated time warp-to-burn runs to at maximum warp, then drops to 1×. */
let warpTarget: number | null = null;
let selectedBurn: number | null = null;
let seenCompleted = 0;
/** A transient note under the burn editor, e.g. why a snap failed. */
let planMessage: { text: string; until: number } | null = null;
const held = new Set<string>();

const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
renderer.setClearColor(0x03040a);
if (!(window.devicePixelRatio > 0)) throw new Error(`invalid devicePixelRatio ${window.devicePixelRatio}`);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
root.append(renderer.domElement);
const camera = new THREE.PerspectiveCamera(50, 1, 1, 2);
const rig = new CameraRig(renderer.domElement, 60_000, 5e10);
const view = new SceneView(sim, overlay, frame, trailSpan, vesselSpan, (picked) => setFocus(picked));

const panel = new Panel(document.body, sim.system.bodies, { frame, focus, trailSpan, vesselSpan, predictionSpan, planCoast, system: systemId,
  startPlanes: startPlaneChoices(), startPlane: startPlaneValue(sim.vesselStart.plane) }, {
  frame(spec) { frame = spec; view.setFrame(spec); },
  focus(next) { setFocus(next); },
  trailSpan(s) { trailSpan = s; view.setTrailSpan(s); updateRetention(); },
  vesselSpan(s) { vesselSpan = s; view.setVesselSpan(s); updateRetention(); },
  system(id) { window.location.search = `?system=${id}`; },
  resetVessel() { sim.resetVessel(); view.invalidatePaths(); },
  attitude(mode) { setAttitude(mode); },
  reference(index) { sim.referenceChoice = index; },
  predictionHorizon(s) { sim.predictionHorizonSeconds = s; },
  planAdd() {
    const last = sim.plan.burns[sim.plan.burns.length - 1];
    const startTime = Math.max(sim.time, last?.endTime ?? sim.time) + NEW_BURN_LEAD_SECONDS;
    selectedBurn = sim.addManeuver({ startTime, referenceBody: sim.navigationReference(), prograde: 0, normal: 0, radial: 0 });
  },
  planSelect(i) { selectedBurn = i; planMessage = null; },
  planRemove() {
    const i = requireSelected();
    sim.removeManeuver(i);
    selectedBurn = sim.plan.count === 0 ? null : Math.min(i, sim.plan.count - 1);
  },
  planWarp() {
    const next = sim.plan.burns[0];
    if (!next) throw new Error('warp to burn without an executable burn');
    const target = next.startTime - WARP_LEAD_SECONDS;
    if (target > sim.time) { warpTarget = target; paused = false; }
  },
  planShift(seconds) { editSelected((spec) => ({ ...spec, startTime: spec.startTime + seconds })); },
  planSnap(kind) {
    const placement = sim.placeManeuverAtApsis(requireSelected(), kind);
    planMessage = placement.ok ? null : { text: placement.reason, until: performance.now() + PLAN_MESSAGE_SECONDS * 1000 };
  },
  planReference(body) { editSelected((spec) => ({ ...spec, referenceBody: body })); },
  planCoast(s) { sim.plan.coastSeconds = s; },
  startPlane(value) {
    sim.vesselStart = { ...sim.vesselStart, plane: parseStartPlane(value) };
    sim.resetVessel();
    view.invalidatePaths();
  },
  planDeltaV(component, value) { editSelected((spec) => ({ ...spec, [component]: value })); },
});
panel.showAttitude(sim.attitudeMode);

/** Select values: "equator", or "orbit-of:<id>" for each satellite of the home body. */
function startPlaneChoices(): [string, string][] {
  const home = sim.bodyIndex(HOME_BODY[systemId]);
  const homeName = sim.system.bodies[home]!.name;
  return [
    ['equator', `${homeName} equator`],
    ...sim.system.bodies.filter((b) => b.parentIndex === home).map((b): [string, string] => [`orbit-of:${b.id}`, `${b.name}'s orbit plane`]),
  ];
}

function startPlaneValue(plane: StartPlane): string {
  if (plane.kind === 'orbit-of') return `orbit-of:${plane.bodyId}`;
  if (plane.inclinationRadians !== 0) throw new Error(`start plane inclination ${plane.inclinationRadians} has no panel choice`);
  return 'equator';
}

function parseStartPlane(value: string): StartPlane {
  if (value === 'equator') return { kind: 'equatorial', inclinationRadians: 0 };
  if (value.startsWith('orbit-of:')) return { kind: 'orbit-of', bodyId: value.slice('orbit-of:'.length) };
  throw new RangeError(`start plane "${value}"`);
}

function requireSelected(): number {
  if (selectedBurn === null || selectedBurn >= sim.plan.count) throw new Error(`no burn selected (${selectedBurn})`);
  return selectedBurn;
}

function editSelected(change: (spec: ManeuverSpec) => ManeuverSpec): void {
  const i = requireSelected();
  sim.replaceManeuver(i, change(sim.plan.maneuver(i)));
}

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
  else if (e.code === 'Space') { paused = !paused; warpTarget = null; e.preventDefault(); }
  else if (e.code === 'Period') { warpIndex = Math.min(WARPS.length - 1, warpIndex + 1); warpTarget = null; }
  else if (e.code === 'Comma') { warpIndex = Math.max(0, warpIndex - 1); warpTarget = null; }
  else if (e.code === 'KeyZ' && !sim.executingBurn && !sim.impact) sim.throttle = 1;
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
    if (up !== down && !sim.impact && !sim.executingBurn) {
      sim.throttle = Math.min(1, Math.max(0, sim.throttle + (up - down) * THROTTLE_RATE_PER_SECOND * realDt));
    }
    const warp = warpTarget === null ? WARPS[warpIndex]! : WARPS[WARPS.length - 1]!;
    const before = sim.time;
    const dt = warpTarget === null ? realDt * warp : Math.min(realDt * warp, warpTarget - sim.time);
    if (!paused && dt > 0) lastReport = sim.advance(dt, MAX_VESSEL_STEPS_PER_FRAME);
    if (warpTarget !== null && sim.time >= warpTarget) { warpTarget = null; warpIndex = 0; }
    if (sim.plan.completedCount !== seenCompleted) {
      // Flown burns leave the list; keep the selection on the same burn.
      const flown = sim.plan.completedCount - seenCompleted;
      seenCompleted = sim.plan.completedCount;
      if (selectedBurn !== null) selectedBurn = selectedBurn - flown >= 0 ? selectedBurn - flown : null;
    }
    if (selectedBurn !== null && selectedBurn >= sim.plan.count) selectedBurn = null;
    sim.extendPrediction(MAX_PREDICTION_STEPS_PER_FRAME);
    sim.extendPlan(MAX_PLAN_STEPS_PER_FRAME);
    achievedWarp = realDt > 0 ? (sim.time - before) / realDt : 0;
    rig.apply(camera);
    view.update(focus, camera, window.innerWidth, window.innerHeight, rig.distance * 0.12);
    renderer.render(view.scene, camera);
    panel.setThrottle(sim.effectiveThrottle, sim.effectiveThrottle > 0);
    if (nowMs - lastReadout > 100) {
      lastReadout = nowMs;
      updateText(warp);
      updatePlanPanel(nowMs);
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
    `warp ${formatWarp(warp)}${warpTarget !== null ? ` → burn in ${formatDuration(warpTarget + WARP_LEAD_SECONDS - sim.time)}` : ''}${paused ? '  PAUSED' : ''}${lagging ? `  LAGGING (achieved ${achievedWarp.toExponential(1)}×)` : ''}`,
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
    `accel      ${(sim.engine.thrustNewtons * sim.effectiveThrottle / sim.vessel.massKg).toFixed(3)} m/s² `
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
    const apsisRef = apsisBody(ref);
    const apsisRadius = sim.system.bodies[apsisRef]!.radiusMeters;
    lines.push(`  apsides about ${sim.system.bodies[apsisRef]!.name}:`);
    for (const apsis of findApsides(sim.prediction, eph, apsisRef, sim.time, MAX_APSIDES)) {
      const short = apsis.kind === 'periapsis' ? 'Pe' : 'Ap';
      const altitude = formatDistance(apsis.distanceMeters - apsisRadius);
      lines.push(`  ${short} ${altitude.padStart(13)}  in ${formatDuration(apsis.time - sim.time)}`);
      events.push({ kind: apsis.kind, plan: false, time: apsis.time, position: apsis.position, label: `${short} ${altitude}` });
    }
    const impact = sim.predictionImpact;
    if (impact) {
      const name = sim.system.bodies[impact.bodyIndex]!.name;
      lines.push(`  IMPACT on ${name} in ${formatDuration(impact.time - sim.time)}`);
      events.push({ kind: 'impact', plan: false, time: impact.time, position: sim.prediction.position(sim.prediction.count - 1), label: `Impact ${name}` });
    }
  }
  if (!sim.impact) lines.push(...planReadout(events));
  view.setEvents(events);
  panel.setReadout(lines.join('\n'));
}

/**
 * Apsides are measured from the body the view is centred on, as in
 * Principia: centring on a moon shows the plan's periapsis there.
 */
function apsisBody(fallback: number): number {
  return frame.kind === 'body-inertial' || frame.kind === 'body-surface' ? frame.body : fallback;
}

/** Readout lines for the plan beyond its last burn; adds burn and plan apsis markers. */
function planReadout(events: TrajectoryEvent[]): string[] {
  const plan = sim.plan;
  if (plan.count === 0) return [];
  const burns = plan.burns;
  const trajectory = plan.trajectory;
  const total = burns.reduce((sum, b) => sum + b.deltaV, 0);
  const last = burns[burns.length - 1];
  const fuelAfter = (last ? last.massAfterKg : sim.vessel.massKg) - sim.engine.dryMassKg;
  const lines = [
    '',
    `plan       ${burns.length}/${plan.count} burns ok, Δv ${formatSpeed(total)}`,
    `  fuel after ${(fuelAfter / 1000).toFixed(3)} t (Δv ${formatSpeed(sim.exhaustVelocity * Math.log((fuelAfter + sim.engine.dryMassKg) / sim.engine.dryMassKg))})`,
    `  computed to T+ ${formatDuration(plan.computedUntil)}${plan.complete ? '' : ' …'}`,
  ];
  const covered = (t: number) => trajectory.count > 1 && t >= trajectory.firstTime && t <= trajectory.lastTime;
  burns.forEach((burn, i) => {
    if (burn.startTime >= sim.time && covered(burn.startTime)) {
      events.push({ kind: 'burn', plan: true, time: burn.startTime, position: trajectory.sample(burn.startTime).position, label: `Burn ${i + 1} · ${formatSpeed(burn.deltaV)}` });
    }
  });
  if (!last) return lines;
  const ref = apsisBody(plan.maneuver(burns.length - 1).referenceBody);
  const body = sim.system.bodies[ref]!;
  const from = Math.max(sim.time, last.endTime);
  if (trajectory.count > 1 && trajectory.lastTime > from) {
    lines.push(`  after burn ${burns.length}, about ${body.name}:`);
    for (const apsis of findApsides(trajectory, sim.ephemeris, ref, from, 4)) {
      const short = apsis.kind === 'periapsis' ? 'Pe' : 'Ap';
      const altitude = formatDistance(apsis.distanceMeters - body.radiusMeters);
      lines.push(`  ${short} ${altitude.padStart(13)}  in ${formatDuration(apsis.time - sim.time)}`);
      events.push({ kind: apsis.kind, plan: true, time: apsis.time, position: apsis.position, label: `plan ${short} ${altitude}` });
    }
  }
  const impact = plan.impact;
  if (impact) {
    const name = sim.system.bodies[impact.bodyIndex]!.name;
    lines.push(`  IMPACT on ${name} in ${formatDuration(impact.time - sim.time)}`);
    events.push({ kind: 'impact', plan: true, time: impact.time, position: trajectory.position(trajectory.count - 1), label: `plan impact ${name}` });
  }
  return lines;
}

function updatePlanPanel(nowMs: number): void {
  const plan = sim.plan;
  const executing = sim.executingBurn;
  const rows: PlanRow[] = [];
  for (let i = 0; i < plan.count; i += 1) {
    const spec = plan.maneuver(i);
    const status = plan.status(i);
    const dv = Math.hypot(spec.prograde, spec.normal, spec.radial);
    const when = executing && i === 0 ? 'BURNING   ' : `in ${formatDuration(spec.startTime - sim.time)}`;
    rows.push({ text: `#${i + 1} ${when.padEnd(13)} ${formatSpeed(dv).padStart(11)}${status.ok ? '' : '  ✕'}`, ok: status.ok });
  }
  let editor: BurnEditor | null = null;
  if (selectedBurn !== null) {
    const i = selectedBurn;
    const spec = plan.maneuver(i);
    const status = plan.status(i);
    const summary = [
      `start T+ ${formatDuration(spec.startTime)} (in ${formatDuration(spec.startTime - sim.time)})`,
    ];
    if (status.ok) {
      const burn = status.burn;
      summary.push(
        `Δv ${formatSpeed(burn.deltaV)}, ${formatDuration(burn.endTime - burn.startTime)} at full thrust`,
        `fuel ${((burn.massBeforeKg - sim.engine.dryMassKg) / 1000).toFixed(3)} → ${((burn.massAfterKg - sim.engine.dryMassKg) / 1000).toFixed(3)} t`,
      );
    } else {
      summary.push(`✕ ${status.reason}`);
    }
    if (planMessage && nowMs < planMessage.until) summary.push(`✕ ${planMessage.text}`);
    editor = {
      index: i, referenceBody: spec.referenceBody, prograde: spec.prograde, normal: spec.normal, radial: spec.radial,
      summary: summary.join('\n'), ok: status.ok, editable: !(executing && i === 0),
    };
  }
  const next = plan.burns[0];
  panel.showPlan(rows, selectedBurn, editor, next !== undefined && next.startTime - WARP_LEAD_SECONDS > sim.time);
}

requestAnimationFrame(frameLoop);
