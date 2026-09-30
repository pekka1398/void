/**
 * Headless checks of the stability assist: the controller against lab/landing's flight attitude integrator
 * (undamped, so every bit of stopping is SAS's), on the demo rocket's real inertias; then on the rocket itself
 * through PartJointRocket's per-step steering, in contact and in flight.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import type { Vec3 } from '../landing/src/orbitCore';
import type { Quaternion } from '../landing/src/physics/ContactWorld';
import { matVec, quatToMatrix, scaleMat, stepAttitude, transpose, type Mat3 } from '../landing/src/vessel/Attitude';
import { PartJointRocket, STEERING_TORQUE } from '../landing/src/vessel/PartJointRocket';
import type { LanderControl } from '../landing/src/vessel/Lander';
import { demoRocket } from '../landing/src/vessel/DemoRocket';
import { pebble, planetEphemeris } from '../landing/src/planet/Planets';
import { attitudeError, StabilityAssist } from './src/StabilityAssist';

declare const process: { exit(code: number): never };

const failures: string[] = [];
function check(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${detail}`);
  if (!ok) failures.push(name);
}
function throws(run: () => void): boolean {
  try { run(); } catch { return true; }
  return false;
}

const ZERO: Vec3 = { x: 0, y: 0, z: 0 };
const DT = 1 / 60;
const DEG = 180 / Math.PI;
const norm = (v: Vec3) => Math.hypot(v.x, v.y, v.z);
const angle = (a: Quaternion, b: Quaternion) => norm(attitudeError(a, b));
const tilted: Quaternion = (() => {
  const q = { x: 0.12, y: -0.3, z: 0.2, w: 0.92 };
  const l = Math.hypot(q.x, q.y, q.z, q.w);
  return { x: q.x / l, y: q.y / l, z: q.z / l, w: q.w / l };
})();

await RAPIER.init();
const planet = pebble();
const { ephemeris, bodyIndex } = planetEphemeris(planet);
const demo = demoRocket(planet.terrain);
const makeRocket = () => PartJointRocket.landed(RAPIER, ephemeris, bodyIndex, planet.terrain, demo.full, demo.upper, demo.booster, demo.options, demo.launchSite);
const pad = makeRocket();
const stackInertia = pad.controlledInertia();
pad.separate();
const upperInertia = pad.controlledInertia();
pad.free();

/** A craft on lab/landing's flight attitude integrator with no damping. */
class Craft {
  rotation: Quaternion = tilted;
  angularVelocity: Vec3 = ZERO;
  largestCommand = 0;
  constructor(readonly inertia: Mat3, readonly sas: StabilityAssist) {}
  step(pilot: Vec3): Vec3 {
    const u = this.sas.command({ rotation: this.rotation, angularVelocity: this.angularVelocity, inertiaLocal: this.inertia }, pilot, DT);
    this.largestCommand = Math.max(this.largestCommand, Math.abs(u.x), Math.abs(u.y), Math.abs(u.z));
    const next = stepAttitude(this.rotation, this.angularVelocity, this.inertia, { x: u.x * STEERING_TORQUE, y: u.y * STEERING_TORQUE, z: u.z * STEERING_TORQUE }, DT);
    this.rotation = next.rotation;
    this.angularVelocity = next.angularVelocity;
    return u;
  }
  run(seconds: number, pilot: Vec3 = ZERO, each?: (t: number) => void): void {
    for (let k = 0; k < Math.round(seconds / DT); k += 1) { this.step(pilot); each?.(k * DT); }
  }
}

const cases: { label: string; inertia: Mat3 }[] = [
  { label: 'full stack', inertia: stackInertia },
  { label: 'upper stage', inertia: upperInertia },
  { label: 'stack x4 (heavier craft)', inertia: scaleMat(stackInertia, 4) },
  { label: 'upper x0.25 (nearly empty)', inertia: scaleMat(upperInertia, 0.25) },
];
console.log(`inertia (kg m^2, local diagonal): stack ${[stackInertia[0], stackInertia[4], stackInertia[8]].map((v) => v.toFixed(0)).join(' / ')}, upper ${[upperInertia[0], upperInertia[4], upperInertia[8]].map((v) => v.toFixed(0)).join(' / ')}`);

