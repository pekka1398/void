import { bodyOrientation, equatorialAxes } from './BodyRotation';
import { STANDARD_GRAVITY } from './Constants';
import { DominanceTree } from './Dominance';
import { Ephemeris, suggestedStepSeconds } from './Ephemeris';
import { stateFromElements } from './Kepler';
import { buildSystem, type BuiltSystem, type SystemSpec } from './SystemSpec';
import { Trajectory } from './Trajectory';
import { add, dot, sub, type Vec3 } from './Vec3';
import {
  PropagationRun, VesselPropagator, type AttitudeLaw, type ThrustControl, type Tolerances, type VesselState,
} from './VesselPropagator';

export interface VesselStartSpec {
  homeBodyId: string;
  altitudeMeters: number;
  /** Relative to the home body's equator. */
  inclinationRadians: number;
}

export interface EngineSpec {
  thrustNewtons: number;
  specificImpulseSeconds: number;
  dryMassKg: number;
  /** Propellant loaded at (re)start. */
  fuelMassKg: number;
}

export interface SimulationOptions {
  system: SystemSpec;
  stepsPerOrbit: number;
  tolerances: Tolerances;
  vesselStart: VesselStartSpec;
  engine: EngineSpec;
  /** Past interval kept in the ephemeris and the vessel history, seconds. */
  retentionSeconds: number;
  predictionHorizonSeconds: number;
}

export type AttitudeMode = 'prograde' | 'retrograde' | 'normal' | 'antinormal' | 'radial-out' | 'radial-in' | 'hold';

const FRENET_COMPONENTS: Record<Exclude<AttitudeMode, 'hold'>, readonly [number, number, number]> = {
  prograde: [1, 0, 0],
  retrograde: [-1, 0, 0],
  normal: [0, 1, 0],
  antinormal: [0, -1, 0],
  'radial-out': [0, 0, 1],
  'radial-in': [0, 0, -1],
};

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
  /** True when the engine produced thrust at any point of this advance. */
  thrusted: boolean;
}

/** Owns simulated time, the ephemeris, the one vessel, its controls and its prediction. */
export class Simulation {
  readonly system: BuiltSystem;
  readonly ephemeris: Ephemeris;
  readonly propagator: VesselPropagator;
  readonly dominance: DominanceTree;
  readonly history = new Trajectory();
  /** Coast prediction from the current state (engine assumed off). */
  readonly prediction = new Trajectory();
  readonly engine: EngineSpec;
  private readonly predictor: VesselPropagator;
  private readonly vesselStart: VesselStartSpec;
  private retention: number;
  private horizon: number;
  private run: PropagationRun;
  private predictionRun: PropagationRun | null = null;
  /** Increments whenever the prediction restarts from a new state. */
  predictionGeneration = 0;
  impact: ImpactRecord | null = null;
  time = 0;
  /** 0..1 */
  throttle = 0;
  /** null follows the dominant body. */
  referenceChoice: number | null = null;
  private attitude: AttitudeMode = 'prograde';
  private heldDirection: Vec3 | null = null;

  constructor(options: SimulationOptions) {
    this.system = buildSystem(options.system);
    this.ephemeris = new Ephemeris(this.system, {
      stepSeconds: suggestedStepSeconds(this.system.bodies, options.stepsPerOrbit),
      chunkSteps: 2048,
    });
    this.ephemeris.extendTo(this.ephemeris.stepSeconds);
    this.propagator = new VesselPropagator(this.ephemeris, options.tolerances);
    this.predictor = new VesselPropagator(this.ephemeris, options.tolerances);
    this.dominance = new DominanceTree(this.system.bodies);
    this.vesselStart = options.vesselStart;
    this.engine = checkedEngine(options.engine);
    this.retention = checkedPositive(options.retentionSeconds, 'retention');
    this.horizon = checkedPositive(options.predictionHorizonSeconds, 'prediction horizon');
    this.run = this.startRun();
    this.restartPrediction();
  }

  get vessel(): VesselState {
    return this.run.state;
  }

  get retentionSeconds(): number {
    return this.retention;
  }

  set retentionSeconds(value: number) {
    this.retention = checkedPositive(value, 'retention');
  }

  get predictionHorizonSeconds(): number {
    return this.horizon;
  }

