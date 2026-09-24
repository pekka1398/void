import { Vector3 } from 'three';
import { rotateAroundYAxis } from '../../core/coords/FrameGraph';
import type { CelestialLightFrame } from '../../lighting';

/** Only an authentic catalog ring can eclipse its own planet's surface. */
export interface PhysicalRingShadowDescriptor {
  readonly innerRadiusMeters: number;
  readonly outerRadiusMeters: number;
  readonly tiltRadians: number;
  readonly opacity: number;
}

interface VectorLike {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export const PHYSICAL_RING_BAND_CENTERS = [0.15, 0.34, 0.49, 0.63, 0.83] as const;

function smoothstep(edge0: number, edge1: number, value: number): number {
  const fraction = Math.max(0, Math.min(1, (value - edge0) / Math.max(Number.EPSILON, edge1 - edge0)));
  return fraction * fraction * (3 - 2 * fraction);
}

/** Match the five actual annulus density bands without creating new geometry. */
export function samplePhysicalRingDensity(progress: number): number {
  if (!Number.isFinite(progress) || progress < 0 || progress > 1) return 0;
  const gaussian = (center: number, width: number) => Math.exp(-(((progress - center) / width) ** 2));
  const density = gaussian(0.15, 0.047) * 0.52
    + gaussian(0.34, 0.064) * 0.78
    + gaussian(0.49, 0.018) * 0.45
    + gaussian(0.63, 0.05) * 0.58
    + gaussian(0.83, 0.023) * 0.7
    + 0.028;
  return Math.min(1, density)
    * smoothstep(0, 0.035, progress)
    * (1 - smoothstep(0.965, 1, progress));
}

/** Body-fixed normal matches the real ring group's rotation around its Z axis. */
export function physicalRingPlaneNormal(tiltRadians: number): Vector3 {
  return new Vector3(-Math.sin(tiltRadians), Math.cos(tiltRadians), 0);
}

/** Return actual [0, 0.88] direct-starlight occlusion, never a fabricated shadow. */
export function samplePhysicalRingOcclusion(
  positionMeters: VectorLike,
  starDirectionBodyFixed: VectorLike,
  ring: PhysicalRingShadowDescriptor | undefined,
): number {
  if (!ring || !Number.isFinite(ring.innerRadiusMeters) || !Number.isFinite(ring.outerRadiusMeters)
    || !Number.isFinite(ring.tiltRadians) || !Number.isFinite(ring.opacity)
    || ring.innerRadiusMeters <= 0 || ring.outerRadiusMeters <= ring.innerRadiusMeters || ring.opacity <= 0) {
    return 0;
  }

  const point = new Vector3(positionMeters.x, positionMeters.y, positionMeters.z);
  const direction = new Vector3(starDirectionBodyFixed.x, starDirectionBodyFixed.y, starDirectionBodyFixed.z);
  if (!Number.isFinite(point.lengthSq()) || !Number.isFinite(direction.lengthSq()) || direction.lengthSq() < 1e-12) {
    return 0;
  }
  direction.normalize();

  const normal = physicalRingPlaneNormal(ring.tiltRadians);
  const projectedDirection = direction.dot(normal);
  if (Math.abs(projectedDirection) < 1e-7) return 0;
  const intersectionDistance = -point.dot(normal) / projectedDirection;
  if (intersectionDistance <= 0) return 0;

  const impact = point.addScaledVector(direction, intersectionDistance);
  const radial = Math.sqrt(Math.max(0, impact.lengthSq() - impact.dot(normal) ** 2));
  const progress = (radial - ring.innerRadiusMeters) / (ring.outerRadiusMeters - ring.innerRadiusMeters);
  return Math.min(0.88, samplePhysicalRingDensity(progress) * Math.max(0, Math.min(1, ring.opacity)) * 0.94);
}

/** One source-weighted land shadow policy for distant and human-scale terrain. */
export function sampleSurfaceRingLighting(
  positionBodyFixedMeters: VectorLike,
  frame: CelestialLightFrame,
  bodyRotationRadians: number,
  ring: PhysicalRingShadowDescriptor | undefined,
): { occlusions: readonly [number, number, number]; weightedOcclusion: number; daylight: number } {
  const occlusions: [number, number, number] = [0, 0, 0];
  let totalReceived = 0;
  let blockedReceived = 0;
  for (const source of frame.sources) {
    if (!source.active || !source.id) continue;
    const direction = rotateAroundYAxis(source.directionWorld, -bodyRotationRadians);
    const occlusion = samplePhysicalRingOcclusion(positionBodyFixedMeters, direction, ring);
    occlusions[source.slot] = occlusion;
    const received = Number.isFinite(source.receivedIrradianceSolar) ? Math.max(0, source.receivedIrradianceSolar) : 0;
    totalReceived += received;
    blockedReceived += received * occlusion;
  }
  const weightedOcclusion = totalReceived > 0 ? blockedReceived / totalReceived : 0;
  return { occlusions, weightedOcclusion,
    daylight: Math.max(0, Math.min(1, frame.daylight * (1 - weightedOcclusion * 0.72))) };
}
