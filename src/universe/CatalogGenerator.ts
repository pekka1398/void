import { addressFromMeters, deriveSeed, LIGHT_YEAR_METERS, SeededRandom, vec3 } from "../core";
import { generateSystem } from "./SystemGenerator";
import { CONTRAST_SYSTEM_ID, DEFAULT_UNIVERSE_SEED, HERO_SYSTEM_ID, UNIVERSE_GENERATOR_VERSION, type StarSystem } from "./types";

export interface CatalogGenerationOptions {
  seed?: string | number;
  systemCount?: number;
  radiusLightYears?: number;
}

interface CatalogCandidate {
  id: string;
  priority: number;
  xLightYears: number;
  yLightYears: number;
  zLightYears: number;
}

/** Stable integer-cell candidates prevent system identities depending on arrival order. */
function candidateSystems(seed: number, count: number, radiusLightYears: number): CatalogCandidate[] {
  const spacingLightYears = radiusLightYears / Math.max(4, Math.cbrt(count) * 0.8);
  const extent = Math.ceil(radiusLightYears / spacingLightYears) + 1;
  const candidates: CatalogCandidate[] = [];

  for (let cellX = -extent; cellX <= extent; cellX += 1) {
    for (let cellY = -extent; cellY <= extent; cellY += 1) {
      for (let cellZ = -extent; cellZ <= extent; cellZ += 1) {
        if (cellX === 0 && cellY === 0 && cellZ === 0) continue;
        const cellSeed = deriveSeed(seed, "catalog-cell", cellX, cellY, cellZ);
        const random = new SeededRandom(cellSeed);
        const xLightYears = (cellX + random.range(-0.34, 0.34)) * spacingLightYears;
        const yLightYears = (cellY + random.range(-0.34, 0.34)) * spacingLightYears;
        const zLightYears = (cellZ + random.range(-0.34, 0.34)) * spacingLightYears;
        if (Math.hypot(xLightYears, yLightYears, zLightYears) > radiusLightYears) continue;
        if (Math.hypot(xLightYears - 4.28, yLightYears + 1.18, zLightYears - 2.86) < 1.4) continue;

        candidates.push({
          id: `system-${cellSeed.toString(36).padStart(7, "0")}`,
          priority: deriveSeed(seed, "catalog-priority", cellX, cellY, cellZ),
          xLightYears,
          yLightYears,
          zLightYears,
        });
      }
    }
  }
  candidates.sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));
  return candidates;
}

export function generateCatalog(options: CatalogGenerationOptions = {}): StarSystem[] {
  const sourceSeed = options.seed ?? DEFAULT_UNIVERSE_SEED;
  const count = Math.max(2, Math.floor(options.systemCount ?? 2_048));
  const radiusLightYears = Math.max(6, options.radiusLightYears ?? 60);
  const seed = deriveSeed(sourceSeed, "catalog", UNIVERSE_GENERATOR_VERSION);
  const systems: StarSystem[] = [
    generateSystem({ id: HERO_SYSTEM_ID, universeSeed: seed, position: addressFromMeters(vec3()), showcase: true }),
    generateSystem({
      id: CONTRAST_SYSTEM_ID,
      universeSeed: seed,
      position: addressFromMeters(vec3(4.28 * LIGHT_YEAR_METERS, -1.18 * LIGHT_YEAR_METERS, 2.86 * LIGHT_YEAR_METERS)),
      showcase: true,
    }),
  ];

  const occupiedIds = new Set(systems.map((system) => system.id));
  for (const candidate of candidateSystems(seed, count, radiusLightYears)) {
    if (systems.length >= count) break;
    if (occupiedIds.has(candidate.id)) continue;
    occupiedIds.add(candidate.id);
    systems.push(generateSystem({
      id: candidate.id,
      universeSeed: seed,
      position: addressFromMeters(vec3(
        candidate.xLightYears * LIGHT_YEAR_METERS,
        candidate.yLightYears * LIGHT_YEAR_METERS,
        candidate.zLightYears * LIGHT_YEAR_METERS,
      )),
      showcase: systems.length < 32,
    }));
  }

  if (systems.length !== count) {
    throw new Error(`Procedural catalog produced ${systems.length} systems, expected ${count}`);
  }
  return systems;
}

export function catalogFingerprint(systems: readonly StarSystem[]): string {
  let fingerprint = deriveSeed("catalog-fingerprint", UNIVERSE_GENERATOR_VERSION, systems.length);
  for (const system of systems) {
    fingerprint = deriveSeed(fingerprint, system.id, system.seed, system.kind, system.planets.length);
  }
  return fingerprint.toString(16).padStart(8, "0");
}
