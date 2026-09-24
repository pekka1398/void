/** Conservative first-slice orbital filters, not a full n-body integrator. */
export function isStableCircumbinaryOrbit(
  planetSemiMajorAxisMeters: number,
  binarySeparationMeters: number,
  binaryEccentricity = 0,
): boolean {
  return planetSemiMajorAxisMeters > binarySeparationMeters * (2.8 + binaryEccentricity * 3.5);
}

export function isStableCircumstellarOrbit(
  planetSemiMajorAxisMeters: number,
  binarySeparationMeters: number,
  binaryEccentricity = 0,
): boolean {
  return planetSemiMajorAxisMeters < binarySeparationMeters * Math.max(0.08, 0.35 - binaryEccentricity * 0.3);
}

export function isStableHierarchicalTriple(
  innerSeparationMeters: number,
  outerSeparationMeters: number,
  outerEccentricity = 0,
): boolean {
  if (!(innerSeparationMeters > 0)) return false;
  return outerSeparationMeters / innerSeparationMeters > 5 * (1 + outerEccentricity);
}

export function haveStablePlanetSpacing(innerAxisMeters: number, outerAxisMeters: number): boolean {
  return outerAxisMeters > innerAxisMeters * 1.25;
}
