import type RAPIER_NS from '@dimforge/rapier3d-compat';
import type { Vec3 } from '../orbitCore';
import { tileId, tilesAround } from '../lodCore';
import { buildTerrainTile, surfaceIndices, surfacePositions } from '../terrain/TerrainTiles';
import type { Terrain } from '../terrain/Surface';
import type { FrameState, PlanetFrame } from './PlanetFrame';

type Rapier = typeof RAPIER_NS;

export interface ContactWorldOptions {
  /** Fixed physics step, s. */
  stepSeconds: number;
  tileLevel: number;
  /** Vertices per tile side (lab/lod's tile resolution). */
  tileResolution: number;
  /** Tiles within this distance of a body's ground point are loaded. */
  tileReachMeters: number;
  /** Tiles farther than this from every body are unloaded (> reach, for hysteresis). */
  tileKeepMeters: number;
  /** The floating origin moves to a body that gets this far from it. */
  recenterMeters: number;
}

export type BodyShape =
  | { kind: 'box'; halfExtents: Vec3 }
  | { kind: 'ball'; radius: number }
  | { kind: 'cylinder'; radius: number; halfHeight: number }
  | { kind: 'cone'; radius: number; halfHeight: number }
  | { kind: 'compound'; parts: { shape: Exclude<BodyShape, { kind: 'compound' }>; position: Vec3; rotation?: Quaternion }[] };

export interface ContactBodySpec {
  shape: BodyShape;
  massKg: number;
  friction: number;
  restitution: number;
  /** Keep the body's orientation fixed in the planet's frame. */
  lockRotations: boolean;
}

/** Unit quaternion, body-fixed axes. */
export interface Quaternion { x: number; y: number; z: number; w: number }

/**
 * Extra acceleration (e.g. thrust) for a body, called once per step. Leapfrog
 * kicks cover the half steps on both sides of a step, so this must return
 * the average of the extra acceleration over the step just ended and the
 * step starting; a jump (engine on or off) then lands at the step boundary.
 */
export type ExtraAcceleration = (body: RAPIER_NS.RigidBody, state: FrameState) => Vec3;

/** Rapier angular damping of every non-ball body; flight attitude (vessel/Attitude.ts) uses the same. */
export const ANGULAR_DAMPING = 0.8;

export interface TileCollider { collider: RAPIER_NS.Collider; origin: Vec3 }

/**
 * Rapier rigid bodies in the planet's rotating frame, on collision tiles
 * streamed around them.
 * - Coordinates: Rapier works in float32 relative to a float64 floating
 *   origin (body-fixed). The origin follows the bodies, so Rapier numbers
 *   stay within about recenterMeters.
 * - Forces: Rapier's own gravity is off. Each step first kicks every body's
 *   velocity by PlanetFrame.acceleration * dt; then Rapier resolves contacts
 *   and drifts positions.
 * - Accuracy: Rapier's kick-then-drift is first-order. The velocity kept in
 *   Rapier is treated as the half-step velocity, v(n - 1/2): bodies enter
 *   with v - a dt/2 and are read back as u + a dt/2. The same kick-drift
 *   loop is then leapfrog, second order in free flight.
 */
export class ContactWorld {
  readonly world: RAPIER_NS.World;
  readonly frame: PlanetFrame;
  readonly terrain: Terrain;
  readonly options: ContactWorldOptions;
  /** Simulated time, s (the frame's clock). */
  time: number;
  /** Floating origin, body-fixed metres. */
  origin: Vec3;
  /** Diagnostics. */
  tileLoads = 0;
  tileUnloads = 0;
  recenters = 0;
  private readonly rapier: Rapier;
  private readonly bodies = new Set<RAPIER_NS.RigidBody>();
  private readonly bodyColliderWeights = new Map<RAPIER_NS.RigidBody, number[]>();
  private readonly tiles = new Map<string, TileCollider>();
  private readonly contactDeltaV = new Map<RAPIER_NS.RigidBody, number>();

