import { findApsides } from './Apsides';
import type { Ephemeris } from './Ephemeris';
import { osculatingOrbit } from './Kepler';
import { Trajectory } from './Trajectory';
import { sub } from './Vec3';
import { PropagationRun, VesselPropagator, type ThrustControl, type Tolerances } from './VesselPropagator';

/** A planned burn: Δv components along the Frenet axes relative to referenceBody. */
export interface ManeuverSpec {
  startTime: number;
  referenceBody: number;
  /** m/s along the velocity relative to the reference body. */
  prograde: number;
  /** m/s along the orbit normal r x v. */
  normal: number;
  /** m/s along prograde x normal (radial out on a circular orbit). */
  radial: number;
}

export interface PlanEngine {
  thrustNewtons: number;
  exhaustVelocity: number;
  dryMassKg: number;
}

/** A maneuver made concrete: full thrust from startTime until the Δv is spent. */
export interface BurnSchedule {
  startTime: number;
  endTime: number;
  deltaV: number;
  massBeforeKg: number;
  massAfterKg: number;
  /** null for a zero Δv, which takes no time and does nothing. */
  control: ThrustControl | null;
}

export type ManeuverStatus = { ok: true; burn: BurnSchedule } | { ok: false; reason: string };

export type ApsisPlacement = { ok: true; startTime: number } | { ok: false; reason: string };

/** Coasting steps allowed when searching for an apsis to centre a burn on. */
const APSIS_SEARCH_MAX_STEPS = 200_000;

/**
 * A sequence of burns executed at full thrust, and the trajectory they give
 * from an anchor state. Burns are checked in order; the first one that
 * cannot happen (in the past, overlapping, not enough propellant) ends the
 * executable plan, and every later burn is reported as blocked by it.
 */
export class FlightPlan {
  readonly trajectory = new Trajectory();
  /** Increments whenever the trajectory restarts. */
  generation = 0;
  private readonly ephemeris: Ephemeris;
  private readonly propagator: VesselPropagator;
  private readonly engine: PlanEngine;
  private coast: number;
  private specs: ManeuverSpec[] = [];
  private statuses: ManeuverStatus[] = [];
  private schedule: BurnSchedule[] = [];
  private anchor: PropagationRun | null = null;
  private run: PropagationRun | null = null;
  /** Burns executed and removed since construction. */
  completedCount = 0;

  constructor(ephemeris: Ephemeris, tolerances: Tolerances, engine: PlanEngine, coastSeconds: number) {
    if (!(engine.thrustNewtons > 0) || !(engine.exhaustVelocity > 0) || !(engine.dryMassKg > 0)) {
      throw new RangeError(`FlightPlan: engine ${JSON.stringify(engine)}`);
    }
    this.ephemeris = ephemeris;
    this.propagator = new VesselPropagator(ephemeris, tolerances);
    this.engine = { ...engine };
    this.coast = checkedCoast(coastSeconds);
  }

  get count(): number {
    return this.specs.length;
  }

  /** The executable prefix of the plan. */
  get burns(): readonly BurnSchedule[] {
    return this.schedule;
  }

  get coastSeconds(): number {
    return this.coast;
  }

  /** Lengthening keeps what is integrated and continues; shortening restarts. */
  set coastSeconds(value: number) {
    const shorter = checkedCoast(value) < this.coast;
    this.coast = value;
    if (shorter) this.restart();
  }

  get anchorTime(): number {
    if (!this.anchor) throw new Error('FlightPlan: no anchor');
    return this.anchor.time;
  }

  /** Coasting ends this long after the last executable burn. */
  get endTime(): number {
    const last = this.schedule[this.schedule.length - 1];
    return (last ? last.endTime : this.anchorTime) + this.coast;
  }

  /** How far the trajectory has been integrated. */
  get computedUntil(): number {
    if (!this.run) throw new Error('FlightPlan: no anchor');
    return this.run.time;
  }

  get impact(): { bodyIndex: number; time: number } | null {
    return this.run?.impact ?? null;
  }

  get complete(): boolean {
    return this.run !== null && (this.run.impact !== null || this.run.time >= this.endTime);
  }

  maneuver(i: number): ManeuverSpec {
    const spec = this.specs[i];
    if (!spec) throw new RangeError(`FlightPlan: maneuver ${i} of ${this.specs.length}`);
    return { ...spec };
  }

