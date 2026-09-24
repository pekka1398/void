import {
  AU_METERS,
  deriveSeed,
  EARTH_MASS_KG,
  EARTH_RADIUS_METERS,
  GRAVITATIONAL_CONSTANT,
  SECONDS_PER_DAY,
  SeededRandom,
} from "../core";
import { orbitalPeriodSeconds } from "./OrbitPropagator";
import { generatePlanetAtmosphere, type PlanetAtmosphereEnvironment, type PlanetAtmosphereGenerationInput } from "./PlanetAtmosphere";
import type { AtmosphereDescriptor, OrbitElements, PlanetArchetype, PlanetDescriptor, PlanetPalette, RingDescriptor } from "./types";
import { PLANET_GENERATOR_VERSION } from "./types";

const PALETTES: Record<PlanetArchetype, PlanetPalette> = {
  ocean: { deep: "#07304c", shallow: "#08c9d1", land: "#402358", highland: "#7761c2", atmosphere: "#52eaff", accent: "#ff47bd" },
  temperate: { deep: "#102c51", shallow: "#13b8ae", land: "#395f68", highland: "#af93cd", atmosphere: "#80eaff", accent: "#78efc4" },
  desert: { deep: "#5b243c", shallow: "#9f5551", land: "#dd8556", highland: "#f3c28a", atmosphere: "#ffac77", accent: "#ff64a5" },
  volcanic: { deep: "#210c24", shallow: "#712042", land: "#382044", highland: "#873252", atmosphere: "#ff6380", accent: "#ff9a4b" },
  frozen: { deep: "#162744", shallow: "#4589b8", land: "#8dbbdc", highland: "#e2efff", atmosphere: "#a2ddff", accent: "#93f4ff" },
  barren: { deep: "#1a1829", shallow: "#403147", land: "#655366", highland: "#a38c89", atmosphere: "#a085b5", accent: "#f3a578" },
  "ice-moon": { deep: "#202638", shallow: "#395c7a", land: "#7a9db6", highland: "#dcefff", atmosphere: "#8ebfff", accent: "#c8e7ff" },
  "gas-giant": { deep: "#2f133f", shallow: "#704389", land: "#ae638d", highland: "#e9a8b1", atmosphere: "#da8cca", accent: "#ffbc80" },
  "ice-giant": { deep: "#10264b", shallow: "#326195", land: "#529bc1", highland: "#afd8ec", atmosphere: "#6cdcff", accent: "#b48fff" },
};

const ROCKY_ARCHETYPES: PlanetArchetype[] = ["temperate", "ocean", "desert", "frozen", "volcanic", "barren"];
const MOON_ARCHETYPES: PlanetArchetype[] = ["barren", "ice-moon", "frozen"];

export function planetPalette(archetype: PlanetArchetype): PlanetPalette {
  return { ...PALETTES[archetype] };
}

export function selectPlanetArchetype(random: SeededRandom, orbitalDistanceAu: number): PlanetArchetype {
  const rarity = random.next();
  if (orbitalDistanceAu > 2.7 && rarity < 0.42) return rarity < 0.25 ? "gas-giant" : "ice-giant";
  if (orbitalDistanceAu < 0.34) return rarity < 0.64 ? "volcanic" : "barren";
  if (orbitalDistanceAu > 3.4) return rarity < 0.63 ? "frozen" : "ice-moon";
  if (orbitalDistanceAu > 1.8 && rarity < 0.44) return "frozen";
  return random.pick(ROCKY_ARCHETYPES);
}

