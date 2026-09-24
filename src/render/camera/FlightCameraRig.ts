import * as THREE from 'three';
import {
  addAddressOffset,
  subtractAddresses,
  type GalacticAddress,
  type Vec3,
} from '../../core';
import type { SurfacePhase } from '../../simulation/ship/ShipState';
import { AURORA_ACTIVE_ASSET } from '../ship/AuroraAsset';
import {
  WORLD_NEAR_RENDER_UNITS,
  finiteUnitVector,
  orthonormalObserverBasis,
  type ActiveObserverPose,
} from '../ObserverPose';

export type CameraDiscontinuityReason =
  | 'initial' | 'restore' | 'teleport' | 'system-switch' | 'ftl-arrival'
  | 'recovery' | 'view-switch' | 'egress' | 'boarding';

export interface CameraBoomSweep {
  readonly fromAddress: GalacticAddress;
  readonly toAddress: GalacticAddress;
  readonly radiusMeters: number;
}

export interface CameraBoomSweepResult {
  readonly safeFraction: number;
  /** A contact authority may return its exact safe canonical sphere center. */
  readonly address?: GalacticAddress;
}

export interface FlightCameraInput {
  readonly shipAddress: GalacticAddress;
  readonly forward: Readonly<Vec3>;
  readonly referenceUp: Readonly<Vec3>;
  readonly surfaceUp?: Readonly<Vec3>;
  readonly surfaceInfluence?: number;
  readonly velocityMetersPerSecond: Readonly<Vec3>;
  readonly rollRadians: number;
  readonly mode: string;
  readonly surfacePhase?: SurfacePhase;
  readonly clearanceMeters?: number;
  readonly throttle?: number;
  readonly deltaSeconds: number;
  readonly shipLengthMeters?: number;
  readonly sweepBoom?: (sweep: CameraBoomSweep) => CameraBoomSweepResult;
}

export interface FlightCameraProfile {
  readonly armMeters: number;
  readonly heightMeters: number;
  readonly shoulderMeters: number;
  readonly lookAheadMeters: number;
  readonly focusLiftMeters: number;
  readonly fovDegrees: number;
  readonly positionFrequency: number;
  readonly orientationFrequency: number;
  readonly rollInfluence: number;
}

export interface CriticalSpringValue {
  readonly value: number;
  readonly velocity: number;
}

const BOUNDS = AURORA_ACTIVE_ASSET.geometry?.bounds;
export const DEFAULT_PHYSICAL_SHIP_LENGTH_METERS = BOUNDS
  ? BOUNDS.max.z - BOUNDS.min.z
  : 12.02;

const POWERED_VELOCITY_LEAD_WEIGHT = 0.045;
const COASTING_VELOCITY_LEAD_WEIGHT = 0.18;
const REVERSE_LEAD_ALIGNMENT = -0.35;
const FULL_LEAD_ALIGNMENT = 0.55;

/** Exact solution of x'' + 2ωx' + ω²(x-target) = 0 for a fixed target. */
export function stepCriticallyDampedSpring(
  value: number,
  velocity: number,
  target: number,
  angularFrequency: number,
  deltaSeconds: number,
): CriticalSpringValue {
  if (!(deltaSeconds > 0)) return { value, velocity };
  const omega = Math.max(1e-5, angularFrequency);
  const displacement = value - target;
  const coefficient = velocity + omega * displacement;
  const decay = Math.exp(-omega * deltaSeconds);
  return {
    value: target + (displacement + coefficient * deltaSeconds) * decay,
    velocity: (velocity - omega * coefficient * deltaSeconds) * decay,
  };
}

function lengthFor(input: Pick<FlightCameraInput, 'shipLengthMeters'>): number {
  return Number.isFinite(input.shipLengthMeters) && input.shipLengthMeters! > 0
    ? Math.max(2, Math.min(200, input.shipLengthMeters!))
    : DEFAULT_PHYSICAL_SHIP_LENGTH_METERS;
}

