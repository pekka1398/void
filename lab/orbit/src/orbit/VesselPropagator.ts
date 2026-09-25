import { spinAxis } from './BodyRotation';
import { Dopri5 } from './Dopri5';
import type { Ephemeris } from './Ephemeris';
import type { Trajectory } from './Trajectory';
import type { Vec3 } from './Vec3';

/** Per-step absolute error bounds. Mass needs none: its derivative is constant per leg. */
export interface Tolerances {
  positionMeters: number;
  velocityMetersPerSecond: number;
}

export interface VesselState {
  time: number;
  position: Vec3;
  velocity: Vec3;
  massKg: number;
}

/**
 * Thrust direction law.
 * - inertial: a fixed barycentric direction.
 * - frenet: unit components along the trajectory's frame relative to a body:
 *   tangent = velocity relative to the body (prograde), normal = orbit normal
 *   r x v, radial = tangent x normal (radial out for a circular orbit).
 */
export type AttitudeLaw =
  | { kind: 'inertial'; direction: Vec3 }
  | { kind: 'frenet'; referenceBody: number; tangent: number; normal: number; radial: number };

/** Constant for the duration of one advance call. */
export interface ThrustControl {
  thrustNewtons: number;
  /** Isp * g0, m/s. */
  exhaustVelocity: number;
  /** Dry mass: reaching it inside a leg is a caller bug, legs end at fuel exhaustion. */
  minimumMassKg: number;
  attitude: AttitudeLaw;
}

export type AdvanceOutcome =
  | { kind: 'reached' }
  | { kind: 'budget' }
  | { kind: 'impact'; bodyIndex: number };

const DIM = 7;
const STEP_GROWTH_LIMIT = 5;
const STEP_SHRINK_LIMIT = 0.2;
const SAFETY = 0.9;
const INITIAL_STEP_SECONDS = 1;
const IMPACT_SCAN_SAMPLES = 8;
const IMPACT_TIME_RESOLUTION_SECONDS = 1e-4;

export function assertThrustControl(control: ThrustControl, bodyCount: number): void {
  if (!(control.thrustNewtons > 0) || !Number.isFinite(control.thrustNewtons)) throw new RangeError(`thrust ${control.thrustNewtons}`);
  if (!(control.exhaustVelocity > 0) || !Number.isFinite(control.exhaustVelocity)) throw new RangeError(`exhaust velocity ${control.exhaustVelocity}`);
  if (!(control.minimumMassKg > 0)) throw new RangeError(`minimum mass ${control.minimumMassKg}`);
  const a = control.attitude;
  if (a.kind === 'inertial') {
    if (Math.abs(Math.hypot(a.direction.x, a.direction.y, a.direction.z) - 1) > 1e-9) throw new RangeError('inertial attitude is not a unit vector');
  } else {
    if (!Number.isInteger(a.referenceBody) || a.referenceBody < 0 || a.referenceBody >= bodyCount) throw new RangeError(`attitude body ${a.referenceBody}`);
    if (Math.abs(Math.hypot(a.tangent, a.normal, a.radial) - 1) > 1e-9) throw new RangeError('frenet attitude components are not a unit vector');
  }
}

/**
 * Continuable propagation of one vessel through the ephemeris' gravity.
 * Holds the state (position, velocity, mass) plus the integrator's FSAL
 * derivative, the control it belongs to, and step-size memory.
 */
export class PropagationRun {
  time: number;
  readonly y = new Float64Array(DIM);
  readonly dy = new Float64Array(DIM);
  /** The control dy was evaluated with; a different control invalidates it. */
  derivativeControl: ThrustControl | null | undefined = undefined;
  /** Last controller-proposed step, unclamped by leg ends. */
  stepHint = INITIAL_STEP_SECONDS;
  impact: { bodyIndex: number; time: number } | null = null;

  constructor(state: VesselState) {
    this.time = state.time;
    this.y.set([
      state.position.x, state.position.y, state.position.z,
      state.velocity.x, state.velocity.y, state.velocity.z, state.massKg,
    ]);
    for (const value of this.y) if (!Number.isFinite(value)) throw new RangeError('PropagationRun: non-finite initial state');
    if (!(state.massKg > 0)) throw new RangeError(`PropagationRun: mass ${state.massKg}`);
  }

  get state(): VesselState {
    const y = this.y;
    return {
      time: this.time,
      position: { x: y[0]!, y: y[1]!, z: y[2]! },
      velocity: { x: y[3]!, y: y[4]!, z: y[5]! },
      massKg: y[6]!,
    };
  }

