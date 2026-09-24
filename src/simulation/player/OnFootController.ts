import {
  addVec3,
  bodyFixedToWorld,
  crossVec3,
  dotVec3,
  lengthVec3,
  lerpVec3,
  normalizeVec3,
  rotateAroundYAxis,
  scaleVec3,
  subVec3,
  vec3,
  type BodyFrame,
  type GalacticAddress,
  type Vec3,
} from '../../core';
import type { SurfaceContactAuthority, SurfaceSweepReason } from '../../terrain/SurfaceContactAuthority';
import {
  ACTOR_CAPSULE_HALF_HEIGHT_METERS,
  ACTOR_CAPSULE_RADIUS_METERS,
  ACTOR_COLLISION_SKIN_METERS,
  ACTOR_EYE_HEIGHT_METERS,
  ACTOR_MAXIMUM_SLOPE_DEGREES,
  SurfaceMotionSolver,
} from './SurfaceMotionSolver';

export const SURFACE_ACTOR_VERSION = 1;
export const ON_FOOT_WALK_SPEED_METERS_PER_SECOND = 4.2;
export const ON_FOOT_SPRINT_SPEED_METERS_PER_SECOND = 7.1;
export const ON_FOOT_MAXIMUM_LOOK_PITCH_RADIANS = Math.PI * 0.475;

export interface SurfaceActorState {
  systemId: string;
  bodyId: string;
  /** Center of the 1.8 m capsule in authoritative body-fixed float64 meters. */
  bodyFixedCenterMeters: Vec3;
  bodyFixedVelocityMetersPerSecond: Vec3;
  tangentForwardBodyFixed: Vec3;
  lookPitchRadians: number;
  grounded: boolean;
}

export type OnFootInputAction = 'forward' | 'backward' | 'left' | 'right' | 'sprint';
export type OnFootInputState = Record<OnFootInputAction, boolean>;

export interface SurfaceActorObserverPose {
  address: GalacticAddress;
  forward: Vec3;
  up: Vec3;
  right: Vec3;
}

export interface OnFootControllerOptions {
  contact: SurfaceContactAuthority;
  motion: SurfaceMotionSolver;
  /** The real body's GM/r², supplied by the catalog-owning coordinator. */
  gravityMetersPerSecondSquared?: (bodyId: string, bodyFixedCenterMeters: Readonly<Vec3>) => number;
}

export interface OnFootSnapshot {
  actor?: SurfaceActorState;
  leaseId?: string;
  generationId?: string;
  speedMetersPerSecond: number;
  grounded: boolean;
  blockingReason?: SurfaceSweepReason | 'terrain-loading';
  /** Monotonic runtime event identity; it is deliberately not saved. */
  footstepSerial: number;
}

export function emptyOnFootInput(): OnFootInputState {
  return { forward: false, backward: false, left: false, right: false, sprint: false };
}

export function cloneSurfaceActorState(state: SurfaceActorState): SurfaceActorState {
  return {
    ...state,
    bodyFixedCenterMeters: { ...state.bodyFixedCenterMeters },
    bodyFixedVelocityMetersPerSecond: { ...state.bodyFixedVelocityMetersPerSecond },
    tangentForwardBodyFixed: { ...state.tangentForwardBodyFixed },
  };
}

/** Structural validation only; actual body, dry support and capsule clearance are runtime checks. */
export function isValidSurfaceActorState(value: unknown): value is SurfaceActorState {
  if (!value || typeof value !== 'object') return false;
  const actor = value as Partial<SurfaceActorState>;
  return typeof actor.systemId === 'string' && actor.systemId.length > 0 &&
    typeof actor.bodyId === 'string' && actor.bodyId.length > 0 &&
    finiteVector(actor.bodyFixedCenterMeters) && lengthVec3(actor.bodyFixedCenterMeters) > 1 &&
    finiteVector(actor.bodyFixedVelocityMetersPerSecond) && lengthVec3(actor.bodyFixedVelocityMetersPerSecond) <= 120 &&
    finiteVector(actor.tangentForwardBodyFixed) && lengthVec3(actor.tangentForwardBodyFixed) > 0.5 &&
    lengthVec3(actor.tangentForwardBodyFixed) < 1.5 &&
    typeof actor.lookPitchRadians === 'number' && Number.isFinite(actor.lookPitchRadians) &&
    Math.abs(actor.lookPitchRadians) <= ON_FOOT_MAXIMUM_LOOK_PITCH_RADIANS + 1e-5 &&
    typeof actor.grounded === 'boolean';
}

