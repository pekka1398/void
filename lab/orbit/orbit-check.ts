import { SYSTEM_PRESETS } from './src/app/SystemPresets';
import {
  DEGREES, Dopri5, Ephemeris, GRAVITATIONAL_CONSTANT, PropagationRun, SECONDS_PER_DAY,
  SECONDS_PER_JULIAN_YEAR, Trajectory, VesselPropagator, buildSystem, distance, length, orbitalPeriodSeconds,
  osculatingOrbit, solveKeplerElliptic, stateFromElements, sub, suggestedStepSeconds,
  type BodySpec, type EllipticElements, type SystemSpec,
} from './src/orbit';

declare const process: { exit(code: number): never };

const failures: string[] = [];
function check(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${detail}`);
  if (!ok) failures.push(name);
}
function throws(fn: () => unknown): boolean {
  try { fn(); return false; } catch { return true; }
}
const fmt = (x: number) => x.toExponential(2);

const STEPS_PER_ORBIT = 256;
const TOLERANCES = { positionMeters: 1e-4, velocityMetersPerSecond: 1e-7 };
const EARTH_MASS = 5.9722e24;
const EARTH_RADIUS = 6.371e6;
const MU_EARTH = GRAVITATIONAL_CONSTANT * EARTH_MASS;
const staticSpin = { periodSeconds: SECONDS_PER_DAY, obliquityRadians: 0, poleLongitudeRadians: 0, angleAtEpochRadians: 0 };

function body(id: string, massKg: number, radiusMeters: number, orbit?: EllipticElements, children: BodySpec[] = []): BodySpec {
  return { id, name: id, massKg, radiusMeters, color: '#fff', rotation: staticSpin, ...(orbit ? { orbit } : {}), children };
}

function lonePlanet(): Ephemeris {
  const eph = new Ephemeris(buildSystem({ name: 'lone', root: body('earth', EARTH_MASS, EARTH_RADIUS) }), {
    stepSeconds: 600, chunkSteps: 512,
  });
  return eph;
}

// --- Kepler -----------------------------------------------------------------
{
  let worst = 0;
  for (const e of [0, 0.1, 0.5, 0.9, 0.99, 0.999999]) {
    for (let k = -8; k <= 40; k += 1) {
      const m = k * 0.37;
      const bigE = solveKeplerElliptic(m, e);
      const wrapped = m - 2 * Math.PI * Math.floor(m / (2 * Math.PI));
      worst = Math.max(worst, Math.abs(bigE - e * Math.sin(bigE) - wrapped));
    }
  }
  check('kepler residual', worst < 1e-13, `worst |E - e sinE - M| = ${fmt(worst)}`);
  check('kepler rejects e>=1 and NaN', throws(() => solveKeplerElliptic(1, 1)) && throws(() => solveKeplerElliptic(Number.NaN, 0.1)), 'throws');
}
{
  const el: EllipticElements = {
    semiMajorAxisMeters: 2.4e7, eccentricity: 0.37, inclinationRadians: 51 * DEGREES,
    longitudeOfAscendingNodeRadians: 1.1, argumentOfPeriapsisRadians: 4.2, meanAnomalyRadians: 2.9,
  };
  const s = stateFromElements(el, MU_EARTH);
  const osc = osculatingOrbit(s.position, s.velocity, MU_EARTH);
  const rel = Math.max(
    Math.abs(osc.semiMajorAxisMeters / el.semiMajorAxisMeters - 1),
    Math.abs(osc.eccentricity - el.eccentricity),
    Math.abs(osc.inclinationRadians - el.inclinationRadians),
    Math.abs(osc.periapsisRadiusMeters / (el.semiMajorAxisMeters * (1 - el.eccentricity)) - 1),
  );
  check('elements roundtrip', rel < 1e-12, `max deviation ${fmt(rel)}`);
  check('invalid elements rejected', throws(() => stateFromElements({ ...el, eccentricity: 1.2 }, MU_EARTH))
    && throws(() => stateFromElements({ ...el, semiMajorAxisMeters: -1 }, MU_EARTH)), 'throws');
}

// --- System construction ---------------------------------------------------
for (const [id, spec] of Object.entries(SYSTEM_PRESETS)) {
  const sys = buildSystem(spec);
  let px = 0, py = 0, pz = 0, cx = 0, cy = 0, cz = 0, m = 0;
  for (const b of sys.bodies) {
    const i = b.index * 3;
    m += b.massKg;
    cx += b.massKg * sys.positions[i]!; cy += b.massKg * sys.positions[i + 1]!; cz += b.massKg * sys.positions[i + 2]!;
    px += b.massKg * sys.velocities[i]!; py += b.massKg * sys.velocities[i + 1]!; pz += b.massKg * sys.velocities[i + 2]!;
  }
  const bary = Math.hypot(cx, cy, cz) / m;
  const momentum = Math.hypot(px, py, pz) / m;
  let fastest = 0;
  for (let i = 0; i < sys.velocities.length; i += 3) fastest = Math.max(fastest, Math.hypot(sys.velocities[i]!, sys.velocities[i + 1]!, sys.velocities[i + 2]!));
  check(`${id} barycentric start`, bary < 1e-3 && momentum / fastest < 1e-15,
    `barycenter ${fmt(bary)} m, momentum/M ${fmt(momentum)} m/s (${fmt(momentum / fastest)} of fastest body)`);
}
check('missing orbit rejected', throws(() => buildSystem({ name: 'x', root: body('a', 1e24, 1e6, undefined, [body('b', 1e22, 1e5)]) })), 'throws');
check('duplicate id rejected', throws(() => buildSystem({
  name: 'x',
  root: body('a', 1e24, 1e6, undefined, [
    body('a', 1e22, 1e5, stateOrbit(1e8)),
  ]),
})), 'throws');
function stateOrbit(a: number): EllipticElements {
  return { semiMajorAxisMeters: a, eccentricity: 0, inclinationRadians: 0, longitudeOfAscendingNodeRadians: 0, argumentOfPeriapsisRadians: 0, meanAnomalyRadians: 0 };
}

// --- Yoshida 8th order: two-body against analytic Kepler --------------------
{
  const el: EllipticElements = {
    semiMajorAxisMeters: 1e9, eccentricity: 0.3, inclinationRadians: 0.4,
    longitudeOfAscendingNodeRadians: 0.2, argumentOfPeriapsisRadians: 1.0, meanAnomalyRadians: 0.5,
  };
  const spec: SystemSpec = { name: 'two', root: body('a', 6e24, 1e6, undefined, [body('b', 2e24, 1e6, el)]) };
  const mu = GRAVITATIONAL_CONSTANT * 8e24;
  const period = orbitalPeriodSeconds(el.semiMajorAxisMeters, mu);
  const errors: number[] = [];
  for (const n of [160, 320]) {
    const eph = new Ephemeris(buildSystem(spec), { stepSeconds: period / n, chunkSteps: 256 });
    eph.extendTo(period * 0.999_999_999);
    const t = eph.endTime;
    const rel = sub(eph.bodyPosition(1, t), eph.bodyPosition(0, t));
    const exact = stateFromElements({ ...el, meanAnomalyRadians: el.meanAnomalyRadians + (2 * Math.PI * t) / period }, mu);
    errors.push(distance(rel, exact.position));
  }
  const ratio = errors[0]! / errors[1]!;
  check('yoshida8 order', ratio > 180 && ratio < 360,
    `e=0.3: err(P/160)=${fmt(errors[0]!)} m err(P/320)=${fmt(errors[1]!)} m ratio=${ratio.toFixed(1)} (2^8=256)`);
}

// --- Presets: conservation and hierarchy over years ------------------------
for (const [id, spec] of Object.entries(SYSTEM_PRESETS)) {
  const sys = buildSystem(spec);
  const step = suggestedStepSeconds(sys.bodies, STEPS_PER_ORBIT);
  const eph = new Ephemeris(sys, { stepSeconds: step, chunkSteps: 2048 });
  const e0 = eph.currentEnergy();
  const l0 = eph.currentAngularMomentum();
  const years = 10;
  const started = performance.now();
  let worstEnergy = 0;
  const bounds = new Map<number, { min: number; max: number }>();
  for (let t = 0; t <= years * SECONDS_PER_JULIAN_YEAR; t += 5 * SECONDS_PER_DAY) {
    eph.extendTo(t);
    worstEnergy = Math.max(worstEnergy, Math.abs(eph.currentEnergy() / e0 - 1));
    for (const b of sys.bodies) {
      if (b.parentIndex === null || t === 0) continue;
      const d = distance(eph.bodyPosition(b.index, t), eph.bodyPosition(b.parentIndex, t));
      const entry = bounds.get(b.index) ?? { min: d, max: d };
      entry.min = Math.min(entry.min, d);
      entry.max = Math.max(entry.max, d);
      bounds.set(b.index, entry);
    }
    eph.forgetBefore(t - 30 * SECONDS_PER_DAY);
  }
  const elapsed = performance.now() - started;
  const l1 = eph.currentAngularMomentum();
  const angular = length(sub(l1, l0)) / length(l0);
  check(`${id} energy drift ${years} y`, worstEnergy < 1e-10,
    `step ${step.toFixed(1)} s, worst |dE/E| ${fmt(worstEnergy)}, |dL|/L ${fmt(angular)}, ${elapsed.toFixed(0)} ms`);
  // Bound means neither escaped nor collided. Circumbinary planets are measured
  // against one wobbling star, and moons feel real stellar perturbations, so the
  // ranges are informational beyond that.
  let hierarchyOk = true;
  const lines: string[] = [];
  for (const [index, range] of bounds) {
    const b = sys.bodies[index]!;
    const node = findSpec(spec.root, b.id);
    const orbitEl = node.orbit!;
    const peri = orbitEl.semiMajorAxisMeters * (1 - orbitEl.eccentricity);
    const apo = orbitEl.semiMajorAxisMeters * (1 + orbitEl.eccentricity);
    const ok = range.min > peri * 0.5 && range.max < apo * 1.5;
    hierarchyOk &&= ok;
    lines.push(`${b.id} ${(range.min / peri).toFixed(3)}..${(range.max / apo).toFixed(3)}`);
  }
  check(`${id} satellites stay bound`, hierarchyOk, lines.join(', '));
}
function findSpec(node: BodySpec, id: string): BodySpec {
  if (node.id === id) return node;
  for (const child of node.children) {
    try { return findSpec(child, id); } catch { /* keep searching siblings */ }
  }
  throw new Error(`no spec ${id}`);
}

// --- Hermite interpolation against a finer independent integration ----------
{
  const sys = buildSystem(SYSTEM_PRESETS.sol);
  const step = suggestedStepSeconds(sys.bodies, STEPS_PER_ORBIT);
  const coarse = new Ephemeris(sys, { stepSeconds: step, chunkSteps: 1024 });
  const fine = new Ephemeris(sys, { stepSeconds: step / 2, chunkSteps: 2048 });
  const span = 60 * SECONDS_PER_DAY;
  coarse.extendTo(span);
  fine.extendTo(span);
  // Differences at shared sample times are integration error; any excess at
  // mid-step times is interpolation error.
  let atSample = 0;
  let atMid = 0;
  for (let k = 1; (k + 1) * step < span; k += 1) {
    for (const b of sys.bodies) {
      atSample = Math.max(atSample, distance(coarse.bodyPosition(b.index, k * step), fine.bodyPosition(b.index, k * step)));
      atMid = Math.max(atMid, distance(coarse.bodyPosition(b.index, (k + 0.5) * step), fine.bodyPosition(b.index, (k + 0.5) * step)));
    }
  }
  check('ephemeris integration', atSample < 0.2, `60 d, step vs half step at samples ${fmt(atSample)} m`);
  check('ephemeris interpolation', atMid - atSample < 1e-3, `mid-step excess ${fmt(atMid - atSample)} m`);
  check('ephemeris range enforced', throws(() => coarse.bodyPosition(0, span * 2)), 'query past coverage throws');
  coarse.forgetBefore(30 * SECONDS_PER_DAY);
  check('forgotten range enforced', throws(() => coarse.bodyPosition(0, 1)), 'query before retained range throws');
}

// --- Dormand-Prince order on a harmonic oscillator --------------------------
{
  const f = (_t: number, y: Float64Array, dy: Float64Array) => { dy[0] = y[1]!; dy[1] = -y[0]!; };
  const errs: number[] = [];
  for (const n of [40, 80]) {
    const stepper = new Dopri5(2);
    const y = Float64Array.of(1, 0), k1 = new Float64Array(2), yOut = new Float64Array(2), k7 = new Float64Array(2);
    const h = (2 * Math.PI) / n;
    f(0, y, k1);
    for (let i = 0; i < n; i += 1) {
      stepper.step(f, i * h, y, k1, h, yOut, k7);
      y.set(yOut); k1.set(k7);
    }
    errs.push(Math.hypot(y[0]! - 1, y[1]!));
  }
  const ratio = errs[0]! / errs[1]!;
  check('dopri5 order', ratio > 24 && ratio < 40, `ratio ${ratio.toFixed(1)} (2^5=32)`);
}

// --- Vessel against analytic Kepler ------------------------------------------
{
  const eph = lonePlanet();
  const el: EllipticElements = {
    semiMajorAxisMeters: 9e6, eccentricity: 0.2, inclinationRadians: 0.9,
    longitudeOfAscendingNodeRadians: 0.3, argumentOfPeriapsisRadians: 2, meanAnomalyRadians: 0,
  };
  const period = orbitalPeriodSeconds(el.semiMajorAxisMeters, MU_EARTH);
  const s = stateFromElements(el, MU_EARTH);
  const prop = new VesselPropagator(eph, TOLERANCES);
  const run = new PropagationRun({ time: 0, position: s.position, velocity: s.velocity });
  const orbits = 20;
  const started = performance.now();
  const outcome = prop.advance(run, orbits * period, 1e7, null);
  const exact = stateFromElements({ ...el, meanAnomalyRadians: 2 * Math.PI * orbits }, MU_EARTH);
  const err = distance(run.state.position, exact.position);
  check('vessel vs kepler', outcome.kind === 'reached' && err < 2,
    `${orbits} orbits, ${prop.acceptedSteps} steps (${(prop.acceptedSteps / orbits).toFixed(0)}/orbit, ${prop.rejectedSteps} rejected), `
    + `position error ${fmt(err)} m, ${(performance.now() - started).toFixed(0)} ms`);
}

// --- Budgeted continuation equals one uninterrupted run ------------------------
{
  const eph = lonePlanet();
  const s = stateFromElements({ ...stateOrbit(7.5e6), eccentricity: 0.1, inclinationRadians: 0.3 }, MU_EARTH);
  const tEnd = 5 * SECONDS_PER_DAY;
  const whole = new PropagationRun({ time: 0, position: s.position, velocity: s.velocity });
  new VesselPropagator(eph, TOLERANCES).advance(whole, tEnd, 1e7, null);
  const pieces = new PropagationRun({ time: 0, position: s.position, velocity: s.velocity });
  const prop = new VesselPropagator(eph, TOLERANCES);
  let calls = 0;
  while (prop.advance(pieces, tEnd, 37, null).kind === 'budget') calls += 1;
  const d = distance(whole.state.position, pieces.state.position);
  check('budgeted continuation', d < 1e-6 && calls > 10, `${calls} resumptions, divergence ${fmt(d)} m`);
}

// --- Surface impact ------------------------------------------------------------
{
  const eph = lonePlanet();
  const r0 = 2 * EARTH_RADIUS;
  const run = new PropagationRun({ time: 0, position: { x: r0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 } });
  const traj = new Trajectory();
  const outcome = new VesselPropagator(eph, TOLERANCES).advance(run, SECONDS_PER_DAY, 1e6, traj);
  const x = EARTH_RADIUS / r0;
  const exactT = Math.sqrt(r0 ** 3 / (2 * MU_EARTH)) * (Math.sqrt(x * (1 - x)) + Math.acos(Math.sqrt(x)));
  const rImpact = length(run.state.position);
  check('radial impact', outcome.kind === 'impact' && Math.abs(run.time - exactT) < 1e-3 && rImpact <= EARTH_RADIUS && EARTH_RADIUS - rImpact < 1,
    `t=${run.time.toFixed(4)} s exact ${exactT.toFixed(4)} s, below surface by ${(EARTH_RADIUS - rImpact).toFixed(3)} m, ${traj.count} samples`);
  check('impact run is final', throws(() => new VesselPropagator(eph, { positionMeters: 1, velocityMetersPerSecond: 1 }).advance(run, 2 * SECONDS_PER_DAY, 10, null)), 'advance after impact throws');
}
for (const [label, periMargin, expectImpact] of [['grazing 500 m above', 500, false], ['grazing 500 m below', -500, true]] as const) {
  const eph = lonePlanet();
  const rp = EARTH_RADIUS + periMargin;
  const el: EllipticElements = { ...stateOrbit(rp / (1 - 0.3)), eccentricity: 0.3, meanAnomalyRadians: Math.PI };
  const s = stateFromElements(el, MU_EARTH);
  const run = new PropagationRun({ time: 0, position: s.position, velocity: s.velocity });
  const outcome = new VesselPropagator(eph, TOLERANCES)
    .advance(run, 3 * orbitalPeriodSeconds(el.semiMajorAxisMeters, MU_EARTH), 1e6, null);
  check(`impact ${label}`, (outcome.kind === 'impact') === expectImpact, `outcome ${outcome.kind}`);
}
check('start inside body rejected', throws(() => new VesselPropagator(lonePlanet(), { positionMeters: 1, velocityMetersPerSecond: 1 })
  .advance(new PropagationRun({ time: 0, position: { x: 1e6, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 } }), 10, 10, null)), 'throws');

// --- Low orbit in the full Sol system ----------------------------------------------
{
  const sys = buildSystem(SYSTEM_PRESETS.sol);
  const eph = new Ephemeris(sys, { stepSeconds: suggestedStepSeconds(sys.bodies, STEPS_PER_ORBIT), chunkSteps: 2048 });
  eph.extendTo(1);
  const home = sys.bodies.find((b) => b.id === 'aurelia')!;
  const planet = eph.bodyState(home.index, 0);
  const r = home.radiusMeters + 400e3;
  const vCirc = Math.sqrt(home.gm / r);
  const run = new PropagationRun({
    time: 0,
    position: { x: planet.position.x + r, y: planet.position.y, z: planet.position.z },
    velocity: { x: planet.velocity.x, y: planet.velocity.y + vCirc, z: planet.velocity.z },
  });
  const prop = new VesselPropagator(eph, TOLERANCES);
  const started = performance.now();
  const traj = new Trajectory();
  const outcome = prop.advance(run, SECONDS_PER_DAY, 1e7, traj);
  const now = eph.bodyState(home.index, run.time);
  const osc = osculatingOrbit(sub(run.state.position, now.position), sub(run.state.velocity, now.velocity), home.gm);
  check('LEO day in Sol system', outcome.kind === 'reached' && Math.abs(osc.semiMajorAxisMeters - r) < 20e3,
    `${prop.acceptedSteps} steps, ${(performance.now() - started).toFixed(0)} ms, a drift ${((osc.semiMajorAxisMeters - r) / 1e3).toFixed(3)} km, e ${osc.eccentricity.toExponential(2)}`);
  const mid = traj.sample(0.5 * (traj.time(10) + traj.time(11)));
  const midR = distance(mid.position, eph.bodyPosition(home.index, 0.5 * (traj.time(10) + traj.time(11))));
  check('trajectory interpolation', Math.abs(midR - r) < 5e3, `mid-step radius ${(midR / 1e3).toFixed(3)} km vs ${(r / 1e3).toFixed(3)} km`);
}

if (failures.length > 0) {
  console.log(`\n${failures.length} CHECK(S) FAILED: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\nALL CHECKS PASSED');