  /** An independent copy with the same state and step memory. */
  clone(): PropagationRun {
    const copy = new PropagationRun(this.state);
    copy.stepHint = this.stepHint;
    return copy;
  }
}

export class VesselPropagator {
  readonly ephemeris: Ephemeris;
  readonly tolerances: Tolerances;
  /** Accepted and rejected step counts since construction, for diagnostics. */
  acceptedSteps = 0;
  rejectedSteps = 0;
  private readonly stepper = new Dopri5(DIM);
  private readonly bodyPositions: Float64Array;
  private readonly bodyVelocities: Float64Array;
  /** Per body: spin axis (3), then 1.5 J2 GM R^2 (0 for a point mass). */
  private readonly oblateness: Float64Array;
  private readonly yNext = new Float64Array(DIM);
  private readonly dyNext = new Float64Array(DIM);
  private readonly probeY = new Float64Array(DIM);
  private readonly probeDy = new Float64Array(DIM);
  private control: ThrustControl | null = null;
  private readonly derivative = (t: number, y: Float64Array, dy: Float64Array): void => this.evaluate(t, y, dy);

  constructor(ephemeris: Ephemeris, tolerances: Tolerances) {
    if (!(tolerances.positionMeters > 0) || !(tolerances.velocityMetersPerSecond > 0)) {
      throw new RangeError(`VesselPropagator: tolerances ${JSON.stringify(tolerances)}`);
    }
    this.ephemeris = ephemeris;
    this.tolerances = tolerances;
    this.bodyPositions = new Float64Array(ephemeris.bodyCount * 3);
    this.bodyVelocities = new Float64Array(ephemeris.bodyCount * 3);
    this.oblateness = new Float64Array(ephemeris.bodyCount * 4);
    ephemeris.bodies.forEach((body, i) => {
      const k = spinAxis(body);
      this.oblateness.set([k.x, k.y, k.z, 1.5 * body.j2 * body.gm * body.j2ReferenceRadiusMeters ** 2], i * 4);
    });
  }

  /** Unit thrust direction the law gives for a state at t. */
  thrustDirection(attitude: AttitudeLaw, t: number, position: Vec3, velocity: Vec3): Vec3 {
    if (attitude.kind === 'inertial') return { ...attitude.direction };
    this.ephemeris.statesAt(t, this.bodyPositions, this.bodyVelocities);
    const out = new Float64Array(3);
    this.frenetDirection(attitude, position.x, position.y, position.z, velocity.x, velocity.y, velocity.z, out);
    return { x: out[0]!, y: out[1]!, z: out[2]! };
  }

  /**
   * Propagate from run.time to tEnd under a constant control (null = coast).
   * Stops early at a surface impact or after maxSteps accepted steps. Every
   * accepted step end is appended to sink.
   */
  advance(run: PropagationRun, tEnd: number, maxSteps: number, sink: Trajectory | null, control: ThrustControl | null): AdvanceOutcome {
    if (run.impact) throw new Error('VesselPropagator: the run already ended in an impact');
    if (!Number.isFinite(tEnd) || tEnd < run.time) throw new RangeError(`VesselPropagator: tEnd ${tEnd} before ${run.time}`);
    if (control) assertThrustControl(control, this.ephemeris.bodyCount);
    this.ephemeris.extendTo(tEnd);
    this.control = control;
    if (run.derivativeControl === undefined) {
      const inside = this.bodyContaining(run.time, run.y);
      if (inside !== null) throw new Error(`VesselPropagator: initial state is inside ${this.ephemeris.bodies[inside]!.id}`);
    }
    if (run.derivativeControl !== control) {
      this.evaluate(run.time, run.y, run.dy);
      run.derivativeControl = control;
    }
    let steps = 0;
    while (run.time < tEnd) {
      if (steps >= maxSteps) return { kind: 'budget' };
      const remaining = tEnd - run.time;
      const lastStep = run.stepHint >= remaining;
      const h = lastStep ? remaining : run.stepHint;
      this.stepper.step(this.derivative, run.time, run.y, run.dy, h, this.yNext, this.dyNext);
      const err = this.errorNorm();
      if (!Number.isFinite(err)) throw new Error(`VesselPropagator: non-finite error estimate at t=${run.time}`);
      const factor = err === 0
        ? STEP_GROWTH_LIMIT
        : Math.min(STEP_GROWTH_LIMIT, Math.max(STEP_SHRINK_LIMIT, SAFETY * err ** -0.2));
      if (err > 1) {
        this.rejectedSteps += 1;
        run.stepHint = h * Math.min(1, factor);
        if (!(run.stepHint > Math.abs(run.time) * 1e-15)) {
          throw new Error(`VesselPropagator: step size underflow at t=${run.time}`);
        }
        continue;
      }
      if (control && this.yNext[6]! < control.minimumMassKg * (1 - 1e-12)) {
        throw new Error(`VesselPropagator: mass ${this.yNext[6]} fell below dry mass ${control.minimumMassKg}; the leg should have ended at fuel exhaustion`);
      }
      this.acceptedSteps += 1;
      steps += 1;
      const t1 = lastStep ? tEnd : run.time + h;
      const candidate = this.scanForImpact(run.time, run.y, run.dy, t1, this.yNext, this.dyNext);
      if (candidate !== null && this.resolveImpact(run, candidate, h)) {
        if (sink) sink.append(run.time, run.y);
        return { kind: 'impact', bodyIndex: candidate };
      }
      run.time = t1;
      run.y.set(this.yNext);
      run.dy.set(this.dyNext);
      // A step clamped to the leg end says nothing about the natural step size.
      if (!lastStep) run.stepHint = h * factor;
      if (sink) sink.append(run.time, run.y);
    }
    return { kind: 'reached' };
  }

