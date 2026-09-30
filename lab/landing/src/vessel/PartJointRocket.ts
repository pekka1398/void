import type RAPIER_NS from '@dimforge/rapier3d-compat';
import { bodyOrientation, PropagationRun, STANDARD_GRAVITY, VesselPropagator, type Ephemeris, type ThrustControl, type Vec3 } from '../orbitCore';
import { ContactWorld, type Quaternion } from '../physics/ContactWorld';
import { addMat, parallelAxisPerKg, quatToMatrix, scaleMat, stepAttitude, transpose, matMul, type Mat3 } from './Attitude';
import { PlanetFrame, type FrameState } from '../physics/PlanetFrame';
import type { Terrain } from '../terrain/Surface';
import type { LanderControl, LanderOptions, LanderSpec } from './Lander';

type Rapier = typeof RAPIER_NS;
export type RocketPart = 'upper' | 'booster';
export type PhysicsMode = 'flight' | 'contact' | 'destroyed';

const ZERO = { x: 0, y: 0, z: 0 };
const UPPER_OFFSET = 1.1;
const BOOSTER_OFFSET = -1.3;
const INITIAL_CLEARANCE_METERS = 1.0;
const FLIGHT_CHUNK_SECONDS = 1;
const ENTRY_SNAP_METERS = 0.1;
const PARTS: readonly RocketPart[] = ['upper', 'booster'];
/** Steering torque per unit of control.turn, N m, about the upper stage's local axes. */
export const STEERING_TORQUE = 6000;

function addScaled(a: Vec3, b: Vec3, k: number): Vec3 {
  return { x: a.x + b.x * k, y: a.y + b.y * k, z: a.z + b.z * k };
}

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function rotate(q: Quaternion, v: Vec3): Vec3 {
  const cx = q.y * v.z - q.z * v.y + q.w * v.x;
  const cy = q.z * v.x - q.x * v.z + q.w * v.y;
  const cz = q.x * v.y - q.y * v.x + q.w * v.z;
  return { x: v.x + 2 * (q.y * cz - q.z * cy), y: v.y + 2 * (q.z * cx - q.x * cz), z: v.z + 2 * (q.x * cy - q.y * cx) };
}

function uprightAt(direction: Vec3): Quaternion {
  const w = 1 + direction.y;
  if (w < 1e-12) return { x: 1, y: 0, z: 0, w: 0 };
  const q = { x: direction.z, y: 0, z: -direction.x, w };
  const length = Math.hypot(q.x, q.y, q.z, q.w);
  return { x: q.x / length, y: q.y / length, z: q.z / length, w: q.w / length };
}

/**
 * One part's physics state: a Rapier body in some contact world, or (after
 * staging) its own orbit-propagated state. While attached in free flight both
 * parts have neither; the stack's centre of mass follows attachedRun.
 */
interface PartSlot {
  readonly spec: LanderSpec;
  readonly offset: number;
  fuelKg: number;
  world: ContactWorld | null;
  body: RAPIER_NS.RigidBody | null;
  /** Thrust acceleration over the coming contact step, for the half-step velocity. */
  push: Vec3;
  run: PropagationRun | null;
  /** Body-fixed attitude and angular velocity while not in a contact world (a Rapier body holds them otherwise). */
  rotation: Quaternion;
  angularVelocity: Vec3;
  /** Inertia about the part's centre of mass in its local axes, per kg of current mass (colliders scale uniformly with fuel). */
  inertiaPerKg: Mat3;
  /** Last state before a crash; set once the part is destroyed. */
  wreck: FrameState | null;
}

/**
 * Two parts joined by one removable Rapier fixed joint. Attached, the stack
 * switches between contact and orbital physics as one unit. After staging each
 * part switches on its own clearance, so a spent booster landing does not pull
 * the upper stage back into Rapier. Contact parts closer than recenterMeters
 * share one Rapier world (they can collide); farther apart they get separate
 * worlds. All parts advance on one clock.
 */
