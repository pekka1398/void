import { bodyOrientation } from './BodyRotation';
import { DominanceTree } from './Dominance';
import { Ephemeris, suggestedStepSeconds } from './Ephemeris';
import { stateFromElements } from './Kepler';
import { buildSystem, type BuiltSystem, type SystemSpec } from './SystemSpec';
import { Trajectory } from './Trajectory';
import { add, dot, sub, type Vec3 } from './Vec3';
import { PropagationRun, VesselPropagator, type Tolerances, type VesselState } from './VesselPropagator';

export interface VesselStartSpec {
  homeBodyId: string;
  altitudeMeters: number;
  inclinationRadians: number;
}

export interface SimulationOptions {
  system: SystemSpec;
  stepsPerOrbit: number;
  tolerances: Tolerances;
  vesselStart: VesselStartSpec;
  /** Past interval kept in the ephemeris and the vessel history, seconds. */
  retentionSeconds: number;
}

export interface ImpactRecord {
  bodyIndex: number;
  time: number;
  /** Impact point in the body's rotating axes. */
  bodyFixedPosition: Vec3;
}

export interface AdvanceReport {
  /** False when the step budget ran out before the requested time. */
  completed: boolean;
  steps: number;
}

/** Owns simulated time, the ephemeris and the one vessel. */
export class Simulation {
  readonly system: BuiltSystem;
  readonly ephemeris: Ephemeris;
  readonly propagator: VesselPropagator;
  readonly dominance: DominanceTree;
  readonly history = new Trajectory();
  private readonly vesselStart: VesselStartSpec;
  private retention: number;
  private run: PropagationRun;
  impact: ImpactRecord | null = null;
  time = 0;

  constructor(options: SimulationOptions) {
    this.system = buildSystem(options.system);
    this.ephemeris = new Ephemeris(this.system, {
      stepSeconds: suggestedStepSeconds(this.system.bodies, options.stepsPerOrbit),
      chunkSteps: 2048,
    });
    this.ephemeris.extendTo(this.ephemeris.stepSeconds);
    this.propagator = new VesselPropagator(this.ephemeris, options.tolerances);
    this.dominance = new DominanceTree(this.system.bodies);
    this.vesselStart = options.vesselStart;
    this.retention = this.checkedRetention(options.retentionSeconds);
    this.run = this.startRun();
  }

  get vessel(): VesselState {
    return this.run.state;
  }

  get retentionSeconds(): number {
    return this.retention;
  }

  set retentionSeconds(value: number) {
    this.retention = this.checkedRetention(value);
  }

  bodyIndex(id: string): number {
    const body = this.system.bodies.find((b) => b.id === id);
    if (!body) throw new RangeError(`Simulation: unknown body ${id}`);
    return body.index;
  }

  /** Put a fresh vessel on its start orbit at the current time. */
  resetVessel(): void {
    this.impact = null;
    this.history.clear();
    this.run = this.startRun();
  }

  /** Advance simulated time by dt, spending at most maxSteps vessel steps. */
  advance(dt: number, maxSteps: number): AdvanceReport {
    if (!(dt >= 0) || !Number.isFinite(dt)) throw new RangeError(`Simulation.advance(${dt})`);
    const target = this.time + dt;
    let completed = true;
    const before = this.propagator.acceptedSteps;
    if (this.impact) {
      this.ephemeris.extendTo(target);
      this.time = target;
    } else {
      const outcome = this.propagator.advance(this.run, target, maxSteps, this.history);
      if (outcome.kind === 'impact') {
        this.recordImpact(outcome.bodyIndex);
        this.ephemeris.extendTo(target);
        this.time = target;
      } else {
        completed = outcome.kind === 'reached';
        this.time = this.run.time;
      }
    }
    const horizon = this.time - this.retention;
    this.ephemeris.forgetBefore(horizon);
    this.history.trimBefore(horizon);
    return { completed, steps: this.propagator.acceptedSteps - before };
  }

  /** Barycentric vessel position at t, following the impact site after a crash. */
  vesselPositionAt(t: number): Vec3 {
    if (this.impact && t >= this.impact.time) {
      const body = this.system.bodies[this.impact.bodyIndex]!;
      const axes = bodyOrientation(body, t);
      const p = this.impact.bodyFixedPosition;
      const center = this.ephemeris.bodyPosition(body.index, t);
      return {
        x: center.x + p.x * axes.x.x + p.y * axes.y.x + p.z * axes.z.x,
        y: center.y + p.x * axes.x.y + p.y * axes.y.y + p.z * axes.z.y,
        z: center.z + p.x * axes.x.z + p.y * axes.y.z + p.z * axes.z.z,
      };
    }
    return this.history.sample(t).position;
  }

  private startRun(): PropagationRun {
    const home = this.bodyIndex(this.vesselStart.homeBodyId);
    const body = this.system.bodies[home]!;
    const planet = this.ephemeris.bodyState(home, this.time);
    const relative = stateFromElements({
      semiMajorAxisMeters: body.radiusMeters + this.vesselStart.altitudeMeters,
      eccentricity: 0,
      inclinationRadians: this.vesselStart.inclinationRadians,
      longitudeOfAscendingNodeRadians: 0,
      argumentOfPeriapsisRadians: 0,
      meanAnomalyRadians: 0,
    }, body.gm);
    const run = new PropagationRun({
      time: this.time,
      position: add(planet.position, relative.position),
      velocity: add(planet.velocity, relative.velocity),
    });
    this.history.append(run.time, run.y);
    return run;
  }

  private recordImpact(bodyIndex: number): void {
    const body = this.system.bodies[bodyIndex]!;
    const state = this.run.state;
    const axes = bodyOrientation(body, state.time);
    const r = sub(state.position, this.ephemeris.bodyPosition(bodyIndex, state.time));
    this.impact = {
      bodyIndex,
      time: state.time,
      bodyFixedPosition: { x: dot(r, axes.x), y: dot(r, axes.y), z: dot(r, axes.z) },
    };
  }

  private checkedRetention(value: number): number {
    if (!(value > 0) || !Number.isFinite(value)) throw new RangeError(`retention ${value}`);
    return value;
  }
}