// --- Holding against a kick -----------------------------------------------------------
for (const { label, inertia } of cases) {
  const craft = new Craft(inertia, new StabilityAssist(STEERING_TORQUE));
  craft.sas.setEnabled(true);
  craft.run(0.5);
  const lock = craft.sas.target;
  const lockedAtOnce = craft.sas.phase === 'holding' && lock !== null && angle(lock, tilted) < 1e-12;
  // Kick: an off-axis spin of 0.2 rad/s in the frame.
  craft.angularVelocity = { x: 0.12, y: -0.1, z: 0.13 };
  const kick = norm(craft.angularVelocity);
  let peak = 0, settled = Infinity, closeIn = Infinity, overshoot = 0;
  craft.run(30, ZERO, (t) => {
    const a = angle(lock!, craft.rotation);
    peak = Math.max(peak, a);
    if (closeIn === Infinity && peak > 0 && a < 0.01 * peak) closeIn = t;
    if (closeIn !== Infinity) overshoot = Math.max(overshoot, a);
    if (a < 0.1 / DEG && norm(craft.angularVelocity) < 1e-3) { if (settled === Infinity) settled = t; } else settled = Infinity;
  });
  const final = angle(lock!, craft.rotation);
  check(`holds against a kick: ${label}`, lockedAtOnce && final < 0.01 / DEG && settled < 15 && overshoot < 0.05 * peak && craft.largestCommand <= 1 + 1e-12,
    `kick ${kick.toFixed(2)} rad/s turned it ${(peak * DEG).toFixed(2)}° away; back within 0.1° and 1e-3 rad/s after ${settled.toFixed(2)} s, ` +
    `overshoot ${(overshoot / peak * 100).toFixed(2)}% of the peak, final ${(final * DEG).toExponential(1)}°, largest command ${craft.largestCommand.toFixed(3)}`);
}

// --- Pilot input, release, new lock ---------------------------------------------------
{
  const craft = new Craft(stackInertia, new StabilityAssist(STEERING_TORQUE));
  craft.sas.setEnabled(true);
  craft.run(0.5);
  const original = craft.sas.target!;
  // Off-axis drift while the pilot pitches: SAS must stop it on the free axes.
  craft.angularVelocity = matVec(quatToMatrix(craft.rotation), { x: 0, y: 0.05, z: 0.05 });
  let passThrough = true;
  for (let k = 0; k < 60; k += 1) if (craft.step({ x: 1, y: 0, z: 0 }).x !== 1) passThrough = false;
  const phaseWhileHeld = craft.sas.phase;
  const local = matVec(transpose(quatToMatrix(craft.rotation)), craft.angularVelocity);
  const pitchRate = Math.abs(local.x), offAxis = Math.hypot(local.y, local.z);
  let lockedAt: Quaternion | null = null, lockTime = Infinity;
  craft.run(15, ZERO, (t) => { if (!lockedAt && craft.sas.phase === 'holding') { lockedAt = craft.sas.target; lockTime = t; } });
  const drift = lockedAt ? angle(lockedAt, craft.rotation) : Infinity;
  const moved = lockedAt ? angle(original, lockedAt) : 0;
  check('pilot axis passes through, other axes are damped', passThrough && phaseWhileHeld === 'pilot' && offAxis < 0.1 * 0.05 * Math.SQRT2 && pitchRate > 0.2,
    `1 s of full pitch: command stayed 1, pitch rate ${pitchRate.toFixed(3)} rad/s; roll/yaw drift 0.071 -> ${offAxis.toExponential(2)} rad/s`);
  check('release damps, then locks the new attitude', lockedAt !== null && moved > 5 / DEG && drift < 0.01 / DEG,
    `locked ${lockTime.toFixed(2)} s after release, ${(moved * DEG).toFixed(1)}° from the old lock; 15 s later ${(drift * DEG).toExponential(1)}° from the new one`);
}

// --- Off ----------------------------------------------------------------------------------
{
  const sas = new StabilityAssist(STEERING_TORQUE);
  const craft = new Craft(upperInertia, sas);
  const pilot = { x: 0.3, y: -1, z: 0 };
  const same = craft.step(pilot);
  // Spin about the long axis (a principal axis): with SAS off and no damping it keeps going.
  craft.rotation = { x: 0, y: 0, z: 0, w: 1 };
  craft.angularVelocity = { x: 0, y: 0.4, z: 0 };
  craft.run(10);
  const kept = norm(craft.angularVelocity);
  check('off: pilot command unchanged, spin not stopped', same === pilot && sas.phase === 'off' && Math.abs(kept - 0.4) < 1e-12,
    `spin 0.4 rad/s after 10 s: ${kept.toFixed(12)} rad/s`);
}

// --- Turning on while spinning -------------------------------------------------------------
{
  const craft = new Craft(stackInertia, new StabilityAssist(STEERING_TORQUE));
  craft.angularVelocity = { x: 0.3, y: 0.2, z: -0.1 };
  craft.sas.setEnabled(true);
  let lockTime = Infinity, rateAtLock = Infinity;
  craft.run(20, ZERO, (t) => { if (lockTime === Infinity && craft.sas.phase === 'holding') { lockTime = t; rateAtLock = norm(craft.angularVelocity); } });
  const drift = angle(craft.sas.target!, craft.rotation);
  check('turned on while spinning: stops, then holds', lockTime < 10 && rateAtLock < 3e-3 && drift < 0.01 / DEG && craft.largestCommand <= 1 + 1e-12,
    `0.37 rad/s stopped and locked after ${lockTime.toFixed(2)} s (spin ${rateAtLock.toExponential(1)} rad/s); then ${(drift * DEG).toExponential(1)}° from the lock`);
}

