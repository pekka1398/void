import type * as THREE from 'three';
import {
  addAddressOffset,
  cloneAddress,
  crossVec3,
  dotVec3,
  lengthVec3,
  scaleVec3,
  subtractAddresses,
  type GalacticAddress,
  type Vec3,
} from '../core';

/** One physical scale for planetary geometry, spacecraft, actors, and effects. */
export const WORLD_METERS_PER_RENDER_UNIT = 140_000;
/** Three r185's logarithmic depth clamps its effective near plane to this value. */
export const WORLD_NEAR_RENDER_UNITS = 1e-6;
export const FIRST_PERSON_FIELD_OF_VIEW_DEGREES = 70;

export type ObserverOwner = 'ship-chase' | 'ship-cockpit' | 'surface-actor';

export interface ObserverBasis {
  readonly forward: Vec3;
  readonly up: Vec3;
  readonly right: Vec3;
}

export interface ActiveObserverPose extends ObserverBasis {
  readonly owner: ObserverOwner;
  readonly address: GalacticAddress;
  readonly fovDegrees: number;
  readonly nearRenderUnits: number;
}

export interface CanonicalObserverInput {
  readonly address: GalacticAddress;
  readonly forward: Readonly<Vec3>;
  readonly up: Readonly<Vec3>;
  readonly right?: Readonly<Vec3>;
}

const WORLD_UP: Readonly<Vec3> = Object.freeze({ x: 0, y: 1, z: 0 });
const WORLD_FORWARD: Readonly<Vec3> = Object.freeze({ x: 0, y: 0, z: -1 });

export function finiteUnitVector(value: Readonly<Vec3>, fallback: Readonly<Vec3>): Vec3 {
  const magnitude = Math.hypot(value.x, value.y, value.z);
  return Number.isFinite(magnitude) && magnitude > 1e-10
    ? { x: value.x / magnitude, y: value.y / magnitude, z: value.z / magnitude }
    : { ...fallback };
}

/** Stable +Y-up / -Z-forward basis, including a continuous vertical-flight fallback. */
export function orthonormalObserverBasis(
  heading: Readonly<Vec3>,
  preferredUp: Readonly<Vec3>,
  previousRight?: Readonly<Vec3>,
): ObserverBasis {
  const forward = finiteUnitVector(heading, WORLD_FORWARD);
  const upHint = finiteUnitVector(preferredUp, WORLD_UP);
  let right = crossVec3(forward, upHint);
  if (lengthVec3(right) < 1e-7 && previousRight) {
    const along = dotVec3(previousRight, forward);
    right = {
      x: previousRight.x - forward.x * along,
      y: previousRight.y - forward.y * along,
      z: previousRight.z - forward.z * along,
    };
  }
  if (lengthVec3(right) < 1e-7) {
    const leastAligned = Math.abs(forward.x) <= Math.abs(forward.y) &&
      Math.abs(forward.x) <= Math.abs(forward.z)
      ? { x: 1, y: 0, z: 0 }
      : Math.abs(forward.y) <= Math.abs(forward.z)
        ? WORLD_UP
        : { x: 0, y: 0, z: 1 };
    right = crossVec3(forward, leastAligned);
  }
  right = finiteUnitVector(right, { x: 1, y: 0, z: 0 });
  return {
    forward,
    right,
    up: finiteUnitVector(crossVec3(right, forward), WORLD_UP),
  };
}

/** Positive roll turns the starboard wing down around the physical bow axis. */
export function rollObserverBasis(basis: ObserverBasis, rollRadians: number): ObserverBasis {
  const roll = Number.isFinite(rollRadians) ? rollRadians : 0;
  const cosine = Math.cos(roll);
  const sine = Math.sin(roll);
  return {
    forward: { ...basis.forward },
    right: {
      x: basis.right.x * cosine - basis.up.x * sine,
      y: basis.right.y * cosine - basis.up.y * sine,
      z: basis.right.z * cosine - basis.up.z * sine,
    },
    up: {
      x: basis.up.x * cosine + basis.right.x * sine,
      y: basis.up.y * cosine + basis.right.y * sine,
      z: basis.up.z * cosine + basis.right.z * sine,
    },
  };
}

/** Convert native glTF +X starboard, +Y dorsal, -Z bow meters into world meters. */
export function shipLocalOffsetToWorld(local: Readonly<Vec3>, basis: ObserverBasis): Vec3 {
  return {
    x: basis.right.x * local.x + basis.up.x * local.y - basis.forward.x * local.z,
    y: basis.right.y * local.x + basis.up.y * local.y - basis.forward.y * local.z,
    z: basis.right.z * local.x + basis.up.z * local.y - basis.forward.z * local.z,
  };
}

export function offsetObserverAddress(
  address: GalacticAddress,
  localMeters: Readonly<Vec3>,
  basis: ObserverBasis,
): GalacticAddress {
  return addAddressOffset(address, shipLocalOffsetToWorld(localMeters, basis));
}

/** Cockpit and on-foot views are rigid: camera smoothing never changes their physical eye. */
export function createRigidObserverPose(
  owner: ObserverOwner,
  pose: CanonicalObserverInput,
  options: { readonly fovDegrees?: number; readonly nearRenderUnits?: number } = {},
): ActiveObserverPose {
  const basis = orthonormalObserverBasis(pose.forward, pose.up, pose.right);
  const fov = options.fovDegrees ?? FIRST_PERSON_FIELD_OF_VIEW_DEGREES;
  const near = options.nearRenderUnits ?? WORLD_NEAR_RENDER_UNITS;
  return {
    owner,
    address: cloneAddress(pose.address),
    ...basis,
    fovDegrees: Number.isFinite(fov) ? Math.max(30, Math.min(110, fov)) : FIRST_PERSON_FIELD_OF_VIEW_DEGREES,
    nearRenderUnits: Number.isFinite(near) ? Math.max(WORLD_NEAR_RENDER_UNITS, near) : WORLD_NEAR_RENDER_UNITS,
  };
}

export function observerRelativeRenderPosition(
  address: GalacticAddress,
  observer: Pick<ActiveObserverPose, 'address'>,
  metersPerRenderUnit = WORLD_METERS_PER_RENDER_UNIT,
): Vec3 {
  return scaleVec3(subtractAddresses(address, observer.address), 1 / metersPerRenderUnit);
}

/** Apply an observer to a camera-relative world; the camera itself stays at GPU origin. */
export function applyObserverPose(camera: THREE.PerspectiveCamera, pose: ActiveObserverPose): void {
  const basis = orthonormalObserverBasis(pose.forward, pose.up, pose.right);
  camera.position.set(0, 0, 0);
  camera.up.set(basis.up.x, basis.up.y, basis.up.z);
  camera.lookAt(basis.forward.x, basis.forward.y, basis.forward.z);
  if (camera.fov !== pose.fovDegrees || camera.near !== pose.nearRenderUnits) {
    camera.fov = pose.fovDegrees;
    camera.near = pose.nearRenderUnits;
    camera.updateProjectionMatrix();
  }
  camera.updateMatrixWorld(true);
}