function createAtmosphere(
  archetype: PlanetArchetype,
  colors: PlanetPalette,
  random: SeededRandom,
  context: Omit<PlanetAtmosphereGenerationInput, "archetype">,
): AtmosphereDescriptor {
  const densityByArchetype: Record<PlanetArchetype, number> = {
    ocean: 0.92,
    temperate: 0.76,
    desert: 0.39,
    volcanic: 0.66,
    frozen: 0.26,
    barren: 0.035,
    "ice-moon": 0.07,
    "gas-giant": 1,
    "ice-giant": 0.94,
  };
  const density = Math.min(1, densityByArchetype[archetype] * random.range(0.88, 1.12));
  // These remain the exact two legacy draws in the original body stream.
  // Classification uses its own versioned seed and cannot shift later values.
  return generatePlanetAtmosphere({ ...context, archetype }, {
    density,
    color: colors.atmosphere,
    heightMeters: Math.round((42_000 + density * 94_000) * random.range(0.85, 1.15)),
    cloudCoverage: Math.max(0, Math.min(0.9, density * (archetype === "ocean" ? 0.71 : 0.4))),
  });
}

function ringDescriptor(radiusMeters: number, random: SeededRandom, color?: string): RingDescriptor {
  const innerRadiusMeters = radiusMeters * random.range(1.38, 1.65);
  return {
    innerRadiusMeters,
    outerRadiusMeters: innerRadiusMeters * random.range(1.35, 1.72),
    color: color ?? random.pick(["#ff3fbe", "#9878ff", "#62dfff", "#f3aa79"]),
    opacity: random.range(0.42, 0.73),
    tiltRadians: random.range(0.08, 0.34),
  };
}

export interface PlanetGenerationOptions {
  archetype?: PlanetArchetype;
  name?: string;
  radiusMeters?: number;
  seaLevel?: number;
  ring?: boolean;
  ringColor?: string;
  orbitalDistanceAu: number;
  /** Actual total luminosity of the host stars; standalone callers default to one Sun. */
  stellarLuminositySolar?: number;
  parentMassKg: number;
  parentId?: string;
  moonCount?: number;
  phaseRadians?: number;
}

export function generatePlanet(
  systemId: string,
  systemSeed: number,
  index: number,
  options: PlanetGenerationOptions,
): PlanetDescriptor {
  const seed = deriveSeed(systemSeed, "planet", index);
  const random = new SeededRandom(seed);
  const archetype = options.archetype ?? selectPlanetArchetype(random, options.orbitalDistanceAu);
  const gaseous = archetype === "gas-giant" || archetype === "ice-giant";
  const radiusMultiplier = gaseous ? random.range(4.5, 8.5) : random.range(0.47, 1.3);
  const radiusMeters = options.radiusMeters ?? Math.round(EARTH_RADIUS_METERS * radiusMultiplier);
  const massMultiplier = gaseous ? radiusMultiplier ** 2.1 : radiusMultiplier ** 3 * random.range(0.74, 1.28);
  const massKg = EARTH_MASS_KG * massMultiplier;
  const semiMajorAxisMeters = options.orbitalDistanceAu * AU_METERS;
  const parentId = options.parentId ?? systemId;
  const atmosphereEnvironment: PlanetAtmosphereEnvironment = {
    stellarDistanceAu: options.orbitalDistanceAu,
    stellarLuminositySolar: options.stellarLuminositySolar ?? 1,
  };

  const orbit: OrbitElements = {
    semiMajorAxisMeters,
    eccentricity: random.range(0.002, gaseous ? 0.035 : 0.075),
    inclinationRadians: random.range(-0.055, 0.055),
    longitudeAscendingNodeRadians: random.range(0, Math.PI * 2),
    argumentPeriapsisRadians: random.range(0, Math.PI * 2),
    meanAnomalyAtEpochRadians: options.phaseRadians ?? random.range(0, Math.PI * 2),
    periodSeconds: orbitalPeriodSeconds(semiMajorAxisMeters, options.parentMassKg),
    parentId,
  };

  const colors = planetPalette(archetype);
  const seaLevelByArchetype: Record<PlanetArchetype, number> = {
    ocean: 0.14,
    temperate: 0.025,
    desert: -0.2,
    volcanic: -0.27,
    frozen: -0.035,
    barren: -0.32,
    "ice-moon": -0.19,
    "gas-giant": -1,
    "ice-giant": -1,
  };

  const planet: PlanetDescriptor = {
    id: `${systemId}:planet:${index}`,
    systemId,
    name: options.name ?? `${String.fromCharCode(98 + index).toUpperCase()}-${random.int(10, 99)}`,
    seed,
    archetype,
    radiusMeters,
    massKg,
    orbit,
    atmosphere: createAtmosphere(archetype, colors, random, {
      ...atmosphereEnvironment, bodyId: `${systemId}:planet:${index}`, seed, radiusMeters, massKg,
    }),
    seaLevel: options.seaLevel ?? seaLevelByArchetype[archetype],
    colors,
    moons: [],
    rotationPeriodSeconds: random.range(0.45, 2.6) * SECONDS_PER_DAY,
    axialTiltRadians: random.range(-0.42, 0.42),
    isLandable: !gaseous,
    surfaceGravity: (GRAVITATIONAL_CONSTANT * massKg) / (radiusMeters * radiusMeters),
    generatorVersion: PLANET_GENERATOR_VERSION,
  };

  if (options.ring ?? (gaseous ? random.chance(0.52) : random.chance(0.11))) {
    planet.ring = ringDescriptor(radiusMeters, random, options.ringColor);
  }

  const moonCount = options.moonCount ?? (gaseous ? random.int(1, 3) : random.chance(0.25) ? 1 : 0);
  for (let moonIndex = 0; moonIndex < moonCount; moonIndex += 1) {
    planet.moons.push(generateMoon(planet, moonIndex, atmosphereEnvironment));
  }
  return planet;
}