export class PartJointRocket {
  /** Physics-mode changes of the controlled vessel (the stack, then the upper stage). */
  readonly modeChanges: { time: number; from: PhysicsMode; to: PhysicsMode }[] = [];
  /** Crashes in order: which part, when, and the contact speed change that broke it. */
  readonly crashes: { part: RocketPart; time: number; deltaV: number }[] = [];
  /** Destroy parts that exceed their crash tolerance. Off by default: impacts only collide. */
  crashDetection = false;
  readonly frame: PlanetFrame;
  readonly terrain: Terrain;
  readonly options: LanderOptions;
  readonly upperSpec: LanderSpec;
  readonly boosterSpec: LanderSpec;
  readonly fullSpec: LanderSpec;
  private readonly parts: Record<RocketPart, PartSlot>;
  private joint: RAPIER_NS.ImpulseJoint | null = null;
  private attachedRun: PropagationRun | null = null;
  private pendingSeconds = 0;
  private simTime = 0;
  private lastMode: PhysicsMode = 'contact';
  private readonly rapier: Rapier;
  private readonly propagator: VesselPropagator;

  private constructor(rapier: Rapier, ephemeris: Ephemeris, bodyIndex: number, terrain: Terrain, fullSpec: LanderSpec, upperSpec: LanderSpec,
    boosterSpec: LanderSpec, options: LanderOptions, direction: Vec3) {
    this.frame = new PlanetFrame(ephemeris, bodyIndex);
    this.propagator = new VesselPropagator(ephemeris, options.tolerances);
    this.rapier = rapier;
    this.terrain = terrain;
    this.options = options;
    this.fullSpec = fullSpec;
    this.upperSpec = upperSpec;
    this.boosterSpec = boosterSpec;
    if (!upperSpec.contactShape || !boosterSpec.contactShape) throw new Error('PartJointRocket: each part needs its own contact shape');
    for (const part of [upperSpec, boosterSpec]) {
      const tolerance = part.crashToleranceMetersPerSecond;
      if (tolerance === undefined || !(tolerance > 0)) throw new RangeError(`PartJointRocket: each part needs a crash tolerance, got ${tolerance}`);
    }
    if (Math.abs(fullSpec.dryMassKg - upperSpec.dryMassKg - upperSpec.fuelMassKg - boosterSpec.dryMassKg) > 1e-9 ||
        fullSpec.fuelMassKg !== boosterSpec.fuelMassKg) throw new Error('PartJointRocket: aggregate mass must equal the two parts');
    const length = Math.hypot(direction.x, direction.y, direction.z);
    if (!(length > 0)) throw new RangeError('PartJointRocket: invalid launch direction');
    const d = { x: direction.x / length, y: direction.y / length, z: direction.z / length };
    const q = uprightAt(d);
    const ground = terrain.sample(d).heightMeters;
    const root = { x: d.x * (terrain.radiusMeters + ground + 2.72 + INITIAL_CLEARANCE_METERS),
      y: d.y * (terrain.radiusMeters + ground + 2.72 + INITIAL_CLEARANCE_METERS),
      z: d.z * (terrain.radiusMeters + ground + 2.72 + INITIAL_CLEARANCE_METERS) };
    const up = rotate(q, { x: 0, y: 1, z: 0 });
    const slot = (spec: LanderSpec, offset: number): PartSlot => ({ spec, offset, fuelKg: spec.fuelMassKg, world: null, body: null,
      push: ZERO, run: null, rotation: q, angularVelocity: ZERO, inertiaPerKg: [0, 0, 0, 0, 0, 0, 0, 0, 0], wreck: null });
    this.parts = { upper: slot(upperSpec, UPPER_OFFSET), booster: slot(boosterSpec, BOOSTER_OFFSET) };
    const world = new ContactWorld(rapier, this.frame, terrain, options.contact, 0, root);
    for (const which of PARTS) {
      const s = this.parts[which];
      this.addToWorld(which, world, { position: addScaled(root, up, s.offset), velocity: ZERO });
      // Rapier's mass properties from the part's colliders, valid as soon as they are attached.
      const body = s.body!;
      const principal = body.principalInertia();
      const frame = quatToMatrix(body.principalInertiaLocalFrame());
      const diagonal: Mat3 = [principal.x, 0, 0, 0, principal.y, 0, 0, 0, principal.z];
      s.inertiaPerKg = scaleMat(matMul(matMul(frame, diagonal), transpose(frame)), 1 / body.mass());
    }
    this.joinParts();
  }

  /** bodyIndex: the planet in the ephemeris the rocket stands on. */
  static landed(rapier: Rapier, ephemeris: Ephemeris, bodyIndex: number, terrain: Terrain, fullSpec: LanderSpec, upperSpec: LanderSpec,
    boosterSpec: LanderSpec, options: LanderOptions, direction: Vec3): PartJointRocket {
    return new PartJointRocket(rapier, ephemeris, bodyIndex, terrain, fullSpec, upperSpec, boosterSpec, options, direction);
  }

