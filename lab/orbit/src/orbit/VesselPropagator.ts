import { Dopri5 } from './Dopri5';
import type { Ephemeris } from './Ephemeris';
import type { Trajectory } from './Trajectory';
import type { Vec3 } from './Vec3';

/** Per-step absolute error bounds. */
export interface Tolerances {
  positionMeters: number;
  velocityMetersPerSecond: number;
}

export interface VesselState {
  time: number;
  position: Vec3;
  velocity: Vec3;
}

export type AdvanceOutcome =
  | { kind: 'reached' }
  | { kind: 'budget' }
  | { kind: 'impact'; bodyIndex: number };

const STEP_GROWTH_LIMIT = 5;
const STEP_SHRINK_LIMIT = 0.2;
const SAFETY = 0.9;
const INITIAL_STEP_SECONDS = 1;
const IMPACT_SCAN_SAMPLES = 8;
const IMPACT_TIME_RESOLUTION_SECONDS = 1e-4;

/**
 * Continuable propagation of one massless vessel through the ephemeris' gravity.
 * Holds the state plus the integrator's FSAL derivative and step-size memory.
 */
export class PropagationRun {
  time: number;
  readonly y = new Float64Array(6);
  readonly dy = new Float64Array(6);
  hasDerivative = false;
  /** Last controller-proposed step, unclamped by leg ends. */
  stepHint = INITIAL_STEP_SECONDS;
  impact: { bodyIndex: number; time: number } | null = null;

  constructor(state: VesselState) {
    this.time = state.time;
    this.y.set([state.position.x, state.position.y, state.position.z, state.velocity.x, state.velocity.y, state.velocity.z]);
    for (const value of this.y) if (!Number.isFinite(value)) throw new RangeError('PropagationRun: non-finite initial state');
  }

  get state(): VesselState {
    const y = this.y;
    return { time: this.time, position: { x: y[0]!, y: y[1]!, z: y[2]! }, velocity: { x: y[3]!, y: y[4]!, z: y[5]! } };
  }
}

export class VesselPropagator {
  readonly ephemeris: Ephemeris;
  readonly tolerances: Tolerances;
  /** Accepted and rejected step counts since construction, for diagnostics. */
  acceptedSteps = 0;
  rejectedSteps = 0;
  private readonly stepper = new Dopri5(6);
  private readonly bodyPositions: Float64Array;
  private readonly yNext = new Float64Array(6);
  private readonly dyNext = new Float64Array(6);
  private readonly probeY = new Float64Array(6);
  private readonly probeDy = new Float64Array(6);
  private readonly derivative = (t: number, y: Float64Array, dy: Float64Array): void => this.gravity(t, y, dy);

  constructor(ephemeris: Ephemeris, tolerances: Tolerances) {
    if (!(tolerances.positionMeters > 0) || !(tolerances.velocityMetersPerSecond > 0)) {
      throw new RangeError(`VesselPropagator: tolerances ${JSON.stringify(tolerances)}`);
    }
    this.ephemeris = ephemeris;
    this.tolerances = tolerances;
    this.bodyPositions = new Float64Array(ephemeris.bodyCount * 3);
  }

  /**
   * Coast from run.time to tEnd. Stops early at a surface impact or after
   * maxSteps accepted steps. Every accepted step end is appended to sink.
   */
  advance(run: PropagationRun, tEnd: number, maxSteps: number, sink: Trajectory | null): AdvanceOutcome {
    if (run.impact) throw new Error('VesselPropagator: the run already ended in an impact');
    if (!Number.isFinite(tEnd) || tEnd < run.time) throw new RangeError(`VesselPropagator: tEnd ${tEnd} before ${run.time}`);
    this.ephemeris.extendTo(tEnd);
    if (!run.hasDerivative) {
      const inside = this.bodyContaining(run.time, run.y);
      if (inside !== null) throw new Error(`VesselPropagator: initial state is inside ${this.ephemeris.bodies[inside]!.id}`);
      this.gravity(run.time, run.y, run.dy);
      run.hasDerivative = true;
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
      this.acceptedSteps += 1;
      steps += 1;
      const t0 = run.time;
      const t1 = lastStep ? tEnd : run.time + h;
      const candidate = this.scanForImpact(t0, run.y, run.dy, t1, this.yNext, this.dyNext);
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

  private gravity(t: number, y: Float64Array, dy: Float64Array): void {
    const positions = this.bodyPositions;
    this.ephemeris.positionsAt(t, positions);
    let ax = 0, ay = 0, az = 0;
    const x = y[0]!, yy = y[1]!, z = y[2]!;
    const bodies = this.ephemeris.bodies;
    for (let i = 0; i < bodies.length; i += 1) {
      const dx = positions[i * 3]! - x;
      const dyy = positions[i * 3 + 1]! - yy;
      const dz = positions[i * 3 + 2]! - z;
      const r2 = dx * dx + dyy * dyy + dz * dz;
      const s = bodies[i]!.gm / (r2 * Math.sqrt(r2));
      ax += dx * s; ay += dyy * s; az += dz * s;
    }
    dy[0] = y[3]!; dy[1] = y[4]!; dy[2] = y[5]!;
    dy[3] = ax; dy[4] = ay; dy[5] = az;
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
   * interpolated body positions. A dip below a surface is confirmed with a real
   * integrated state; the returned body is the one hit first.
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
