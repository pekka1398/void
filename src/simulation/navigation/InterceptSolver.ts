import { distanceVec3, lengthVec3, subVec3, type Vec3 } from "../../core";

export function estimateArrivalSeconds(
  distanceMeters: number,
  currentSpeedMetersPerSecond: number,
  maximumSpeedMetersPerSecond: number,
  accelerationMetersPerSecondSquared: number,
  brakingMetersPerSecondSquared = accelerationMetersPerSecondSquared,
): number {
  const remaining = Math.max(0, distanceMeters);
  if (remaining === 0) return 0;
  if (!(maximumSpeedMetersPerSecond > 0) || !(accelerationMetersPerSecondSquared > 0)) return Number.POSITIVE_INFINITY;

  const initial = Math.max(0, Math.min(currentSpeedMetersPerSecond, maximumSpeedMetersPerSecond));
  const accelerationDistance = Math.max(0, (maximumSpeedMetersPerSecond ** 2 - initial ** 2) / (2 * accelerationMetersPerSecondSquared));
  const brakingDistance = maximumSpeedMetersPerSecond ** 2 / (2 * brakingMetersPerSecondSquared);

  if (accelerationDistance + brakingDistance <= remaining) {
    const accelerateTime = (maximumSpeedMetersPerSecond - initial) / accelerationMetersPerSecondSquared;
    const cruiseTime = (remaining - accelerationDistance - brakingDistance) / maximumSpeedMetersPerSecond;
    const brakeTime = maximumSpeedMetersPerSecond / brakingMetersPerSecondSquared;
    return accelerateTime + cruiseTime + brakeTime;
  }

  const peakSquared = Math.max(0, (
    2 * remaining + initial ** 2 / accelerationMetersPerSecondSquared
  ) / (1 / accelerationMetersPerSecondSquared + 1 / brakingMetersPerSecondSquared));
  const peak = Math.min(maximumSpeedMetersPerSecond, Math.sqrt(peakSquared));
  return Math.max(0, (peak - initial) / accelerationMetersPerSecondSquared) + peak / brakingMetersPerSecondSquared;
}

/** Constant-velocity lead estimate, clamped to a useful bounded horizon. */
export function predictIntercept(
  shipPosition: Vec3,
  targetPosition: Vec3,
  targetVelocityMetersPerSecond: Vec3,
  shipSpeedMetersPerSecond: number,
  maximumHorizonSeconds = 120,
): Vec3 {
  const distance = distanceVec3(shipPosition, targetPosition);
  const relativeTargetSpeed = lengthVec3(targetVelocityMetersPerSecond);
  const closure = Math.max(1, shipSpeedMetersPerSecond - relativeTargetSpeed);
  const leadSeconds = Math.min(maximumHorizonSeconds, distance / closure);
  return {
    x: targetPosition.x + targetVelocityMetersPerSecond.x * leadSeconds,
    y: targetPosition.y + targetVelocityMetersPerSecond.y * leadSeconds,
    z: targetPosition.z + targetVelocityMetersPerSecond.z * leadSeconds,
  };
}

export function headingToTarget(shipPosition: Vec3, targetPosition: Vec3): { yawRadians: number; pitchRadians: number } {
  const direction = subVec3(targetPosition, shipPosition);
  const horizontal = Math.hypot(direction.x, direction.z);
  // Three.js cameras face -Z; a positive Y rotation points toward negative X.
  return { yawRadians: Math.atan2(-direction.x, -direction.z), pitchRadians: Math.atan2(direction.y, horizontal) };
}
