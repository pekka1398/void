import type {
  Collider,
  KinematicCharacterController,
  RigidBody,
  Rotation,
  World,
} from '@dimforge/rapier3d-compat';
import {
  addVec3,
  crossVec3,
  dotVec3,
  lengthVec3,
  normalizeVec3,
  scaleVec3,
  subVec3,
  vec3,
  type Vec3,
} from '../../core';
import {
  bodyFixedToContactLocal,
  contactGenerationContains,
  type ContactSurfaceGeneration,
  type ContactTangentFrame,
} from '../../terrain/ContactGeometry';
import type { PreparedContactCollider } from '../../terrain/ContactSurfaceStreamer';

/** Capsule half-height includes both hemispheres; Rapier receives halfHeight - radius. */
export const ACTOR_CAPSULE_RADIUS_METERS = 0.35;
export const ACTOR_CAPSULE_HALF_HEIGHT_METERS = 0.9;
export const ACTOR_EYE_HEIGHT_METERS = 1.7;
export const ACTOR_COLLISION_SKIN_METERS = 0.015;
export const ACTOR_MAXIMUM_SLOPE_DEGREES = 44;

type RapierApi = typeof import('@dimforge/rapier3d-compat').default;

let rapierInitialization: Promise<RapierApi> | undefined;

/** The compatibility WASM is loaded once, when a real surface contact lease needs it. */
export function initializeSurfacePhysics(): Promise<RapierApi> {
  if (!rapierInitialization) {
    rapierInitialization = import('@dimforge/rapier3d-compat').then(async (module) => {
      const rapier = module.default;
      await rapier.init();
      return rapier;
    }).catch((error: unknown) => {
      rapierInitialization = undefined;
      throw error;
    });
  }
  return rapierInitialization;
}

/** A box's axes are its right-handed local +X, +Y and +Z, in the body-fixed frame. */
export interface SurfaceMotionBox {
  readonly id: string;
  readonly centerBodyFixedMeters: Readonly<Vec3>;
  readonly halfExtentsMeters: Readonly<Vec3>;
  readonly rightBodyFixed: Readonly<Vec3>;
  readonly upBodyFixed: Readonly<Vec3>;
  readonly forwardBodyFixed: Readonly<Vec3>;
}

export interface SurfaceMotionRequest {
  generation: ContactSurfaceGeneration;
  centerBodyFixedMeters: Readonly<Vec3>;
  desiredTranslationBodyFixedMeters: Readonly<Vec3>;
  upBodyFixed: Readonly<Vec3>;
  deltaSeconds: number;
}

export interface SurfaceMotionResult {
  centerBodyFixedMeters: Vec3;
  translationBodyFixedMeters: Vec3;
  grounded: boolean;
  collisionCount: number;
  generationId: string;
}

export interface SurfaceMotionSweep {
  clear: boolean;
  safeFraction: number;
}

interface PreparedWorld {
  readonly generation: ContactSurfaceGeneration;
  readonly rapier: RapierApi;
  readonly world: World;
  readonly controller: KinematicCharacterController;
  readonly extraColliders: Collider[];
  characterBody?: RigidBody;
  characterCollider?: Collider;
  active: boolean;
  disposed: boolean;
}

/**
 * Bounded tangent-meter physics. The game retains every canonical/body-fixed
 * coordinate; Rapier only corrects a desired local translation against the
 * exact contact-generation triangles and solid descriptors.
 */
export class SurfaceMotionSolver {
  private readonly activeWorlds = new Map<string, PreparedWorld>();
  private readonly allWorlds = new Set<PreparedWorld>();
  private readonly additionalBoxes = new Map<string, readonly SurfaceMotionBox[]>();
  private disposed = false;

  get readyGenerationIds(): readonly string[] {
    return [...this.activeWorlds.keys()];
  }

  get diagnostics(): { backend: 'rapier'; version: '0.20.0'; readyGenerations: number; residentWorlds: number } {
    return {
      backend: 'rapier',
      version: '0.20.0',
      readyGenerations: this.activeWorlds.size,
      residentWorlds: this.allWorlds.size,
    };
  }