export function generateMoon(
  parent: PlanetDescriptor,
  index: number,
  atmosphereEnvironment: PlanetAtmosphereEnvironment = {
    stellarDistanceAu: parent.orbit.semiMajorAxisMeters / AU_METERS,
    stellarLuminositySolar: 1,
  },
): PlanetDescriptor {
  const seed = deriveSeed(parent.seed, "moon", index);
  const random = new SeededRandom(seed);
  const archetype = random.pick(MOON_ARCHETYPES);
  const radiusMeters = Math.round(parent.radiusMeters * random.range(0.12, 0.28));
  const densityRatio = random.range(0.66, 0.94);
  const massKg = parent.massKg * (radiusMeters / parent.radiusMeters) ** 3 * densityRatio;
  const minimumOrbit = parent.ring ? parent.ring.outerRadiusMeters * 1.45 : parent.radiusMeters * 5;
  const semiMajorAxisMeters = minimumOrbit * (1 + index * 0.7) * random.range(1, 1.22);
  const colors = planetPalette(archetype);

  return {
    id: `${parent.id}:moon:${index}`,
    systemId: parent.systemId,
    name: `${parent.name} ${String.fromCharCode(73 + index)}`,
    seed,
    archetype,
    radiusMeters,
    massKg,
    orbit: {
      semiMajorAxisMeters,
      eccentricity: random.range(0.001, 0.05),
      inclinationRadians: random.range(-0.18, 0.18),
      longitudeAscendingNodeRadians: random.range(0, Math.PI * 2),
      argumentPeriapsisRadians: random.range(0, Math.PI * 2),
      meanAnomalyAtEpochRadians: random.range(0, Math.PI * 2),
      periodSeconds: orbitalPeriodSeconds(semiMajorAxisMeters, parent.massKg),
      parentId: parent.id,
    },
    atmosphere: createAtmosphere(archetype, colors, random, {
      ...atmosphereEnvironment, bodyId: `${parent.id}:moon:${index}`, seed, radiusMeters, massKg, isMoon: true,
    }),
    seaLevel: -0.18,
    colors,
    moons: [],
    rotationPeriodSeconds: random.range(1.6, 8.4) * SECONDS_PER_DAY,
    axialTiltRadians: random.range(-0.18, 0.18),
    isLandable: true,
    surfaceGravity: (GRAVITATIONAL_CONSTANT * massKg) / (radiusMeters * radiusMeters),
    generatorVersion: PLANET_GENERATOR_VERSION,
    parentPlanetId: parent.id,
  };
}
