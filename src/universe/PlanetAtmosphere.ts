import { deriveSeed, GRAVITATIONAL_CONSTANT, SeededRandom } from "../core";
import type { AtmosphereDescriptor, AtmosphereRegime, PlanetArchetype, PlanetCloudType } from "./types";
import { ATMOSPHERE_GENERATOR_VERSION } from "./types";

export { ATMOSPHERE_GENERATOR_VERSION } from "./types";

export type LegacyAtmosphereDescriptor = Pick<AtmosphereDescriptor,
  "density" | "color" | "heightMeters" | "cloudCoverage">;

export interface PlanetAtmosphereEnvironment {
  /** Distance from the actual stellar/barycentric orbit, never a moon's planet-centered orbit. */
  stellarDistanceAu: number;
  /** Sum of the real host stars' luminosities; direct generator callers default to one Sun. */
  stellarLuminositySolar?: number;
}

export interface PlanetAtmosphereGenerationInput extends PlanetAtmosphereEnvironment {
  bodyId: string;
  seed: number;
  archetype: PlanetArchetype;
  radiusMeters: number;
  massKg: number;
  isMoon?: boolean;
}

const positiveFinite = (value: number): boolean => Number.isFinite(value) && value > 0;
const unitInterval = (value: number): boolean => Number.isFinite(value) && value >= 0 && value <= 1;
const clamp = (value: number, minimum: number, maximum: number): number => Math.max(minimum, Math.min(maximum, value));
const renderableRegime = (regime: AtmosphereRegime): boolean => regime === "thin" || regime === "substantial";
const cloudTypes: readonly PlanetCloudType[] = ["water", "water-ice", "methane", "volcanic-aerosol", "ammonia"];

interface AtmosphereChoice {
  regime: AtmosphereRegime;
  cloudType: PlanetCloudType;
  minimumPressure: number;
  maximumPressure: number;
  /** Preserve approved existing thick-world presentation independently of the new pressure estimate. */
  preserveLegacy?: boolean;
}

const NO_AIR: AtmosphereChoice = { regime: "airless", cloudType: "none", minimumPressure: 0, maximumPressure: 0 };
const TRACE_AIR: AtmosphereChoice = { regime: "exosphere", cloudType: "none", minimumPressure: 1e-10, maximumPressure: 0.03 };
const GAS_CONSTANT = 8.31446261815324;
/** Shared conservative clearance for the visible orbital and local cloud envelopes. */
export const PLANET_CLOUD_TERRAIN_CLEARANCE_METERS = 750;
const MINIMUM_CLOUD_BASE_METERS = 650;
const MINIMUM_CLOUD_THICKNESS_METERS = 900;
const MINIMUM_CLOUD_TOP_METERS = Math.max(
  MINIMUM_CLOUD_BASE_METERS + MINIMUM_CLOUD_THICKNESS_METERS,
  PLANET_CLOUD_TERRAIN_CLEARANCE_METERS + 800,
);

/** Fit a drawable band without changing the renderer's 750 m real-terrain clearance. */
function fitGeneratedCloudLayer(
  heightMeters: number,
  preserveLegacy: boolean,
  substantial: boolean,
): { baseMeters: number; topMeters: number } | undefined {
  if (!Number.isFinite(heightMeters) || heightMeters < MINIMUM_CLOUD_TOP_METERS) return undefined;
  const ceiling = preserveLegacy ? heightMeters
    : Math.min(heightMeters, Math.max(MINIMUM_CLOUD_TOP_METERS, heightMeters * 0.7));
  const preferredBase = preserveLegacy
    ? clamp(heightMeters * 0.0125, MINIMUM_CLOUD_BASE_METERS, 2_500)
    : clamp(heightMeters * 0.022, MINIMUM_CLOUD_BASE_METERS, 2_500);
  const baseMeters = Math.min(preferredBase, ceiling - MINIMUM_CLOUD_THICKNESS_METERS);
  const thickness = preserveLegacy
    ? clamp(heightMeters * 0.0325, 1_400, 4_350)
    : clamp(heightMeters * 0.031, MINIMUM_CLOUD_THICKNESS_METERS, substantial ? 3_600 : 2_200);
  return { baseMeters, topMeters: Math.min(ceiling, Math.max(MINIMUM_CLOUD_TOP_METERS, baseMeters + thickness)) };
}

function logRange(minimum: number, maximum: number, amount: number): number {
  return Math.exp(Math.log(minimum) + (Math.log(maximum) - Math.log(minimum)) * amount);
}

