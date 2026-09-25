import type { Ephemeris } from './Ephemeris';
import type { Trajectory } from './Trajectory';
import type { Vec3 } from './Vec3';

export interface Apsis {
  kind: 'periapsis' | 'apoapsis';
  time: number;
  /** Barycentric vessel position at the apsis. */
  position: Vec3;
  /** Distance from the reference body's centre. */
  distanceMeters: number;
}

const TIME_RESOLUTION_SECONDS = 1e-3;

/**
 * Actual (not osculating) apsides of a trajectory relative to one body: zeros
 * of the radial velocity, bracketed at step points and refined by bisection
 * on the trajectory's Hermite interpolation.
 */
export function findApsides(
  trajectory: Trajectory, ephemeris: Ephemeris, bodyIndex: number, fromTime: number, maxCount: number,
): Apsis[] {
  const found: Apsis[] = [];
  if (trajectory.count < 2) return found;
  const positions = new Float64Array(ephemeris.bodyCount * 3);
  const velocities = new Float64Array(ephemeris.bodyCount * 3);
  const b = bodyIndex * 3;
  const radialRate = (t: number, p: Vec3, v: Vec3): { rate: number; distance: number } => {
    ephemeris.statesAt(t, positions, velocities);
    const rx = p.x - positions[b]!, ry = p.y - positions[b + 1]!, rz = p.z - positions[b + 2]!;
    const ux = v.x - velocities[b]!, uy = v.y - velocities[b + 1]!, uz = v.z - velocities[b + 2]!;
    return { rate: rx * ux + ry * uy + rz * uz, distance: Math.hypot(rx, ry, rz) };
  };
  let i = 0;
  while (i < trajectory.count - 1 && trajectory.time(i + 1) <= fromTime) i += 1;
  let previous = radialRate(trajectory.time(i), trajectory.position(i), trajectory.velocity(i));
  for (; i < trajectory.count - 1 && found.length < maxCount; i += 1) {
    const next = radialRate(trajectory.time(i + 1), trajectory.position(i + 1), trajectory.velocity(i + 1));
    if (previous.rate !== 0 && Math.sign(previous.rate) !== Math.sign(next.rate)) {
      const kind = previous.rate < 0 ? 'periapsis' : 'apoapsis';
      let lo = trajectory.time(i);
      let hi = trajectory.time(i + 1);
      const loSign = Math.sign(previous.rate);
      while (hi - lo > TIME_RESOLUTION_SECONDS) {
        const mid = 0.5 * (lo + hi);
        const s = trajectory.sample(mid);
        if (Math.sign(radialRate(mid, s.position, s.velocity).rate) === loSign) lo = mid;
        else hi = mid;
      }
      const t = 0.5 * (lo + hi);
      const s = trajectory.sample(t);
      if (t >= fromTime) {
        found.push({ kind, time: t, position: s.position, distanceMeters: radialRate(t, s.position, s.velocity).distance });
      }
    }
    previous = next;
  }
  return found;
}