// --- Bad input panics ----------------------------------------------------------------------
{
  const sas = new StabilityAssist(STEERING_TORQUE);
  sas.setEnabled(true);
  const sample = { rotation: tilted, angularVelocity: ZERO, inertiaLocal: stackInertia };
  const cases = [
    throws(() => new StabilityAssist(0)),
    throws(() => new StabilityAssist(STEERING_TORQUE, { rateSeconds: 0.2, attitudeSeconds: 0.5, brakeFraction: 0.5, lockRate: 1e-3 })),
    throws(() => sas.command(sample, { x: 1.5, y: 0, z: 0 }, DT)),
    throws(() => sas.command(sample, ZERO, 0)),
    throws(() => sas.command({ ...sample, inertiaLocal: [0, 0, 0, 0, 1, 0, 0, 0, 1] }, ZERO, DT)),
    throws(() => sas.command({ ...sample, inertiaLocal: [1, 0, 0, 0, NaN, 0, 0, 0, 1] }, ZERO, DT)),
  ];
  check('bad input panics', cases.every(Boolean), `thrown: ${cases.map((c) => (c ? 'yes' : 'NO')).join(', ')} (torque 0, loose tuning, pilot 1.5, dt 0, zero and NaN inertia)`);
}

// --- On the rocket: PartJointRocket's per-step steering --------------------------------------
{
  const rocket = makeRocket();
  const step = demo.options.contact.stepSeconds;
  const both = throws(() => rocket.advance(step, { throttle: 0, up: 1, prograde: 0, turn: ZERO, steering: () => ZERO }));
  // Tip it with the keys while climbing, then hand over to SAS and keep climbing into free flight.
  for (let k = 0; k < 60; k += 1) rocket.advance(step, { throttle: 1, up: 1, prograde: 0, turn: { x: 0.4, y: 0.2, z: 0 } });
  const tipSpin = norm(rocket.partAngularVelocity('upper'));
  const sas = new StabilityAssist(STEERING_TORQUE);
  sas.setEnabled(true);
  let calls = 0, inertiaMatches = true;
  const control: LanderControl = { throttle: 1, up: 1, prograde: 0, steering: (sample, dt) => {
    calls += 1;
    const expected = rocket.controlledInertia();
    if (sample.inertiaLocal.some((v, i) => Math.abs(v - expected[i]!) > 1e-9 * Math.abs(expected[0]))) inertiaMatches = false;
    return sas.command(sample, ZERO, dt);
  } };
  const start = rocket.time;
  let contactSteps = 0;
  while (rocket.mode === 'contact' && rocket.time - start < 60) { rocket.advance(step, control); contactSteps += 1; }
  const contactSpin = norm(rocket.partAngularVelocity('upper'));
  const inFlight = rocket.mode === 'flight';
  const lockedInContact = sas.phase === 'holding';
  const contactCalls = calls;
  // In flight: one advance over several frames, as time warp does; SAS still runs every physics step.
  const flightStart = rocket.time, held = rocket.orientation(), callsBefore = calls;
  rocket.advance(4, control);
  const flightCalls = calls - callsBefore, expectedCalls = Math.round((rocket.time - flightStart) / step);
  const drift = angle(held, rocket.orientation());
  check('turn and steering together panic', both, 'advance with both throws');
  check('SAS on the rocket in contact physics', lockedInContact && contactSpin < 3e-3 && inertiaMatches && contactCalls === contactSteps,
    `tipped to ${tipSpin.toFixed(3)} rad/s under thrust; SAS stopped and locked it before leaving the contact band (${contactSteps} steps, ${contactCalls} steering calls), spin there ${contactSpin.toExponential(1)} rad/s`);
  check('SAS on the rocket in free flight', inFlight && rocket.mode === 'flight' && Math.abs(flightCalls - expectedCalls) <= 1 && drift < 0.05 / DEG,
    `4 s burn in one advance: ${flightCalls} steering calls for ${expectedCalls} steps; attitude held within ${(drift * DEG).toExponential(1)}°`);
  rocket.free();
}

if (failures.length > 0) {
  console.log(`\n${failures.length} FAILED: ${failures.join('; ')}`);
  process.exit(1);
}
console.log('\nALL CHECKS PASSED');