/** The profile changes camera distance, never the actual spacecraft scale. */
export function resolveFlightCameraProfile(input: Pick<FlightCameraInput,
  'mode' | 'surfacePhase' | 'clearanceMeters' | 'shipLengthMeters'
>): FlightCameraProfile {
  const length = lengthFor(input);
  const phase = input.surfacePhase ?? 'airborne';
  let arm = 2;
  let height = 0.45;
  let fov = 57;
  let lookAhead = 0.7;
  let positionFrequency = 6.2;
  let rollInfluence = 0.28;

  if (input.mode === 'pulse' || input.mode === 'hyperdrive' || input.mode === 'hyper') {
    arm = 2.5; height = 0.55; fov = 68; lookAhead = 1.15;
  } else if (input.mode === 'boost') {
    arm = 2.3; height = 0.5; fov = 62; lookAhead = 0.9;
  }

  const clearance = Number.isFinite(input.clearanceMeters) ? input.clearanceMeters! : Infinity;
  if (phase === 'landing-armed' || (phase === 'airborne' && clearance < 1_800)) {
    arm = 1.8; height = 0.4; fov = input.mode === 'boost' ? 62 : 59;
    lookAhead = 0.6; rollInfluence = 0.2;
  }
  if (phase === 'flare' || phase === 'touchdown-settle' || phase === 'parked' ||
    phase === 'takeoff-spool' || phase === 'takeoff-rise') {
    arm = phase === 'parked' ? 1.65 : 1.55;
    height = phase === 'parked' ? 0.35 : 0.3;
    fov = 64; lookAhead = 0.34; positionFrequency = 5.6; rollInfluence = 0.12;
  } else if (phase === 'takeoff-climb') {
    arm = 1.85; height = 0.4; fov = 61; lookAhead = 0.6; rollInfluence = 0.2;
  }

  return {
    armMeters: arm * length,
    heightMeters: height * length,
    shoulderMeters: 0,
    lookAheadMeters: lookAhead * length,
    focusLiftMeters: length * 0.045,
    fovDegrees: fov,
    positionFrequency,
    orientationFrequency: phase === 'airborne' || phase === 'landing-armed' ? 9 : 10.5,
    rollInfluence,
  };
}

const FORWARD = new THREE.Vector3(0, 0, -1);
const UP = new THREE.Vector3(0, 1, 0);
const RIGHT = new THREE.Vector3(1, 0, 0);

function assignVector(destination: THREE.Vector3, source: Readonly<Vec3>): THREE.Vector3 {
  return destination.set(source.x, source.y, source.z);
}

function plainVector(vector: THREE.Vector3): Vec3 {
  return { x: vector.x, y: vector.y, z: vector.z };
}

function springVector(
  value: THREE.Vector3,
  velocity: THREE.Vector3,
  target: THREE.Vector3,
  omega: number,
  delta: number,
): void {
  for (const component of ['x', 'y', 'z'] as const) {
    const next = stepCriticallyDampedSpring(value[component], velocity[component], target[component], omega, delta);
    value[component] = next.value;
    velocity[component] = next.velocity;
  }
}

/**
 * A ship-relative meter-space spring. It follows canonical movement exactly
 * and only damps the bounded camera arm, so FTL and origin rebases cannot leave
 * the camera millions of kilometers behind or pollute the physics state.
 */
export class FlightCameraRig {
  private readonly offset = new THREE.Vector3();
  private readonly offsetVelocity = new THREE.Vector3();
  private readonly orientation = new THREE.Quaternion();
  private readonly angularVelocity = new THREE.Vector3();
  private readonly previousAim = FORWARD.clone();
  private readonly transportedUp = UP.clone();
  private readonly forward = new THREE.Vector3();
  private readonly motion = new THREE.Vector3();
  private readonly aim = new THREE.Vector3();
  private readonly upHint = new THREE.Vector3();
  private readonly projectedUp = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly up = new THREE.Vector3();
  private readonly rolledUp = new THREE.Vector3();
  private readonly desiredOffset = new THREE.Vector3();
  private readonly focus = new THREE.Vector3();
  private readonly viewForward = new THREE.Vector3();
  private readonly backward = new THREE.Vector3();
  private readonly scratch = new THREE.Vector3();
  private readonly scratch2 = new THREE.Vector3();
  private readonly transport = new THREE.Quaternion();
  private readonly targetOrientation = new THREE.Quaternion();
  private readonly errorQuaternion = new THREE.Quaternion();
  private readonly orientationError = new THREE.Vector3();
  private readonly matrix = new THREE.Matrix4();
  private initialized = false;
  private fieldOfView = 57;
  private fieldOfViewVelocity = 0;
  private resetSerial = 0;
  private resetReason: CameraDiscontinuityReason = 'initial';
  private boomFraction = 1;

  get diagnostics(): Readonly<{
    initialized: boolean;
    resetSerial: number;
    resetReason: CameraDiscontinuityReason;
    offsetMeters: Vec3;
    boomSafeFraction: number;
  }> {
    return {
      initialized: this.initialized,
      resetSerial: this.resetSerial,
      resetReason: this.resetReason,
      offsetMeters: plainVector(this.offset),
      boomSafeFraction: this.boomFraction,
    };
  }

  /** Only real view/simulation discontinuities reset; ordinary render rebases do not. */
  reset(reason: CameraDiscontinuityReason = 'initial'): void {
    this.initialized = false;
    this.offsetVelocity.set(0, 0, 0);
    this.angularVelocity.set(0, 0, 0);
    this.fieldOfViewVelocity = 0;
    this.resetReason = reason;
    this.resetSerial += 1;
  }

