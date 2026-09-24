import {
  dotVec3,
  lengthVec3,
  normalizeVec3,
  scaleVec3,
  type Vec3,
} from '../../core';
import {
  orthonormalObserverBasis,
  rollObserverBasis,
  shipLocalOffsetToWorld,
} from '../ObserverPose';
import { AURORA_ACTIVE_ASSET, AURORA_PHYSICAL_METERS_PER_GLTF_UNIT } from './AuroraAsset';

export type FlightViewMode = 'chase' | 'cockpit';

export interface CockpitCanopyBounds {
  readonly min: Readonly<Vec3>;
  readonly max: Readonly<Vec3>;
}

export interface CockpitCameraInput {
  /** Authoritative canonical flight heading; never a decorative chase angle. */
  readonly forward: Readonly<Vec3>;
  /** Existing smoothly blended orbital / planet-relative flight up. */
  readonly referenceUp: Readonly<Vec3>;
  /** The actual moving planet's radial up, when a surface is influential. */
  readonly surfaceUp?: Readonly<Vec3>;
  readonly surfaceInfluence?: number;
  /** Uniform scale applied to the genuinely loaded active AURORA glTF asset. */
  readonly assetScale?: number;
  /** Native +Y-up, -Z-forward bounds of the real authored canopy geometry. */
  readonly canopyBounds?: CockpitCanopyBounds;
  /** Validated native-meter pilot socket from the additive surface kit. */
  readonly pilotEyeMeters?: Readonly<Vec3>;
  readonly rollRadians?: number;
}

export interface CockpitCameraPresentation {
  /** Physical offset from the actual canonical spacecraft center, in meters. */
  readonly eyeOffsetMeters: Vec3;
  readonly eyeHeightMeters: number;
  readonly eyeForwardMeters: number;
  readonly fieldOfViewDegrees: number;
  readonly hideExterior: true;
}

/** POSITION accessor bounds measured from the actual approved AURORA canopy. */
export const AURORA_COCKPIT_CANOPY_BOUNDS: CockpitCanopyBounds = Object.freeze({
  min: Object.freeze({ ...AURORA_ACTIVE_ASSET.canopyBounds.min }),
  max: Object.freeze({ ...AURORA_ACTIVE_ASSET.canopyBounds.max }),
});

/** Physical glTF meter scale, not the retired camera-display scale. */
export const AURORA_COCKPIT_MODEL_SCALE = AURORA_PHYSICAL_METERS_PER_GLTF_UNIT;
export const COCKPIT_FIELD_OF_VIEW_DEGREES = 70;

/**
 * Derive a genuine pilot-eye position from the existing authored AURORA canopy.
 *
 * The returned value is a canonical meter offset, not a foreground-scene
 * position. GameApp subtracts it from every real body, star, and nebula using
 * the same existing camera-relative path as its exterior chase presentation.
 */
export function resolveCockpitCameraPresentation(
  input: CockpitCameraInput,
): CockpitCameraPresentation {
  const forward = normalizeFinite(input.forward, { x: 0, y: 0, z: -1 });
  const referenceUp = normalizeFinite(input.referenceUp, { x: 0, y: 1, z: 0 });
  const surfaceUp = input.surfaceUp
    ? normalizeFinite(input.surfaceUp, referenceUp)
    : referenceUp;
  const influence = input.surfaceUp && Number.isFinite(input.surfaceInfluence)
    ? Math.max(0, Math.min(1, input.surfaceInfluence!))
    : 0;
  const preferredUp = normalizeFinite({
    x: referenceUp.x + (surfaceUp.x - referenceUp.x) * influence,
    y: referenceUp.y + (surfaceUp.y - referenceUp.y) * influence,
    z: referenceUp.z + (surfaceUp.z - referenceUp.z) * influence,
  }, referenceUp);
  const up = perpendicularUp(forward, preferredUp);

  const canopy = validBounds(input.canopyBounds)
    ? input.canopyBounds
    : AURORA_COCKPIT_CANOPY_BOUNDS;
  const scale = Number.isFinite(input.assetScale) && input.assetScale! > 0
    ? Math.min(input.assetScale!, 4)
    : AURORA_COCKPIT_MODEL_SCALE;

  // glTF's real +Y is the spacecraft's dorsal up; its -Z points to the bow.
  // The cockpit remains centered rather than inheriting tiny mesh asymmetry.
  const explicitEye = input.pilotEyeMeters;
  const pilotEye = explicitEye && Number.isFinite(explicitEye.x) &&
    Number.isFinite(explicitEye.y) && Number.isFinite(explicitEye.z)
    ? explicitEye
    : {
        x: 0,
        y: (canopy.min.y + canopy.max.y) * 0.5 * scale,
        z: (canopy.min.z + canopy.max.z) * 0.5 * scale,
      };
  const eyeHeightMeters = pilotEye.y;
  const eyeForwardMeters = -pilotEye.z;
  const basis = rollObserverBasis(orthonormalObserverBasis(forward, up), input.rollRadians ?? 0);

  return {
    eyeOffsetMeters: shipLocalOffsetToWorld(pilotEye, basis),
    eyeHeightMeters,
    eyeForwardMeters,
    fieldOfViewDegrees: COCKPIT_FIELD_OF_VIEW_DEGREES,
    hideExterior: true,
  };
}

function normalizeFinite(value: Readonly<Vec3>, fallback: Readonly<Vec3>): Vec3 {
  if (!Number.isFinite(value.x) || !Number.isFinite(value.y) || !Number.isFinite(value.z)) {
    return { x: fallback.x, y: fallback.y, z: fallback.z };
  }
  const magnitude = lengthVec3(value);
  return magnitude > 1e-9
    ? scaleVec3(value, 1 / magnitude)
    : { x: fallback.x, y: fallback.y, z: fallback.z };
}

function perpendicularUp(forward: Vec3, preferredUp: Vec3): Vec3 {
  const alignment = dotVec3(forward, preferredUp);
  let projected = {
    x: preferredUp.x - forward.x * alignment,
    y: preferredUp.y - forward.y * alignment,
    z: preferredUp.z - forward.z * alignment,
  };

  if (lengthVec3(projected) <= 1e-8) {
    // Straight up/down flight has no body-radial horizon. Pick the least
    // aligned real world axis so the pilot eye stays finite and perpendicular.
    const axis = Math.abs(forward.x) <= Math.abs(forward.y) &&
      Math.abs(forward.x) <= Math.abs(forward.z)
      ? { x: 1, y: 0, z: 0 }
      : Math.abs(forward.y) <= Math.abs(forward.z)
        ? { x: 0, y: 1, z: 0 }
        : { x: 0, y: 0, z: 1 };
    const axisAlignment = dotVec3(forward, axis);
    projected = {
      x: axis.x - forward.x * axisAlignment,
      y: axis.y - forward.y * axisAlignment,
      z: axis.z - forward.z * axisAlignment,
    };
  }

  return normalizeVec3(projected);
}

function validBounds(bounds: CockpitCanopyBounds | undefined): bounds is CockpitCanopyBounds {
  if (!bounds) return false;
  return Number.isFinite(bounds.min.x) && Number.isFinite(bounds.min.y) &&
    Number.isFinite(bounds.min.z) && Number.isFinite(bounds.max.x) &&
    Number.isFinite(bounds.max.y) && Number.isFinite(bounds.max.z) &&
    bounds.min.x < bounds.max.x && bounds.min.y < bounds.max.y &&
    bounds.min.z < bounds.max.z &&
    bounds.min.y + bounds.max.y > 0 && bounds.min.z + bounds.max.z < 0;
}
