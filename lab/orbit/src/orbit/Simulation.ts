import { bodyOrientation, equatorialAxes } from './BodyRotation';
import { STANDARD_GRAVITY } from './Constants';
import { DominanceTree } from './Dominance';
import { Ephemeris, suggestedStepSeconds } from './Ephemeris';
import { FlightPlan, type ApsisPlacement, type BurnSchedule, type ManeuverSpec } from './FlightPlan';
import { stateFromElements } from './Kepler';
import { buildSystem, type BuiltSystem, type SystemSpec } from './SystemSpec';
import { Trajectory } from './Trajectory';
import { add, cross, dot, normalize, sub, type Vec3 } from './Vec3';
import type { Basis } from './BodyRotation';
import {
  PropagationRun, VesselPropagator, type AttitudeLaw, type ThrustControl, type Tolerances, type VesselState,
} from './VesselPropagator';

/**
 * Plane of the start orbit:
 * - equatorial: inclined from the home body's equator, ascending node at its equinox.
 * - orbit-of: the current orbital plane of one of the home body's satellites,
 *   same direction of motion, starting on the line to that satellite.
 */
export type StartPlane =
  | { kind: 'equatorial'; inclinationRadians: number }
  | { kind: 'orbit-of'; bodyId: string };

export interface VesselStartSpec {
  homeBodyId: string;
  altitudeMeters: number;
  plane: StartPlane;
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
  /** Coast after the last planned burn. */
  planCoastSeconds: number;
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

/** Relative mass mismatch at the end of a burn that counts as a bug, not rounding. */
const BURN_MASS_TOLERANCE = 1e-9;

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
  /** Burns flown automatically at full thrust when their start time arrives. */
  readonly plan: FlightPlan;
  private readonly predictor: VesselPropagator;
  private start: VesselStartSpec;
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
    this.start = { ...options.vesselStart };
    this.engine = checkedEngine(options.engine);
    this.retention = checkedPositive(options.retentionSeconds, 'retention');
    this.horizon = checkedPositive(options.predictionHorizonSeconds, 'prediction horizon');
    this.plan = new FlightPlan(this.ephemeris, options.tolerances, {
      thrustNewtons: this.engine.thrustNewtons, exhaustVelocity: this.exhaustVelocity, dryMassKg: this.engine.dryMassKg,
    }, options.planCoastSeconds);
    this.run = this.startRun();
    this.plan.rebase(this.run);
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

  /** The planned burn flying right now, if any. */
  get executingBurn(): BurnSchedule | null {
    const burn = this.plan.burns[0];
    if (!burn || this.impact) return null;
    return burn.startTime <= this.run.time && this.run.time < burn.endTime ? burn : null;
  }

  /** Throttle the engine actually runs at: a planned burn overrides the manual throttle. */
  get effectiveThrottle(): number {
    if (this.executingBurn) return 1;
    return this.fuelKg > 0 && !this.impact ? this.throttle : 0;
  }

  /** Append a maneuver. Plans from the current state unless a burn is flying. */
  addManeuver(spec: ManeuverSpec): number {
    this.requirePlannable();
    if (!this.executingBurn) this.plan.rebase(this.run);
    const i = this.plan.add(spec);
    this.resolveReferences();
    return i;
  }

  replaceManeuver(i: number, spec: ManeuverSpec): void {
    this.requireEditable(i);
    if (!this.executingBurn) this.plan.rebase(this.run);
    this.plan.replace(i, spec);
    this.resolveReferences();
  }

  removeManeuver(i: number): void {
    this.requireEditable(i);
    if (!this.executingBurn) this.plan.rebase(this.run);
    this.plan.remove(i);
    this.resolveReferences();
  }

  /** Move maneuver i so it is centred on the next apsis of the coast before it. */
  placeManeuverAtApsis(i: number, kind: 'periapsis' | 'apoapsis'): ApsisPlacement {
    this.requireEditable(i);
    if (!this.executingBurn) this.plan.rebase(this.run);
    const placement = this.plan.startAtApsis(i, kind, this.time);
    if (placement.ok) {
      this.plan.replace(i, { ...this.plan.maneuver(i), startTime: placement.startTime });
      this.resolveReferences();
    }
    return placement;
  }

  /** Grow the planned trajectory by at most maxSteps. */
  extendPlan(maxSteps: number): void {
    if (!this.impact) this.plan.extend(maxSteps);
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
    const law = this.executingBurn?.control?.attitude ?? this.attitudeLaw();
    return this.propagator.thrustDirection(law, this.time, state.position, state.velocity);
  }

  get vesselStart(): VesselStartSpec {
    return { ...this.start };
  }

  /** Used by the next resetVessel. */
  set vesselStart(spec: VesselStartSpec) {
    this.start = { ...spec };
  }