  isReady(generationId: string): boolean {
    const prepared = this.activeWorlds.get(generationId);
    return Boolean(prepared?.active && !prepared.disposed);
  }

  /**
   * ContactSurfaceStreamer calls this before its atomic mesh/collider handoff.
   * An uncommitted or stale candidate never becomes usable by an actor.
   */
  async prepareGeneration(generation: ContactSurfaceGeneration): Promise<PreparedContactCollider> {
    if (this.disposed) throw new Error('Surface motion solver is disposed.');
    validateGeneration(generation);
    const rapier = await initializeSurfacePhysics();
    if (this.disposed) throw new Error('Surface motion solver was disposed during initialization.');
    const world = new rapier.World(vec3());
    let prepared: PreparedWorld | undefined;
    try {
      // The visible 1 m grid is also the collider. Internal-edge correction
      // prevents a capsule snagging on the grid's coplanar triangle diagonals.
      world.createCollider(rapier.ColliderDesc.trimesh(
        generation.vertices,
        generation.indices,
        rapier.TriMeshFlags.FIX_INTERNAL_EDGES,
      ).setFriction(0).setRestitution(0));
      for (const solid of generation.solids) this.addBox(world, rapier, generation, solid);
      const controller = world.createCharacterController(ACTOR_COLLISION_SKIN_METERS);
      controller.setMaxSlopeClimbAngle(ACTOR_MAXIMUM_SLOPE_DEGREES * Math.PI / 180);
      controller.setMinSlopeSlideAngle(48 * Math.PI / 180);
      controller.enableAutostep(0.3, 0.2, false);
      controller.enableSnapToGround(0.28);
      controller.setApplyImpulsesToDynamicBodies(false);
      prepared = {
        generation, rapier, world, controller, extraColliders: [], active: false, disposed: false,
      };
      this.allWorlds.add(prepared);
      this.replaceAdditionalBoxes(prepared);
      // Rapier's broad phase must see the newly created static colliders before
      // the first scene query/character move. There are no dynamic bodies here.
      world.step();
    } catch (error) {
      if (prepared) this.disposePrepared(prepared);
      else world.free();
      throw error;
    }
    const candidate = prepared;
    return {
      kind: 'rapier',
      activate: () => {
        if (candidate.disposed || this.disposed) return;
        const previous = this.activeWorlds.get(generation.id);
        if (previous && previous !== candidate) this.disposePrepared(previous);
        candidate.active = true;
        this.activeWorlds.set(generation.id, candidate);
      },
      dispose: () => this.disposePrepared(candidate),
    };
  }

  /** Parked AURORA collision proxies are plain body-fixed boxes, never a moved ship body. */
  setAdditionalObstacles(bodyId: string, boxes: readonly SurfaceMotionBox[]): void {
    if (this.disposed) return;
    this.additionalBoxes.set(bodyId, boxes);
    for (const prepared of this.allWorlds) {
      if (prepared.generation.bodyId !== bodyId || prepared.disposed) continue;
      this.replaceAdditionalBoxes(prepared);
      prepared.world.step();
    }
  }

  clearAdditionalObstacles(bodyId?: string): void {
    if (bodyId === undefined) {
      const ids = [...this.additionalBoxes.keys()];
      this.additionalBoxes.clear();
      for (const id of ids) this.refreshAdditionalObstacles(id);
      return;
    }
    this.additionalBoxes.delete(bodyId);
    this.refreshAdditionalObstacles(bodyId);
  }

  private refreshAdditionalObstacles(bodyId: string): void {
    for (const prepared of this.allWorlds) {
      if (prepared.generation.bodyId !== bodyId || prepared.disposed) continue;
      this.replaceAdditionalBoxes(prepared);
      prepared.world.step();
    }
  }

  private replaceAdditionalBoxes(prepared: PreparedWorld): void {
    for (const collider of prepared.extraColliders) prepared.world.removeCollider(collider, false);
    prepared.extraColliders.length = 0;
    for (const box of this.additionalBoxes.get(prepared.generation.bodyId) ?? []) {
      const collider = this.addBox(prepared.world, prepared.rapier, prepared.generation, box);
      if (collider) prepared.extraColliders.push(collider);
    }
  }