  get time(): number { return this.simTime; }
  get separated(): boolean { return this.joint === null; }
  get spec(): LanderSpec { return this.separated ? this.upperSpec : this.fullSpec; }
  get fuelKg(): number { return this.parts[this.enginePart].fuelKg; }
  get massKg(): number { return this.separated ? this.partMass('upper') : this.partMass('upper') + this.partMass('booster'); }
  /** Physics mode of the controlled vessel. */
  get mode(): PhysicsMode { return this.partMode('upper'); }
  /** The controlled vessel's contact world. */
  get world(): ContactWorld {
    const world = this.parts.upper.world;
    if (!world) throw new Error('PartJointRocket: upper stage is in orbital flight, not a contact world');
    return world;
  }
  get upper(): RAPIER_NS.RigidBody { return this.bodyOf('upper'); }
  get booster(): RAPIER_NS.RigidBody { return this.bodyOf('booster'); }

  partMode(which: RocketPart): PhysicsMode {
    const s = this.parts[which];
    return s.wreck ? 'destroyed' : s.world ? 'contact' : 'flight';
  }
  /** Fuel left in one part's tank. */
  partFuelKg(which: RocketPart): number { return this.parts[which].fuelKg; }
  /**
   * Δv left in one part's tank, in vacuum (Tsiolkovsky), m/s. The booster pushes the upper stage too
   * while they are joined; the upper stage fires only after separation, so it pushes itself alone.
   */
  partDeltaV(which: RocketPart): number {
    const slot = this.parts[which];
    const startMass = which === 'booster' && !this.separated ? this.massKg : this.partMass(which);
    return slot.spec.specificImpulseSeconds * STANDARD_GRAVITY * Math.log(startMass / (startMass - slot.fuelKg));
  }
  /** Contact worlds in use (one while the parts are together, up to one per part otherwise). */
  contactWorlds(): ContactWorld[] {
    return [...new Set(PARTS.map((which) => this.parts[which].world).filter((w): w is ContactWorld => w !== null))];
  }

  orientation(): Quaternion { return this.partOrientation('upper'); }
  partState(which: RocketPart): FrameState {
    const s = this.parts[which];
    if (s.wreck) return s.wreck;
    if (s.world && s.body) return s.world.state(s.body, s.push);
    if (this.attachedRun) {
      const centre = this.frame.toBodyFixed(this.time, this.attachedRun.state);
      const mu = this.partMass('upper'), mb = this.partMass('booster');
      const comOffset = (mu * UPPER_OFFSET + mb * BOOSTER_OFFSET) / (mu + mb);
      const delta = rotate(this.parts.upper.rotation, { x: 0, y: s.offset - comOffset, z: 0 });
      return { position: addScaled(centre.position, delta, 1), velocity: centre.velocity };
    }
    if (!s.run) throw new Error(`PartJointRocket: missing ${which} flight state`);
    return this.frame.toBodyFixed(this.time, s.run.state);
  }
  /** Angular velocity in the body-fixed planet frame, rad/s. */
  partAngularVelocity(which: RocketPart): Vec3 {
    const s = this.parts[which];
    return s.body ? s.body.angvel() : s.angularVelocity;
  }
  partOrientation(which: RocketPart): Quaternion {
    const s = this.parts[which];
    return s.body ? s.body.rotation() : s.rotation;
  }

  bodyFixedState(): FrameState {
    const upper = this.partState('upper');
    if (this.separated) return upper;
    const booster = this.partState('booster');
    const mu = this.partMass('upper'), mb = this.partMass('booster');
    const blend = (a: Vec3, b: Vec3): Vec3 => ({ x: (a.x * mu + b.x * mb) / (mu + mb), y: (a.y * mu + b.y * mb) / (mu + mb), z: (a.z * mu + b.z * mb) / (mu + mb) });
    return { position: blend(upper.position, booster.position), velocity: blend(upper.velocity, booster.velocity) };
  }

  clearance(): number {
    return this.clearanceAt(this.bodyFixedState().position);
  }

