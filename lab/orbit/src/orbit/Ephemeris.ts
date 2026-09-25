import type { BuiltSystem, CelestialBody } from './SystemSpec';
import type { Vec3 } from './Vec3';

/**
 * Yoshida (1990) 8th-order symmetric composition of the leapfrog, solution A.
 * Sequence w7 .. w1 w0 w1 .. w7; w0 = 1 - 2 sum(w1..w7).
 */
const YOSHIDA8_W = [
  -1.61582374150097,
  -2.44699182370524,
  -0.716989419708120e-2,
  2.44002732616735,
  0.157739928123617,
  1.82020630970714,
  1.04242620869991,
] as const;
const YOSHIDA8_W0 = 1 - 2 * YOSHIDA8_W.reduce((sum, w) => sum + w, 0);
export const YOSHIDA8_SEQUENCE: readonly number[] = [
  ...[...YOSHIDA8_W].reverse(), YOSHIDA8_W0, ...YOSHIDA8_W,
];

/** Floats per body per sample: position, velocity, acceleration. */
const SAMPLE_STRIDE = 9;

export interface EphemerisOptions {
  /** Fixed integration and sampling step, seconds. */
  stepSeconds: number;
  /** Samples per storage chunk. */
  chunkSteps: number;
}

/** Pick a step resolving the tightest Jacobi periapsis passage with the given samples per orbit. */
export function suggestedStepSeconds(bodies: readonly CelestialBody[], stepsPerOrbit: number): number {
  if (!(stepsPerOrbit > 0)) throw new RangeError(`stepsPerOrbit=${stepsPerOrbit}`);
  let tightest = Number.POSITIVE_INFINITY;
  for (const body of bodies) {
    if (body.orbitPeriodSeconds === null || body.periapsisFraction === null) continue;
    tightest = Math.min(tightest, body.orbitPeriodSeconds * body.periapsisFraction ** 1.5);
  }
  if (!Number.isFinite(tightest)) throw new RangeError('suggestedStepSeconds: system has no orbiting bodies');
  return tightest / stepsPerOrbit;
}

/**
 * Massive-body trajectories integrated as one N-body problem and queryable at
 * any covered time by quintic Hermite interpolation of (x, v, a) samples.
 * Queries outside the covered interval throw: callers must extend first.
 */
export class Ephemeris {
  readonly bodies: readonly CelestialBody[];
  readonly bodyCount: number;
  readonly stepSeconds: number;
  readonly epochSeconds: number;
  private readonly chunkSteps: number;
  private readonly gm: Float64Array;
  private readonly q: Float64Array;
  private readonly qCompensation: Float64Array;
  private readonly v: Float64Array;
  private readonly a: Float64Array;
  private readonly chunks = new Map<number, Float64Array>();
  /** Index of the newest sample; sample k is at epoch + k * step. */
  private lastStep = 0;
  /** Index of the oldest retained sample. */
  private firstStep = 0;
  private readonly scratch: Float64Array;

  constructor(system: BuiltSystem, options: EphemerisOptions) {
    if (!(options.stepSeconds > 0) || !Number.isFinite(options.stepSeconds)) {
      throw new RangeError(`Ephemeris: step ${options.stepSeconds}`);
    }
    if (!Number.isInteger(options.chunkSteps) || options.chunkSteps < 2) {
      throw new RangeError(`Ephemeris: chunkSteps ${options.chunkSteps}`);
    }
    this.bodies = system.bodies;
    this.bodyCount = system.bodies.length;
    this.stepSeconds = options.stepSeconds;
    this.chunkSteps = options.chunkSteps;
    this.epochSeconds = 0;
    this.gm = Float64Array.from(system.bodies, (b) => b.gm);
    this.q = Float64Array.from(system.positions);
    this.v = Float64Array.from(system.velocities);
    this.qCompensation = new Float64Array(this.q.length);
    this.a = new Float64Array(this.q.length);
    this.scratch = new Float64Array(this.q.length);
    if (this.q.length !== this.bodyCount * 3 || this.v.length !== this.bodyCount * 3) {
      throw new RangeError('Ephemeris: state arrays do not match body count');
    }
    this.computeAccelerations(this.q, this.a);
    this.storeSample(0);
  }

  get startTime(): number {
    return this.epochSeconds + this.firstStep * this.stepSeconds;
  }

  get endTime(): number {
    return this.epochSeconds + this.lastStep * this.stepSeconds;
  }

  /** Integrate forward until the covered interval contains t. */
  extendTo(t: number): void {
    if (!Number.isFinite(t)) throw new RangeError(`Ephemeris.extendTo(${t})`);
    while (this.endTime < t) {
      this.step();
      this.lastStep += 1;
      this.storeSample(this.lastStep);
    }
  }