/** One independent pilot actor. Walking never writes the parked ship's state. */
export class OnFootController {
  readonly input = emptyOnFootInput();
  private currentState?: SurfaceActorState;
  private currentLeaseId?: string;
  private blockingReason?: OnFootSnapshot['blockingReason'];
  private footstepDistanceMeters = 0;
  private footstepEventSerial = 0;

  constructor(private readonly options: OnFootControllerOptions) {}

  get state(): SurfaceActorState | undefined {
    return this.currentState;
  }

  get leaseId(): string | undefined {
    return this.currentLeaseId;
  }

  get snapshot(): OnFootSnapshot {
    const state = this.currentState;
    const up = state ? normalizeVec3(state.bodyFixedCenterMeters) : vec3(0, 1, 0);
    const velocity = state?.bodyFixedVelocityMetersPerSecond ?? vec3();
    return {
      ...(state ? { actor: cloneSurfaceActorState(state) } : {}),
      ...(this.currentLeaseId ? { leaseId: this.currentLeaseId } : {}),
      ...(this.currentLeaseId && this.options.contact.getGeneration(this.currentLeaseId)
        ? { generationId: this.options.contact.getGeneration(this.currentLeaseId)!.id } : {}),
      speedMetersPerSecond: lengthVec3(projectToTangent(velocity, up)),
      grounded: state?.grounded ?? false,
      ...(this.blockingReason ? { blockingReason: this.blockingReason } : {}),
      footstepSerial: this.footstepEventSerial,
    };
  }

  attach(state: SurfaceActorState, leaseId: string): boolean {
    if (!isValidSurfaceActorState(state)) return false;
    const lease = this.options.contact.getLease(leaseId);
    if (!lease || lease.kind !== 'actor' || lease.bodyId !== state.bodyId) return false;
    this.clearInput();
    this.currentState = cloneSurfaceActorState(state);
    this.currentState.tangentForwardBodyFixed = tangentHeading(
      this.currentState.tangentForwardBodyFixed,
      normalizeVec3(this.currentState.bodyFixedCenterMeters),
    );
    this.currentLeaseId = leaseId;
    this.blockingReason = undefined;
    this.footstepDistanceMeters = 0;
    this.footstepEventSerial = 0;
    return true;
  }

  detach(): void {
    this.clearInput();
    this.currentState = undefined;
    this.currentLeaseId = undefined;
    this.blockingReason = undefined;
    this.footstepDistanceMeters = 0;
    this.footstepEventSerial = 0;
  }

  setInput(action: OnFootInputAction, active: boolean): void {
    this.input[action] = active;
  }

  clearInput(): void {
    for (const action of Object.keys(this.input) as OnFootInputAction[]) this.input[action] = false;
  }

  /** Positive yaw turns left, matching the ship's existing mouse convention. */
  look(yawDeltaRadians: number, pitchDeltaRadians: number): void {
    const state = this.currentState;
    if (!state || !Number.isFinite(yawDeltaRadians) || !Number.isFinite(pitchDeltaRadians)) return;
    const up = normalizeVec3(state.bodyFixedCenterMeters);
    state.tangentForwardBodyFixed = tangentHeading(
      rotateAroundAxis(state.tangentForwardBodyFixed, up, yawDeltaRadians), up,
    );
    state.lookPitchRadians = Math.max(-ON_FOOT_MAXIMUM_LOOK_PITCH_RADIANS,
      Math.min(ON_FOOT_MAXIMUM_LOOK_PITCH_RADIANS, state.lookPitchRadians + pitchDeltaRadians));
  }

