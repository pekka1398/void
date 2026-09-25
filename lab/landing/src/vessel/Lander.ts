import type RAPIER_NS from '@dimforge/rapier3d-compat';
import {
  bodyOrientation, PropagationRun, STANDARD_GRAVITY, VesselPropagator,
  type Ephemeris, type ThrustControl, type Tolerances, type Vec3,
} from '../orbitCore';
import { ContactWorld, type ContactWorldOptions, type Quaternion } from '../physics/ContactWorld';
import { PlanetFrame, type FrameState } from '../physics/PlanetFrame';
import type { Terrain } from '../terrain/Surface';

type Rapier = typeof RAPIER_NS;

export interface LanderSpec {
  thrustNewtons: number;
  specificImpulseSeconds: number;
  dryMassKg: number;
  fuelMassKg: number;
  /** The hull is a box; its local +y is the thrust axis ("up"). */
  halfExtents: Vec3;
  friction: number;
}

/**
 * Engine command, constant over one advance call. Thrust points along the
 * orbit lab's surface law: the normalised up * (local vertical) + prograde *
 * (direction of the velocity over the ground).
 */
export interface LanderControl {
  throttle: number; up: number; prograde: number;
  /** Optional body-fixed thrust axis and collider orientation for manual steering. */
  direction?: Vec3;
  rotation?: Quaternion;
}

export type LanderMode = 'flight' | 'contact' | 'landed';

export interface LanderOptions {
  contact: ContactWorldOptions;
  tolerances: Tolerances;
  /** Contact physics starts this far above the highest terrain... */
  bandEnterMeters: number;
  /** ...and hands back to free flight this far above it (> enter). */
  bandExitMeters: number;
  /** At rest with the engine off: ground speed below this... */
  landedSpeed: number;
  /** ...for this long pins the lander to the ground. */
  landedSeconds: number;
}

export interface ModeChange { time: number; from: LanderMode; to: LanderMode }

/** Distance within which a coast chunk switches to contact instead of creeping up on the band. */
const BAND_SNAP_METERS = 1;

/**
 * One vessel near a rotating planet, in one of three modes:
 * - flight: the orbit lab's integrator, inertial frame, while above the
 *   terrain band (highest terrain + bandEnter). Chunks are bounded so the
 *   band cannot be crossed unseen between checks.
 * - contact: a Rapier box in the planet's rotating frame, inside the band.
 * - landed: at rest on the ground, pinned in body-fixed coordinates; any
 *   time step is allowed.
 * States cross between modes unchanged (converted between frames).
 */
export class Lander {
  readonly frame: PlanetFrame;
  readonly terrain: Terrain;
  readonly spec: LanderSpec;
  readonly options: LanderOptions;
  readonly modeChanges: ModeChange[] = [];
  mode: LanderMode;
  time: number;
  massKg: number;
  private readonly rapier: Rapier;
  private readonly propagator: VesselPropagator;
  private run: PropagationRun | null = null;
  private contact: { world: ContactWorld; body: RAPIER_NS.RigidBody } | null = null;
  private pinned: Vec3 | null = null;
  private restingFor = 0;
  /**
   * Thrust acceleration over the last contact step (or the half step before
   * entering contact), for the leapfrog average; see ExtraAcceleration.
   */
  private previousPush: Vec3 = { x: 0, y: 0, z: 0 };

  private constructor(rapier: Rapier, ephemeris: Ephemeris, bodyIndex: number, terrain: Terrain, spec: LanderSpec, options: LanderOptions, time: number) {
    if (!(options.bandExitMeters > options.bandEnterMeters) || !(options.bandEnterMeters > 0)) throw new RangeError(`Lander: band ${options.bandEnterMeters}..${options.bandExitMeters}`);
    if (!(spec.thrustNewtons > 0) || !(spec.specificImpulseSeconds > 0) || !(spec.dryMassKg > 0) || !(spec.fuelMassKg >= 0)) throw new RangeError(`Lander: spec ${JSON.stringify(spec)}`);
    this.rapier = rapier;
    this.frame = new PlanetFrame(ephemeris, bodyIndex);
    this.terrain = terrain;
    this.spec = spec;
    this.options = options;
    this.propagator = new VesselPropagator(ephemeris, options.tolerances);
    this.time = time;
    this.massKg = spec.dryMassKg + spec.fuelMassKg;
    this.mode = 'landed';
  }