  /** Release whole chunks strictly older than t. */
  forgetBefore(t: number): void {
    const step = Math.floor((t - this.epochSeconds) / this.stepSeconds);
    // Always keep the newest interval so the covered range never degenerates to a point.
    const firstKeptChunk = Math.floor(Math.max(0, Math.min(step, this.lastStep - 1)) / this.chunkSteps);
    for (const key of [...this.chunks.keys()]) {
      if (key < firstKeptChunk) this.chunks.delete(key);
    }
    this.firstStep = Math.max(this.firstStep, firstKeptChunk * this.chunkSteps);
  }

  /** Barycentric positions of every body at t, 3 floats per body. */
  positionsAt(t: number, out: Float64Array): void {
    this.interpolate(t, out, null);
  }

  statesAt(t: number, outPositions: Float64Array, outVelocities: Float64Array): void {
    this.interpolate(t, outPositions, outVelocities);
  }

  bodyPosition(index: number, t: number): Vec3 {
    this.interpolate(t, this.scratch, null);
    return { x: this.scratch[index * 3]!, y: this.scratch[index * 3 + 1]!, z: this.scratch[index * 3 + 2]! };
  }

  bodyState(index: number, t: number): { position: Vec3; velocity: Vec3 } {
    const velocities = new Float64Array(this.bodyCount * 3);
    this.interpolate(t, this.scratch, velocities);
    return {
      position: { x: this.scratch[index * 3]!, y: this.scratch[index * 3 + 1]!, z: this.scratch[index * 3 + 2]! },
      velocity: { x: velocities[index * 3]!, y: velocities[index * 3 + 1]!, z: velocities[index * 3 + 2]! },
    };
  }

  /** Total energy of the integrator's newest state, for conservation checks. */
  currentEnergy(): number {
    let kinetic = 0;
    let potential = 0;
    const n = this.bodyCount;
    for (let i = 0; i < n; i += 1) {
      const m = this.gm[i]!;
      const vx = this.v[i * 3]!, vy = this.v[i * 3 + 1]!, vz = this.v[i * 3 + 2]!;
      kinetic += 0.5 * m * (vx * vx + vy * vy + vz * vz);
      for (let j = i + 1; j < n; j += 1) {
        const dx = this.q[j * 3]! - this.q[i * 3]!;
        const dy = this.q[j * 3 + 1]! - this.q[i * 3 + 1]!;
        const dz = this.q[j * 3 + 2]! - this.q[i * 3 + 2]!;
        potential -= m * this.gm[j]! / Math.sqrt(dx * dx + dy * dy + dz * dz);
      }
    }
    // Energy scaled by G, consistent with using GM as mass.
    return kinetic + potential;
  }

  /** Total angular momentum (scaled by G) of the newest state. */
  currentAngularMomentum(): Vec3 {
    let x = 0, y = 0, z = 0;
    for (let i = 0; i < this.bodyCount; i += 1) {
      const m = this.gm[i]!;
      const qx = this.q[i * 3]!, qy = this.q[i * 3 + 1]!, qz = this.q[i * 3 + 2]!;
      const vx = this.v[i * 3]!, vy = this.v[i * 3 + 1]!, vz = this.v[i * 3 + 2]!;
      x += m * (qy * vz - qz * vy);
      y += m * (qz * vx - qx * vz);
      z += m * (qx * vy - qy * vx);
    }
    return { x, y, z };
  }

  private step(): void {
    const h = this.stepSeconds;
    const q = this.q, v = this.v, a = this.a, c = this.qCompensation;
    const len = q.length;
    for (const w of YOSHIDA8_SEQUENCE) {
      const halfKick = 0.5 * w * h;
      const drift = w * h;
      for (let i = 0; i < len; i += 1) v[i]! += a[i]! * halfKick;
      for (let i = 0; i < len; i += 1) {
        // Kahan-compensated position update: barycentric coordinates are large
        // compared with a single drift, so plain summation loses low bits.
        const y = v[i]! * drift - c[i]!;
        const t = q[i]! + y;
        c[i] = (t - q[i]!) - y;
        q[i] = t;
      }
      this.computeAccelerations(q, a);
      for (let i = 0; i < len; i += 1) v[i]! += a[i]! * halfKick;
    }
    for (let i = 0; i < len; i += 1) {
      if (!Number.isFinite(q[i]!) || !Number.isFinite(v[i]!)) {
        throw new Error(`Ephemeris: non-finite state after step ${this.lastStep + 1}`);
      }
    }
  }

