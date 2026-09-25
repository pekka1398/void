import { bodyOrientation, type Basis } from './BodyRotation';
import type { Ephemeris } from './Ephemeris';
import { cross, dot, normalize, sub, type Vec3 } from './Vec3';

/** Plotting frames in the spirit of Principia's navigation frames. */
export type FrameSpec =
  | { kind: 'barycentric' }
  | { kind: 'body-inertial'; body: number }
  | { kind: 'body-surface'; body: number }
  | { kind: 'two-body-rotating'; primary: number; secondary: number };

export interface FrameState {
  /** Frame origin in barycentric ecliptic coordinates. */
  origin: Vec3;
  axes: Basis;
}

const ECLIPTIC_AXES: Basis = Object.freeze({
  x: Object.freeze({ x: 1, y: 0, z: 0 }),
  y: Object.freeze({ x: 0, y: 1, z: 0 }),
  z: Object.freeze({ x: 0, y: 0, z: 1 }),
});

export function assertFrameSpec(spec: FrameSpec, bodyCount: number): void {
  const valid = (i: number) => Number.isInteger(i) && i >= 0 && i < bodyCount;
  switch (spec.kind) {
    case 'barycentric': return;
    case 'body-inertial':
    case 'body-surface':
      if (!valid(spec.body)) throw new RangeError(`frame body ${spec.body}`);
      return;
    case 'two-body-rotating':
      if (!valid(spec.primary) || !valid(spec.secondary) || spec.primary === spec.secondary) {
        throw new RangeError(`two-body frame ${spec.primary}/${spec.secondary}`);
      }
  }
}

/** Evaluates a frame at arbitrary covered times, reusing scratch buffers. */
export class FrameEvaluator {
  readonly spec: FrameSpec;
  private readonly ephemeris: Ephemeris;
  private readonly positions: Float64Array;
  private readonly velocities: Float64Array;

  constructor(ephemeris: Ephemeris, spec: FrameSpec) {
    assertFrameSpec(spec, ephemeris.bodyCount);
    this.ephemeris = ephemeris;
    this.spec = spec;
    this.positions = new Float64Array(ephemeris.bodyCount * 3);
    this.velocities = new Float64Array(ephemeris.bodyCount * 3);
  }

  /**
   * Characteristic period of the frame's own rotation at t; infinite for
   * non-rotating frames. A two-body frame uses its instantaneous angular rate.
   */
  rotationPeriodSeconds(t: number): number {
    const spec = this.spec;
    if (spec.kind === 'body-surface') return this.ephemeris.bodies[spec.body]!.rotation.periodSeconds;
    if (spec.kind !== 'two-body-rotating') return Number.POSITIVE_INFINITY;
    this.ephemeris.statesAt(t, this.positions, this.velocities);
    const r = sub(this.position(spec.secondary), this.position(spec.primary));
    const v = sub(this.velocity(spec.secondary), this.velocity(spec.primary));
    const h = cross(r, v);
    const omega = Math.hypot(h.x, h.y, h.z) / dot(r, r);
    if (!(omega > 0)) throw new Error('two-body frame has no rotation');
    return (2 * Math.PI) / omega;
  }

  /** Frame state plus the requested bodies' positions at t, from one ephemeris evaluation. */
  evaluate(t: number): FrameState {
    const spec = this.spec;
    if (spec.kind === 'barycentric') {
      this.ephemeris.positionsAt(t, this.positions);
      return { origin: { x: 0, y: 0, z: 0 }, axes: ECLIPTIC_AXES };
    }
    if (spec.kind === 'body-inertial') {
      this.ephemeris.positionsAt(t, this.positions);
      return { origin: this.position(spec.body), axes: ECLIPTIC_AXES };
    }
    if (spec.kind === 'body-surface') {
      this.ephemeris.positionsAt(t, this.positions);
      return { origin: this.position(spec.body), axes: bodyOrientation(this.ephemeris.bodies[spec.body]!, t) };
    }
    this.ephemeris.statesAt(t, this.positions, this.velocities);
    const m1 = this.ephemeris.bodies[spec.primary]!.gm;
    const m2 = this.ephemeris.bodies[spec.secondary]!.gm;
    const p1 = this.position(spec.primary), p2 = this.position(spec.secondary);
    const separation = sub(p2, p1);
    const relativeVelocity = sub(this.velocity(spec.secondary), this.velocity(spec.primary));
    const x = normalize(separation);
    const z = normalize(cross(separation, relativeVelocity));
    const total = m1 + m2;
    return {
      origin: {
        x: (m1 * p1.x + m2 * p2.x) / total,
        y: (m1 * p1.y + m2 * p2.y) / total,
        z: (m1 * p1.z + m2 * p2.z) / total,
      },
      axes: { x, y: cross(z, x), z },
    };
  }

  /** Position of a body from the most recent evaluate() call. */
  position(index: number): Vec3 {
    return { x: this.positions[index * 3]!, y: this.positions[index * 3 + 1]!, z: this.positions[index * 3 + 2]! };
  }

  private velocity(index: number): Vec3 {
    return { x: this.velocities[index * 3]!, y: this.velocities[index * 3 + 1]!, z: this.velocities[index * 3 + 2]! };
  }
}

export function toFrame(frame: FrameState, barycentric: Vec3): Vec3 {
  const d = sub(barycentric, frame.origin);
  return { x: dot(d, frame.axes.x), y: dot(d, frame.axes.y), z: dot(d, frame.axes.z) };
}

/** Rotate a barycentric direction into frame axes. */
export function directionToFrame(frame: FrameState, direction: Vec3): Vec3 {
  return { x: dot(direction, frame.axes.x), y: dot(direction, frame.axes.y), z: dot(direction, frame.axes.z) };
}