  /** Remove only the joint; in contact both rigid bodies and their colliders stay alive. */
  separate(): void {
    if (!this.joint) return;
    const axis = rotate(this.orientation(), { x: 0, y: 1, z: 0 });
    const impulse = 500;
    if (!this.attachedRun) {
      this.world.world.removeImpulseJoint(this.joint, true);
      this.joint = null;
      this.upper.applyImpulse({ x: axis.x * impulse, y: axis.y * impulse, z: axis.z * impulse }, true);
      this.booster.applyImpulse({ x: -axis.x * impulse, y: -axis.y * impulse, z: -axis.z * impulse }, true);
      return;
    }
    const worldAxis = this.toInertialDirection(axis, this.time);
    for (const which of PARTS) {
      const s = this.parts[which];
      const state = this.frame.toInertial(this.time, this.partState(which));
      const mass = this.partMass(which);
      state.velocity = addScaled(state.velocity, worldAxis, (which === 'upper' ? impulse : -impulse) / mass);
      s.run = new PropagationRun({ ...state, time: this.time, massKg: mass });
    }
    this.parts.booster.rotation = this.parts.upper.rotation;
    this.parts.booster.angularVelocity = this.parts.upper.angularVelocity;
    this.attachedRun = null;
    this.joint = null;
  }

  advance(dt: number, control: LanderControl): void {
    if (!(dt >= 0) || !Number.isFinite(dt)) throw new RangeError(`PartJointRocket.advance(${dt})`);
    if (!(control.throttle >= 0 && control.throttle <= 1)) throw new RangeError(`PartJointRocket: throttle ${control.throttle}`);
    if (control.turn && control.steering) throw new Error('PartJointRocket: give either turn or steering, not both');
    if (this.parts.upper.wreck) return;
    if (control.orbitalAttitude && (this.contactWorlds().length > 0 || !control.rotation)) {
      throw new Error('PartJointRocket: orbital maneuver requires free flight and a commanded orientation');
    }
    if (control.rotation) {
      for (const which of this.separated ? ['upper' as const] : PARTS) {
        if (!this.parts[which].body) {
          this.parts[which].rotation = { ...control.rotation };
          if (control.orbitalAttitude) this.parts[which].angularVelocity = ZERO;
        }
      }
    }
    const target = this.simTime + this.pendingSeconds + dt;
    const step = this.options.contact.stepSeconds;
    for (;;) {
      this.updateModes(control);
      if (control.orbitalAttitude && this.contactWorlds().length > 0) {
        throw new Error('PartJointRocket: orbital maneuver entered contact physics');
      }
      if (this.parts.upper.wreck) { this.pendingSeconds = 0; return; }
      if (this.contactWorlds().length > 0) {
        if (this.simTime + step > target + 1e-12) { this.pendingSeconds = Math.max(0, target - this.simTime); return; }
        this.stepContact(control);
      } else {
        if (this.simTime + 1e-9 >= target) { this.pendingSeconds = 0; return; }
        this.flightChunk(target, control);
      }
    }
  }

  /**
   * Why the rocket cannot go on rails now, or null if it can. On rails (KSP's high time warp) nothing is
   * simulated in Rapier and no engine burns: every live part is either coasting in orbital flight or
   * asleep on the ground.
   */
  railsBlocker(throttle: number): string | null {
    if (this.parts.upper.wreck) return 'the vessel is destroyed';
    if (throttle > 0 && this.parts[this.enginePart].fuelKg > 0) return 'engine firing';
    if (this.contactWorlds().some((world) => !world.asleep)) return 'moving near the ground';
    return null;
  }

  /**
   * Advance on rails: flight parts coast (no thrust, attitude held in the body-fixed frame, spin
   * stopped), resting parts keep their place on the ground. Returns false, having stopped short, when a
   * part came down into the contact band or woke up: the caller drops back to physics time.
   */
  advanceOnRails(dt: number): boolean {
    if (!(dt >= 0) || !Number.isFinite(dt)) throw new RangeError(`PartJointRocket.advanceOnRails(${dt})`);
    const blocker = this.railsBlocker(0);
    if (blocker) throw new Error(`PartJointRocket.advanceOnRails: ${blocker}`);
    for (const which of PARTS) if (!this.parts[which].body) this.parts[which].angularVelocity = ZERO;
    const target = this.simTime + this.pendingSeconds + dt;
    this.pendingSeconds = 0;
    const coast: LanderControl = { throttle: 0, up: 0, prograde: 0 };
    for (;;) {
      this.updateModes(coast);
      if (this.railsBlocker(0)) return false;
      if (this.simTime + 1e-9 >= target) return true;
      const flying = this.attachedRun !== null || PARTS.some((which) => this.parts[which].run);
      if (flying) this.flightChunk(target, coast, false);
      else this.simTime = target;
      for (const world of this.contactWorlds()) world.idleTo(this.simTime);
    }
  }

  free(): void {
    for (const world of this.contactWorlds()) world.free();
    for (const which of PARTS) { this.parts[which].world = null; this.parts[which].body = null; }
  }