  private computeAccelerations(q: Float64Array, out: Float64Array): void {
    out.fill(0);
    const n = this.bodyCount;
    for (let i = 0; i < n; i += 1) {
      const xi = q[i * 3]!, yi = q[i * 3 + 1]!, zi = q[i * 3 + 2]!;
      for (let j = i + 1; j < n; j += 1) {
        const dx = q[j * 3]! - xi;
        const dy = q[j * 3 + 1]! - yi;
        const dz = q[j * 3 + 2]! - zi;
        const r2 = dx * dx + dy * dy + dz * dz;
        if (!(r2 > 0)) {
          throw new Error(`Ephemeris: bodies ${this.bodies[i]!.id} and ${this.bodies[j]!.id} coincide`);
        }
        const inv = 1 / (r2 * Math.sqrt(r2));
        const si = this.gm[j]! * inv;
        const sj = this.gm[i]! * inv;
        out[i * 3]! += dx * si; out[i * 3 + 1]! += dy * si; out[i * 3 + 2]! += dz * si;
        out[j * 3]! -= dx * sj; out[j * 3 + 1]! -= dy * sj; out[j * 3 + 2]! -= dz * sj;
      }
    }
  }

  private storeSample(step: number): void {
    const chunkIndex = Math.floor(step / this.chunkSteps);
    let chunk = this.chunks.get(chunkIndex);
    if (!chunk) {
      chunk = new Float64Array(this.chunkSteps * this.bodyCount * SAMPLE_STRIDE);
      this.chunks.set(chunkIndex, chunk);
    }
    const base = (step - chunkIndex * this.chunkSteps) * this.bodyCount * SAMPLE_STRIDE;
    for (let i = 0; i < this.bodyCount; i += 1) {
      const o = base + i * SAMPLE_STRIDE;
      for (let k = 0; k < 3; k += 1) {
        chunk[o + k] = this.q[i * 3 + k]!;
        chunk[o + 3 + k] = this.v[i * 3 + k]!;
        chunk[o + 6 + k] = this.a[i * 3 + k]!;
      }
    }
  }

  private sampleOffset(step: number): { chunk: Float64Array; base: number } {
    const chunkIndex = Math.floor(step / this.chunkSteps);
    const chunk = this.chunks.get(chunkIndex);
    if (!chunk) throw new Error(`Ephemeris: sample ${step} is not retained`);
    return { chunk, base: (step - chunkIndex * this.chunkSteps) * this.bodyCount * SAMPLE_STRIDE };
  }

  private interpolate(t: number, outPositions: Float64Array, outVelocities: Float64Array | null): void {
    if (this.lastStep === 0) throw new RangeError('Ephemeris: no interval integrated yet; call extendTo first');
    if (!(t >= this.startTime && t <= this.endTime)) {
      throw new RangeError(`Ephemeris: t=${t} outside covered [${this.startTime}, ${this.endTime}]`);
    }
    const h = this.stepSeconds;
    let k = Math.floor((t - this.epochSeconds) / h);
    // t is inside [start, end]; these only absorb the closed right end and division rounding.
    if (k >= this.lastStep) k = this.lastStep - 1;
    if (k < this.firstStep) k = this.firstStep;
    const s = (t - this.epochSeconds - k * h) / h;
    const s2 = s * s, s3 = s2 * s, s4 = s3 * s, s5 = s4 * s;
    // Quintic Hermite basis; p = p0 + H5 (p1 - p0) + h (H1 v0 + H4 v1) + h^2 (H2 a0 + H3 a1).
    const h1 = s - 6 * s3 + 8 * s4 - 3 * s5;
    const h2 = 0.5 * s2 - 1.5 * s3 + 1.5 * s4 - 0.5 * s5;
    const h3 = 0.5 * s3 - s4 + 0.5 * s5;
    const h4 = -4 * s3 + 7 * s4 - 3 * s5;
    const h5 = 10 * s3 - 15 * s4 + 6 * s5;
    const d1 = 1 - 18 * s2 + 32 * s3 - 15 * s4;
    const d2 = s - 4.5 * s2 + 6 * s3 - 2.5 * s4;
    const d3 = 1.5 * s2 - 4 * s3 + 2.5 * s4;
    const d4 = -12 * s2 + 28 * s3 - 15 * s4;
    const d5 = 30 * s2 - 60 * s3 + 30 * s4;
    const hh = h * h;
    const left = this.sampleOffset(k);
    const right = this.sampleOffset(k + 1);
    for (let i = 0; i < this.bodyCount; i += 1) {
      const o0 = left.base + i * SAMPLE_STRIDE;
      const o1 = right.base + i * SAMPLE_STRIDE;
      for (let c = 0; c < 3; c += 1) {
        const p0 = left.chunk[o0 + c]!, p1 = right.chunk[o1 + c]!;
        const v0 = left.chunk[o0 + 3 + c]!, v1 = right.chunk[o1 + 3 + c]!;
        const a0 = left.chunk[o0 + 6 + c]!, a1 = right.chunk[o1 + 6 + c]!;
        const dp = p1 - p0;
        outPositions[i * 3 + c] = p0 + h5 * dp + h * (h1 * v0 + h4 * v1) + hh * (h2 * a0 + h3 * a1);
        if (outVelocities) {
          outVelocities[i * 3 + c] = d5 * dp / h + d1 * v0 + d4 * v1 + h * (d2 * a0 + d3 * a1);
        }
      }
    }
  }
}
