import type { GalacticAddress, Vec3 } from "../../core";
import type { FlightMode, FlightPhase } from "./FlightModes";

export type FlightInputAction =
  | "accelerate"
  | "brake"
  | "forward"
  | "backward"
  | "turnLeft"
  | "turnRight"
  | "pitchUp"
  | "pitchDown"
  | "rollLeft"
  | "rollRight"
  | "ascend"
  | "descend"
  | "boost";

export type FlightInputState = Record<FlightInputAction, boolean>;

/** Surface choreography is independent of the cruise/boost/FTL drive state. */
export type SurfacePhase =
  | "airborne"
  | "landing-armed"
  | "flare"
  | "touchdown-settle"
  | "parked"
  | "takeoff-spool"
  | "takeoff-rise"
  | "takeoff-climb";

/** A real authored landing foot resting on the committed body-fixed ground. */
export interface SurfacePadContact {
  padId: string;
  bodyFixedPointMeters: Vec3;
  bodyFixedNormal: Vec3;
  compressionMeters: number;
}

/** The physical ship origin and heading, not a camera-relative display offset. */
export interface ParkedShipAnchor {
  bodyId: string;
  bodyFixedOriginMeters: Vec3;
  bodyFixedForward: Vec3;
  supportNormalBodyFixed: Vec3;
  padContacts: SurfacePadContact[];
  surfaceKitVersion: number;
}

export interface BodyFixedLandingAnchor {
  bodyId: string;
  surfaceDirection: Vec3;
  altitudeMeters: number;
  latitudeRadians: number;
  longitudeRadians: number;
}

export interface ShipState {
  /** Double-precision meters in the current star system's barycentric frame. */
  position: Vec3;
  /** Canonical bigint-cell position; remains continuous across system changes. */
  address: GalacticAddress;
  velocity: Vec3;
  forward: Vec3;
  /** Smooth altitude-aware camera/steering up; transitions from world +Y to true body radial. */
  referenceUp: Vec3;
  /** Exact current nearest-landable-body outward normal, or world +Y in deep space. */
  surfaceUp: Vec3;
  /** Continuous 0..1 influence of the current body's radial frame. */
  surfaceInfluence: number;
  yaw: number;
  pitch: number;
  roll: number;
  speedMetersPerSecond: number;
  mode: FlightMode;
  phase: FlightPhase;
  systemId: string;
  targetId?: string;
  surfacePhase: SurfacePhase;
  parkedAnchor?: ParkedShipAnchor;
  landed: boolean;
  landedBodyId?: string;
  landedAnchor?: BodyFixedLandingAnchor;
  throttle: number;
  spoolProgress: number;
  altitudeMeters?: number;
  nearestBodyId?: string;
  travelProgress: number;
}

export function emptyFlightInput(): FlightInputState {
  return {
    accelerate: false,
    brake: false,
    forward: false,
    backward: false,
    turnLeft: false,
    turnRight: false,
    pitchUp: false,
    pitchDown: false,
    rollLeft: false,
    rollRight: false,
    ascend: false,
    descend: false,
    boost: false,
  };
}

export interface SerializedFlightState {
  position: { cell: [string, string, string]; localMeters: Vec3 };
  velocity: Vec3;
  yaw: number;
  pitch: number;
  systemId: string;
  targetId?: string;
  landedAnchor?: BodyFixedLandingAnchor;
}