  constructor(rapier: Rapier, frame: PlanetFrame, terrain: Terrain, options: ContactWorldOptions, time: number, origin: Vec3) {
    if (!(options.stepSeconds > 0) || !(options.tileKeepMeters > options.tileReachMeters) || !(options.recenterMeters > 0)) {
      throw new RangeError(`ContactWorld: options ${JSON.stringify(options)}`);
    }
    if (terrain.radiusMeters !== frame.body.radiusMeters) {
      throw new RangeError(`ContactWorld: terrain radius ${terrain.radiusMeters} differs from ${frame.body.id}'s ${frame.body.radiusMeters}`);
    }
    this.rapier = rapier;
    this.frame = frame;
    this.terrain = terrain;
    this.options = options;
    this.time = time;
    this.origin = { ...origin };
    this.world = new rapier.World({ x: 0, y: 0, z: 0 });
    this.world.timestep = options.stepSeconds;
    frame.ephemeris.extendTo(time + options.stepSeconds);
  }

  get loadedTileCount(): number {
    return this.tiles.size;
  }

  /** Loaded terrain colliders: tile id, body-fixed tile origin, and the Rapier collider holding its triangles. */
  terrainColliders(): Iterable<readonly [string, Readonly<TileCollider>]> {
    return this.tiles.entries();
  }

  /**
   * extraBefore: acceleration beyond gravity and the frame's over the half
   * step before now (thrust already running), for the half-step velocity.
   */
  addBody(spec: ContactBodySpec, state: FrameState, rotation: Quaternion = { x: 0, y: 0, z: 0, w: 1 }, extraBefore: Vec3 = { x: 0, y: 0, z: 0 }): RAPIER_NS.RigidBody {
    const R = this.rapier;
    const p = this.toLocal(state.position);
    const g = this.frame.acceleration(this.time, state.position, state.velocity);
    const a = { x: g.x + extraBefore.x, y: g.y + extraBefore.y, z: g.z + extraBefore.z };
    const dt = this.options.stepSeconds;
    const body = this.world.createRigidBody(R.RigidBodyDesc.dynamic()
      .setTranslation(p.x, p.y, p.z)
      // Stored velocity is the half-step velocity v - a dt/2.
      .setLinvel(state.velocity.x - (a.x * dt) / 2, state.velocity.y - (a.y * dt) / 2, state.velocity.z - (a.z * dt) / 2)
      .setRotation(rotation)
      .setAngularDamping(spec.shape.kind === 'ball' ? 0 : ANGULAR_DAMPING)
      .setCcdEnabled(true));
    if (spec.lockRotations) body.lockRotations(true, false);
    const pieces = spec.shape.kind === 'compound'
      ? spec.shape.parts
      : [{ shape: spec.shape, position: { x: 0, y: 0, z: 0 } }];
    const volume = (shape: Exclude<BodyShape, { kind: 'compound' }>): number => {
      if (shape.kind === 'box') return 8 * shape.halfExtents.x * shape.halfExtents.y * shape.halfExtents.z;
      if (shape.kind === 'ball') return (4 / 3) * Math.PI * shape.radius ** 3;
      if (shape.kind === 'cone') return (2 / 3) * Math.PI * shape.radius ** 2 * shape.halfHeight;
      return 2 * Math.PI * shape.radius ** 2 * shape.halfHeight;
    };
    const density = spec.massKg / pieces.reduce((sum, piece) => sum + volume(piece.shape), 0);
    const weights: number[] = [];
    for (const piece of pieces) {
      const shape = piece.shape;
      const desc = shape.kind === 'box' ? R.ColliderDesc.cuboid(shape.halfExtents.x, shape.halfExtents.y, shape.halfExtents.z)
        : shape.kind === 'ball' ? R.ColliderDesc.ball(shape.radius)
        : shape.kind === 'cone' ? R.ColliderDesc.cone(shape.halfHeight, shape.radius)
        : R.ColliderDesc.cylinder(shape.halfHeight, shape.radius);
      desc.setTranslation(piece.position.x, piece.position.y, piece.position.z);
      if ('rotation' in piece && piece.rotation) desc.setRotation(piece.rotation);
      desc.setDensity(density).setFriction(spec.friction).setRestitution(spec.restitution);
      this.world.createCollider(desc, body);
      weights.push(volume(shape) * density / spec.massKg);
    }
    this.bodies.add(body);
    this.bodyColliderWeights.set(body, weights);
    // No solver step has touched the new body yet.
    this.contactDeltaV.set(body, 0);
    this.streamTiles();
    return body;
  }