function chooseAtmosphere(
  input: PlanetAtmosphereGenerationInput,
  temperatureKelvin: number,
  escapeMetersPerSecond: number,
  gravity: number,
  inventory: number,
  retention: number,
  condensate: number,
): AtmosphereChoice {
  const icy = input.archetype === "frozen" || input.archetype === "ice-moon";
  // The escape-to-thermal-speed comparison is a retention screening rule, not
  // a Jeans-escape history, magnetic-field model, or thermochemical climate.
  const heavyRetention = escapeMetersPerSecond / Math.sqrt(3 * GAS_CONSTANT * temperatureKelvin / 0.028);
  const methaneRetention = escapeMetersPerSecond / Math.sqrt(3 * GAS_CONSTANT * temperatureKelvin / 0.016);
  const coldMethaneRetention = icy && temperatureKelvin <= 145 && input.radiusMeters >= 1_000_000 &&
    gravity >= 0.55 && escapeMetersPerSecond >= 2_200 && methaneRetention >= 6.5;

  if (input.isMoon) {
    // Most small rocky/icy satellites have no ordinary collisional atmosphere.
    // Rare volatile-rich, cold, retentive moons retain a Titan-like exception.
    if (coldMethaneRetention && inventory < 0.055) {
      return { regime: "substantial", cloudType: "methane", minimumPressure: 35_000, maximumPressure: 190_000 };
    }
    const thinRetentionChance = clamp(0.08 + (escapeMetersPerSecond - 2_200) / 18_000, 0.08, 0.28);
    if (icy && temperatureKelvin <= 210 && gravity >= 0.55 && escapeMetersPerSecond >= 2_000 &&
        heavyRetention >= 6 && retention < thinRetentionChance) {
      return { regime: "thin", cloudType: condensate < 0.58
        ? temperatureKelvin <= 150 ? "methane" : "water-ice" : "none",
      minimumPressure: 120, maximumPressure: 19_000 };
    }
    if (!icy && temperatureKelvin <= 260 && gravity >= 1 && escapeMetersPerSecond >= 3_000 &&
        heavyRetention >= 8 && inventory < 0.045) {
      return { regime: "thin", cloudType: "none", minimumPressure: 80, maximumPressure: 4_500 };
    }
    return icy
      ? escapeMetersPerSecond >= 700 && temperatureKelvin < 550 ? TRACE_AIR : NO_AIR
      : escapeMetersPerSecond >= 1_300 && temperatureKelvin < 750 && retention < 0.55 ? TRACE_AIR : NO_AIR;
  }

  switch (input.archetype) {
    case "gas-giant":
      return { regime: "substantial", cloudType: "ammonia", minimumPressure: 100_000, maximumPressure: 350_000, preserveLegacy: true };
    case "ice-giant":
      return { regime: "substantial", cloudType: "methane", minimumPressure: 100_000, maximumPressure: 350_000, preserveLegacy: true };
    case "ocean":
    case "temperate":
      // The already generated surface archetype establishes a volatile-bearing
      // world. Do not regenerate its approved terrain or ocean to classify air.
      return { regime: "substantial", cloudType: "water", minimumPressure: 55_000, maximumPressure: 220_000, preserveLegacy: true };
    case "volcanic":
      if (escapeMetersPerSecond >= 3_500 && temperatureKelvin < 1_300) {
        return { regime: "substantial", cloudType: "volcanic-aerosol", minimumPressure: 35_000, maximumPressure: 300_000, preserveLegacy: true };
      }
      return escapeMetersPerSecond >= 2_200 && heavyRetention >= 4
        ? { regime: "thin", cloudType: "volcanic-aerosol", minimumPressure: 120, maximumPressure: 12_000 }
        : escapeMetersPerSecond >= 1_200 ? TRACE_AIR : NO_AIR;
    case "desert":
      if (escapeMetersPerSecond < 2_500 || temperatureKelvin > 1_250) return TRACE_AIR;
      if (escapeMetersPerSecond >= 7_000 && heavyRetention >= 9 && temperatureKelvin <= 650 && inventory < 0.32) {
        return { regime: "substantial", cloudType: "none", minimumPressure: 30_000, maximumPressure: 130_000, preserveLegacy: true };
      }
      return { regime: "thin", cloudType: temperatureKelvin < 240 && condensate < 0.2 ? "water-ice" : "none",
        minimumPressure: 350, maximumPressure: 16_000 };
    case "frozen":
    case "ice-moon":
      if (coldMethaneRetention && inventory < 0.1) {
        return { regime: "substantial", cloudType: "methane", minimumPressure: 35_000, maximumPressure: 190_000 };
      }
      if (heavyRetention >= 5.5 && temperatureKelvin <= 280 && escapeMetersPerSecond >= 2_500) {
        if (escapeMetersPerSecond >= 5_000 && temperatureKelvin <= 200 && retention < 0.28) {
          return { regime: "substantial", cloudType: "water-ice", minimumPressure: 30_000, maximumPressure: 140_000 };
        }
        return { regime: "thin", cloudType: condensate < 0.55
          ? temperatureKelvin <= 150 ? "methane" : "water-ice" : "none",
        minimumPressure: 350, maximumPressure: 22_000 };
      }
      return escapeMetersPerSecond >= 1_000 && temperatureKelvin < 800 ? TRACE_AIR : NO_AIR;
    case "barren":
      if (escapeMetersPerSecond >= 3_800 && heavyRetention >= 7.5 && temperatureKelvin < 600 && inventory < 0.24) {
        return { regime: "thin", cloudType: "none", minimumPressure: 80, maximumPressure: 8_000 };
      }
      return escapeMetersPerSecond >= 2_200 && temperatureKelvin < 750 && retention < 0.65 ? TRACE_AIR : NO_AIR;
  }
}