  private addBox(
    world: World,
    rapier: RapierApi,
    frame: ContactSurfaceGeneration,
    box: SurfaceMotionBox,
  ): Collider | undefined {
    const center = bodyFixedToContactLocal(frame, box.centerBodyFixedMeters);
    const half = box.halfExtentsMeters;
    if (![center.x, center.y, center.z, half.x, half.y, half.z].every(Number.isFinite) ||
        half.x <= 0 || half.y <= 0 || half.z <= 0 || !finiteVector(box.rightBodyFixed) ||
        !finiteVector(box.upBodyFixed) || !finiteVector(box.forwardBodyFixed) ||
        lengthVec3(box.rightBodyFixed) < 0.5 || lengthVec3(box.upBodyFixed) < 0.5 ||
        lengthVec3(box.forwardBodyFixed) < 0.5) return undefined;
    const reach = lengthVec3(half) + 3;
    if (Math.abs(center.x) > frame.radiusMeters + reach || Math.abs(center.z) > frame.radiusMeters + reach) {
      return undefined;
    }
    const rotation = quaternionFromAxes(
      bodyFixedVectorToContactLocal(frame, box.rightBodyFixed),
      bodyFixedVectorToContactLocal(frame, box.upBodyFixed),
      bodyFixedVectorToContactLocal(frame, box.forwardBodyFixed),
    );
    return world.createCollider(rapier.ColliderDesc.cuboid(half.x, half.y, half.z)
      .setTranslation(center.x, center.y, center.z)
      .setRotation(rotation)
      .setFriction(0)
      .setRestitution(0));
  }

  move(request: SurfaceMotionRequest): SurfaceMotionResult | null {
    const prepared = this.getPrepared(request.generation);
    if (!prepared || !finiteVector(request.centerBodyFixedMeters) ||
        !finiteVector(request.desiredTranslationBodyFixedMeters) || !finiteVector(request.upBodyFixed) ||
        !Number.isFinite(request.deltaSeconds) || request.deltaSeconds <= 0) return null;
    const delta = Math.max(1 / 240, Math.min(0.05, request.deltaSeconds));
    if (!Number.isFinite(delta) || !contactGenerationContains(
      request.generation, request.centerBodyFixedMeters, ACTOR_CAPSULE_RADIUS_METERS,
    )) return null;
    const local = bodyFixedToContactLocal(request.generation, request.centerBodyFixedMeters);
    const up = normalizeVec3(bodyFixedVectorToContactLocal(request.generation, request.upBodyFixed));
    if (lengthVec3(up) < 0.5) return null;
    const rotation = quaternionFromUp(up);
    this.ensureCharacter(prepared, local, rotation);
    const body = prepared.characterBody!;
    const collider = prepared.characterCollider!;
    prepared.world.timestep = delta;
    // Restore from the authoritative float64 state. This also handles a newly
    // activated tangent frame without changing the player's canonical pose.
    body.setTranslation(local, false);
    body.setRotation(rotation, false);
    prepared.world.propagateModifiedBodyPositionsToColliders();
    prepared.controller.setUp(up);
    const desired = bodyFixedVectorToContactLocal(request.generation, request.desiredTranslationBodyFixedMeters);
    prepared.controller.computeColliderMovement(collider, desired);
    const corrected = prepared.controller.computedMovement();
    const grounded = prepared.controller.computedGrounded();
    const collisionCount = prepared.controller.numComputedCollisions();
    body.setNextKinematicTranslation(addVec3(local, corrected));
    body.setNextKinematicRotation(rotation);
    prepared.world.step();
    const translationBodyFixedMeters = contactLocalVectorToBodyFixed(request.generation, corrected);
    return {
      centerBodyFixedMeters: addVec3(request.centerBodyFixedMeters, translationBodyFixedMeters),
      translationBodyFixedMeters,
      grounded,
      collisionCount,
      generationId: request.generation.id,
    };
  }

