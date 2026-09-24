import {
  crossVec3,
  dotVec3,
  lengthVec3,
  normalizeVec3,
  scaleVec3,
  subVec3,
  type Vec3,
} from '../core/Vec3';
import type { ContactFlowDescriptor } from './ContactGeometry';

const PERIMETER = [0, 2, 3, 1] as const;
const UNIT_AXIS_TOLERANCE = 1e-5;
const BOUNDS_TOLERANCE_METERS = 1e-3;
// Legacy cascades keep the source's heading while searching at most 9 * 82 m
// downstream. Their heading is therefore only approximately tangent at the
// final cascade midpoint. This permits that curvature, not arbitrary axes.
const LEGACY_CASCADE_HEADING_DISTANCE_METERS = 9 * 82;

interface Point2 {
  readonly x: number;
  readonly z: number;
}

function projectFootprint(
  bodyRadiusMeters: number,
  flow: ContactFlowDescriptor,
  center: Readonly<Vec3>,
  acrossAxis: Readonly<Vec3>,
): Point2[] {
  return PERIMETER.map((index) => {
    const vertex = scaleVec3(normalizeVec3(flow.cornersBodyFixedMeters[index]), bodyRadiusMeters);
    const relative = subVec3(vertex, center);
    return { x: dotVec3(relative, flow.headingBodyFixed), z: dotVec3(relative, acrossAxis) };
  });
}

/**
 * Exact convex footprint of the four vertices used by both visible flow
 * meshes. Validate immutable descriptors once at their handoff, not per query.
 */
export function surfaceFlowContains(
  bodyRadiusMeters: number,
  flow: ContactFlowDescriptor,
  positionOrDirection: Readonly<Vec3>,
  marginMeters = 0,
): boolean {
  const direction = normalizeVec3(positionOrDirection);
  const center = scaleVec3(flow.centerDirection, bodyRadiusMeters);
  const acrossAxis = normalizeVec3(crossVec3(flow.centerDirection, flow.headingBodyFixed));
  const point = subVec3(scaleVec3(direction, bodyRadiusMeters), center);
  const px = dotVec3(point, flow.headingBodyFixed);
  const pz = dotVec3(point, acrossAxis);
  const corners = projectFootprint(bodyRadiusMeters, flow, center, acrossAxis);
  let winding = 0;
  for (let index = 0; index < corners.length; index += 1) {
    const a = corners[index]!;
    const b = corners[(index + 1) % corners.length]!;
    const cross = (b.x - a.x) * (pz - a.z) - (b.z - a.z) * (px - a.x);
    const tolerance = Math.max(0, marginMeters) * Math.hypot(b.x - a.x, b.z - a.z) + 1e-6;
    if (Math.abs(cross) <= tolerance) continue;
    const sign = Math.sign(cross);
    if (winding !== 0 && sign !== winding) return false;
    winding = sign;
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isFiniteVector(value: unknown): value is Vec3 {
  return isRecord(value) && typeof value.x === 'number' && Number.isFinite(value.x)
    && typeof value.y === 'number' && Number.isFinite(value.y)
    && typeof value.z === 'number' && Number.isFinite(value.z);
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * Cheap, sampling-free validation of a local convex liquid quad. Supply the
 * real mean body radius to check its conservative meter bounds; corner radii
 * alone include terrain elevation and cannot identify that datum exactly.
 */
export function isValidSurfaceFlowDescriptor(
  value: unknown,
  bodyRadiusMeters?: number,
): value is ContactFlowDescriptor {
  if (!isRecord(value) || typeof value.id !== 'string' || value.id.length === 0
    || (value.kind !== 'river' && value.kind !== 'lava')
    || (value.appearance !== undefined && value.appearance !== 'channel' && value.appearance !== 'cascade')
    || !isFiniteVector(value.centerDirection) || !isFiniteVector(value.headingBodyFixed)
    || !isPositiveFinite(value.halfLengthMeters) || !isPositiveFinite(value.halfWidthMeters)
    || (value.strength !== undefined && (typeof value.strength !== 'number' || !Number.isFinite(value.strength)))
    || (value.variation !== undefined && (typeof value.variation !== 'number' || !Number.isFinite(value.variation)))
    || !Array.isArray(value.cornersBodyFixedMeters) || value.cornersBodyFixedMeters.length !== 4
    || (bodyRadiusMeters !== undefined && !isPositiveFinite(bodyRadiusMeters))) return false;

  const centerDirection = value.centerDirection;
  const heading = value.headingBodyFixed;
  if (Math.abs(lengthVec3(centerDirection) - 1) > UNIT_AXIS_TOLERANCE
    || Math.abs(lengthVec3(heading) - 1) > UNIT_AXIS_TOLERANCE) return false;

  let minimumCornerRadius = Number.POSITIVE_INFINITY;
  for (const corner of value.cornersBodyFixedMeters) {
    if (!isFiniteVector(corner)) return false;
    const radius = lengthVec3(corner);
    if (!isPositiveFinite(radius) || dotVec3(corner, centerDirection) <= 0) return false;
    minimumCornerRadius = Math.min(minimumCornerRadius, radius);
  }
  const radius = bodyRadiusMeters ?? minimumCornerRadius;
  const tangentTolerance = UNIT_AXIS_TOLERANCE + (value.appearance === 'cascade'
    ? Math.min(0.01, LEGACY_CASCADE_HEADING_DISTANCE_METERS / radius) : 0);
  if (Math.abs(dotVec3(centerDirection, heading)) > tangentTolerance) return false;

  const flow = value as unknown as ContactFlowDescriptor;
  const center = scaleVec3(centerDirection, radius);
  const across = normalizeVec3(crossVec3(centerDirection, heading));
  const corners = projectFootprint(radius, flow, center, across);
  const boundsTolerance = Math.max(BOUNDS_TOLERANCE_METERS, radius * Number.EPSILON * 64);
  let minimumX = Number.POSITIVE_INFINITY;
  let maximumX = Number.NEGATIVE_INFINITY;
  let minimumZ = Number.POSITIVE_INFINITY;
  let maximumZ = Number.NEGATIVE_INFINITY;
  for (const point of corners) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.z)) return false;
    if (bodyRadiusMeters !== undefined
      && (Math.abs(point.x) > flow.halfLengthMeters + boundsTolerance
        || Math.abs(point.z) > flow.halfWidthMeters + boundsTolerance)) return false;
    minimumX = Math.min(minimumX, point.x);
    maximumX = Math.max(maximumX, point.x);
    minimumZ = Math.min(minimumZ, point.z);
    maximumZ = Math.max(maximumZ, point.z);
  }

  const span = Math.max(maximumX - minimumX, maximumZ - minimumZ);
  const areaTolerance = Math.max(1e-12, span * span * 1e-12);
  let winding = 0;
  let twiceArea = 0;
  for (let index = 0; index < corners.length; index += 1) {
    const a = corners[index]!;
    const b = corners[(index + 1) % corners.length]!;
    const c = corners[(index + 2) % corners.length]!;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    if (dx * dx + dz * dz <= 1e-16) return false;
    twiceArea += a.x * b.z - b.x * a.z;
    const turn = dx * (c.z - b.z) - dz * (c.x - b.x);
    if (Math.abs(turn) <= areaTolerance) continue;
    const sign = Math.sign(turn);
    if (winding !== 0 && sign !== winding) return false;
    winding = sign;
  }
  return winding !== 0 && Number.isFinite(twiceArea) && Math.abs(twiceArea) > areaTolerance;
}