  status(i: number): ManeuverStatus {
    const status = this.statuses[i];
    if (!status) throw new RangeError(`FlightPlan: maneuver ${i} of ${this.specs.length}`);
    return status;
  }

  /** Start planning from this state; the run is copied. */
  rebase(state: PropagationRun): void {
    if (state.impact) throw new Error('FlightPlan: cannot plan from an impact');
    this.anchor = state.clone();
    this.restart();
  }

  add(spec: ManeuverSpec): number {
    this.specs.push(this.checked(spec));
    this.restart();
    return this.specs.length - 1;
  }

  replace(i: number, spec: ManeuverSpec): void {
    this.maneuver(i);
    this.specs[i] = this.checked(spec);
    this.restart();
  }

  remove(i: number): void {
    this.maneuver(i);
    this.specs.splice(i, 1);
    this.restart();
  }

  clear(): void {
    this.specs = [];
    this.restart();
  }

  /**
   * The first burn has been flown: drop it and continue planning from the
   * state it left the vessel in.
   */
  completeFirst(state: PropagationRun): void {
    if (this.schedule.length === 0) throw new Error('FlightPlan: no executable burn to complete');
    this.specs.shift();
    this.completedCount += 1;
    this.rebase(state);
  }

  /** Integrate the planned trajectory further by at most maxSteps accepted steps. */
  extend(maxSteps: number): void {
    const run = this.run;
    if (!run || this.specs.length === 0) return;
    const end = this.endTime;
    let left = maxSteps;
    while (!run.impact && run.time < end && left > 0) {
      let legEnd = end;
      let control: ThrustControl | null = null;
      const burn = this.schedule.find((b) => b.endTime > run.time);
      if (burn && run.time < burn.startTime) legEnd = burn.startTime;
      else if (burn) { legEnd = burn.endTime; control = burn.control; }
      const before = this.propagator.acceptedSteps;
      const outcome = this.propagator.advance(run, legEnd, left, this.trajectory, control);
      left -= this.propagator.acceptedSteps - before;
      if (outcome.kind !== 'reached') break;
    }
  }

  /** Drop trajectory samples before t (keeping the one bracketing it). */
  trimBefore(t: number): void {
    if (this.trajectory.count > 0) this.trajectory.trimBefore(t);
  }

  /**
   * A start time centring maneuver i on the next apsis of the coast before
   * it (the state after burn i - 1, or the anchor), at or after notBefore.
   */
  startAtApsis(i: number, kind: 'periapsis' | 'apoapsis', notBefore: number): ApsisPlacement {
    const spec = this.maneuver(i);
    const anchor = this.anchor;
    if (!anchor) throw new Error('FlightPlan: no anchor');
    let from: PropagationRun;
    let earliest: number;
    if (i === 0) {
      from = anchor.clone();
      earliest = Math.max(anchor.time, notBefore);
    } else {
      const previous = this.statuses[i - 1]!;
      if (!previous.ok) return { ok: false, reason: `burn ${i} is not executable` };
      const t = previous.burn.endTime;
      // The coast starts where burn i - 1 ends; integrate the plan that far now.
      const run = this.run!;
      const before = this.propagator.acceptedSteps;
      while (run.time < t && !run.impact && this.propagator.acceptedSteps - before < APSIS_SEARCH_MAX_STEPS) this.extend(5000);
      if (run.impact && run.impact.time <= t) return { ok: false, reason: 'the plan hits a surface before this burn' };
      if (run.time < t) return { ok: false, reason: 'the plan before this burn ran out of steps' };
      const s = this.trajectory.sample(t);
      from = new PropagationRun({ time: t, position: s.position, velocity: s.velocity, massKg: previous.burn.massAfterKg });
      earliest = Math.max(t, notBefore);
    }
    const mass = from.state.massKg;
    const dv = Math.hypot(spec.prograde, spec.normal, spec.radial);
    const massAfter = mass * Math.exp(-dv / this.engine.exhaustVelocity);
    if (massAfter < this.engine.dryMassKg) return { ok: false, reason: 'not enough propellant for this burn' };
    const halfBurn = (0.5 * (mass - massAfter) * this.engine.exhaustVelocity) / this.engine.thrustNewtons;

    const bodies = this.ephemeris.bodies;
    const ref = spec.referenceBody;
    this.ephemeris.extendTo(from.time);
    const center = this.ephemeris.bodyState(ref, from.time);
    const state = from.state;
    const osc = osculatingOrbit(sub(state.position, center.position), sub(state.velocity, center.velocity), bodies[ref]!.gm);
    const window = (Number.isFinite(osc.periodSeconds) ? 2.2 * osc.periodSeconds : this.coast) + (earliest - from.time) + halfBurn;
    const path = new Trajectory();
    path.append(from.time, from.y);
    const outcome = this.propagator.advance(from, from.time + window, APSIS_SEARCH_MAX_STEPS, path, null);
    if (outcome.kind === 'budget') return { ok: false, reason: 'apsis search ran out of steps' };
    const apsis = findApsides(path, this.ephemeris, ref, earliest, 16)
      .find((a) => a.kind === kind && a.time - halfBurn >= earliest);
    if (!apsis) {
      const where = outcome.kind === 'impact' ? ' before impact' : '';
      return { ok: false, reason: `no ${kind} of ${bodies[ref]!.name}${where}` };
    }
    return { ok: true, startTime: apsis.time - halfBurn };
  }