  private get enginePart(): RocketPart { return this.separated ? 'upper' : 'booster'; }

  private partMass(which: RocketPart): number { return this.parts[which].spec.dryMassKg + this.parts[which].fuelKg; }

  private bodyOf(which: RocketPart): RAPIER_NS.RigidBody {
    const body = this.parts[which].body;
    if (!body) throw new Error(`PartJointRocket: ${which} is in orbital flight, not a contact world`);
    return body;
  }

  private clearanceAt(p: Vec3): number {
    const r = Math.hypot(p.x, p.y, p.z);
    return r - this.terrain.radiusMeters - this.terrain.sample({ x: p.x / r, y: p.y / r, z: p.z / r }).heightMeters;
  }

  /** Height of one part's reference point above the terrain under it, m. */
  partClearance(which: RocketPart): number { return this.clearanceAt(this.partState(which).position); }

  private toInertialDirection(local: Vec3, time: number): Vec3 {
    const axes = bodyOrientation(this.frame.body, time);
    const v = { x: local.x * axes.x.x + local.y * axes.y.x + local.z * axes.z.x,
      y: local.x * axes.x.y + local.y * axes.y.y + local.z * axes.z.y,
      z: local.x * axes.x.z + local.y * axes.y.z + local.z * axes.z.z };
    const length = Math.hypot(v.x, v.y, v.z);
    return { x: v.x / length, y: v.y / length, z: v.z / length };
  }

  /** One fixed Rapier step for every contact world; flight states follow to the same time. */
  private stepContact(control: LanderControl): void {
    const step = this.options.contact.stepSeconds;
    const t1 = this.simTime + step;
    const engine = this.parts[this.enginePart];
    let burned = 0;
    let push: Vec3 = ZERO;
    if (engine.body) {
      const ve = engine.spec.specificImpulseSeconds * STANDARD_GRAVITY;
      burned = Math.min(engine.fuelKg, control.throttle * engine.spec.thrustNewtons * step / ve);
      const thrust = burned * ve / step;
      const meanMass = engine.spec.dryMassKg + engine.fuelKg - burned / 2;
      const direction = rotate(engine.body.rotation(), { x: 0, y: 1, z: 0 });
      push = { x: direction.x * thrust / meanMass, y: direction.y * thrust / meanMass, z: direction.z * thrust / meanMass };
    }
    const upperBody = this.parts.upper.body;
    const turn = upperBody ? this.turnFor(this.separated ? ['upper'] : PARTS, control, upperBody.rotation(), upperBody.angvel(), step) : null;
    if (turn && upperBody) {
      const torque = rotate(upperBody.rotation(), turn);
      upperBody.applyTorqueImpulse({ x: torque.x * STEERING_TORQUE * step, y: torque.y * STEERING_TORQUE * step, z: torque.z * STEERING_TORQUE * step }, true);
    }
    const before = engine.push;
    for (const world of this.contactWorlds()) {
      world.step((body) => body === engine.body ? {
        x: (before.x + push.x) / 2, y: (before.y + push.y) / 2, z: (before.z + push.z) / 2,
      } : ZERO);
    }
    if (engine.body) {
      engine.fuelKg -= burned;
      engine.push = push;
      if (burned > 0) engine.world!.setBodyMass(engine.body, this.partMass(this.enginePart));
    }
    for (const which of PARTS) {
      const run = this.parts[which].run;
      if (!run) continue;
      this.propagate(run, t1, which === this.enginePart ? which : null, control.throttle, control);
      this.stepFlightAttitude([which], control, step);
    }
    this.simTime = t1;
    this.checkCrashes();
  }

  /** A part whose contact speed change exceeds its crash tolerance is destroyed and leaves the simulation. */
  private checkCrashes(): void {
    if (!this.crashDetection) return;
    const broken = PARTS.filter((which) => {
      const s = this.parts[which];
      return s.world && s.body && s.world.lastContactDeltaV(s.body) > s.spec.crashToleranceMetersPerSecond!;
    });
    if (broken.length === 0) return;
    // Removing a body removes its joint too, so a crash while attached also stages the stack.
    if (this.joint) this.joint = null;
    for (const which of broken) {
      const s = this.parts[which];
      const deltaV = s.world!.lastContactDeltaV(s.body!);
      const wreck = this.partState(which);
      this.detach(which);
      s.wreck = wreck;
      this.crashes.push({ part: which, time: this.time, deltaV });
    }
  }