  private evaluate(t: number, y: Float64Array, dy: Float64Array): void {
    const control = this.control;
    const frenet = control !== null && control.attitude.kind === 'frenet';
    if (frenet) this.ephemeris.statesAt(t, this.bodyPositions, this.bodyVelocities);
    else this.ephemeris.positionsAt(t, this.bodyPositions);
    const positions = this.bodyPositions;
    let ax = 0, ay = 0, az = 0;
    const x = y[0]!, yy = y[1]!, z = y[2]!;
    const bodies = this.ephemeris.bodies;
    const obl = this.oblateness;
    for (let i = 0; i < bodies.length; i += 1) {
      const dx = positions[i * 3]! - x;
      const dyy = positions[i * 3 + 1]! - yy;
      const dz = positions[i * 3 + 2]! - z;
      const r2 = dx * dx + dyy * dyy + dz * dz;
      const s = bodies[i]!.gm / (r2 * Math.sqrt(r2));
      ax += dx * s; ay += dyy * s; az += dz * s;
      const c = obl[i * 4 + 3]!;
      if (c !== 0) {
        // J2 with r = vessel - body = -d and u = r.k:
        // a = c / r^5 [(5 u^2 / r^2 - 1) r - 2 u k], c = 1.5 J2 GM R^2.
        const kx = obl[i * 4]!, ky = obl[i * 4 + 1]!, kz = obl[i * 4 + 2]!;
        const u = -(dx * kx + dyy * ky + dz * kz);
        const f = c / (r2 * r2 * Math.sqrt(r2));
        const radial = f * (5 * u * u / r2 - 1);
        ax -= radial * dx + 2 * f * u * kx;
        ay -= radial * dyy + 2 * f * u * ky;
        az -= radial * dz + 2 * f * u * kz;
      }
    }
    dy[0] = y[3]!; dy[1] = y[4]!; dy[2] = y[5]!;
    if (control) {
      const direction = this.scratchDirection;
      if (control.attitude.kind === 'inertial') {
        direction[0] = control.attitude.direction.x;
        direction[1] = control.attitude.direction.y;
        direction[2] = control.attitude.direction.z;
      } else {
        this.frenetDirection(control.attitude, x, yy, z, y[3]!, y[4]!, y[5]!, direction);
      }
      const accel = control.thrustNewtons / y[6]!;
      ax += direction[0]! * accel;
      ay += direction[1]! * accel;
      az += direction[2]! * accel;
      dy[6] = -control.thrustNewtons / control.exhaustVelocity;
    } else {
      dy[6] = 0;
    }
    dy[3] = ax; dy[4] = ay; dy[5] = az;
  }

  private readonly scratchDirection = new Float64Array(3);

  /** Requires bodyPositions/bodyVelocities evaluated at the same time. */
  private frenetDirection(
    law: Extract<AttitudeLaw, { kind: 'frenet' }>,
    x: number, y: number, z: number, vx: number, vy: number, vz: number, out: Float64Array,
  ): void {
    const b = law.referenceBody * 3;
    const rx = x - this.bodyPositions[b]!, ry = y - this.bodyPositions[b + 1]!, rz = z - this.bodyPositions[b + 2]!;
    const ux = vx - this.bodyVelocities[b]!, uy = vy - this.bodyVelocities[b + 1]!, uz = vz - this.bodyVelocities[b + 2]!;
    const uLen = Math.hypot(ux, uy, uz);
    let nx = ry * uz - rz * uy, ny = rz * ux - rx * uz, nz = rx * uy - ry * ux;
    const nLen = Math.hypot(nx, ny, nz);
    if (!(uLen > 0) || !(nLen > 0)) {
      throw new Error('frenet attitude undefined: velocity relative to the reference body is zero or radial');
    }
    const tx = ux / uLen, ty = uy / uLen, tz = uz / uLen;
    nx /= nLen; ny /= nLen; nz /= nLen;
    // radial = tangent x normal
    const qx = ty * nz - tz * ny, qy = tz * nx - tx * nz, qz = tx * ny - ty * nx;
    out[0] = law.tangent * tx + law.normal * nx + law.radial * qx;
    out[1] = law.tangent * ty + law.normal * ny + law.radial * qy;
    out[2] = law.tangent * tz + law.normal * nz + law.radial * qz;
  }

