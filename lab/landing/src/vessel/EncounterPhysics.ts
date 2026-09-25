import type { Vec3 } from '../orbitCore';

export interface EncounterPhysicsRanges {
  /** Enter detailed, mutually collidable physics inside this distance. */
  unpackMeters: number;
  /** Return to independent orbital propagation only beyond this distance. */
  packMeters: number;
}

export interface EncounterPairState {
  first: string;
  second: string;
  distanceMeters: number;
  physics: boolean;
  changed: boolean;
  closestApproachMeters: number;
  timeToClosestApproachSeconds: number;
}

export interface EncounterKinematics {
  position: Vec3;
  velocity: Vec3;
}

/**
 * Hysteresis gate for an orbital encounter. Callers pass both vessel states in
 * the same frame (normally barycentric inertial or one shared local frame) and
 * the length of the next orbital propagation interval. Predicting the closest
 * approach within that interval avoids stepping over the unpack sphere.
 * A true pair means both vessels must be promoted together into one local
 * physics scene before mutual collision or docking can be simulated.
 */
export class EncounterPhysicsGate {
  readonly ranges: EncounterPhysicsRanges;
  private readonly active = new Map<string, { first: string; second: string }>();

  constructor(ranges: EncounterPhysicsRanges = { unpackMeters: 10_000, packMeters: 15_000 }) {
    if (!(ranges.unpackMeters > 0) || !(ranges.packMeters > ranges.unpackMeters)) {
      throw new RangeError(`EncounterPhysicsGate: invalid ranges ${ranges.unpackMeters}/${ranges.packMeters}`);
    }
    this.ranges = { ...ranges };
  }

  update(firstId: string, first: EncounterKinematics, secondId: string, second: EncounterKinematics,
    lookaheadSeconds: number): EncounterPairState {
    if (!firstId || !secondId || firstId === secondId) throw new RangeError('EncounterPhysicsGate: expected two distinct vessel ids');
    if (!(lookaheadSeconds >= 0) || !Number.isFinite(lookaheadSeconds)) throw new RangeError(`EncounterPhysicsGate: lookahead ${lookaheadSeconds}`);
    const key = pairKey(firstId, secondId);
    const dx = second.position.x - first.position.x;
    const dy = second.position.y - first.position.y;
    const dz = second.position.z - first.position.z;
    const distanceMeters = Math.hypot(dx, dy, dz);
    if (!Number.isFinite(distanceMeters)) throw new RangeError('EncounterPhysicsGate: non-finite position');
    const vx = second.velocity.x - first.velocity.x;
    const vy = second.velocity.y - first.velocity.y;
    const vz = second.velocity.z - first.velocity.z;
    const speedSquared = vx * vx + vy * vy + vz * vz;
    const timeToClosestApproachSeconds = speedSquared > 0
      ? Math.max(0, Math.min(lookaheadSeconds, -(dx * vx + dy * vy + dz * vz) / speedSquared))
      : 0;
    const cx = dx + vx * timeToClosestApproachSeconds;
    const cy = dy + vy * timeToClosestApproachSeconds;
    const cz = dz + vz * timeToClosestApproachSeconds;
    const closestApproachMeters = Math.hypot(cx, cy, cz);
    const wasActive = this.active.has(key);
    const threshold = wasActive ? this.ranges.packMeters : this.ranges.unpackMeters;
    const physics = distanceMeters <= threshold || closestApproachMeters < threshold;
    if (physics && !wasActive) this.active.set(key, { first: firstId, second: secondId });
    else if (!physics && wasActive) this.active.delete(key);
    return { first: firstId, second: secondId, distanceMeters, physics, changed: physics !== wasActive,
      closestApproachMeters, timeToClosestApproachSeconds };
  }

  isPhysicsActive(vesselId: string): boolean {
    for (const pair of this.active.values()) if (pair.first === vesselId || pair.second === vesselId) return true;
    return false;
  }

  activePairs(): ReadonlyArray<Readonly<{ first: string; second: string }>> {
    return [...this.active.values()];
  }

  removeVessel(vesselId: string): void {
    for (const [key, pair] of this.active) if (pair.first === vesselId || pair.second === vesselId) this.active.delete(key);
  }
}

function pairKey(a: string, b: string): string {
  return JSON.stringify(a < b ? [a, b] : [b, a]);
}