  set predictionHorizonSeconds(value: number) {
    this.horizon = checkedPositive(value, 'prediction horizon');
  }

  get predictionImpact(): { bodyIndex: number; time: number } | null {
    return this.predictionRun?.impact ?? null;
  }

  get attitudeMode(): AttitudeMode {
    return this.attitude;
  }

  get exhaustVelocity(): number {
    return this.engine.specificImpulseSeconds * STANDARD_GRAVITY;
  }

  get fuelKg(): number {
    return this.run.state.massKg - this.engine.dryMassKg;
  }

  /** Tsiolkovsky delta-v left in the tanks. */
  get deltaVRemaining(): number {
    return this.exhaustVelocity * Math.log(this.run.state.massKg / this.engine.dryMassKg);
  }

  bodyIndex(id: string): number {
    const body = this.system.bodies.find((b) => b.id === id);
    if (!body) throw new RangeError(`Simulation: unknown body ${id}`);
    return body.index;
  }

  /** The chosen reference body, or the body whose sphere of influence holds the vessel. */
  navigationReference(): number {
    if (this.referenceChoice !== null) return this.referenceChoice;
    const positions = new Float64Array(this.ephemeris.bodyCount * 3);
    if (this.impact) {
      this.ephemeris.positionsAt(this.time, positions);
      return this.dominance.dominant(positions, this.vesselPositionAt(this.time));
    }
    this.ephemeris.positionsAt(this.run.time, positions);
    return this.dominance.dominant(positions, this.run.state.position);
  }

  setAttitude(mode: AttitudeMode): void {
    if (mode === 'hold') this.heldDirection = this.thrustDirection();
    this.attitude = mode;
  }

  /** The direction the engine points right now. */
  thrustDirection(): Vec3 {
    const state = this.run.state;
    return this.propagator.thrustDirection(this.attitudeLaw(), this.time, state.position, state.velocity);
  }

  /** Put a fresh vessel with full tanks on its start orbit at the current time. */
  resetVessel(): void {
    this.impact = null;
    this.throttle = 0;
    this.history.clear();
    this.run = this.startRun();
    this.restartPrediction();
  }

  /** Advance simulated time by dt, spending at most maxSteps vessel steps. */
  advance(dt: number, maxSteps: number): AdvanceReport {
    if (!(dt >= 0) || !Number.isFinite(dt)) throw new RangeError(`Simulation.advance(${dt})`);
    if (!(this.throttle >= 0 && this.throttle <= 1)) throw new RangeError(`throttle ${this.throttle}`);
    const target = this.time + dt;
    let completed = true;
    let thrusted = false;
    const before = this.propagator.acceptedSteps;
    if (this.impact) {
      this.ephemeris.extendTo(target);
      this.time = target;
    }
    while (!this.impact && this.run.time < target) {
      const left = maxSteps - (this.propagator.acceptedSteps - before);
      if (left <= 0) { completed = false; break; }
      const control = this.activeControl();
      let legEnd = target;
      let exhausts = false;
      if (control) {
        const burnout = this.run.time + (this.fuelKg * control.exhaustVelocity) / control.thrustNewtons;
        if (burnout <= target) { legEnd = burnout; exhausts = true; }
        thrusted = true;
      }
      const outcome = this.propagator.advance(this.run, legEnd, left, this.history, control);
      if (outcome.kind === 'impact') {
        this.recordImpact(outcome.bodyIndex);
        this.ephemeris.extendTo(target);
        this.time = target;
        break;
      }
      if (outcome.kind === 'budget') { completed = false; break; }
      if (exhausts) {
        // The leg ended exactly at burnout; remove only rounding from the mass.
        const residual = this.run.y[6]! - this.engine.dryMassKg;
        if (Math.abs(residual) > 1e-6 * this.engine.dryMassKg) {
          throw new Error(`Simulation: mass at burnout differs from dry mass by ${residual} kg`);
        }
        this.run.y[6] = this.engine.dryMassKg;
      }
    }
    if (!this.impact) this.time = this.run.time;
    const horizonStart = this.time - this.retention;
    this.ephemeris.forgetBefore(horizonStart);
    this.history.trimBefore(horizonStart);
    if (thrusted || this.impact || (this.predictionRun && this.prediction.lastTime < this.time)) this.restartPrediction();
    else this.prediction.trimBefore(this.time);
    return { completed, steps: this.propagator.acceptedSteps - before, thrusted };
  }

