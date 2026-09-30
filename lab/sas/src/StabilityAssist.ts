import type { Vec3 } from '../../landing/src/orbitCore';
import type { Quaternion } from '../../landing/src/physics/ContactWorld';
import { matVec, quatToMatrix, transpose } from '../../landing/src/vessel/Attitude';
import type { AttitudeSample } from '../../landing/src/vessel/Lander';

/**
 * off: the pilot's command passes through. pilot: a key is held; SAS stops spin on the other axes.
 * damping: keys released, SAS brings the spin down before it locks. holding: SAS holds the locked attitude.
 */
export type SasPhase = 'off' | 'pilot' | 'damping' | 'holding';

export interface SasTuning {
  /** Rate loop: the spin error is closed with this time constant, s. */
  rateSeconds: number;
  /** Attitude loop, s. At least 4 x rateSeconds, so the linear loop is critically damped or slower. */
  attitudeSeconds: number;
  /** Fraction of the unit's angular acceleration the approach plans to brake with; the rest is margin. */
  brakeFraction: number;
  /** Spin below which damping locks the current attitude, rad/s. */
  lockRate: number;
}

export const SAS_TUNING: SasTuning = { rateSeconds: 0.15, attitudeSeconds: 0.6, brakeFraction: 0.5, lockRate: 0.002 };

const ZERO: Vec3 = { x: 0, y: 0, z: 0 };
const AXES = ['x', 'y', 'z'] as const;

function conjugate(q: Quaternion): Quaternion { return { x: -q.x, y: -q.y, z: -q.z, w: q.w }; }