  /**
   * Every part is in orbital flight (or, on rails, the rest asleep): advance them together, stopping
   * before any can reach the contact band. `attitude` false holds attitudes (on rails).
   */
  private flightChunk(target: number, control: LanderControl, attitude = true): void {
    const units: { run: PropagationRun; parts: readonly RocketPart[] }[] = this.attachedRun
      ? [{ run: this.attachedRun, parts: PARTS }]
      : PARTS.filter((which) => this.parts[which].run).map((which) => ({ run: this.parts[which].run!, parts: [which] }));
    // Chunks bound the attitude steps; on rails attitudes are held, and only the band limits a chunk.
    let end = attitude ? Math.min(target, this.simTime + FLIGHT_CHUNK_SECONDS) : target;
    for (const unit of units) {
      const states = unit.parts.map((which) => this.partState(which));
      const gap = Math.min(...states.map((s) => this.clearanceAt(s.position))) - this.options.bandEnterMeters;
      const r = Math.min(...states.map((s) => Math.hypot(s.position.x, s.position.y, s.position.z)));
      const speed = Math.max(...states.map((s) => Math.hypot(s.velocity.x, s.velocity.y, s.velocity.z)));
      const thrusting = unit.parts.includes(this.enginePart) && control.throttle > 0 && this.parts[this.enginePart].fuelKg > 0;
      const acceleration = 1.2 * this.frame.body.gm / Math.max(1, r * r)
        + (thrusting ? control.throttle * this.parts[this.enginePart].spec.thrustNewtons : 0) / Math.max(1, unit.run.state.massKg);
      const safe = (-speed + Math.sqrt(speed * speed + 2 * acceleration * Math.max(gap, 0))) / acceleration;
      end = Math.min(end, this.simTime + Math.max(safe, 1e-3));
      // Thrust follows the attitude, which the integrator holds fixed over a call: while it turns, advance one step at a time.
      if (thrusting && this.attitudeChanging(unit.parts, control)) end = Math.min(end, this.simTime + this.options.contact.stepSeconds);
    }
    for (const unit of units) this.propagate(unit.run, end, unit.parts.includes(this.enginePart) ? this.enginePart : null, control.throttle, control);
    const step = this.options.contact.stepSeconds;
    if (attitude) {
      for (const unit of units) {
        for (let t = this.simTime; t < end - 1e-12; t += step) this.stepFlightAttitude(unit.parts, control, Math.min(step, end - t));
      }
    }
    this.simTime = end;
  }

  /** Propagate an orbit state to `end`, splitting at burnout and charging the engine part's fuel. */
  private propagate(run: PropagationRun, end: number, engine: RocketPart | null, throttle: number, command?: LanderControl): void {
    while (run.time + 1e-12 < end) {
      const thrust = engine ? this.flightControl(engine, throttle, run.time, command?.orbitalAttitude) : null;
      const start = run.time;
      let stop = end;
      if (thrust) {
        const slot = this.parts[engine!];
        const burnout = start + slot.fuelKg * thrust.exhaustVelocity / thrust.thrustNewtons;
        if (burnout < end) stop = burnout;
        if (stop > start + 1e-12) {
          const outcome = this.propagator.advance(run, stop, 100_000, null, thrust);
          if (outcome.kind !== 'reached') throw new Error(`PartJointRocket: free-flight propagation ${outcome.kind}`);
        }
        slot.fuelKg = stop < end ? 0 : Math.max(0, slot.fuelKg - thrust.thrustNewtons * (stop - start) / thrust.exhaustVelocity);
        continue;
      }
      const outcome = this.propagator.advance(run, end, 100_000, null, null);
      if (outcome.kind !== 'reached') throw new Error(`PartJointRocket: free-flight propagation ${outcome.kind}`);
    }
  }

  private flightControl(which: RocketPart, throttle: number, time: number, orbitalAttitude?: LanderControl['orbitalAttitude']): ThrustControl | null {
    const slot = this.parts[which];
    if (throttle <= 0 || slot.fuelKg <= 0) return null;
    const direction = this.toInertialDirection(rotate(slot.rotation, { x: 0, y: 1, z: 0 }), time);
    const minimumMassKg = this.separated
      ? this.upperSpec.dryMassKg
      : this.upperSpec.dryMassKg + this.boosterSpec.dryMassKg + this.parts.upper.fuelKg;
    return { thrustNewtons: throttle * slot.spec.thrustNewtons, exhaustVelocity: slot.spec.specificImpulseSeconds * STANDARD_GRAVITY,
      minimumMassKg, attitude: orbitalAttitude ?? { kind: 'inertial', direction } };
  }