  update(deltaSeconds: number): void {
    const state = this.currentState;
    const leaseId = this.currentLeaseId;
    if (!state || !leaseId || !Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return;
    const delta = Math.min(0.05, deltaSeconds);
    const generation = this.options.contact.getGeneration(leaseId);
    const up = normalizeVec3(state.bodyFixedCenterMeters);
    if (!generation || !this.options.motion.isReady(generation.id) ||
        !this.options.contact.isReadyAt(state.bodyId, state.bodyFixedCenterMeters, {
          leaseId, radiusMeters: ACTOR_CAPSULE_RADIUS_METERS + ACTOR_COLLISION_SKIN_METERS,
        })) {
      state.bodyFixedVelocityMetersPerSecond = vec3();
      this.blockingReason = 'terrain-loading';
      return;
    }
    const forward = tangentHeading(state.tangentForwardBodyFixed, up);
    const right = normalizeVec3(crossVec3(forward, up));
    const wish = addVec3(
      scaleVec3(forward, Number(this.input.forward) - Number(this.input.backward)),
      scaleVec3(right, Number(this.input.right) - Number(this.input.left)),
    );
    const wishLength = lengthVec3(wish);
    const speed = this.input.sprint ? ON_FOOT_SPRINT_SPEED_METERS_PER_SECOND : ON_FOOT_WALK_SPEED_METERS_PER_SECOND;
    const desiredHorizontal = wishLength > 1e-9 ? scaleVec3(wish, speed / Math.max(1, wishLength)) : vec3();
    const previousHorizontal = projectToTangent(state.bodyFixedVelocityMetersPerSecond, up);
    const response = 1 - Math.exp(-delta * (wishLength > 0 ? 12 : 18));
    const horizontalVelocity = lerpVec3(previousHorizontal, desiredHorizontal, response);
    const suppliedGravity = this.options.gravityMetersPerSecondSquared?.(state.bodyId, state.bodyFixedCenterMeters) ?? 9.81;
    const gravity = Math.max(0.03, Math.min(65, Number.isFinite(suppliedGravity) ? suppliedGravity : 9.81));
    const oldVertical = dotVec3(state.bodyFixedVelocityMetersPerSecond, up);
    const verticalVelocity = state.grounded ? -Math.max(0.65, gravity * delta) : Math.max(-38, oldVertical - gravity * delta);
    const horizontalTranslation = scaleVec3(horizontalVelocity, delta);
    const verticalTranslation = scaleVec3(up, verticalVelocity * delta);
    const desiredTranslation = addVec3(horizontalTranslation, verticalTranslation);
    const before = { ...state.bodyFixedCenterMeters };
    const safety = this.options.contact.sweepCapsule(state.bodyId, before, addVec3(before, desiredTranslation), {
      leaseId,
      radiusMeters: ACTOR_CAPSULE_RADIUS_METERS,
      halfHeightMeters: ACTOR_CAPSULE_HALF_HEIGHT_METERS,
      checkGround: false,
      includeSolids: false,
      // The actual collider decides what is climbable. Hazard/ready authority
      // must not disable Rapier's slope slide and 30 cm autostep response.
      maximumSlopeDegrees: 90,
    });
    const boundedTranslation = safety.blocked
      ? addVec3(scaleVec3(horizontalTranslation, safety.safeFraction), verticalTranslation)
      : desiredTranslation;
    const result = this.options.motion.move({
      generation,
      centerBodyFixedMeters: before,
      desiredTranslationBodyFixedMeters: boundedTranslation,
      upBodyFixed: up,
      deltaSeconds: delta,
    });
    if (!result) {
      state.bodyFixedVelocityMetersPerSecond = vec3();
      this.blockingReason = 'terrain-loading';
      return;
    }
    // Sliding around a solid can change the path; check the corrected segment
    // against the same committed liquid/readiness footprint before publishing.
    const correctedSafety = this.options.contact.sweepCapsule(state.bodyId, before, result.centerBodyFixedMeters, {
      leaseId,
      radiusMeters: ACTOR_CAPSULE_RADIUS_METERS,
      halfHeightMeters: ACTOR_CAPSULE_HALF_HEIGHT_METERS,
      checkGround: false,
      includeSolids: false,
      maximumSlopeDegrees: 90,
    });
    const next = correctedSafety.blocked
      ? { ...correctedSafety.positionBodyFixedMeters }
      : result.centerBodyFixedMeters;
    const actualTranslation = subVec3(next, before);
    const nextUp = normalizeVec3(next);
    state.bodyFixedCenterMeters = next;
    state.tangentForwardBodyFixed = tangentHeading(forward, nextUp);
    state.grounded = result.grounded;
    const actualVelocity = scaleVec3(actualTranslation, 1 / delta);
    state.bodyFixedVelocityMetersPerSecond = state.grounded
      ? projectToTangent(actualVelocity, nextUp)
      : actualVelocity;
    this.blockingReason = correctedSafety.blocked ? correctedSafety.reason
      : safety.blocked ? safety.reason : undefined;
    const walkedMeters = lengthVec3(projectToTangent(actualTranslation, nextUp));
    if (state.grounded && walkedMeters > 1e-5) {
      this.footstepDistanceMeters += walkedMeters;
      const stride = this.input.sprint ? 1.75 : 1.45;
      if (this.footstepDistanceMeters >= stride) {
        this.footstepDistanceMeters %= stride;
        this.footstepEventSerial += 1;
      }
    }
    this.options.contact.updateLease(leaseId, { centerDirection: nextUp });
  }

  getObserverPose(frame: BodyFrame): SurfaceActorObserverPose | undefined {
    return this.currentState && frame.id === this.currentState.bodyId
      ? getSurfaceActorObserverPose(this.currentState, frame)
      : undefined;
  }
}

/** Same-epoch body rotation is applied to eye and all basis vectors together. */
export function getSurfaceActorObserverPose(state: SurfaceActorState, frame: BodyFrame): SurfaceActorObserverPose {
  if (frame.id !== state.bodyId) throw new RangeError('The actor observer needs its own body frame.');
  const radialUp = normalizeVec3(state.bodyFixedCenterMeters);
  const tangentForward = tangentHeading(state.tangentForwardBodyFixed, radialUp);
  const forwardBodyFixed = normalizeVec3(addVec3(
    scaleVec3(tangentForward, Math.cos(state.lookPitchRadians)),
    scaleVec3(radialUp, Math.sin(state.lookPitchRadians)),
  ));
  const rightBodyFixed = normalizeVec3(crossVec3(forwardBodyFixed, radialUp));
  const cameraUpBodyFixed = normalizeVec3(crossVec3(rightBodyFixed, forwardBodyFixed));
  const eyeBodyFixed = addVec3(state.bodyFixedCenterMeters,
    scaleVec3(radialUp, ACTOR_EYE_HEIGHT_METERS - ACTOR_CAPSULE_HALF_HEIGHT_METERS));
  return {
    address: bodyFixedToWorld(frame, eyeBodyFixed),
    forward: rotateAroundYAxis(forwardBodyFixed, frame.rotationRadians),
    up: rotateAroundYAxis(cameraUpBodyFixed, frame.rotationRadians),
    right: rotateAroundYAxis(rightBodyFixed, frame.rotationRadians),
  };
}

export function createSurfaceActorState(
  systemId: string,
  bodyId: string,
  groundPointBodyFixedMeters: Readonly<Vec3>,
  forwardBodyFixed: Readonly<Vec3>,
  groundNormalBodyFixed: Readonly<Vec3> = normalizeVec3(groundPointBodyFixedMeters),
): SurfaceActorState {
  const up = normalizeVec3(groundPointBodyFixedMeters);
  const supportCosine = Math.max(0.1, dotVec3(normalizeVec3(groundNormalBodyFixed), up));
  const centerHeight = ACTOR_CAPSULE_HALF_HEIGHT_METERS - ACTOR_CAPSULE_RADIUS_METERS +
    (ACTOR_CAPSULE_RADIUS_METERS + ACTOR_COLLISION_SKIN_METERS) / supportCosine;
  return {
    systemId,
    bodyId,
    bodyFixedCenterMeters: addVec3(groundPointBodyFixedMeters,
      scaleVec3(up, centerHeight)),
    bodyFixedVelocityMetersPerSecond: vec3(),
    tangentForwardBodyFixed: tangentHeading(forwardBodyFixed, up),
    lookPitchRadians: 0,
    grounded: true,
  };
}

export function tangentHeading(forward: Readonly<Vec3>, up: Readonly<Vec3>): Vec3 {
  const projected = projectToTangent(forward, up);
  if (lengthVec3(projected) > 1e-8) return normalizeVec3(projected);
  const reference = Math.abs(up.y) < 0.9 ? vec3(0, 1, 0) : vec3(0, 0, 1);
  return normalizeVec3(crossVec3(reference, up));
}

export function projectToTangent(value: Readonly<Vec3>, up: Readonly<Vec3>): Vec3 {
  return subVec3(value, scaleVec3(up, dotVec3(value, up)));
}

function rotateAroundAxis(value: Readonly<Vec3>, axis: Readonly<Vec3>, angle: number): Vec3 {
  return addVec3(scaleVec3(value, Math.cos(angle)), addVec3(
    scaleVec3(crossVec3(axis, value), Math.sin(angle)),
    scaleVec3(axis, dotVec3(axis, value) * (1 - Math.cos(angle))),
  ));
}

function finiteVector(value: unknown): value is Vec3 {
  if (!value || typeof value !== 'object') return false;
  const vector = value as Partial<Vec3>;
  return typeof vector.x === 'number' && Number.isFinite(vector.x) &&
    typeof vector.y === 'number' && Number.isFinite(vector.y) &&
    typeof vector.z === 'number' && Number.isFinite(vector.z);
}

export { ACTOR_CAPSULE_HALF_HEIGHT_METERS, ACTOR_CAPSULE_RADIUS_METERS, ACTOR_EYE_HEIGHT_METERS, ACTOR_MAXIMUM_SLOPE_DEGREES };