  /**
   * Body-fixed state at the current time (velocity back from the half step).
   * extra: any acceleration beyond gravity and the frame's, over the coming
   * step (thrust), which the half step back includes.
   */
  state(body: RAPIER_NS.RigidBody, extra: Vec3 = { x: 0, y: 0, z: 0 }): FrameState {
    if (!this.bodies.has(body)) throw new Error('ContactWorld: unknown body');
    const t = body.translation();
    const position = { x: this.origin.x + t.x, y: this.origin.y + t.y, z: this.origin.z + t.z };
    const u = body.linvel();
    const dt = this.options.stepSeconds;
    // One fixed-point pass: the Coriolis term depends on the velocity itself.
    const total = (v: Vec3): Vec3 => {
      const g = this.frame.acceleration(this.time, position, v);
      return { x: g.x + extra.x, y: g.y + extra.y, z: g.z + extra.z };
    };
    let a = total(u);
    a = total({ x: u.x + (a.x * dt) / 2, y: u.y + (a.y * dt) / 2, z: u.z + (a.z * dt) / 2 });
    return { position, velocity: { x: u.x + (a.x * dt) / 2, y: u.y + (a.y * dt) / 2, z: u.z + (a.z * dt) / 2 } };
  }

  removeBody(body: RAPIER_NS.RigidBody): void {
    if (!this.bodies.delete(body)) throw new Error('ContactWorld: unknown body');
    this.bodyColliderWeights.delete(body);
    this.contactDeltaV.delete(body);
    this.world.removeRigidBody(body);
  }

  /** Keep the physical collider mass in sync with fuel consumed by a part. */
  setBodyMass(body: RAPIER_NS.RigidBody, massKg: number): void {
    const weights = this.bodyColliderWeights.get(body);
    if (!weights || !(massKg > 0)) throw new RangeError('ContactWorld: invalid body mass');
    for (let i = 0; i < weights.length; i += 1) body.collider(i).setMass(massKg * weights[i]!);
    body.wakeUp();
  }

  /** Release Rapier's memory; the world is unusable afterwards. */
  free(): void {
    this.world.free();
    this.bodies.clear();
    this.bodyColliderWeights.clear();
    this.contactDeltaV.clear();
    this.tiles.clear();
  }

  /**
   * Speed change Rapier's solver gave a body in the last step, m/s. Rapier's
   * own gravity is off, so this is contact and joint impulse only: a
   * restitution-free impact at normal speed v shows up as about v.
   */
  lastContactDeltaV(body: RAPIER_NS.RigidBody): number {
    if (!this.bodies.has(body)) throw new Error('ContactWorld: unknown body');
    const deltaV = this.contactDeltaV.get(body);
    if (deltaV === undefined) throw new Error('ContactWorld: body has no contact record');
    return deltaV;
  }