  canOccupy(
    generation: ContactSurfaceGeneration,
    centerBodyFixedMeters: Readonly<Vec3>,
    upBodyFixed: Readonly<Vec3> = normalizeVec3(centerBodyFixedMeters),
  ): boolean {
    const prepared = this.getPrepared(generation);
    if (!prepared || !finiteVector(upBodyFixed) || lengthVec3(upBodyFixed) < 0.5 ||
        !contactGenerationContains(generation, centerBodyFixedMeters, ACTOR_CAPSULE_RADIUS_METERS)) {
      return false;
    }
    const center = bodyFixedToContactLocal(generation, centerBodyFixedMeters);
    const up = normalizeVec3(bodyFixedVectorToContactLocal(generation, upBodyFixed));
    return prepared.world.intersectionWithShape(
      center,
      quaternionFromUp(up),
      new prepared.rapier.Capsule(
        ACTOR_CAPSULE_HALF_HEIGHT_METERS - ACTOR_CAPSULE_RADIUS_METERS,
        ACTOR_CAPSULE_RADIUS_METERS,
      ),
      undefined,
      undefined,
      prepared.characterCollider,
      prepared.characterBody,
    ) === null;
  }

  sweepCapsule(
    generation: ContactSurfaceGeneration,
    fromBodyFixedMeters: Readonly<Vec3>,
    toBodyFixedMeters: Readonly<Vec3>,
    upBodyFixed: Readonly<Vec3> = normalizeVec3(fromBodyFixedMeters),
  ): SurfaceMotionSweep {
    const prepared = this.getPrepared(generation);
    if (!prepared || !finiteVector(upBodyFixed) || lengthVec3(upBodyFixed) < 0.5 ||
        !contactGenerationContains(generation, fromBodyFixedMeters, ACTOR_CAPSULE_RADIUS_METERS) ||
        !contactGenerationContains(generation, toBodyFixedMeters, ACTOR_CAPSULE_RADIUS_METERS)) {
      return { clear: false, safeFraction: 0 };
    }
    const from = bodyFixedToContactLocal(generation, fromBodyFixedMeters);
    const delta = bodyFixedVectorToContactLocal(generation, subVec3(toBodyFixedMeters, fromBodyFixedMeters));
    const up = normalizeVec3(bodyFixedVectorToContactLocal(generation, upBodyFixed));
    const shape = new prepared.rapier.Capsule(
      ACTOR_CAPSULE_HALF_HEIGHT_METERS - ACTOR_CAPSULE_RADIUS_METERS,
      ACTOR_CAPSULE_RADIUS_METERS,
    );
    const hit = prepared.world.castShape(
      from, quaternionFromUp(up), delta, shape,
      ACTOR_COLLISION_SKIN_METERS * 0.2, 1, true,
      undefined, undefined, prepared.characterCollider, prepared.characterBody,
    );
    if (!hit) {
      const clear = this.canOccupy(generation, toBodyFixedMeters, upBodyFixed);
      return { clear, safeFraction: clear ? 1 : 0 };
    }
    const safeFraction = Math.max(0, Math.min(1, hit.time_of_impact));
    return { clear: safeFraction >= 1 - 1e-5, safeFraction };
  }

  private ensureCharacter(prepared: PreparedWorld, local: Vec3, rotation: Rotation): void {
    if (prepared.characterBody && prepared.characterCollider) return;
    prepared.characterBody = prepared.world.createRigidBody(prepared.rapier.RigidBodyDesc
      .kinematicPositionBased().setTranslation(local.x, local.y, local.z).setRotation(rotation));
    prepared.characterCollider = prepared.world.createCollider(prepared.rapier.ColliderDesc.capsule(
      ACTOR_CAPSULE_HALF_HEIGHT_METERS - ACTOR_CAPSULE_RADIUS_METERS,
      ACTOR_CAPSULE_RADIUS_METERS,
    ).setFriction(0).setRestitution(0), prepared.characterBody);
    prepared.world.step();
  }

