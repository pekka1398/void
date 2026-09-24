import type { GalacticAddress, Vec3 } from "../core";

export const UNIVERSE_GENERATOR_VERSION = 1;
export const PLANET_GENERATOR_VERSION = 2;
export const ATMOSPHERE_GENERATOR_VERSION = 1;
export const DEFAULT_UNIVERSE_SEED = "VOID-NEON-017";
export const HERO_SYSTEM_ID = "system-astris-prime";
export const HERO_PLANET_ID = `${HERO_SYSTEM_ID}:planet:1`;
export const CONTRAST_SYSTEM_ID = "system-vanta-reach";

export type StarSystemKind = "single" | "binary" | "triple";
export type SpectralType = "A" | "F" | "G" | "K" | "M";
export type PlanetArchetype =
  | "ocean"
  | "temperate"
  | "desert"
  | "volcanic"
  | "frozen"
  | "barren"
  | "ice-moon"
  | "gas-giant"
  | "ice-giant";

export interface OrbitElements {
  semiMajorAxisMeters: number;
  eccentricity: number;
  inclinationRadians: number;
  longitudeAscendingNodeRadians: number;
  argumentPeriapsisRadians: number;
  meanAnomalyAtEpochRadians: number;
  periodSeconds: number;
  parentId: string;
}

export interface StarDescriptor {
  id: string;
  systemId: string;
  name: string;
  seed: number;
  spectralType: SpectralType;
  spectralSubtype: number;
  temperatureKelvin: number;
  massKg: number;
  radiusMeters: number;
  luminositySolar: number;
  color: string;
  orbit?: OrbitElements;
}

export interface PlanetPalette {
  deep: string;
  shallow: string;
  land: string;
  highland: string;
  atmosphere: string;
  accent: string;
}

export type AtmosphereRegime = "airless" | "exosphere" | "thin" | "substantial";
export type PlanetCloudType = "none" | "water" | "water-ice" | "methane" | "volcanic-aerosol" | "ammonia";

export interface AtmosphereDescriptor {
  generatorVersion: number;
  regime: AtmosphereRegime;
  /** Approximate generated pressure at the solid surface or a giant's reference level, in pascals. */
  surfacePressurePascals: number;
  /** Bounded visual scattering coefficient, not a pressure or mass-density unit. */
  density: number;
  color: string;
  heightMeters: number;
  cloudCoverage: number;
  cloudType: PlanetCloudType;
  cloudBaseMeters: number;
  cloudTopMeters: number;
  cloudOpacityScale: number;
}

export interface RingDescriptor {
  innerRadiusMeters: number;
  outerRadiusMeters: number;
  color: string;
  opacity: number;
  tiltRadians: number;
}

export interface PlanetDescriptor {
  id: string;
  systemId: string;
  name: string;
  seed: number;
  archetype: PlanetArchetype;
  radiusMeters: number;
  massKg: number;
  orbit: OrbitElements;
  atmosphere: AtmosphereDescriptor;
  /** Signed normalized elevation: terrain samples below this threshold are ocean. */
  seaLevel: number;
  colors: PlanetPalette;
  ring?: RingDescriptor;
  moons: PlanetDescriptor[];
  rotationPeriodSeconds: number;
  axialTiltRadians: number;
  isLandable: boolean;
  surfaceGravity: number;
  generatorVersion: number;
  parentPlanetId?: string;
}

export interface StarSystem {
  id: string;
  name: string;
  seed: number;
  kind: StarSystemKind;
  position: GalacticAddress;
  stars: StarDescriptor[];
  planets: PlanetDescriptor[];
  showcase: boolean;
  binarySeparationMeters?: number;
  outerSeparationMeters?: number;
}

export interface BodyPose {
  id: string;
  systemId: string;
  kind: "star" | "planet" | "moon";
  position: GalacticAddress;
  localPositionMeters: Vec3;
  rotationRadians: number;
}

export interface SystemSnapshot {
  system: StarSystem;
  timeSeconds: number;
  stars: BodyPose[];
  planets: BodyPose[];
  moons: BodyPose[];
  poses: Map<string, BodyPose>;
}
