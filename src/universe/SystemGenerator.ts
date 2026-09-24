import { AU_METERS, deriveSeed, EARTH_RADIUS_METERS, SeededRandom } from "../core";
import type { GalacticAddress } from "../core";
import { generatePlanet } from "./PlanetGenerator";
import { generateStar } from "./StarGenerator";
import { isStableCircumbinaryOrbit, isStableHierarchicalTriple } from "./StabilityRules";
import type { StarSystem, StarSystemKind } from "./types";
import { CONTRAST_SYSTEM_ID, HERO_SYSTEM_ID } from "./types";

const NAME_PREFIXES = [
  "Astra", "Vela", "Nyra", "Cygn", "Thal", "Iona", "Keph", "Mira", "Luma", "Oris", "Voss", "Aeon",
  "Tess", "Cael", "Zora", "Rhev", "Sora", "Nemi", "Tauri", "Oryn", "Sable", "Eris", "Haze", "Prax",
];
const NAME_SUFFIXES = [
  "reach", "veil", "hollow", "spire", "drift", "haven", "wake", "fall", "crown", "relay", "lantern", "bloom",
  "serein", "umbra", "chorus", "rime", "flare", "expanse", "shard", "tide", "arc", "vigil", "dust", "glass",
];

export interface SystemGenerationOptions {
  id: string;
  universeSeed: number;
  position: GalacticAddress;
  showcase?: boolean;
}

function generatedSystemName(random: SeededRandom): string {
  return `${random.pick(NAME_PREFIXES)} ${random.pick(NAME_SUFFIXES)} ${random.int(10, 99)}`;
}

export function selectSystemKind(random: SeededRandom): StarSystemKind {
  const roll = random.next();
  if (roll < 0.7) return "single";
  if (roll < 0.95) return "binary";
  return "triple";
}

export function generateSystem(options: SystemGenerationOptions): StarSystem {
  const seed = deriveSeed(options.universeSeed, "system", options.id);
  const random = new SeededRandom(seed);
  if (options.id === HERO_SYSTEM_ID) return generateHeroSystem(seed, options.position);
  if (options.id === CONTRAST_SYSTEM_ID) return generateContrastSystem(seed, options.position);

  const kind = selectSystemKind(random);
  const stars = [generateStar(options.id, seed, 0)];
  if (kind !== "single") stars.push(generateStar(options.id, seed, 1));
  if (kind === "triple") stars.push(generateStar(options.id, seed, 2));

  const system: StarSystem = {
    id: options.id,
    name: generatedSystemName(random),
    seed,
    kind,
    position: options.position,
    stars,
    planets: [],
    showcase: options.showcase ?? false,
  };

  if (kind !== "single") system.binarySeparationMeters = random.range(0.045, 0.16) * AU_METERS;
  if (kind === "triple") {
    const inner = system.binarySeparationMeters ?? 0.08 * AU_METERS;
    const outer = inner * random.range(8, 14);
    if (isStableHierarchicalTriple(inner, outer)) system.outerSeparationMeters = outer;
  }

  const stellarMass = stars.reduce((sum, star) => sum + star.massKg, 0);
  const stellarLuminositySolar = stars.reduce((sum, star) => sum + star.luminositySolar, 0);
  const minimumDistance = kind === "triple"
    ? ((system.outerSeparationMeters ?? AU_METERS) / AU_METERS) * 3.5
    : kind === "binary"
      ? ((system.binarySeparationMeters ?? AU_METERS * 0.12) / AU_METERS) * 3.2
      : 0.28;
  let orbitalDistanceAu = Math.max(minimumDistance, random.range(0.3, 0.62));
  const planetCount = random.int(3, 8);

  for (let index = 0; index < planetCount; index += 1) {
    if (system.binarySeparationMeters && !isStableCircumbinaryOrbit(orbitalDistanceAu * AU_METERS, system.binarySeparationMeters)) {
      orbitalDistanceAu *= 1.4;
    }
    system.planets.push(generatePlanet(options.id, seed, index, {
      orbitalDistanceAu, parentMassKg: stellarMass, stellarLuminositySolar,
    }));
    orbitalDistanceAu *= random.range(1.34, 1.8);
  }
  return system;
}