  private getPrepared(generation: ContactSurfaceGeneration): PreparedWorld | undefined {
    const prepared = this.activeWorlds.get(generation.id);
    return prepared?.active && !prepared.disposed && prepared.generation === generation ? prepared : undefined;
  }

  private disposePrepared(prepared: PreparedWorld): void {
    if (prepared.disposed) return;
    prepared.disposed = true;
    prepared.active = false;
    if (this.activeWorlds.get(prepared.generation.id) === prepared) this.activeWorlds.delete(prepared.generation.id);
    this.allWorlds.delete(prepared);
    prepared.world.removeCharacterController(prepared.controller);
    prepared.world.free();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const prepared of [...this.allWorlds]) this.disposePrepared(prepared);
    this.additionalBoxes.clear();
  }
}

export function bodyFixedVectorToContactLocal(frame: ContactTangentFrame, value: Readonly<Vec3>): Vec3 {
  return vec3(dotVec3(value, frame.eastBodyFixed), dotVec3(value, frame.upBodyFixed), dotVec3(value, frame.northBodyFixed));
}

export function contactLocalVectorToBodyFixed(frame: ContactTangentFrame, value: Readonly<Vec3>): Vec3 {
  return addVec3(scaleVec3(frame.eastBodyFixed, value.x), addVec3(
    scaleVec3(frame.upBodyFixed, value.y), scaleVec3(frame.northBodyFixed, value.z),
  ));
}

function finiteVector(value: Readonly<Vec3>): boolean {
  return Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);
}

function validateGeneration(generation: ContactSurfaceGeneration): void {
  if (!finiteVector(generation.originBodyFixedMeters) || !finiteVector(generation.eastBodyFixed) ||
      !finiteVector(generation.upBodyFixed) || !finiteVector(generation.northBodyFixed) ||
      generation.vertices.length < 9 || generation.vertices.length % 3 !== 0 ||
      generation.indices.length < 3 || generation.indices.length % 3 !== 0 ||
      !generation.vertices.every(Number.isFinite) ||
      !generation.indices.every((index) => index < generation.vertices.length / 3)) {
    throw new RangeError('A contact collider needs finite indexed meter-scale triangles.');
  }
}

function quaternionFromUp(upInput: Readonly<Vec3>): Rotation {
  const up = normalizeVec3(upInput);
  const cosine = Math.max(-1, Math.min(1, up.y));
  if (cosine < -0.999999) return { x: 1, y: 0, z: 0, w: 0 };
  const axis = crossVec3(vec3(0, 1, 0), up);
  const w = 1 + cosine;
  const inverse = 1 / Math.hypot(axis.x, axis.y, axis.z, w);
  return { x: axis.x * inverse, y: axis.y * inverse, z: axis.z * inverse, w: w * inverse };
}

function quaternionFromAxes(x: Vec3, y: Vec3, z: Vec3): Rotation {
  const trace = x.x + y.y + z.z;
  let result: Rotation;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    result = { x: (y.z - z.y) / s, y: (z.x - x.z) / s, z: (x.y - y.x) / s, w: s * 0.25 };
  } else if (x.x > y.y && x.x > z.z) {
    const s = Math.sqrt(1 + x.x - y.y - z.z) * 2;
    result = { x: s * 0.25, y: (y.x + x.y) / s, z: (z.x + x.z) / s, w: (y.z - z.y) / s };
  } else if (y.y > z.z) {
    const s = Math.sqrt(1 + y.y - x.x - z.z) * 2;
    result = { x: (y.x + x.y) / s, y: s * 0.25, z: (z.y + y.z) / s, w: (z.x - x.z) / s };
  } else {
    const s = Math.sqrt(1 + z.z - x.x - y.y) * 2;
    result = { x: (z.x + x.z) / s, y: (z.y + y.z) / s, z: s * 0.25, w: (x.y - y.x) / s };
  }
  const inverse = 1 / Math.hypot(result.x, result.y, result.z, result.w);
  return { x: result.x * inverse, y: result.y * inverse, z: result.z * inverse, w: result.w * inverse };
}
