import { PropagationRun, Trajectory, VesselPropagator, type Ephemeris, type Tolerances, type Vec3 } from '../orbitCore';
import { PlanetFrame, type FrameState } from '../physics/PlanetFrame';
import type { Terrain } from '../terrain/Surface';

export interface CoastPrediction {
  /** Body-fixed positions, ending at the terrain crossing when there is one. */
  points: { time: number; position: Vec3 }[];
  impact: { time: number; position: Vec3 } | null;
  /**
   * The same coast as barycentric inertial integrator samples (for map views
   * and apsides). It ends at the first step past the terrain crossing, at
   * most one sampling interval (about a second near the ground) beyond it.
   */
  trajectory: Trajectory;
}

function clearance(state: FrameState, terrain: Terrain): number {
  const p = state.position;
  const r = Math.hypot(p.x, p.y, p.z);
  return r - terrain.radiusMeters - terrain.sample({ x: p.x / r, y: p.y / r, z: p.z / r }).heightMeters;
}

/** Coast from the current state through orbit physics, stopping at the sampled terrain. */
export function predictCoast(ephemeris: Ephemeris, frame: PlanetFrame, terrain: Terrain, tolerances: Tolerances,
  time: number, state: FrameState, massKg: number, horizonSeconds = 1200): CoastPrediction {
  const result: CoastPrediction = { points: [{ time, position: { ...state.position } }], impact: null, trajectory: new Trajectory() };
  const inertial = frame.toInertial(time, state);
  const run = new PropagationRun({ time, ...inertial, massKg });
  result.trajectory.append(time, run.y);
  if (clearance(state, terrain) <= 0) return result;
  const propagator = new VesselPropagator(ephemeris, tolerances);
  let previous = state;
  let previousTime = time;
  const end = time + horizonSeconds;
  while (run.time < end - 1e-8) {
    const h = Math.max(1, Math.min(15, clearance(previous, terrain) / Math.max(1, Math.hypot(previous.velocity.x, previous.velocity.y, previous.velocity.z))));
    const outcome = propagator.advance(run, Math.min(end, run.time + h), 10000, result.trajectory, null);
    if (outcome.kind === 'budget') throw new Error('coast prediction step budget exhausted');
    const now = frame.toBodyFixed(run.time, run.state);
    const nextClearance = clearance(now, terrain);
    if (nextClearance <= 0 || outcome.kind === 'impact') {
      // Interpolate the two body-fixed states to the terrain crossing. Near
      // the ground the sampling interval is at most one second.
      let lo = 0, hi = 1;
      for (let i = 0; i < 20; i += 1) {
        const f = (lo + hi) / 2;
        const p = { x: previous.position.x + f * (now.position.x - previous.position.x),
          y: previous.position.y + f * (now.position.y - previous.position.y), z: previous.position.z + f * (now.position.z - previous.position.z) };
        if (clearance({ position: p, velocity: now.velocity }, terrain) > 0) lo = f; else hi = f;
      }
      const f = (lo + hi) / 2;
      const position = { x: previous.position.x + f * (now.position.x - previous.position.x),
        y: previous.position.y + f * (now.position.y - previous.position.y), z: previous.position.z + f * (now.position.z - previous.position.z) };
      result.impact = { time: previousTime + f * (run.time - previousTime), position };
      result.points.push(result.impact);
      break;
    }
    result.points.push({ time: run.time, position: now.position });
    previous = now;
    previousTime = run.time;
  }
  return result;
}