function generateHeroSystem(seed: number, position: GalacticAddress): StarSystem {
  const stars = [
    generateStar(HERO_SYSTEM_ID, seed, 0, { spectralType: "G", name: "Astris", color: "#ffd986" }),
    generateStar(HERO_SYSTEM_ID, seed, 1, { spectralType: "K", name: "Lyric", color: "#ff8c78" }),
  ];
  const stellarMass = stars[0]!.massKg + stars[1]!.massKg;
  const stellarLuminositySolar = stars[0]!.luminositySolar + stars[1]!.luminositySolar;
  const planets = [
    generatePlanet(HERO_SYSTEM_ID, seed, 0, {
      name: "Cinder Wake", archetype: "volcanic", orbitalDistanceAu: 0.49, parentMassKg: stellarMass, stellarLuminositySolar, phaseRadians: 1.5,
    }),
    generatePlanet(HERO_SYSTEM_ID, seed, 1, {
      name: "Aurelia Veil", archetype: "ocean", radiusMeters: EARTH_RADIUS_METERS, orbitalDistanceAu: 0.82,
      parentMassKg: stellarMass, stellarLuminositySolar, ring: true, ringColor: "#ff43bf", moonCount: 1, phaseRadians: 0.34, seaLevel: 0.14,
    }),
    generatePlanet(HERO_SYSTEM_ID, seed, 2, {
      name: "Serein Bloom", archetype: "temperate", orbitalDistanceAu: 1.37, parentMassKg: stellarMass, stellarLuminositySolar, moonCount: 1, phaseRadians: 2.4,
    }),
    generatePlanet(HERO_SYSTEM_ID, seed, 3, {
      name: "Velvet Crown", archetype: "gas-giant", orbitalDistanceAu: 2.68, parentMassKg: stellarMass, stellarLuminositySolar,
      ring: true, ringColor: "#9770ff", moonCount: 2, phaseRadians: 4.25,
    }),
    generatePlanet(HERO_SYSTEM_ID, seed, 4, {
      name: "Hushglass", archetype: "frozen", orbitalDistanceAu: 4.76, parentMassKg: stellarMass, stellarLuminositySolar, moonCount: 1, phaseRadians: 5.1,
    }),
  ];

  return {
    id: HERO_SYSTEM_ID,
    name: "Astris Prime",
    seed,
    kind: "binary",
    position,
    stars,
    planets,
    showcase: true,
    binarySeparationMeters: AU_METERS * 0.12,
  };
}

function generateContrastSystem(seed: number, position: GalacticAddress): StarSystem {
  const stars = [generateStar(CONTRAST_SYSTEM_ID, seed, 0, { spectralType: "M", name: "Vanta", color: "#ff627e" })];
  const parentMassKg = stars[0]!.massKg;
  const stellarLuminositySolar = stars[0]!.luminositySolar;
  const planets = [
    generatePlanet(CONTRAST_SYSTEM_ID, seed, 0, { name: "Ember Shard", archetype: "volcanic", orbitalDistanceAu: 0.17, parentMassKg, stellarLuminositySolar, phaseRadians: 1.1 }),
    generatePlanet(CONTRAST_SYSTEM_ID, seed, 1, { name: "Rime Cathedral", archetype: "frozen", orbitalDistanceAu: 0.48, parentMassKg, stellarLuminositySolar, ring: true, ringColor: "#79dfff", moonCount: 1, phaseRadians: 3.2 }),
    generatePlanet(CONTRAST_SYSTEM_ID, seed, 2, { name: "Indigo Silence", archetype: "ice-giant", orbitalDistanceAu: 1.36, parentMassKg, stellarLuminositySolar, moonCount: 2, phaseRadians: 4.1 }),
  ];
  return { id: CONTRAST_SYSTEM_ID, name: "Vanta Reach", seed, kind: "single", position, stars, planets, showcase: true };
}