  /** A lander resting on the ground below a body-fixed direction. */
  static landed(rapier: Rapier, ephemeris: Ephemeris, bodyIndex: number, terrain: Terrain, spec: LanderSpec, options: LanderOptions, time: number, direction: Vec3): Lander {
    const lander = new Lander(rapier, ephemeris, bodyIndex, terrain, spec, options, time);
    const l = Math.hypot(direction.x, direction.y, direction.z);
    const d = { x: direction.x / l, y: direction.y / l, z: direction.z / l };
    // Rest the hull on the highest ground under its footprint (centre and
    // bottom corners), a centimetre up, so it starts touching nothing.
    const q = uprightAt(d);
    let ground = lander.groundHeightUnder(d);
    for (const [sx, sz] of [[-1, -1], [-1, 1], [1, -1], [1, 1]] as const) {
      const c = rotate(q, { x: sx * spec.halfExtents.x, y: 0, z: sz * spec.halfExtents.z });
      const p = { x: d.x * terrain.radiusMeters + c.x, y: d.y * terrain.radiusMeters + c.y, z: d.z * terrain.radiusMeters + c.z };
      const pl = Math.hypot(p.x, p.y, p.z);
      ground = Math.max(ground, lander.groundHeightUnder({ x: p.x / pl, y: p.y / pl, z: p.z / pl }));
    }
    const r = terrain.radiusMeters + ground + spec.halfExtents.y + 0.01;
    lander.pinned = { x: d.x * r, y: d.y * r, z: d.z * r };
    return lander;
  }

  /** A lander in free flight with a body-fixed state, engine off. */
  static flying(rapier: Rapier, ephemeris: Ephemeris, bodyIndex: number, terrain: Terrain, spec: LanderSpec, options: LanderOptions, time: number, state: FrameState): Lander {
    const lander = new Lander(rapier, ephemeris, bodyIndex, terrain, spec, options, time);
    lander.mode = 'flight';
    lander.enterFlight(state);
    lander.checkBand();
    return lander;
  }

  get exhaustVelocity(): number {
    return this.spec.specificImpulseSeconds * STANDARD_GRAVITY;
  }

  get fuelKg(): number {
    return this.massKg - this.spec.dryMassKg;
  }

  /** Body-fixed state now. */
  bodyFixedState(): FrameState {
    if (this.mode === 'landed') return { position: { ...this.pinned! }, velocity: { x: 0, y: 0, z: 0 } };
    if (this.mode === 'contact') return this.contact!.world.state(this.contact!.body, this.previousPush);
    const s = this.run!.state;
    return this.frame.toBodyFixed(this.time, { position: s.position, velocity: s.velocity });
  }

  inertialState(): FrameState {
    if (this.mode === 'flight') {
      const s = this.run!.state;
      return { position: s.position, velocity: s.velocity };
    }
    return this.frame.toInertial(this.time, this.bodyFixedState());
  }

  /** Height of the lander's reference point above the terrain directly below it. */
  clearance(): number {
    const p = this.bodyFixedState().position;
    const r = Math.hypot(p.x, p.y, p.z);
    return r - this.terrain.radiusMeters - this.groundHeightUnder({ x: p.x / r, y: p.y / r, z: p.z / r });
  }

  /**
   * Advance simulated time by dt under one control. Contact mode moves in
   * whole physics steps, so the lander may stop short of the target by less
   * than one step; time is never skipped.
   */
  advance(dt: number, control: LanderControl): void {
    if (!(dt >= 0) || !Number.isFinite(dt)) throw new RangeError(`Lander.advance(${dt})`);
    if (!(control.throttle >= 0 && control.throttle <= 1)) throw new RangeError(`throttle ${control.throttle}`);
    const target = this.time + dt;
    const step = this.options.contact.stepSeconds;
    this.frame.ephemeris.extendTo(target);
    for (;;) {
      if (this.mode === 'landed') {
        if (control.throttle > 0 && this.fuelKg > 0) { this.enterContact(this.bodyFixedState(), { x: 0, y: 0, z: 0 }, control.rotation); continue; }
        this.time = target;
        return;
      }
      if (this.mode === 'contact') {
        if (this.time + step > target + 1e-9) return;
        this.contactStep(control);
        continue;
      }
      if (this.time >= target) return;
      this.flightChunk(target, control);
    }
  }

  private groundHeightUnder(direction: Vec3): number {
    return this.terrain.sample(direction).heightMeters;
  }

  private bandRadius(extra: number): number {
    return this.terrain.radiusMeters + this.terrain.maxHeightMeters + extra;
  }

