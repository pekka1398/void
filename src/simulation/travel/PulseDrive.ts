import type { PlanetDescriptor, StarDescriptor } from "../../universe/types";
import { FLIGHT_MODE_PROFILES } from "../ship/FlightModes";

/**
 * Physical destination framing, calibrated to the actual 2.85R Aurelia start.
 * These are canonical center distances, not a camera or displayed-range scale.
 */
export const PULSE_ARRIVAL_POLICY = Object.freeze({
  planetaryCenterDistanceRadii: 2.85,
  minimumPlanetaryClearanceMeters: 350_000,
  atmosphereHeightMultiplier: 1.7,
  ringOuterRadiusMultiplier: 1.1,
  stellarCenterDistanceRadii: 1.24,
});

/** Keep a whole world readable without ending inside its atmosphere or ring. */
export function planetaryPulseArrivalRadiusMeters(
  planet: Pick<PlanetDescriptor, "radiusMeters" | "atmosphere" | "ring">,
): number {
  return Math.max(
    planet.radiusMeters * PULSE_ARRIVAL_POLICY.planetaryCenterDistanceRadii,
    planet.radiusMeters + Math.max(
      PULSE_ARRIVAL_POLICY.minimumPlanetaryClearanceMeters,
      planet.atmosphere.heightMeters * PULSE_ARRIVAL_POLICY.atmosphereHeightMultiplier,
    ),
    (planet.ring?.outerRadiusMeters ?? 0) * PULSE_ARRIVAL_POLICY.ringOuterRadiusMultiplier,
  );
}

/** One policy is shared by pulse motion, chart guidance, and its truthful ETA. */
export function pulseArrivalRadiusMeters(target: PlanetDescriptor | StarDescriptor | undefined): number {
  if (!target) return FLIGHT_MODE_PROFILES.pulse.minimumCaptureRadiusMeters;
  return "atmosphere" in target
    ? planetaryPulseArrivalRadiusMeters(target)
    : target.radiusMeters * PULSE_ARRIVAL_POLICY.stellarCenterDistanceRadii;
}

/** The same small physical tolerance is used for arrival and already-near commands. */
export function pulseArrivalToleranceMeters(captureRadiusMeters: number): number {
  return Math.max(40, captureRadiusMeters * 0.000_000_5);
}

export function isWithinPulseArrival(distanceMeters: number, captureRadiusMeters: number): boolean {
  return distanceMeters <= captureRadiusMeters + pulseArrivalToleranceMeters(captureRadiusMeters);
}