/**
 * A separately seeded atmosphere pass. The caller has already consumed the
 * exact two legacy atmosphere draws from its planet/moon stream; this function
 * cannot change terrain, moon count, rotation, rings, or orbital identities.
 */
export function generatePlanetAtmosphere(
  input: PlanetAtmosphereGenerationInput,
  legacy: LegacyAtmosphereDescriptor,
): AtmosphereDescriptor {
  const luminosity = input.stellarLuminositySolar ?? 1;
  if (!input.bodyId || !Number.isFinite(input.seed) || !positiveFinite(input.radiusMeters) ||
      !positiveFinite(input.massKg) || !positiveFinite(input.stellarDistanceAu) || !positiveFinite(luminosity) ||
      !unitInterval(legacy.density) || !Number.isFinite(legacy.heightMeters) || legacy.heightMeters < 0 ||
      !unitInterval(legacy.cloudCoverage) || typeof legacy.color !== "string" || legacy.color.length === 0) {
    throw new RangeError("Atmosphere generation needs finite physical body, star, and legacy parameters.");
  }
  const random = new SeededRandom(deriveSeed(input.seed, "planet-atmosphere", ATMOSPHERE_GENERATOR_VERSION));
  const inventory = random.next();
  const retention = random.next();
  const condensate = random.next();
  const pressureVariation = random.next();
  const profileVariation = random.next();
  // Zero-albedo-equivalent stellar equilibrium proxy, using actual summed host
  // luminosity and the planet's stellar orbit. It is deliberately not claimed
  // to be a solved surface temperature or atmospheric escape simulation.
  const temperatureKelvin = clamp(278 * (luminosity / input.stellarDistanceAu ** 2) ** 0.25, 20, 2_000);
  const gravity = GRAVITATIONAL_CONSTANT * input.massKg / input.radiusMeters ** 2;
  const escapeMetersPerSecond = Math.sqrt(2 * GRAVITATIONAL_CONSTANT * input.massKg / input.radiusMeters);
  const choice = chooseAtmosphere(input, temperatureKelvin, escapeMetersPerSecond, gravity, inventory, retention, condensate);
  const pressure = choice.regime === "airless" ? 0 : logRange(choice.minimumPressure, choice.maximumPressure, pressureVariation);

  if (!renderableRegime(choice.regime)) {
    return { generatorVersion: ATMOSPHERE_GENERATOR_VERSION, regime: choice.regime,
      surfacePressurePascals: pressure, density: 0, color: legacy.color, heightMeters: 0,
      cloudCoverage: 0, cloudType: "none", cloudBaseMeters: 0, cloudTopMeters: 0, cloudOpacityScale: 0 };
  }

  const substantial = choice.regime === "substantial";
  const density = choice.preserveLegacy ? legacy.density : substantial
    ? clamp(0.25 + Math.log10(pressure / 30_000) * 0.32, 0.25, 0.72)
    : clamp(0.024 + Math.log10(pressure / 100 + 1) * 0.073, 0.035, 0.23);
  const maximumHeight = Math.min(250_000, input.radiusMeters * 0.14);
  const meanMolarMass = input.archetype === "desert" || input.archetype === "barren" ||
    input.archetype === "volcanic" ? 0.044 : 0.028;
  const scaleHeight = GAS_CONSTANT * temperatureKelvin / (meanMolarMass * Math.max(0.03, gravity));
  const heightMeters = choice.preserveLegacy ? legacy.heightMeters : Math.round(clamp(
    scaleHeight * (5.2 + profileVariation * 1.6), Math.min(8_000, maximumHeight), maximumHeight));
  const layer = choice.cloudType === "none" ? undefined
    : fitGeneratedCloudLayer(heightMeters, choice.preserveLegacy === true, substantial);
  const cloudless = layer === undefined;
  const cloudCoverage = cloudless ? 0 : choice.preserveLegacy ? legacy.cloudCoverage : substantial
    ? clamp(0.14 + profileVariation * 0.25, 0, 0.65)
    : clamp(0.022 + profileVariation * 0.065, 0, 0.12);
  // Approved thick-world bands stay exact. New bands must leave actual room
  // for the shared orbital/local formations above their terrain-clearance floor.
  const cloudBaseMeters = layer?.baseMeters ?? 0;
  const cloudTopMeters = layer?.topMeters ?? 0;
  const cloudOpacityScale = cloudless ? 0 : choice.preserveLegacy ? 1 : substantial
    ? clamp(0.62 + profileVariation * 0.24, 0, 1)
    : clamp(0.10 + pressure / 22_000 * 0.17 + profileVariation * 0.055, 0.10, 0.33);

  return { generatorVersion: ATMOSPHERE_GENERATOR_VERSION, regime: choice.regime,
    surfacePressurePascals: pressure, density, color: legacy.color, heightMeters,
    cloudCoverage, cloudType: cloudless ? "none" : choice.cloudType, cloudBaseMeters, cloudTopMeters, cloudOpacityScale };
}