  /** Apply band crossings (with hysteresis), then keep contact worlds local. */
  private updateModes(control: LanderControl): void {
    const enter = this.options.bandEnterMeters + ENTRY_SNAP_METERS;
    const exit = this.options.bandExitMeters;
    if (!this.separated) {
      const lowest = Math.min(this.partClearance('upper'), this.partClearance('booster'));
      if (this.attachedRun && lowest <= enter) this.stackToContact(control);
      else if (!this.attachedRun && lowest > exit) this.stackToFlight();
    } else {
      for (const which of PARTS) {
        if (this.parts[which].wreck) continue;
        const clearance = this.partClearance(which);
        if (this.parts[which].world && clearance > exit) this.partToFlight(which);
        else if (!this.parts[which].world && clearance <= enter) this.partToContact(which, control);
      }
      this.splitDistantWorld();
    }
    const mode = this.mode;
    if (mode !== this.lastMode) {
      this.modeChanges.push({ time: this.time, from: this.lastMode, to: mode });
      this.lastMode = mode;
    }
  }

  /**
   * Inertia of a flight unit (one part, or the attached stack about its centre of mass) in the upper
   * stage's local axes, from each part's collider inertia and the parallel-axis term of its offset.
   */
  private unitInertia(parts: readonly RocketPart[]): Mat3 {
    if (parts.length === 1) return scaleMat(this.parts[parts[0]!].inertiaPerKg, this.partMass(parts[0]!));
    const total = parts.reduce((sum, which) => sum + this.partMass(which), 0);
    const comOffset = parts.reduce((sum, which) => sum + this.partMass(which) * this.parts[which].offset, 0) / total;
    let inertia: Mat3 = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (const which of parts) {
      const d = { x: 0, y: this.parts[which].offset - comOffset, z: 0 };
      inertia = addMat(inertia, scaleMat(addMat(this.parts[which].inertiaPerKg, parallelAxisPerKg(d)), this.partMass(which)));
    }
    return inertia;
  }

  /** Inertia of the controlled unit (the attached stack, or the upper stage after staging) in the upper stage's local axes, kg m^2. */
  controlledInertia(): Mat3 {
    return this.unitInertia(this.separated ? ['upper'] : PARTS);
  }

  /**
   * The turn command for one step of the unit `parts`, or null when it is not steered. Steering acts on the
   * controlled unit (the attached stack, or the upper stage after staging); a per-step steering law is called
   * here exactly once per physics step, with the attitude at the start of the step.
   */
  private turnFor(parts: readonly RocketPart[], control: LanderControl, rotation: Quaternion, angularVelocity: Vec3, dt: number): Vec3 | null {
    if (!parts.includes('upper')) return null;
    if (!control.steering) return control.turn ?? null;
    const turn = control.steering({ rotation, angularVelocity, inertiaLocal: this.unitInertia(parts) }, dt);
    for (const v of [turn.x, turn.y, turn.z]) if (!(v >= -1 && v <= 1)) throw new RangeError(`PartJointRocket: steering returned ${JSON.stringify(turn)}`);
    return turn;
  }

  private attitudeChanging(parts: readonly RocketPart[], control: LanderControl): boolean {
    const w = this.parts[parts[0]!].angularVelocity;
    // A steering law may command torque on any step, so its unit is always stepped with its attitude.
    if (control.steering && parts.includes('upper')) return true;
    const turn = parts.includes('upper') ? control.turn : undefined;
    return Math.hypot(w.x, w.y, w.z) > 1e-9 || (turn !== undefined && (turn.x !== 0 || turn.y !== 0 || turn.z !== 0));
  }

  /** One attitude step for a unit in orbital flight; attached parts share the upper stage's attitude. */
  private stepFlightAttitude(parts: readonly RocketPart[], control: LanderControl, dt: number): void {
    const lead = this.parts[parts[0]!];
    const turn = this.turnFor(parts, control, lead.rotation, lead.angularVelocity, dt) ?? ZERO;
    const torque = { x: turn.x * STEERING_TORQUE, y: turn.y * STEERING_TORQUE, z: turn.z * STEERING_TORQUE };
    const next = stepAttitude(lead.rotation, lead.angularVelocity, this.unitInertia(parts), torque, dt);
    for (const which of parts) {
      this.parts[which].rotation = next.rotation;
      this.parts[which].angularVelocity = next.angularVelocity;
    }
  }