  update(input: FlightCameraInput): ActiveObserverPose {
    const delta = Number.isFinite(input.deltaSeconds)
      ? THREE.MathUtils.clamp(input.deltaSeconds, 0, 0.25)
      : 0;
    const profile = resolveFlightCameraProfile(input);
    const shipLength = lengthFor(input);
    assignVector(this.forward, finiteUnitVector(input.forward, { x: 0, y: 0, z: -1 }));
    assignVector(this.upHint, finiteUnitVector(input.referenceUp, { x: 0, y: 1, z: 0 }));
    if (input.surfaceUp) {
      const influence = THREE.MathUtils.clamp(input.surfaceInfluence ?? 0, 0, 1);
      assignVector(this.scratch, finiteUnitVector(input.surfaceUp, plainVector(this.upHint)));
      this.upHint.lerp(this.scratch, influence).normalize();
    }

    assignVector(this.motion, input.velocityMetersPerSecond);
    const speed = this.motion.length();
    const validMotion = Number.isFinite(speed) && speed > 0.05;
    if (validMotion) this.motion.multiplyScalar(1 / speed);
    else this.motion.copy(this.forward);
    // Looking a little into a genuine coast makes directional inertia legible.
    // Fade that lead continuously before reverse flight. A binary dot-product
    // cutoff used to jump the aim by 19 degrees, which also forced the bounded
    // camera arm several meters sideways in a single rendered frame.
    const coast = THREE.MathUtils.clamp(1 - (input.throttle ?? 0), 0, 1);
    const motionWeight = validMotion
      ? THREE.MathUtils.lerp(POWERED_VELOCITY_LEAD_WEIGHT, COASTING_VELOCITY_LEAD_WEIGHT, coast) *
        Math.min(1, speed / 12) *
        THREE.MathUtils.smoothstep(this.motion.dot(this.forward), REVERSE_LEAD_ALIGNMENT, FULL_LEAD_ALIGNMENT)
      : 0;
    this.aim.copy(this.forward).lerp(this.motion, motionWeight).normalize();

    this.updateTransportedBasis(delta);
    this.desiredOffset.copy(this.aim).multiplyScalar(-profile.armMeters)
      .addScaledVector(this.up, profile.heightMeters)
      .addScaledVector(this.right, profile.shoulderMeters);
    this.focus.copy(this.aim).multiplyScalar(profile.lookAheadMeters)
      .addScaledVector(this.up, profile.focusLiftMeters);

    if (!this.initialized) {
      this.offset.copy(this.desiredOffset);
      this.fieldOfView = profile.fovDegrees;
    } else {
      springVector(this.offset, this.offsetVelocity, this.desiredOffset, profile.positionFrequency, delta);
      // Bounded local lag is essential during abrupt steering and FTL handoffs.
      this.scratch.copy(this.offset).sub(this.desiredOffset);
      if (this.scratch.lengthSq() > shipLength * shipLength) {
        this.scratch.setLength(shipLength);
        this.offset.copy(this.desiredOffset).add(this.scratch);
        const outward = this.offsetVelocity.dot(this.scratch) / (shipLength * shipLength);
        if (outward > 0) this.offsetVelocity.addScaledVector(this.scratch, -outward);
      }
      const fov = stepCriticallyDampedSpring(this.fieldOfView, this.fieldOfViewVelocity,
        profile.fovDegrees, 5, delta);
      const maximumFovStep = delta * 15;
      this.fieldOfView += THREE.MathUtils.clamp(fov.value - this.fieldOfView,
        -maximumFovStep, maximumFovStep);
      this.fieldOfViewVelocity = fov.velocity;
    }

    this.boomFraction = 1;
    if (input.sweepBoom) {
      // Begin above the fuselage center, not inside the ground at a gear contact.
      this.scratch.copy(this.up).multiplyScalar(Math.min(1.5, shipLength * 0.12));
      const fromAddress = addAddressOffset(input.shipAddress, plainVector(this.scratch));
      const toAddress = addAddressOffset(input.shipAddress, plainVector(this.offset));
      const hit = input.sweepBoom({ fromAddress, toAddress, radiusMeters: 0.35 });
      this.boomFraction = Number.isFinite(hit.safeFraction)
        ? THREE.MathUtils.clamp(hit.safeFraction, 0, 1)
        : 0;
      if (this.boomFraction < 1) {
        if (hit.address) assignVector(this.offset, subtractAddresses(hit.address, input.shipAddress));
        else this.offset.sub(this.scratch).multiplyScalar(this.boomFraction).add(this.scratch);
        // Collision correction is immediate. A spring must never carry the eye through a wall.
        this.offsetVelocity.set(0, 0, 0);
      }
    }

    this.viewForward.copy(this.focus).sub(this.offset).normalize();
    this.rolledUp.copy(this.up).applyAxisAngle(this.aim,
      (Number.isFinite(input.rollRadians) ? input.rollRadians : 0) * profile.rollInfluence);
    this.scratch.crossVectors(this.viewForward, this.rolledUp).normalize();
    if (this.scratch.lengthSq() < 0.1) this.scratch.copy(this.right);
    this.scratch2.crossVectors(this.scratch, this.viewForward).normalize();
    this.matrix.makeBasis(this.scratch, this.scratch2, this.backward.copy(this.viewForward).negate());
    this.targetOrientation.setFromRotationMatrix(this.matrix);

    if (!this.initialized) {
      this.orientation.copy(this.targetOrientation);
      this.initialized = true;
    } else {
      this.springOrientation(this.targetOrientation, profile.orientationFrequency, delta);
    }

    this.previousAim.copy(this.aim);
    this.scratch.copy(FORWARD).applyQuaternion(this.orientation);
    this.scratch2.copy(UP).applyQuaternion(this.orientation);
    const basis = orthonormalObserverBasis(plainVector(this.scratch), plainVector(this.scratch2));
    return {
      owner: 'ship-chase',
      address: addAddressOffset(input.shipAddress, plainVector(this.offset)),
      ...basis,
      fovDegrees: this.fieldOfView,
      nearRenderUnits: WORLD_NEAR_RENDER_UNITS,
    };
  }