/** Molecular scattering needs real air; a trace exosphere is not a normal sky or fog layer. */
export function hasRenderableAtmosphere(atmosphere: Readonly<AtmosphereDescriptor> | null | undefined): boolean {
  return Boolean(atmosphere && atmosphere.generatorVersion === ATMOSPHERE_GENERATOR_VERSION &&
    renderableRegime(atmosphere.regime) && positiveFinite(atmosphere.surfacePressurePascals) &&
    positiveFinite(atmosphere.heightMeters) && positiveFinite(atmosphere.density) &&
    unitInterval(atmosphere.density));
}

/** Cloud geometry, weather, shadows, and traversal use this exact complete physical layer. */
export function supportsAtmosphericClouds(atmosphere: Readonly<AtmosphereDescriptor> | null | undefined): boolean {
  return Boolean(atmosphere && hasRenderableAtmosphere(atmosphere) && cloudTypes.includes(atmosphere.cloudType) &&
    positiveFinite(atmosphere.cloudCoverage) && unitInterval(atmosphere.cloudCoverage) &&
    positiveFinite(atmosphere.cloudOpacityScale) && unitInterval(atmosphere.cloudOpacityScale) &&
    positiveFinite(atmosphere.cloudBaseMeters) && positiveFinite(atmosphere.cloudTopMeters) &&
    atmosphere.cloudTopMeters > atmosphere.cloudBaseMeters && atmosphere.cloudTopMeters <= atmosphere.heightMeters);
}

export function atmosphereSurfaceDensity(atmosphere: Readonly<AtmosphereDescriptor> | null | undefined): number {
  return atmosphere && hasRenderableAtmosphere(atmosphere) ? atmosphere.density : 0;
}

/** The existing bounded barometric presentation, independent of whether clouds can form. */
export function sampleAtmosphereDensity(
  atmosphere: Readonly<AtmosphereDescriptor> | null | undefined,
  altitudeMeters: number,
): number {
  const density = atmosphereSurfaceDensity(atmosphere);
  if (!atmosphere || density === 0 || !Number.isFinite(altitudeMeters)) return 0;
  const altitude = Math.max(0, altitudeMeters);
  const height = atmosphere.heightMeters;
  const boundaryStart = height * 0.72;
  const boundary = Math.max(0, Math.min(1, (altitude - boundaryStart) / (height - boundaryStart)));
  return density * Math.exp(-altitude / (height * 0.22)) *
    (1 - boundary * boundary * (3 - 2 * boundary));
}