  private thrustControl(control: LanderControl): ThrustControl | null {
    if (control.throttle === 0 || this.fuelKg <= 0) return null;
    return {
      thrustNewtons: control.throttle * this.spec.thrustNewtons,
      exhaustVelocity: this.exhaustVelocity,
      minimumMassKg: this.spec.dryMassKg,
      attitude: control.direction
        ? { kind: 'inertial', direction: this.bodyDirectionToInertial(control.direction) }
        : { kind: 'surface', referenceBody: this.frame.body.index, up: control.up, prograde: control.prograde },
    };
  }

  private bodyDirectionToInertial(direction: Vec3): Vec3 {
    const axes = bodyOrientation(this.frame.body, this.time);
    return {
      x: direction.x * axes.x.x + direction.y * axes.y.x + direction.z * axes.z.x,
      y: direction.x * axes.x.y + direction.y * axes.y.y + direction.z * axes.z.y,
      z: direction.x * axes.x.z + direction.y * axes.y.z + direction.z * axes.z.z,
    };
  }

  /** One bounded piece of free flight toward target. */
  private flightChunk(target: number, control: LanderControl): void {
    const run = this.run!;
    const planet = this.frame.ephemeris.bodyState(this.frame.body.index, this.time);
    const s = run.state;
    const rel = { x: s.position.x - planet.position.x, y: s.position.y - planet.position.y, z: s.position.z - planet.position.z };
    const u = { x: s.velocity.x - planet.velocity.x, y: s.velocity.y - planet.velocity.y, z: s.velocity.z - planet.velocity.z };
    const band = this.bandRadius(this.options.bandEnterMeters);
    const gap = Math.hypot(rel.x, rel.y, rel.z) - band;
    if (gap <= BAND_SNAP_METERS) {
      // The engine setting carries over from flight into contact.
      const state = this.bodyFixedState();
      const thrustNow = this.thrustControl(control);
      this.enterContact(state, thrustNow ? scaleVec(surfaceDirection(state, control), thrustNow.thrustNewtons / this.massKg) : { x: 0, y: 0, z: 0 }, control.rotation);
      return;
    }
    // Longest time the band cannot be reached in: |v| t + A t^2 / 2 = gap,
    // A bounding every acceleration (gravity at the band, 20% for J2 and tides, thrust).
    const speed = Math.hypot(u.x, u.y, u.z);
    const A = 1.2 * this.frame.body.gm / band ** 2 + this.spec.thrustNewtons / this.spec.dryMassKg;
    const safe = (-speed + Math.sqrt(speed * speed + 2 * A * gap)) / A;
    const thrust = this.thrustControl(control);
    let end = Math.min(target, this.time + Math.max(safe, 1e-3));
    let burnout = false;
    if (thrust) {
      const out = this.time + (this.fuelKg * thrust.exhaustVelocity) / thrust.thrustNewtons;
      if (out <= end) { end = out; burnout = true; }
    }
    const outcome = this.propagator.advance(run, end, 1e7, null, thrust);
    if (outcome.kind === 'impact') throw new Error('Lander: hit the reference sphere in flight; the terrain band should have caught it');
    if (outcome.kind === 'budget') throw new Error('Lander: flight step budget exhausted');
    this.time = run.time;
    if (burnout) run.y[6] = this.spec.dryMassKg;
    this.massKg = run.y[6]!;
  }

  private contactStep(control: LanderControl): void {
    const { world, body } = this.contact!;
    if (control.rotation) body.setRotation(control.rotation, true);
    const dt = this.options.contact.stepSeconds;
    const flow = (control.throttle * this.spec.thrustNewtons) / this.exhaustVelocity;
    // A step that would empty the tanks burns only what is left.
    const burned = Math.min(flow * dt, this.fuelKg);
    const thrust = burned > 0 ? (burned * this.exhaustVelocity) / dt : 0;
    // Mean mass over the step: the mass falls linearly while burning.
    const meanMass = this.massKg - burned / 2;
    let push: Vec3 = { x: 0, y: 0, z: 0 };
    world.step((_, state) => {
      push = thrust > 0 ? scaleVec(surfaceDirection(state, control), thrust / meanMass) : { x: 0, y: 0, z: 0 };
      const before = this.previousPush;
      return { x: (before.x + push.x) / 2, y: (before.y + push.y) / 2, z: (before.z + push.z) / 2 };
    });
    this.previousPush = push;
    this.massKg -= burned;
    if (this.fuelKg < 1e-9 * this.spec.dryMassKg) this.massKg = this.spec.dryMassKg;
    this.time = world.time;
    const state = world.state(body, push);
    const r = Math.hypot(state.position.x, state.position.y, state.position.z);
    if (r > this.bandRadius(this.options.bandExitMeters)) { this.enterFlight(state); return; }
    const resting = thrust === 0 && Math.hypot(state.velocity.x, state.velocity.y, state.velocity.z) < this.options.landedSpeed;
    this.restingFor = resting ? this.restingFor + dt : 0;
    if (this.restingFor >= this.options.landedSeconds) this.enterLanded(state.position);
  }

