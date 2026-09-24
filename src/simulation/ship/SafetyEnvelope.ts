import { addVec3, dotVec3, scaleVec3, subVec3, type Vec3 } from "../../core";

export interface SafetySphere {
  id: string;
  center: Vec3;
  radiusMeters: number;
  kind: "star" | "planet" | "moon";
  landable: boolean;
}

export interface SweptCollision {
  sphere: SafetySphere;
  fraction: number;
  position: Vec3;
}

/** First segment/sphere entry; returns zero when the segment starts inside. */
export function segmentSphereIntersection(start: Vec3, end: Vec3, center: Vec3, radiusMeters: number): number | undefined {
  const displacement = subVec3(end, start);
  const relativeStart = subVec3(start, center);
  const squaredLength = dotVec3(displacement, displacement);
  const startDistanceSquared = dotVec3(relativeStart, relativeStart);
  const radiusSquared = radiusMeters * radiusMeters;

  if (startDistanceSquared <= radiusSquared) return 0;
  if (squaredLength <= Number.EPSILON) return undefined;

  const projection = -dotVec3(relativeStart, displacement) / squaredLength;
  const closestFraction = Math.max(0, Math.min(1, projection));
  const closest = addVec3(relativeStart, scaleVec3(displacement, closestFraction));
  const closestSquared = dotVec3(closest, closest);
  if (closestSquared > radiusSquared) return undefined;

  const halfChordFraction = Math.sqrt(Math.max(0, radiusSquared - closestSquared) / squaredLength);
  const entry = closestFraction - halfChordFraction;
  return entry >= 0 && entry <= 1 ? entry : undefined;
}

export function findFirstSweptCollision(start: Vec3, end: Vec3, spheres: readonly SafetySphere[]): SweptCollision | undefined {
  let collision: SweptCollision | undefined;
  const displacement = subVec3(end, start);
  for (const sphere of spheres) {
    const fraction = segmentSphereIntersection(start, end, sphere.center, sphere.radiusMeters);
    if (fraction === undefined || (collision !== undefined && fraction >= collision.fraction)) continue;
    collision = { sphere, fraction, position: addVec3(start, scaleVec3(displacement, fraction)) };
  }
  return collision;
}

export function maximumSafeBrakingSpeed(distanceMeters: number, decelerationMetersPerSecondSquared: number): number {
  return Math.sqrt(Math.max(0, 2 * decelerationMetersPerSecondSquared * Math.max(0, distanceMeters)));
}