  /** Put a fresh vessel with full tanks on its start orbit at the current time. */
  resetVessel(): void {
    this.impact = null;
    this.throttle = 0;
    this.history.clear();
    this.run = this.startRun();
    this.plan.clear();
    this.plan.rebase(this.run);
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
      const burn = this.plan.burns[0] ?? null;
      let control: ThrustControl | null;
      let legEnd = target;
      let exhausts = false;
      let burnEnds = false;
      const planned = burn !== null && burn.startTime <= this.run.time;
      if (planned) {
        // Burns that have been flown are removed, so this one is in progress.
        control = burn.control;
        this.throttle = 0;
        if (burn.endTime <= target) { legEnd = burn.endTime; burnEnds = true; }
      } else {
        control = this.activeControl();
        if (control) {
          const burnout = this.run.time + (this.fuelKg * control.exhaustVelocity) / control.thrustNewtons;
          if (burnout <= target) { legEnd = burnout; exhausts = true; }
        }
        if (burn && burn.startTime < legEnd) { legEnd = burn.startTime; exhausts = false; }
      }
      if (control) thrusted = true;
      const outcome = this.propagator.advance(this.run, legEnd, left, this.history, control);
      if (outcome.kind === 'impact') {
        this.recordImpact(outcome.bodyIndex);
        this.plan.clear();
        this.ephemeris.extendTo(target);
        this.time = target;
        break;
      }
      // Manual thrust invalidates the plan's starting state; plan again from here.
      if (!planned && control) this.plan.rebase(this.run);
      if (outcome.kind === 'budget') { completed = false; break; }
      if (burnEnds) {
        const residual = this.run.y[6]! - burn!.massAfterKg;
        if (Math.abs(residual) > BURN_MASS_TOLERANCE * burn!.massBeforeKg) {
          throw new Error(`Simulation: mass after planned burn differs from the schedule by ${residual} kg`);
        }
        this.run.y[6] = burn!.massAfterKg;
        this.plan.completeFirst(this.run);
      }
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
    this.plan.trimBefore(this.time);
    // A plan whose integration fell behind the vessel restarts from the vessel.
    if (!this.impact && !this.executingBurn && this.plan.count > 0 && this.plan.computedUntil < this.time) this.plan.rebase(this.run);
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

  /**
   * Put every auto-reference burn on the body whose sphere of influence
   * holds the plan at its ignition, in order: the trajectory up to burn i
   * depends only on burns before it. A burn the plan cannot reach (in the
   * past, after an impact, not executable) keeps its body; it cannot fire.
   */
  private resolveReferences(): void {
    const positions = new Float64Array(this.ephemeris.bodyCount * 3);
    for (let i = 0; i < this.plan.count; i += 1) {
      const spec = this.plan.maneuver(i);
      if (spec.referenceMode !== 'auto' || !this.plan.status(i).ok) continue;
      // The burn in progress was resolved before it started.
      if (i === 0 && this.executingBurn) continue;
      const at = this.plan.positionAt(spec.startTime);
      if (!at) continue;
      this.ephemeris.positionsAt(spec.startTime, positions);
      const body = this.dominance.dominant(positions, at);
      if (body !== spec.referenceBody) this.plan.replace(i, { ...spec, referenceBody: body });
    }
  }

  private requirePlannable(): void {
    if (this.impact) throw new Error('Simulation: cannot plan after an impact');
  }

  private requireEditable(i: number): void {
    this.requirePlannable();
    if (i === 0 && this.executingBurn) throw new Error('Simulation: the burn in progress cannot be edited');
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
    const home = this.bodyIndex(this.start.homeBodyId);
    const body = this.system.bodies[home]!;
    const planet = this.ephemeris.bodyState(home, this.time);
    const plane = this.start.plane;
    const local = stateFromElements({
      semiMajorAxisMeters: body.radiusMeters + this.start.altitudeMeters,
      eccentricity: 0,
      inclinationRadians: plane.kind === 'equatorial' ? plane.inclinationRadians : 0,
      longitudeOfAscendingNodeRadians: 0,
      argumentOfPeriapsisRadians: 0,
      meanAnomalyRadians: 0,
    }, body.gm);
    // The elements are in the plane's own axes; rotate them into the ecliptic frame.
    const axes = plane.kind === 'equatorial' ? equatorialAxes(body) : this.satellitePlane(home, plane.bodyId);
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

  /** x toward the satellite, z along its orbital angular momentum about home. */
  private satellitePlane(home: number, satelliteId: string): Basis {
    const index = this.bodyIndex(satelliteId);
    if (this.system.bodies[index]!.parentIndex !== home) {
      throw new RangeError(`Simulation: ${satelliteId} does not orbit ${this.system.bodies[home]!.id}`);
    }
    const s = this.ephemeris.bodyState(index, this.time);
    const h = this.ephemeris.bodyState(home, this.time);
    const r = sub(s.position, h.position);
    const z = normalize(cross(r, sub(s.velocity, h.velocity)));
    const x = normalize(r);
    return { x, y: cross(z, x), z };
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