  private enginePush(which: RocketPart, control: LanderControl): Vec3 {
    const slot = this.parts[which];
    if (which !== this.enginePart || !(control.throttle > 0) || !(slot.fuelKg > 0)) return ZERO;
    const d = rotate(slot.rotation, { x: 0, y: 1, z: 0 });
    const a = control.throttle * slot.spec.thrustNewtons / this.partMass(which);
    return { x: d.x * a, y: d.y * a, z: d.z * a };
  }

  private addToWorld(which: RocketPart, world: ContactWorld, state: FrameState, push: Vec3 = ZERO): void {
    const s = this.parts[which];
    s.push = push;
    s.body = world.addBody({ shape: s.spec.contactShape!, massKg: this.partMass(which), friction: s.spec.friction, restitution: 0,
      lockRotations: false }, state, s.rotation, push);
    s.body.setAngvel(s.angularVelocity, true);
    s.world = world;
    s.run = null;
  }

  private joinParts(): void {
    const identity = { x: 0, y: 0, z: 0, w: 1 };
    const seam = (UPPER_OFFSET + BOOSTER_OFFSET) / 2;
    this.joint = this.world.world.createImpulseJoint(this.rapier.JointData.fixed(
      { x: 0, y: seam - UPPER_OFFSET, z: 0 }, identity, { x: 0, y: seam - BOOSTER_OFFSET, z: 0 }, identity),
    this.upper, this.booster, true);
    // Contacts between the parts stay on: the fixed joint is not rigid, and without the seam contact
    // carrying the booster's thrust into the upper stage the stack bends and tips over during a burn.
    // The cost is some resistance to steering (32° instead of 40° in a second of full pitch).
  }

  private stackToFlight(): void {
    const combined = this.bodyFixedState();
    for (const which of PARTS) this.detach(which);
    // The fixed joint keeps both parts turning together; the stack continues as one rigid body.
    this.parts.booster.rotation = this.parts.upper.rotation;
    this.parts.booster.angularVelocity = this.parts.upper.angularVelocity;
    this.attachedRun = new PropagationRun({ ...this.frame.toInertial(this.time, combined), time: this.time,
      massKg: this.partMass('upper') + this.partMass('booster') });
  }

  private stackToContact(control: LanderControl): void {
    const states = { upper: this.partState('upper'), booster: this.partState('booster') };
    const world = new ContactWorld(this.rapier, this.frame, this.terrain, this.options.contact, this.time, states.upper.position);
    for (const which of PARTS) this.addToWorld(which, world, states[which], this.enginePush(which, control));
    this.attachedRun = null;
    this.joinParts();
  }

  private partToFlight(which: RocketPart): void {
    const state = this.partState(which);
    this.detach(which);
    this.parts[which].run = new PropagationRun({ ...this.frame.toInertial(this.time, state), time: this.time, massKg: this.partMass(which) });
  }

  /** Enter the band: share the other part's world when it is close, otherwise start a new one. */
  private partToContact(which: RocketPart, control: LanderControl): void {
    const state = this.partState(which);
    const other = this.parts[which === 'upper' ? 'booster' : 'upper'];
    const near = other.world && other.body
      && distance(other.world.state(other.body).position, state.position) < this.options.contact.recenterMeters / 2;
    const world = near ? other.world! : new ContactWorld(this.rapier, this.frame, this.terrain, this.options.contact, this.time, state.position);
    this.addToWorld(which, world, state, this.enginePush(which, control));
  }

  /** Two separated parts sharing a world but drifting apart get separate floating origins. */
  private splitDistantWorld(): void {
    const { upper, booster } = this.parts;
    if (!upper.world || upper.world !== booster.world) return;
    if (distance(this.partState('upper').position, this.partState('booster').position) <= this.options.contact.recenterMeters) return;
    const state = this.partState('booster');
    const push = booster.push;
    this.detach('booster');
    this.addToWorld('booster', new ContactWorld(this.rapier, this.frame, this.terrain, this.options.contact, this.time, state.position), state, push);
  }

  /** Take a part out of its contact world (freeing the world when it empties), keeping its attitude. */
  private detach(which: RocketPart): void {
    const s = this.parts[which];
    if (!s.world || !s.body) return;
    s.rotation = s.body.rotation();
    s.angularVelocity = s.body.angvel();
    const world = s.world;
    const shared = PARTS.some((other) => other !== which && this.parts[other].world === world);
    if (shared) world.removeBody(s.body); else world.free();
    s.world = null;
    s.body = null;
    s.push = ZERO;
  }
}