  /** pushBefore: thrust acceleration over the half step before now (zero from rest). */
  private enterContact(state: FrameState, pushBefore: Vec3, rotation?: Quaternion): void {
    this.leave();
    this.previousPush = pushBefore;
    const world = new ContactWorld(this.rapier, this.frame, this.terrain, this.options.contact, this.time, state.position);
    const { halfExtents, friction } = this.spec;
    const body = world.addBody(
      { shape: { kind: 'box', halfExtents }, massKg: this.massKg, friction, restitution: 0, lockRotations: true },
      state, rotation ?? uprightAt(state.position), pushBefore,
    );
    this.contact = { world, body };
    this.restingFor = 0;
    this.switchTo('contact');
  }

  private enterFlight(state: FrameState): void {
    this.leave();
    const inertial = this.frame.toInertial(this.time, state);
    this.run = new PropagationRun({ time: this.time, position: inertial.position, velocity: inertial.velocity, massKg: this.massKg });
    this.switchTo('flight');
  }

  private enterLanded(position: Vec3): void {
    this.leave();
    this.pinned = { ...position };
    this.switchTo('landed');
  }

  private leave(): void {
    if (this.contact) { this.contact.world.free(); this.contact = null; }
    this.run = null;
    this.pinned = null;
  }

  private switchTo(mode: LanderMode): void {
    if (mode !== this.mode) this.modeChanges.push({ time: this.time, from: this.mode, to: mode });
    this.mode = mode;
  }

  private checkBand(): void {
    const p = this.bodyFixedState().position;
    if (Math.hypot(p.x, p.y, p.z) <= this.bandRadius(this.options.bandEnterMeters)) this.enterContact(this.bodyFixedState(), { x: 0, y: 0, z: 0 });
  }
}

/** The surface law in body-fixed axes, where the ground is at rest (same definition as the orbit core's). */
export function surfaceDirection(state: FrameState, control: { up: number; prograde: number; direction?: Vec3 }): Vec3 {
  if (control.direction) return control.direction;
  const p = state.position, v = state.velocity;
  const r = Math.hypot(p.x, p.y, p.z);
  const g = Math.hypot(v.x, v.y, v.z);
  if (control.prograde !== 0 && !(g > 0)) throw new Error('surface attitude undefined: no velocity over the ground');
  const k = control.prograde === 0 ? 0 : control.prograde / g;
  const d = { x: (control.up * p.x) / r + k * v.x, y: (control.up * p.y) / r + k * v.y, z: (control.up * p.z) / r + k * v.z };
  const l = Math.hypot(d.x, d.y, d.z);
  if (!(l > 0)) throw new Error('surface attitude undefined: up and ground velocity cancel');
  return { x: d.x / l, y: d.y / l, z: d.z / l };
}

function scaleVec(v: Vec3, k: number): Vec3 {
  return { x: v.x * k, y: v.y * k, z: v.z * k };
}

/** Rotate a vector by a unit quaternion. */
function rotate(q: Quaternion, v: Vec3): Vec3 {
  // v + 2 q_v x (q_v x v + w v)
  const cx = q.y * v.z - q.z * v.y + q.w * v.x;
  const cy = q.z * v.x - q.x * v.z + q.w * v.y;
  const cz = q.x * v.y - q.y * v.x + q.w * v.z;
  return { x: v.x + 2 * (q.y * cz - q.z * cy), y: v.y + 2 * (q.z * cx - q.x * cz), z: v.z + 2 * (q.x * cy - q.y * cx) };
}

/** Rotation taking local +y to the outward vertical at a body-fixed point. */
function uprightAt(p: Vec3): Quaternion {
  const l = Math.hypot(p.x, p.y, p.z);
  const u = { x: p.x / l, y: p.y / l, z: p.z / l };
  // Shortest arc from (0, 1, 0) to u.
  const w = 1 + u.y;
  if (w < 1e-12) return { x: 1, y: 0, z: 0, w: 0 };
  const q = { x: u.z, y: 0, z: -u.x, w };
  const n = Math.hypot(q.x, q.y, q.z, q.w);
  return { x: q.x / n, y: q.y / n, z: q.z / n, w: q.w / n };
}