  private updateTransportedBasis(delta: number): void {
    if (!this.initialized) {
      const basis = orthonormalObserverBasis(plainVector(this.aim), plainVector(this.upHint));
      assignVector(this.transportedUp, basis.up);
    } else {
      this.transport.setFromUnitVectors(this.previousAim, this.aim);
      this.transportedUp.applyQuaternion(this.transport);
    }
    this.transportedUp.addScaledVector(this.aim, -this.transportedUp.dot(this.aim)).normalize();
    this.projectedUp.copy(this.upHint).addScaledVector(this.aim, -this.upHint.dot(this.aim));
    const radialProjection = this.projectedUp.length();
    if (radialProjection > 1e-6) {
      this.projectedUp.multiplyScalar(1 / radialProjection);
      const poleWeight = THREE.MathUtils.smoothstep(radialProjection, 0.06, 0.4);
      const horizonResponse = this.initialized ? (1 - Math.exp(-delta * 3.2)) * poleWeight : 1;
      this.scratch.crossVectors(this.transportedUp, this.projectedUp);
      const angle = Math.atan2(this.aim.dot(this.scratch),
        THREE.MathUtils.clamp(this.transportedUp.dot(this.projectedUp), -1, 1));
      this.transportedUp.applyAxisAngle(this.aim, angle * horizonResponse).normalize();
    }
    this.right.crossVectors(this.aim, this.transportedUp).normalize();
    if (this.right.lengthSq() < 0.1) this.right.copy(RIGHT);
    this.up.crossVectors(this.right, this.aim).normalize();
    this.transportedUp.copy(this.up);
  }

  private springOrientation(target: THREE.Quaternion, omega: number, delta: number): void {
    this.errorQuaternion.copy(target).invert().premultiply(this.orientation).normalize();
    if (this.errorQuaternion.w < 0) {
      this.errorQuaternion.set(-this.errorQuaternion.x, -this.errorQuaternion.y,
        -this.errorQuaternion.z, -this.errorQuaternion.w);
    }
    const sineHalf = Math.hypot(this.errorQuaternion.x, this.errorQuaternion.y, this.errorQuaternion.z);
    const angle = 2 * Math.atan2(sineHalf, Math.max(0, this.errorQuaternion.w));
    if (sineHalf > 1e-10) {
      this.orientationError.set(this.errorQuaternion.x, this.errorQuaternion.y, this.errorQuaternion.z)
        .multiplyScalar(angle / sineHalf);
    } else this.orientationError.set(0, 0, 0);
    this.scratch.set(0, 0, 0);
    springVector(this.orientationError, this.angularVelocity, this.scratch, omega, delta);
    const remainingAngle = this.orientationError.length();
    if (remainingAngle > 1e-10) {
      this.scratch.copy(this.orientationError).multiplyScalar(1 / remainingAngle);
      this.errorQuaternion.setFromAxisAngle(this.scratch, remainingAngle);
      this.orientation.copy(target).premultiply(this.errorQuaternion).normalize();
    } else this.orientation.copy(target);
  }
}