function multiply(a: Quaternion, b: Quaternion): Quaternion {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

/**
 * Rotation vector (axis times angle, rad) that turns the target attitude into the current one, in the craft's
 * local axes. conj(target) * current maps current local coordinates to target local ones; its axis is the same
 * vector in both. The shorter way round is taken.
 */
export function attitudeError(target: Quaternion, current: Quaternion): Vec3 {
  let r = multiply(conjugate(target), current);
  if (r.w < 0) r = { x: -r.x, y: -r.y, z: -r.z, w: -r.w };
  const s = Math.hypot(r.x, r.y, r.z);
  if (s === 0) return ZERO;
  const angle = 2 * Math.atan2(s, r.w);
  return { x: (r.x / s) * angle, y: (r.y / s) * angle, z: (r.z / s) * angle };
}

/**
 * KSP's stability assist on the craft's steering torque. It returns the same `turn` command a pilot gives (local
 * axes, each in [-1, 1], times the unit's maximum torque), so SAS never has more authority than the keys.
 * - With no keys held, it first stops the spin, then locks the attitude it came to rest at and holds it.
 * - While a key is held, that axis is the pilot's; the other axes are only kept from spinning. Releasing every key
 *   damps, then locks the new attitude, so the craft is not pulled back to where it was.
 * Control law, per local axis: a desired spin toward the target that allows braking to rest within brakeFraction
 * of the axis's angular acceleration (sqrt(2 b a |e|)), and linear (|e| / attitudeSeconds) close in; the rate
 * loop then asks for the angular acceleration (desired - spin) / rateSeconds. Torque is I alpha plus the
 * gyroscopic w x Iw; when it exceeds the unit's torque on some axis the whole vector is scaled down, keeping its
 * direction.
 * Attitudes and spin are in the frame the physics integrates in (the planet's body-fixed frame), so "holding"
 * means holding still in that frame.
 */
export class StabilityAssist {
  private currentPhase: SasPhase = 'off';
  private locked: Quaternion | null = null;

  /** maxTorque: N m per unit of turn command on each axis (lab/landing's STEERING_TORQUE). */
  constructor(readonly maxTorque: number, readonly tuning: SasTuning = SAS_TUNING) {
    if (!(maxTorque > 0) || !Number.isFinite(maxTorque)) throw new RangeError(`StabilityAssist: max torque ${maxTorque}`);
    const t = tuning;
    if (!(t.rateSeconds > 0) || !(t.attitudeSeconds >= 4 * t.rateSeconds) || !(t.brakeFraction > 0 && t.brakeFraction <= 1) || !(t.lockRate > 0)) {
      throw new RangeError(`StabilityAssist: bad tuning ${JSON.stringify(t)}`);
    }
  }

  get enabled(): boolean { return this.currentPhase !== 'off'; }
  get phase(): SasPhase { return this.currentPhase; }
  /** The held attitude while holding, else null. */
  get target(): Quaternion | null { return this.locked; }

  setEnabled(on: boolean): void {
    this.locked = null;
    this.currentPhase = on ? 'damping' : 'off';
  }

  toggle(): void { this.setEnabled(!this.enabled); }

  /** The turn command for the coming step of dt seconds. pilot: the pilot's turn command, each axis in [-1, 1]. */
  command(sample: AttitudeSample, pilot: Vec3, dt: number): Vec3 {
    if (!(dt > 0) || !Number.isFinite(dt)) throw new RangeError(`StabilityAssist: dt ${dt}`);
    for (const axis of AXES) if (!(pilot[axis] >= -1 && pilot[axis] <= 1)) throw new RangeError(`StabilityAssist: pilot command ${JSON.stringify(pilot)}`);
    if (this.currentPhase === 'off') return pilot;

    const inertia = sample.inertiaLocal;
    for (const [i, value] of inertia.entries()) if (!Number.isFinite(value) || (i % 4 === 0 && !(value > 0))) throw new RangeError(`StabilityAssist: inertia ${JSON.stringify(inertia)}`);
    const w = matVec(transpose(quatToMatrix(sample.rotation)), sample.angularVelocity);
    const held = AXES.filter((axis) => pilot[axis] !== 0);
    const { rateSeconds, attitudeSeconds, brakeFraction, lockRate } = this.tuning;

    let desired: Vec3 = ZERO;
    if (held.length > 0) {
      this.currentPhase = 'pilot';
      this.locked = null;
    } else {
      if (this.currentPhase !== 'holding') {
        this.currentPhase = 'damping';
        if (Math.hypot(w.x, w.y, w.z) < lockRate) {
          this.currentPhase = 'holding';
          this.locked = { ...sample.rotation };
        }
      }
      if (this.locked) {
        const e = attitudeError(this.locked, sample.rotation);
        const spin = (axis: typeof AXES[number], diagonal: number): number => {
          const size = Math.abs(e[axis]);
          const reach = Math.min(Math.sqrt(2 * brakeFraction * (this.maxTorque / diagonal) * size), size / attitudeSeconds);
          return -Math.sign(e[axis]) * reach;
        };
        desired = { x: spin('x', inertia[0]), y: spin('y', inertia[4]), z: spin('z', inertia[8]) };
      }
    }

    // Pilot axes take no acceleration from SAS; theirs is the pilot's command, set below.
    const alpha: Vec3 = { x: 0, y: 0, z: 0 };
    for (const axis of AXES) if (!held.includes(axis)) alpha[axis] = (desired[axis] - w[axis]) / rateSeconds;
    const iw = matVec(inertia, w);
    const ia = matVec(inertia, alpha);
    const torque = { x: ia.x + w.y * iw.z - w.z * iw.y, y: ia.y + w.z * iw.x - w.x * iw.z, z: ia.z + w.x * iw.y - w.y * iw.x };
    const out: Vec3 = { x: torque.x / this.maxTorque, y: torque.y / this.maxTorque, z: torque.z / this.maxTorque };
    const free = AXES.filter((axis) => !held.includes(axis));
    const largest = Math.max(0, ...free.map((axis) => Math.abs(out[axis])));
    const scale = largest > 1 ? 1 / largest : 1;
    for (const axis of AXES) out[axis] = held.includes(axis) ? pilot[axis] : out[axis] * scale;
    return out;
  }
}

