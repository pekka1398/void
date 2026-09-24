import { AU_METERS, SPEED_OF_LIGHT } from "../../core";

export type FlightMode = "cruise" | "boost" | "pulse" | "hyperdrive";
export type FlightPhase =
  | "idle"
  | "launching"
  | "clearing"
  | "aligning"
  | "spooling"
  | "cruising"
  | "braking";

export interface FlightModeProfile {
  maximumSpeedMetersPerSecond: number;
  accelerationMetersPerSecondSquared: number;
  brakingMetersPerSecondSquared: number;
  spoolSeconds: number;
  minimumCaptureRadiusMeters: number;
}

/** Deliberate flight-assist damping while local thrust is completely released. */
export const MANUAL_COAST_HALF_LIFE_SECONDS = 6;
/** Settle imperceptible residual motion instead of keeping an endless numerical drift. */
export const MANUAL_COAST_STOP_SPEED_METERS_PER_SECOND = 0.05;

export const FLIGHT_MODE_PROFILES: Record<FlightMode, FlightModeProfile> = {
  cruise: {
    maximumSpeedMetersPerSecond: 120_000,
    accelerationMetersPerSecondSquared: 85_000,
    brakingMetersPerSecondSquared: 165_000,
    spoolSeconds: 0,
    minimumCaptureRadiusMeters: 25,
  },
  boost: {
    maximumSpeedMetersPerSecond: 1_800_000,
    accelerationMetersPerSecondSquared: 1_650_000,
    brakingMetersPerSecondSquared: 2_650_000,
    spoolSeconds: 0,
    minimumCaptureRadiusMeters: 250,
  },
  pulse: {
    maximumSpeedMetersPerSecond: 300 * SPEED_OF_LIGHT,
    accelerationMetersPerSecondSquared: 240 * SPEED_OF_LIGHT,
    brakingMetersPerSecondSquared: 320 * SPEED_OF_LIGHT,
    spoolSeconds: 0.36,
    minimumCaptureRadiusMeters: 28_000,
  },
  hyperdrive: {
    maximumSpeedMetersPerSecond: 32_000_000 * SPEED_OF_LIGHT,
    accelerationMetersPerSecondSquared: 28_000_000 * SPEED_OF_LIGHT,
    brakingMetersPerSecondSquared: 36_000_000 * SPEED_OF_LIGHT,
    spoolSeconds: 0.86,
    minimumCaptureRadiusMeters: 0.34 * AU_METERS,
  },
};

export function isFasterThanLight(mode: FlightMode): boolean {
  return mode === "pulse" || mode === "hyperdrive";
}

export function moveToward(current: number, target: number, maximumChange: number): number {
  if (current < target) return Math.min(current + maximumChange, target);
  return Math.max(current - maximumChange, target);
}
