import { GRAVITATIONAL_CONSTANT, SECONDS_PER_YEAR, vec3, type Vec3 } from "../core";
import type { OrbitElements } from "./types";

const TAU = Math.PI * 2;

export function wrapAngle(radians: number): number {
  const wrapped = radians % TAU;
  return wrapped < 0 ? wrapped + TAU : wrapped;
}

/** Kepler period in SI units. */
export function orbitalPeriodSeconds(semiMajorAxisMeters: number, parentMassKg: number): number {
  if (!(semiMajorAxisMeters > 0) || !(parentMassKg > 0)) return SECONDS_PER_YEAR;
  return TAU * Math.sqrt(semiMajorAxisMeters ** 3 / (GRAVITATIONAL_CONSTANT * parentMassKg));
}

/** Newton iteration with a bounded bisection fallback near high eccentricity. */
export function solveKepler(meanAnomalyRadians: number, eccentricity: number): number {
  const anomaly = wrapAngle(meanAnomalyRadians);
  const safeEccentricity = Math.max(0, Math.min(eccentricity, 0.999_999));
  let estimate = safeEccentricity < 0.8 ? anomaly : Math.PI;

  for (let iteration = 0; iteration < 12; iteration += 1) {
    const residual = estimate - safeEccentricity * Math.sin(estimate) - anomaly;
    const derivative = 1 - safeEccentricity * Math.cos(estimate);
    if (Math.abs(residual) <= 1e-12) return estimate;
    if (Math.abs(derivative) < 1e-10) break;
    const next = estimate - residual / derivative;
    if (!Number.isFinite(next) || next < 0 || next > TAU) break;
    estimate = next;
  }

  let lower = 0;
  let upper = TAU;
  for (let iteration = 0; iteration < 52; iteration += 1) {
    estimate = (lower + upper) / 2;
    const residual = estimate - safeEccentricity * Math.sin(estimate) - anomaly;
    if (Math.abs(residual) <= 1e-12) return estimate;
    if (residual < 0) lower = estimate;
    else upper = estimate;
  }
  return estimate;
}

export function evaluateOrbit(elements: OrbitElements, timeSeconds: number): Vec3 {
  if (!(elements.semiMajorAxisMeters > 0) || !(elements.periodSeconds > 0)) return vec3();
  const meanAnomaly = elements.meanAnomalyAtEpochRadians + (TAU * timeSeconds) / elements.periodSeconds;
  const eccentricAnomaly = solveKepler(meanAnomaly, elements.eccentricity);
  const eccentricity = Math.max(0, Math.min(elements.eccentricity, 0.999_999));
  const inPlaneX = elements.semiMajorAxisMeters * (Math.cos(eccentricAnomaly) - eccentricity);
  const inPlaneZ = elements.semiMajorAxisMeters * Math.sqrt(1 - eccentricity ** 2) * Math.sin(eccentricAnomaly);

  const periCos = Math.cos(elements.argumentPeriapsisRadians);
  const periSin = Math.sin(elements.argumentPeriapsisRadians);
  const periX = inPlaneX * periCos - inPlaneZ * periSin;
  const periZ = inPlaneX * periSin + inPlaneZ * periCos;

  const inclinationCos = Math.cos(elements.inclinationRadians);
  const inclinationSin = Math.sin(elements.inclinationRadians);
  const inclinedZ = periZ * inclinationCos;
  const inclinedY = periZ * inclinationSin;

  const ascendingCos = Math.cos(elements.longitudeAscendingNodeRadians);
  const ascendingSin = Math.sin(elements.longitudeAscendingNodeRadians);
  return vec3(
    periX * ascendingCos - inclinedZ * ascendingSin,
    inclinedY,
    periX * ascendingSin + inclinedZ * ascendingCos,
  );
}

export function createCircularOrbit(
  semiMajorAxisMeters: number,
  parentMassKg: number,
  parentId: string,
  phaseRadians = 0,
): OrbitElements {
  return {
    semiMajorAxisMeters,
    eccentricity: 0,
    inclinationRadians: 0,
    longitudeAscendingNodeRadians: 0,
    argumentPeriapsisRadians: 0,
    meanAnomalyAtEpochRadians: phaseRadians,
    periodSeconds: orbitalPeriodSeconds(semiMajorAxisMeters, parentMassKg),
    parentId,
  };
}