  private errorNorm(): number {
    const e = this.stepper.error;
    const tp = this.tolerances.positionMeters;
    const tv = this.tolerances.velocityMetersPerSecond;
    return Math.max(
      Math.abs(e[0]!) / tp, Math.abs(e[1]!) / tp, Math.abs(e[2]!) / tp,
      Math.abs(e[3]!) / tv, Math.abs(e[4]!) / tv, Math.abs(e[5]!) / tv,
    );
  }

  private bodyContaining(t: number, y: Float64Array): number | null {
    this.ephemeris.positionsAt(t, this.bodyPositions);
    const bodies = this.ephemeris.bodies;
    for (let i = 0; i < bodies.length; i += 1) {
      const dx = y[0]! - this.bodyPositions[i * 3]!;
      const dy = y[1]! - this.bodyPositions[i * 3 + 1]!;
      const dz = y[2]! - this.bodyPositions[i * 3 + 2]!;
      if (dx * dx + dy * dy + dz * dz < bodies[i]!.radiusMeters ** 2) return i;
    }
    return null;
  }

  /**
   * Cheap screen of an accepted step: cubic Hermite vessel positions against
   * interpolated body positions. The returned body is a candidate only.
   */
  private scanForImpact(
    t0: number, y0: Float64Array, dy0: Float64Array, t1: number, y1: Float64Array, dy1: Float64Array,
  ): number | null {
    const h = t1 - t0;
    for (let j = 1; j <= IMPACT_SCAN_SAMPLES; j += 1) {
      const s = j / IMPACT_SCAN_SAMPLES;
      const s2 = s * s, s3 = s2 * s;
      const h00 = 2 * s3 - 3 * s2 + 1, h10 = s3 - 2 * s2 + s, h01 = -2 * s3 + 3 * s2, h11 = s3 - s2;
      for (let c = 0; c < 3; c += 1) {
        this.probeY[c] = h00 * y0[c]! + h10 * h * dy0[c]! + h01 * y1[c]! + h11 * h * dy1[c]!;
      }
      const body = this.bodyContaining(t0 + s * h, this.probeY);
      if (body !== null) return body;
    }
    return null;
  }

  /**
   * Confirm a screened candidate with integrated states and bisect the first
   * surface crossing. Returns false when integration shows no crossing: the
   * Hermite screen is only a filter, the integrator is the authority.
   */
  private resolveImpact(run: PropagationRun, bodyIndex: number, acceptedStep: number): boolean {
    const radius = this.ephemeris.bodies[bodyIndex]!.radiusMeters;
    const distanceAt = (tau: number): number => {
      this.stepper.step(this.derivative, run.time, run.y, run.dy, tau, this.probeY, this.probeDy);
      const p = this.ephemeris.bodyPosition(bodyIndex, run.time + tau);
      return Math.hypot(this.probeY[0]! - p.x, this.probeY[1]! - p.y, this.probeY[2]! - p.z);
    };
    let lo = 0;
    let hi = acceptedStep;
    if (!(distanceAt(hi) < radius)) {
      let found = false;
      for (let j = 1; j <= IMPACT_SCAN_SAMPLES * 4; j += 1) {
        const tau = (acceptedStep * j) / (IMPACT_SCAN_SAMPLES * 4);
        if (distanceAt(tau) < radius) { hi = tau; found = true; break; }
        lo = tau;
      }
      if (!found) return false;
    }
    while (hi - lo > IMPACT_TIME_RESOLUTION_SECONDS) {
      const mid = 0.5 * (lo + hi);
      if (distanceAt(mid) < radius) hi = mid;
      else lo = mid;
    }
    distanceAt(hi);
    run.time += hi;
    run.y.set(this.probeY);
    run.dy.set(this.probeDy);
    run.impact = { bodyIndex, time: run.time };
    return true;
  }
}