  step(extra?: ExtraAcceleration): void {
    const dt = this.options.stepSeconds;
    this.frame.ephemeris.extendTo(this.time + dt);
    const kicked = new Map<RAPIER_NS.RigidBody, Vec3>();
    for (const body of this.bodies) {
      const push = extra ? extra(body, this.state(body)) : null;
      if (push && (push.x !== 0 || push.y !== 0 || push.z !== 0)) body.wakeUp();
      if (body.isSleeping()) continue;
      const t = body.translation();
      const position = { x: this.origin.x + t.x, y: this.origin.y + t.y, z: this.origin.z + t.z };
      const u = body.linvel();
      // Coriolis at the mid-point velocity estimate u + a dt / 2, thrust included.
      const e = push ?? { x: 0, y: 0, z: 0 };
      let a = this.frame.acceleration(this.time, position, u);
      a = this.frame.acceleration(this.time, position, { x: u.x + ((a.x + e.x) * dt) / 2, y: u.y + ((a.y + e.y) * dt) / 2, z: u.z + ((a.z + e.z) * dt) / 2 });
      a = { x: a.x + e.x, y: a.y + e.y, z: a.z + e.z };
      const v = { x: u.x + a.x * dt, y: u.y + a.y * dt, z: u.z + a.z * dt };
      body.setLinvel(v, false);
      kicked.set(body, v);
    }
    this.world.step();
    for (const body of this.bodies) {
      const before = kicked.get(body);
      const after = body.linvel();
      this.contactDeltaV.set(body, before ? Math.hypot(after.x - before.x, after.y - before.y, after.z - before.z) : 0);
    }
    this.time += dt;
    this.recenterIfNeeded();
    this.streamTiles();
  }

  /** Move the floating origin to a body-fixed point, keeping every state unchanged. */
  recenter(to: Vec3): void {
    const d = { x: to.x - this.origin.x, y: to.y - this.origin.y, z: to.z - this.origin.z };
    for (const body of this.bodies) {
      const t = body.translation();
      body.setTranslation({ x: t.x - d.x, y: t.y - d.y, z: t.z - d.z }, false);
    }
    this.origin = { ...to };
    for (const tile of this.tiles.values()) {
      const p = this.toLocal(tile.origin);
      tile.collider.setTranslation(p);
    }
    this.recenters += 1;
  }

  private recenterIfNeeded(): void {
    for (const body of this.bodies) {
      const t = body.translation();
      if (Math.hypot(t.x, t.y, t.z) > this.options.recenterMeters) {
        this.recenter({ x: this.origin.x + t.x, y: this.origin.y + t.y, z: this.origin.z + t.z });
        return;
      }
    }
  }

  private toLocal(p: Vec3): Vec3 {
    return { x: p.x - this.origin.x, y: p.y - this.origin.y, z: p.z - this.origin.z };
  }

  private streamTiles(): void {
    const { tileLevel, tileResolution, tileReachMeters, tileKeepMeters } = this.options;
    const R = this.terrain.radiusMeters;
    const wanted = new Set<string>();
    const keep = new Set<string>();
    for (const body of this.bodies) {
      const t = body.translation();
      const p = { x: this.origin.x + t.x, y: this.origin.y + t.y, z: this.origin.z + t.z };
      const r = Math.hypot(p.x, p.y, p.z);
      // Tiles matter only once the body could reach the ground.
      if (r - R - this.terrain.maxHeightMeters > tileReachMeters) continue;
      for (const key of tilesAround(p, tileReachMeters, tileLevel, R)) {
        const id = tileId(key);
        wanted.add(id);
        if (!this.tiles.has(id)) {
          const tile = buildTerrainTile(key, this.terrain, tileResolution);
          const local = this.toLocal(tile.origin);
          const collider = this.world.createCollider(
            this.rapier.ColliderDesc.trimesh(surfacePositions(tile, tileResolution), surfaceIndices(tileResolution))
              .setTranslation(local.x, local.y, local.z).setFriction(0.8),
          );
          this.tiles.set(id, { collider, origin: tile.origin });
          this.tileLoads += 1;
        }
      }
      for (const key of tilesAround(p, tileKeepMeters, tileLevel, R)) keep.add(tileId(key));
    }
    for (const [id, tile] of this.tiles) {
      if (keep.has(id) || wanted.has(id)) continue;
      this.world.removeCollider(tile.collider, true);
      this.tiles.delete(id);
      this.tileUnloads += 1;
    }
  }
}