  private checked(spec: ManeuverSpec): ManeuverSpec {
    for (const [k, v] of Object.entries(spec)) {
      if (!Number.isFinite(v)) throw new RangeError(`FlightPlan: maneuver ${k} = ${v}`);
    }
    if (!Number.isInteger(spec.referenceBody) || spec.referenceBody < 0 || spec.referenceBody >= this.ephemeris.bodyCount) {
      throw new RangeError(`FlightPlan: reference body ${spec.referenceBody}`);
    }
    return { ...spec };
  }

  /** Re-check every burn and restart the trajectory from the anchor. */
  private restart(): void {
    this.generation += 1;
    this.trajectory.clear();
    this.statuses = [];
    this.schedule = [];
    const anchor = this.anchor;
    if (!anchor) {
      this.run = null;
      if (this.specs.length > 0) throw new Error('FlightPlan: maneuvers without an anchor');
      return;
    }
    const { thrustNewtons, exhaustVelocity, dryMassKg } = this.engine;
    let mass = anchor.state.massKg;
    let previousEnd = anchor.time;
    let blocked = false;
    this.specs.forEach((spec, i) => {
      if (blocked) {
        this.statuses.push({ ok: false, reason: 'blocked by an earlier burn' });
        return;
      }
      const dv = Math.hypot(spec.prograde, spec.normal, spec.radial);
      const massAfter = mass * Math.exp(-dv / exhaustVelocity);
      let reason: string | null = null;
      if (spec.startTime < previousEnd) {
        reason = i === 0 ? 'starts in the past' : `starts before burn ${i} ends`;
      } else if (massAfter < dryMassKg) {
        reason = `needs ${dv.toFixed(1)} m/s, ${(exhaustVelocity * Math.log(mass / dryMassKg)).toFixed(1)} m/s left`;
      }
      if (reason) {
        this.statuses.push({ ok: false, reason });
        blocked = true;
        return;
      }
      const duration = ((mass - massAfter) * exhaustVelocity) / thrustNewtons;
      const burn: BurnSchedule = {
        startTime: spec.startTime,
        endTime: spec.startTime + duration,
        deltaV: dv,
        massBeforeKg: mass,
        massAfterKg: massAfter,
        control: dv === 0 ? null : {
          thrustNewtons,
          exhaustVelocity,
          minimumMassKg: dryMassKg,
          attitude: {
            kind: 'frenet', referenceBody: spec.referenceBody,
            tangent: spec.prograde / dv, normal: spec.normal / dv, radial: spec.radial / dv,
          },
        },
      };
      this.statuses.push({ ok: true, burn });
      this.schedule.push(burn);
      mass = massAfter;
      previousEnd = burn.endTime;
    });
    this.run = anchor.clone();
    this.trajectory.append(this.run.time, this.run.y);
  }
}

function checkedCoast(value: number): number {
  if (!(value > 0) || !Number.isFinite(value)) throw new RangeError(`FlightPlan: coast ${value}`);
  return value;
}