  /** Grow the coast prediction toward now + horizon by at most maxSteps. */
  extendPrediction(maxSteps: number): void {
    const run = this.predictionRun;
    if (!run || run.impact) return;
    const end = this.time + this.horizon;
    if (run.time >= end) return;
    this.predictor.advance(run, end, maxSteps, this.prediction, null);
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

  private attitudeLaw(): AttitudeLaw {
    if (this.attitude === 'hold') {
      if (!this.heldDirection) throw new Error('Simulation: hold attitude without a captured direction');
      return { kind: 'inertial', direction: this.heldDirection };
    }
    const [tangent, normal, radial] = FRENET_COMPONENTS[this.attitude];
    return { kind: 'frenet', referenceBody: this.navigationReference(), tangent, normal, radial };
  }

  private activeControl(): ThrustControl | null {
    if (this.throttle === 0 || this.fuelKg <= 0) return null;
    return {
      thrustNewtons: this.engine.thrustNewtons * this.throttle,
      exhaustVelocity: this.exhaustVelocity,
      minimumMassKg: this.engine.dryMassKg,
      attitude: this.attitudeLaw(),
    };
  }

  private restartPrediction(): void {
    this.prediction.clear();
    this.predictionGeneration += 1;
    if (this.impact) {
      this.predictionRun = null;
      return;
    }
    this.predictionRun = this.run.clone();
    this.prediction.append(this.predictionRun.time, this.predictionRun.y);
  }

  private startRun(): PropagationRun {
    const home = this.bodyIndex(this.vesselStart.homeBodyId);
    const body = this.system.bodies[home]!;
    const planet = this.ephemeris.bodyState(home, this.time);
    const local = stateFromElements({
      semiMajorAxisMeters: body.radiusMeters + this.vesselStart.altitudeMeters,
      eccentricity: 0,
      inclinationRadians: this.vesselStart.inclinationRadians,
      longitudeOfAscendingNodeRadians: 0,
      argumentOfPeriapsisRadians: 0,
      meanAnomalyRadians: 0,
    }, body.gm);
    // The elements are equatorial; rotate them into the ecliptic frame.
    const axes = equatorialAxes(body);
    const toEcliptic = (v: Vec3): Vec3 => ({
      x: v.x * axes.x.x + v.y * axes.y.x + v.z * axes.z.x,
      y: v.x * axes.x.y + v.y * axes.y.y + v.z * axes.z.y,
      z: v.x * axes.x.z + v.y * axes.y.z + v.z * axes.z.z,
    });
    const relative = { position: toEcliptic(local.position), velocity: toEcliptic(local.velocity) };
    const run = new PropagationRun({
      time: this.time,
      position: add(planet.position, relative.position),
      velocity: add(planet.velocity, relative.velocity),
      massKg: this.engine.dryMassKg + this.engine.fuelMassKg,
    });
    this.history.append(run.time, run.y);
    return run;
  }

  private recordImpact(bodyIndex: number): void {
    const body = this.system.bodies[bodyIndex]!;
    const state = this.run.state;
    const axes = bodyOrientation(body, state.time);
    const r = sub(state.position, this.ephemeris.bodyPosition(bodyIndex, state.time));
    this.throttle = 0;
    this.impact = {
      bodyIndex,
      time: state.time,
      bodyFixedPosition: { x: dot(r, axes.x), y: dot(r, axes.y), z: dot(r, axes.z) },
    };
  }
}

function checkedPositive(value: number, label: string): number {
  if (!(value > 0) || !Number.isFinite(value)) throw new RangeError(`${label} ${value}`);
  return value;
}

function checkedEngine(engine: EngineSpec): EngineSpec {
  checkedPositive(engine.thrustNewtons, 'thrust');
  checkedPositive(engine.specificImpulseSeconds, 'specific impulse');
  checkedPositive(engine.dryMassKg, 'dry mass');
  if (!(engine.fuelMassKg >= 0) || !Number.isFinite(engine.fuelMassKg)) throw new RangeError(`fuel ${engine.fuelMassKg}`);
  return { ...engine };
}
