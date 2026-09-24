import {
  PLANET_NOISE_VERSION,
  fractalNoise3,
  hashUnit,
  normalizeSeed,
  ridgeNoise3,
  valueNoise3,
  type Vec3Like,
} from './noise';
import {
  createPlanetGeologyProfile,
  samplePlanetGeology,
  type PlanetGeologyProfile,
  type PlanetGeologySample,
} from './PlanetGeology';

export const PLANET_ARCHETYPES = [
  'ocean',
  'temperate',
  'desert',
  'volcanic',
  'frozen',
  'barren',
  'ice-moon',
  'gas-giant',
  'ice-giant',
] as const;

export type PlanetArchetype = (typeof PLANET_ARCHETYPES)[number];
export type Rgb = readonly [number, number, number];

export interface PlanetColors {
  deep: string;
  shallow: string;
  land: string;
  highland: string;
  atmosphere: string;
  accent: string;
}

export interface PlanetFieldInput {
  seed?: number | string;
  radius?: number;
  radiusMeters?: number;
  seaLevel?: number;
  archetype?: PlanetArchetype | string;
  colors?: Partial<PlanetColors>;
  palette?: Partial<PlanetColors>;
  maxHeightMeters?: number;
  generatorVersion?: number;
}

export interface PlanetField {
  readonly seed: number;
  readonly radius: number;
  readonly radiusMeters: number;
  readonly seaLevel: number;
  readonly archetype: PlanetArchetype;
  readonly colors: PlanetColors;
  readonly maxHeightMeters: number;
  readonly generatorVersion: number;
  readonly landable: boolean;
}

export type PlanetBiome =
  | 'deep-ocean'
  | 'shallow-ocean'
  | 'shore'
  | 'lowland'
  | 'highland'
  | 'mountain'
  | 'polar'
  | 'lava'
  | 'gas-band';

export interface PlanetSurfaceSample {
  /** Signed height relative to the procedural sea-level datum, in real meters. */
  readonly heightMeters: number;
  /** Physical flight envelope: mean sea surface over ocean, signed ground elsewhere. */
  readonly radialMeters: number;
  /** Actual signed ground/seabed radius, including terrain beneath an ocean. */
  readonly terrainRadiusMeters: number;
  readonly waterDepthMeters: number;
  readonly normalizedHeight: number;
  readonly continentalness: number;
  readonly moisture: number;
  readonly temperature: number;
  readonly slopeHint: number;
  /** Body-fixed folded ridge strength shared by render meshes and collision. */
  readonly ridgeStrength: number;
  /** Signed medium/fine-scale physical relief already included in heightMeters. */
  readonly microReliefMeters: number;
  /** Stable geological stratum that terrain/decoration colors may consume. */
  readonly geologicalBand: number;
  readonly ocean: boolean;
  readonly biome: PlanetBiome;
  readonly color: Rgb;
  /** Stable, more specific body-fixed ecological region; legacy biome remains unchanged. */
  readonly biomeId?: string;
  /** Actual non-ocean downhill drainage channel, normalized to 0–1. */
  readonly riverStrength?: number;
  /** Physical channel cut measured against the same collision-matched heightfield. */
  readonly riverDepthMeters?: number;
  /** Unit downhill direction tangent to the actual body, or the zero vector. */
  readonly riverDirection?: Vec3Like;
  readonly drainage?: number;
  /** Dry volcanic liquid/thermal masks; identically zero on every other archetype. */
  readonly lavaStrength?: number;
  readonly volcanoStrength?: number;
  readonly craterStrength?: number;
  readonly mineralRichness?: number;
  readonly vegetationDensity?: number;
  readonly cloudCoverage?: number;
  readonly weatherHumidity?: number;
  /** Real version-two tectonic displacement shared by every terrain consumer. */
  readonly macroReliefMeters?: number;
  readonly mountainStrength?: number;
  readonly plateauStrength?: number;
  readonly basinStrength?: number;
  readonly canyonStrength?: number;
  /** Persistent body-fixed dominant range, plateau, impact basin, or canyon. */
  readonly geologyFeatureId?: string | null;
  readonly geologyFeatureDirection?: Vec3Like | null;
}

const PALETTES: Record<PlanetArchetype, PlanetColors> = {
  ocean: {
    deep: '#07566B',
    shallow: '#0FB8A9',
    land: '#171D53',
    highland: '#55328E',
    atmosphere: '#00EAFF',
    accent: '#50F1C8',
  },
  temperate: {
    deep: '#08485F',
    shallow: '#10AFA5',
    land: '#215968',
    highland: '#574A84',
    atmosphere: '#55DBFF',
    accent: '#72E5B9',
  },
  desert: {
    deep: '#49315F',
    shallow: '#895473',
    land: '#AA685A',
    highland: '#F0A667',
    atmosphere: '#FFBD59',
    accent: '#FFCA82',
  },
  volcanic: {
    deep: '#141125',
    shallow: '#3B1736',
    land: '#38243F',
    highland: '#754453',
    atmosphere: '#FF6377',
    accent: '#FF694A',
  },
  frozen: {
    deep: '#14354E',
    shallow: '#2E748D',
    land: '#6482A6',
    highland: '#CDD9F8',
    atmosphere: '#75DBFF',
    accent: '#AFEAF4',
  },
  barren: {
    deep: '#1A1934',
    shallow: '#292547',
    land: '#393451',
    highland: '#786688',
    atmosphere: '#794BFF',
    accent: '#A789D1',
  },
  'ice-moon': {
    deep: '#15253E',
    shallow: '#34556E',
    land: '#7E96AF',
    highland: '#DBEAF8',
    atmosphere: '#8FBFFF',
    accent: '#BDEAFE',
  },
  'gas-giant': {
    deep: '#32234E',
    shallow: '#87476C',
    land: '#BF706B',
    highland: '#F1B182',
    atmosphere: '#FFBD59',
    accent: '#FFD1A5',
  },
  'ice-giant': {
    deep: '#173159',
    shallow: '#275F83',
    land: '#4189A9',
    highland: '#9CDCE7',
    atmosphere: '#63E9FF',
    accent: '#B4F2F3',
  },
};

const DEFAULT_SEA_LEVEL: Record<PlanetArchetype, number> = {
  ocean: 0.035,
  temperate: -0.04,
  desert: -0.54,
  volcanic: -0.4,
  frozen: -0.06,
  barren: -0.82,
  'ice-moon': -0.67,
  'gas-giant': -1,
  'ice-giant': -1,
};

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function mix(left: number, right: number, blend: number): number {
  return left + (right - left) * blend;
}

function smoothRange(edge0: number, edge1: number, value: number): number {
  const blend = clamp((value - edge0) / Math.max(Number.EPSILON, edge1 - edge0));
  return blend * blend * (3 - 2 * blend);
}

function colorFromHex(hex: string): Rgb {
  const normalized = hex.replace('#', '');
  const color = Number.parseInt(normalized, 16);

  if (!Number.isFinite(color)) {
    return [0.09, 0.11, 0.32];
  }

  return [
    ((color >>> 16) & 0xff) / 255,
    ((color >>> 8) & 0xff) / 255,
    (color & 0xff) / 255,
  ];
}

function mixColor(first: Rgb, second: Rgb, blend: number): Rgb {
  const safeBlend = clamp(blend);
  return [
    mix(first[0], second[0], safeBlend),
    mix(first[1], second[1], safeBlend),
    mix(first[2], second[2], safeBlend),
  ];
}

function resolveArchetype(archetype?: string): PlanetArchetype {
  const normalized = archetype?.toLowerCase().replace(/[ _]/g, '-');

  if (normalized === 'ice') return 'frozen';
  if (normalized === 'oceanic' || normalized === 'water') return 'ocean';
  if (normalized === 'gas' || normalized === 'gasgiant') return 'gas-giant';
  if (normalized === 'icegiant') return 'ice-giant';
  if (normalized === 'moon') return 'barren';

  return PLANET_ARCHETYPES.includes(normalized as PlanetArchetype)
    ? (normalized as PlanetArchetype)
    : 'ocean';
}

export function createPlanetField(input: PlanetFieldInput | PlanetField = {}): PlanetField {
  const seed = normalizeSeed(input.seed);
  const radius = Math.max(1, input.radiusMeters ?? input.radius ?? 6_371_000);
  const archetype = resolveArchetype(input.archetype);
  const maxHeightMeters = input.maxHeightMeters ?? Math.min(radius * 0.012, 12_500);
  const providedSeaLevel = input.seaLevel;
  const seaLevel =
    providedSeaLevel === undefined
      ? DEFAULT_SEA_LEVEL[archetype]
      : Math.abs(providedSeaLevel) > 2
        ? providedSeaLevel / maxHeightMeters
        : providedSeaLevel;

  return {
    seed,
    radius,
    radiusMeters: radius,
    seaLevel,
    archetype,
    colors: {
      ...PALETTES[archetype],
      ...('palette' in input ? input.palette : undefined),
      ...input.colors,
    },
    maxHeightMeters,
    generatorVersion: input.generatorVersion ?? PLANET_NOISE_VERSION,
    landable: archetype !== 'gas-giant' && archetype !== 'ice-giant',
  };
}

function normalizeDirection(direction: Vec3Like): Vec3Like {
  const length = Math.hypot(direction.x, direction.y, direction.z);

  if (length < Number.EPSILON) {
    return { x: 0, y: 1, z: 0 };
  }

  return {
    x: direction.x / length,
    y: direction.y / length,
    z: direction.z / length,
  };
}

const NO_FLOW: Vec3Like = Object.freeze({ x: 0, y: 0, z: 0 });
const planetGeologyProfiles = new WeakMap<PlanetField, PlanetGeologyProfile>();

function geologyProfileFor(field: PlanetField): PlanetGeologyProfile {
  let profile = planetGeologyProfiles.get(field);
  if (!profile) {
    profile = createPlanetGeologyProfile(field);
    planetGeologyProfiles.set(field, profile);
  }
  return profile;
}

function warpedPlanetDirection(direction: Vec3Like, field: PlanetField, detail: number): Vec3Like {
  const broadWarp = valueNoise3(
    direction.x * 2.7,
    direction.y * 2.7,
    direction.z * 2.7,
    field.seed ^ 0x18ad_45e1,
  );
  const crossWarp = valueNoise3(
    direction.y * 3.35 + 4.1,
    direction.z * 3.35 - 2.7,
    direction.x * 3.35 + 1.9,
    field.seed ^ 0x72bf_319d,
  );
  return normalizeDirection({
    x: direction.x + broadWarp * 0.067,
    y: direction.y + crossWarp * 0.055,
    z: direction.z + detail * 0.044,
  });
}

/** Cheap gradient of the same continental/ridge frequencies driving real relief. */
function drainagePotential(field: PlanetField, direction: Vec3Like): number {
  const continental = fractalNoise3(direction, {
    frequency: 1.35,
    octaves: 3,
    persistence: 0.53,
    seed: field.seed ^ 0xa18b4f39,
  });
  const ridge = ridgeNoise3(direction, {
    frequency: 5.3,
    octaves: 1,
    seed: field.seed ^ 0x7f4a7c15,
  });
  return continental * 0.76 + ridge * 0.24;
}

function downhillDirection(field: PlanetField, direction: Vec3Like): Vec3Like {
  const reference = Math.abs(direction.y) < 0.88
    ? { x: 0, y: 1, z: 0 }
    : { x: 1, y: 0, z: 0 };
  const tangent = normalizeDirection({
    x: reference.y * direction.z - reference.z * direction.y,
    y: reference.z * direction.x - reference.x * direction.z,
    z: reference.x * direction.y - reference.y * direction.x,
  });
  const bitangent = {
    x: direction.y * tangent.z - direction.z * tangent.y,
    y: direction.z * tangent.x - direction.x * tangent.z,
    z: direction.x * tangent.y - direction.y * tangent.x,
  };
  const step = 0.000_7;
  const offset = (axis: Vec3Like, amount: number): Vec3Like => normalizeDirection({
    x: direction.x + axis.x * amount,
    y: direction.y + axis.y * amount,
    z: direction.z + axis.z * amount,
  });
  const tangentSlope = drainagePotential(field, offset(tangent, step))
    - drainagePotential(field, offset(tangent, -step));
  const bitangentSlope = drainagePotential(field, offset(bitangent, step))
    - drainagePotential(field, offset(bitangent, -step));
  const magnitude = Math.hypot(tangentSlope, bitangentSlope);
  if (magnitude < 1e-10) return NO_FLOW;

  return {
    x: -(tangent.x * tangentSlope + bitangent.x * bitangentSlope) / magnitude,
    y: -(tangent.y * tangentSlope + bitangent.y * bitangentSlope) / magnitude,
    z: -(tangent.z * tangentSlope + bitangent.z * bitangentSlope) / magnitude,
  };
}

function regionalBiomeId(
  field: PlanetField,
  biome: PlanetBiome,
  ocean: boolean,
  riverStrength: number,
  lavaStrength: number,
  volcanoStrength: number,
  craterStrength: number,
  mineralRichness: number,
  vegetationDensity: number,
  moisture: number,
): string {
  if (ocean) return biome === 'deep-ocean' ? 'abyssal-basin' : 'tidal-shelf';
  if (field.archetype === 'volcanic') {
    if (lavaStrength > 0.47) return 'lava-channel';
    if (craterStrength > 0.64 && volcanoStrength > 0.29) return 'active-caldera';
    if (volcanoStrength > 0.43) return 'volcanic-cone';
    return mineralRichness > 0.57 ? 'obsidian-mineral-ridge' : 'ash-basin';
  }
  if (field.archetype === 'frozen' || field.archetype === 'ice-moon') {
    if (craterStrength > 0.62) return 'frozen-impact-basin';
    return mineralRichness > 0.58 ? 'glacial-crystal-field' : 'wind-carved-ice-shelf';
  }
  if (field.archetype === 'desert') {
    if (mineralRichness > 0.62) return 'opaline-mineral-canyon';
    return moisture < 0.4 ? 'wind-sculpted-dune-sea' : 'ochre-salt-mesa';
  }
  if (field.archetype === 'barren') {
    return craterStrength > 0.55 ? 'impact-caldera' : 'metallic-regolith-ridge';
  }
  if (riverStrength > 0.42) return 'braided-river-valley';
  if (vegetationDensity > 0.68) return 'bioluminescent-canopy-grove';
  if (biome === 'shore') return 'luminous-tidal-wetland';
  if (biome === 'mountain') return 'folded-alpine-spine';
  return vegetationDensity > 0.4 ? 'temperate-alien-woodland' : 'windward-mineral-steppe';
}

function sampleGasGiant(field: PlanetField, direction: Vec3Like): PlanetSurfaceSample {
  const latitude = Math.asin(clamp(direction.y, -1, 1));
  const bands =
    Math.sin(latitude * 18 + fractalNoise3(direction, { seed: field.seed, frequency: 3, octaves: 2 }) * 3) *
      0.5 +
    0.5;
  const accent = valueNoise3(direction.x * 6, direction.y * 6, direction.z * 6, field.seed ^ 0x315a);
  const deep = colorFromHex(field.colors.deep);
  const pale = colorFromHex(field.colors.highland);
  const middle = colorFromHex(field.colors.land);
  const color = mixColor(mixColor(deep, middle, bands), pale, clamp(accent * 0.32));

  return {
    heightMeters: 0,
    radialMeters: field.radius,
    terrainRadiusMeters: field.radius,
    waterDepthMeters: 0,
    normalizedHeight: 0,
    continentalness: bands,
    moisture: 0,
    temperature: 0.5,
    slopeHint: 0,
    ridgeStrength: 0,
    microReliefMeters: 0,
    geologicalBand: bands,
    ocean: false,
    biome: 'gas-band',
    color,
    biomeId: field.archetype === 'ice-giant' ? 'cryogenic-storm-band' : 'jovian-cloud-band',
    riverStrength: 0,
    riverDepthMeters: 0,
    riverDirection: NO_FLOW,
    drainage: 0,
    lavaStrength: 0,
    volcanoStrength: 0,
    craterStrength: 0,
    mineralRichness: 0,
    vegetationDensity: 0,
    cloudCoverage: 0.86,
    weatherHumidity: 0,
  };
}

/** The authoritative, face-independent planet field used by proxies and collision. */
export function samplePlanetField(
  fieldInput: PlanetField | PlanetFieldInput,
  rawDirection: Vec3Like,
): PlanetSurfaceSample {
  return samplePlanetFieldInternal(fieldInput, rawDirection, true);
}

/** Exact shared terrain/climate sample without expensive downhill heading probes. */
export function samplePlanetClimate(
  fieldInput: PlanetField | PlanetFieldInput,
  rawDirection: Vec3Like,
): PlanetSurfaceSample {
  return samplePlanetFieldInternal(fieldInput, rawDirection, false);
}

function samplePlanetFieldInternal(
  fieldInput: PlanetField | PlanetFieldInput,
  rawDirection: Vec3Like,
  resolveActualFlow: boolean,
): PlanetSurfaceSample {
  const field = 'landable' in fieldInput ? fieldInput : createPlanetField(fieldInput);
  const direction = normalizeDirection(rawDirection);

  if (!field.landable) {
    return sampleGasGiant(field, direction);
  }

  const continental = fractalNoise3(direction, {
    frequency: 1.35,
    octaves: 4,
    persistence: 0.53,
    seed: field.seed ^ 0xa18b4f39,
  });
  const broadMountain = fractalNoise3(direction, {
    frequency: 2.8,
    octaves: 2,
    seed: field.seed ^ 0x92d68ca2,
  });
  const mountains = ridgeNoise3(direction, {
    frequency: 5.3,
    octaves: 3,
    seed: field.seed ^ 0x7f4a7c15,
  });
  const detail = valueNoise3(
    direction.x * 23,
    direction.y * 23,
    direction.z * 23,
    field.seed ^ 0x25a6f9d3,
  );
  const mountainMask = clamp((continental - field.seaLevel + 0.12) * 2.5);
  const craterMask =
    field.archetype === 'barren' || field.archetype === 'ice-moon'
      ? Math.pow(Math.max(0, 0.35 - Math.abs(detail)), 2) * 2.4
      : 0;
  const rawElevation =
    continental * 0.64 +
    broadMountain * 0.13 +
    (mountains - 0.42) * 0.39 * mountainMask +
    detail * 0.045 -
    craterMask;
  const baseRelativeElevation = rawElevation - field.seaLevel;
  // Preserve exact shore crossings, the canonical two-meter hero landing, and
  // every pre-existing wet/dry decision. The same signed enhancement is added
  // before CPU collision, worker meshing, proxies, clouds, and close surfaces
  // consume the shared body-fixed sample.
  const inlandMask = baseRelativeElevation > 0
    ? smoothRange(Math.min(0.000_42, 3.4 / field.maxHeightMeters), 0.012, baseRelativeElevation)
    : 0;
  let foldedRidges = mountains;
  let mediumRelief = 0;
  let fineRelief = 0;
  let geologicalBand = (detail + 1) * 0.5;

  if (inlandMask > 0) {
    foldedRidges = ridgeNoise3(direction, {
      frequency: 11.8,
      octaves: 2,
      persistence: 0.58,
      seed: field.seed ^ 0x4e7a_86c3,
    });
    const foldedSpine = Math.max(0, foldedRidges - 0.37);
    const ruggedness = field.archetype === 'volcanic'
      ? 1.48
      : field.archetype === 'frozen' || field.archetype === 'ice-moon'
        ? 1.22
        : field.archetype === 'desert'
          ? 0.78
          : field.archetype === 'temperate'
            ? 1.1
            : 0.98;
    const meso = valueNoise3(
      direction.x * 96,
      direction.y * 96,
      direction.z * 96,
      field.seed ^ 0xd1b5_4a35,
    );
    const local = valueNoise3(
      direction.x * 690,
      direction.y * 690,
      direction.z * 690,
      field.seed ^ 0x71a4_b863,
    );
    const grain = valueNoise3(
      direction.x * 3_240,
      direction.y * 3_240,
      direction.z * 3_240,
      field.seed ^ 0x3c6e_f372,
    );
    // Expose genuine near-coastal escarpments to every authoritative field
    // consumer. The dry-only gate is identically zero below 8.75 physical
    // meters, preserving the canonical 2 m landing, every exact sea crossing,
    // and the true collision slope at the showcase shore.
    const coastalMask = smoothRange(0.0007, 0.0072, baseRelativeElevation);
    const coastalFolds = ridgeNoise3(direction, {
      frequency: 168,
      octaves: 2,
      persistence: 0.54,
      seed: field.seed ^ 0x56ce_39a7,
    });
    const escarpment = Math.pow(Math.max(0, coastalFolds - 0.18), 1.44);
    const coastalRelief = escarpment * 0.091 * coastalMask * ruggedness;
    // Smaller folded shelves start only after genuinely dry terrain exceeds
    // 3.4 m. Smoothstep has zero derivative at that boundary, so all three
    // sub-2.1 m showcase landings, their 12 m collision normal probes, and
    // every exact wet/dry coastline remain completely unchanged.
    const nearshoreMask = smoothRange(
      3.4 / field.maxHeightMeters,
      16 / field.maxHeightMeters,
      baseRelativeElevation,
    );
    const nearshoreFolds = ridgeNoise3(direction, {
      frequency: 385,
      octaves: 2,
      persistence: 0.56,
      seed: field.seed ^ 0x62ef_19d7,
    });
    const nearshoreSpine = Math.pow(Math.max(0, nearshoreFolds - 0.16), 1.46);
    const nearshoreRelief = Math.min(
      245 / field.maxHeightMeters,
      nearshoreSpine * 0.084 * ruggedness,
    ) * nearshoreMask;
    geologicalBand = clamp(
      meso * 0.23 + foldedRidges * 0.39 + coastalFolds * coastalMask * 0.19 + nearshoreFolds * nearshoreMask * 0.19,
    );
    mediumRelief = (
      foldedSpine * foldedSpine * 0.73 * ruggedness * (0.4 + mountainMask * 0.6) +
      meso * 0.015 * ruggedness
    ) * inlandMask + coastalRelief + nearshoreRelief;
    fineRelief = (local * 0.0052 + grain * 0.00135) * inlandMask * ruggedness;
  }

  const enhancement = inlandMask > 0
    ? Math.max(-baseRelativeElevation * 0.44, mediumRelief + fineRelief)
    : 0;
  let relativeElevation = baseRelativeElevation + enhancement;
  let heightMeters = relativeElevation * field.maxHeightMeters;
  const ocean = heightMeters < 0 && field.archetype !== 'desert' && field.archetype !== 'volcanic';
  const temperature = clamp(1 - Math.abs(direction.y) * 0.8 + continental * 0.12);
  const moisture = clamp(
    fractalNoise3(direction, {
      frequency: 2.2,
      octaves: 2,
      seed: field.seed ^ 0x4cf2a741,
    }) *
      0.5 +
      0.5,
  );

  const waterBearing = field.archetype === 'ocean' || field.archetype === 'temperate';
  const volcanic = field.archetype === 'volcanic';
  const frozen = field.archetype === 'frozen' || field.archetype === 'ice-moon';
  const arid = field.archetype === 'desert' || field.archetype === 'barren';
  const warp = warpedPlanetDirection(direction, field, detail);
  const watershed = valueNoise3(
    warp.x * 6.4,
    warp.y * 6.4,
    warp.z * 6.4,
    field.seed ^ 0x64cd_18f7,
  );
  const tributary = valueNoise3(
    warp.x * 16.2,
    warp.y * 16.2,
    warp.z * 16.2,
    field.seed ^ 0x093e_7ab5,
  );
  const mineralNoise = (tributary + 1) * 0.5;
  const mineralRichness = clamp(
    geologicalBand * 0.37 + mineralNoise * 0.33 + foldedRidges * 0.18
      + (frozen ? 0.13 : arid ? 0.1 : volcanic ? 0.07 : 0),
  );
  const drainage = !ocean && waterBearing
    ? clamp((0.31 + moisture * 0.48 + Math.max(0, watershed) * 0.22)
      * (1 - smoothRange(0.69, 1, mountainMask) * 0.36))
    : 0;
  const nearShoreProtection = smoothRange(8, 48, heightMeters);
  const channelAxis = Math.abs(watershed * 0.82 + tributary * 0.18);
  const channelMask = 1 - smoothRange(0.035, 0.29, channelAxis);
  let riverStrength = !ocean && waterBearing
    ? clamp(channelMask * drainage * (0.5 + moisture * 0.5) * nearShoreProtection * 1.52)
    : 0;
  if (riverStrength < 0.045) riverStrength = 0;

  const volcanicVent = volcanic
    ? ridgeNoise3(warp, { frequency: 8.4, octaves: 2, seed: field.seed ^ 0x89b3_7e41 })
    : 0;
  const coneCore = volcanic ? smoothRange(0.52, 0.91, volcanicVent) : 0;
  const volcanoStrength = volcanic && !ocean
    ? clamp(coneCore * (0.53 + mountains * 0.47))
    : 0;
  const craterNoise = (valueNoise3(
    warp.x * 11.8,
    warp.y * 11.8,
    warp.z * 11.8,
    field.seed ^ 0x41e8_a16b,
  ) + 1) * 0.5;
  let craterStrength = !ocean && (volcanic || frozen || arid)
    ? smoothRange(volcanic ? 0.59 : 0.54, volcanic ? 0.89 : 0.82, craterNoise)
    : 0;
  const lavaVein = 1 - smoothRange(0.055, 0.34, Math.abs(watershed * 0.75 + tributary * 0.25));
  const lavaStrength = volcanic && !ocean
    ? clamp(lavaVein * (0.42 + volcanoStrength * 0.58) * (0.66 + mountains * 0.34))
    : 0;

  // These terms change the actual authoritative radial field, so collision,
  // workers, proxy geometry, ecology, rivers and landing share one surface.
  // Every original showcase shore and candidate stays mathematically unchanged:
  // highland relief begins above 420 m and ravines above 390 m of real height.
  const highlandGate = !ocean ? smoothRange(420, 1_500, heightMeters) : 0;
  const warpedRidge = highlandGate > 0
    ? ridgeNoise3(warp, {
      frequency: 13.7,
      octaves: 2,
      persistence: 0.56,
      seed: field.seed ^ 0x5b38_d471,
    })
    : 0;
  const tectonicStrength = Math.pow(Math.max(0, warpedRidge - 0.38), 1.68);
  const mountainUplift = tectonicStrength * highlandGate * field.maxHeightMeters
    * (volcanic ? 0.2 : frozen ? 0.13 : arid ? 0.09 : 0.15)
    * (0.56 + mountains * 0.44);
  const volcanicConeMeters = volcanic && !ocean
    ? volcanoStrength * smoothRange(130, 950, heightMeters)
      * field.maxHeightMeters * 0.14
    : 0;
  const volcanicCalderaMeters = volcanicConeMeters
    * craterStrength * smoothRange(0.52, 0.95, volcanoStrength) * 0.42;
  const impactCraterMeters = !ocean && (frozen || field.archetype === 'barren')
    ? craterStrength * smoothRange(260, 1_100, heightMeters) * 140
    : 0;
  const duneReliefMeters = !ocean && field.archetype === 'desert'
    ? (Math.sin(warp.x * 43 + warp.z * 37 + watershed * 5) * 0.5 + 0.5)
      * smoothRange(120, 800, heightMeters) * 96
    : 0;
  const riverDepthMeters = riverStrength > 0
    ? riverStrength * smoothRange(390, 1_350, heightMeters) * (18 + drainage * 58)
    : 0;
  const physicalReliefMeters = mountainUplift + volcanicConeMeters - volcanicCalderaMeters
    - impactCraterMeters + duneReliefMeters - riverDepthMeters;
  if (physicalReliefMeters !== 0) {
    heightMeters += physicalReliefMeters;
    relativeElevation = heightMeters / field.maxHeightMeters;
  }

  // Ocean worlds need authentic folded coastal highlands, not decorative
  // silhouette meshes. Start only after the existing dry surface exceeds
  // 80 m so every verified landing, its 12 m collision probes, and the exact
  // sea crossing remain bit-identical. Broad body-fixed crests become true
  // authoritative terrain for workers, collision, proxies, and surface LODs.
  // Established drainage corridors stay untouched rather than lifting an
  // actual river into the center of a fabricated cliff.
  if (field.archetype === 'ocean' && !ocean && heightMeters > 80) {
    const coastalCrest = ridgeNoise3(direction, {
      frequency: 610,
      octaves: 2,
      persistence: 0.52,
      seed: field.seed ^ 0x739e_214d,
    });
    const foldedCrest = Math.pow(Math.max(0, (coastalCrest - 0.27) / 0.73), 1.32);
    const lowCoastalShelf = smoothRange(80, 300, heightMeters) * 200;
    const inlandMassif = smoothRange(205, 450, heightMeters) * 1_550;
    const genuineRiverProtection = 1 - smoothRange(0.16, 0.48, riverStrength);
    const coastalEscarpmentMeters = Math.min(
      950,
      (lowCoastalShelf + inlandMassif) * foldedCrest * genuineRiverProtection,
    );

    if (coastalEscarpmentMeters > 0) {
      heightMeters += coastalEscarpmentMeters;
      relativeElevation = heightMeters / field.maxHeightMeters;
    }
  }

  let geology: PlanetGeologySample | undefined;
  let macroReliefMeters = 0;
  let geologicalExposure = 0;
  const versionedGeology = field.generatorVersion >= 2;
  if (versionedGeology && !ocean && heightMeters > 120) {
    geology = samplePlanetGeology(geologyProfileFor(field), direction);

    // The canonical coast, all verified <3 m landing positions, their
    // collision-normal probes, and the exact sea-level crossing remain
    // bit-identical. Connected inland ranges are genuine signed terrain,
    // never detached renderer-only silhouette meshes. Wet and protected
    // coastal samples bypass every geology noise/landmark operation.
    geologicalExposure = smoothRange(120, 760, heightMeters);
    if (geologicalExposure > 0) {
      const drainageProtection = 1 - smoothRange(0.2, 0.63, riverStrength) * 0.74;
      const candidate = geology.heightOffsetMeters
        * geologicalExposure
        * (geology.heightOffsetMeters > 0 ? drainageProtection : 1);
      macroReliefMeters = Math.max(-Math.max(0, heightMeters - 120) * 0.7, candidate);
      if (macroReliefMeters !== 0) {
        heightMeters += macroReliefMeters;
        relativeElevation = heightMeters / field.maxHeightMeters;
      }
    }
    craterStrength = Math.max(craterStrength, geology.craterStrength * geologicalExposure);
  }

  const vegetationDensity = !ocean && waterBearing
    ? clamp(
      moisture * 0.51 + (1 - Math.abs(temperature - 0.57) * 1.45) * 0.23
        + drainage * 0.2 - Math.max(0, mountains - 0.7) * 0.38,
    ) * smoothRange(2.2, 16, heightMeters)
    : 0;
  const weatherHumidity = clamp(
    ocean
      ? 0.63 + moisture * 0.32
      : waterBearing
        ? moisture * 0.58 + drainage * 0.23 + riverStrength * 0.14
        : volcanic
          ? 0.12 + volcanoStrength * 0.22
          : frozen
            ? 0.18 + moisture * 0.34
            : 0.035 + moisture * 0.12,
  );
  const cloudCoverage = clamp(
    waterBearing
      ? 0.18 + weatherHumidity * 0.58 + mountains * 0.08
      : volcanic
        ? 0.12 + volcanoStrength * 0.33 + weatherHumidity * 0.18
        : frozen
          ? 0.11 + weatherHumidity * 0.43
          : field.archetype === 'desert'
            ? 0.025 + weatherHumidity * 0.13
            : 0.025 + weatherHumidity * 0.07,
  );

  let biome: PlanetBiome;
  let color: Rgb;

  if (ocean) {
    const depth = clamp(-relativeElevation * 3);
    biome = depth > 0.38 ? 'deep-ocean' : 'shallow-ocean';
    color = mixColor(colorFromHex(field.colors.shallow), colorFromHex(field.colors.deep), depth);
  } else if (relativeElevation < 0.045 && field.archetype !== 'barren') {
    biome = 'shore';
    // An ocean planet may reserve its descriptor accent for magenta rings or
    // minerals. Its coastline still needs the approved restrained mint/teal
    // transition instead of turning entire continents bright bubblegum pink.
    const shoreAccent =
      field.archetype === 'ocean' || field.archetype === 'temperate'
        ? colorFromHex('#50F1C8')
        : colorFromHex(field.colors.accent);
    color = mixColor(colorFromHex(field.colors.land), shoreAccent, 0.3);
  } else if (field.archetype === 'volcanic' && mountains > 0.76 && detail > 0.12) {
    biome = 'lava';
    color = mixColor(colorFromHex(field.colors.highland), colorFromHex(field.colors.accent), 0.8);
  } else if (field.archetype === 'frozen' || temperature < 0.26) {
    biome = 'polar';
    color = mixColor(colorFromHex(field.colors.land), colorFromHex(field.colors.highland), 0.65);
  } else if (relativeElevation > 0.48) {
    biome = 'mountain';
    color = mixColor(colorFromHex(field.colors.land), colorFromHex(field.colors.highland), 0.72 + geologicalBand * 0.19);
  } else if (relativeElevation > 0.2) {
    biome = 'highland';
    color = mixColor(colorFromHex(field.colors.land), colorFromHex(field.colors.highland), 0.38 + geologicalBand * 0.24);
  } else {
    biome = 'lowland';
    color = mixColor(
      colorFromHex(field.colors.land),
      colorFromHex(field.colors.highland),
      0.1 + moisture * 0.12 + geologicalBand * inlandMask * 0.12,
    );
  }

  const facetVariation = (hashUnit(field.seed ^ Math.floor((detail + 1) * 20_000)) - 0.5) * 0.06;
  color = [
    clamp(color[0] + facetVariation),
    clamp(color[1] + facetVariation),
    clamp(color[2] + facetVariation),
  ];

  if (!ocean && waterBearing && riverStrength > 0.22) {
    color = mixColor(color, colorFromHex(field.colors.shallow), Math.min(0.54, riverStrength * 0.52));
  } else if (volcanic && lavaStrength > 0.24) {
    color = mixColor(color, colorFromHex(field.colors.accent), Math.min(0.72, lavaStrength * 0.77));
  } else if (!ocean && frozen) {
    color = mixColor(color, colorFromHex(field.colors.accent), mineralRichness * 0.15);
  } else if (!ocean && arid) {
    color = mixColor(color, colorFromHex(field.colors.highland), mineralRichness * 0.14);
  } else if (!ocean && waterBearing && vegetationDensity > 0.5) {
    color = mixColor(color, colorFromHex('#54C6A4'), (vegetationDensity - 0.5) * 0.19);
  }

  const biomeId = regionalBiomeId(
    field,
    biome,
    ocean,
    riverStrength,
    lavaStrength,
    volcanoStrength,
    craterStrength,
    mineralRichness,
    vegetationDensity,
    moisture,
  );

  let riverDirection = NO_FLOW;
  if (riverStrength > 0 && resolveActualFlow) {
    riverDirection = downhillDirection(field, direction);
    const flowLength = Math.hypot(riverDirection.x, riverDirection.y, riverDirection.z);
    if (flowLength > 0) {
      // The broad watershed gives a stable heading, but the real folded
      // heightfield decides its sign. Internal probes omit their own flow
      // vectors, avoiding recursion while keeping water physically downhill.
      const offset = 90 / field.radius;
      const downstream = normalizeDirection({
        x: direction.x + riverDirection.x * offset,
        y: direction.y + riverDirection.y * offset,
        z: direction.z + riverDirection.z * offset,
      });
      const upstream = normalizeDirection({
        x: direction.x - riverDirection.x * offset,
        y: direction.y - riverDirection.y * offset,
        z: direction.z - riverDirection.z * offset,
      });
      if (
        samplePlanetFieldInternal(field, downstream, false).heightMeters
          > samplePlanetFieldInternal(field, upstream, false).heightMeters
      ) {
        riverDirection = { x: -riverDirection.x, y: -riverDirection.y, z: -riverDirection.z };
      }
    }
  }

  return {
    heightMeters,
    radialMeters: field.radius + (ocean ? 0 : heightMeters),
    terrainRadiusMeters: field.radius + heightMeters,
    waterDepthMeters: ocean ? -heightMeters : 0,
    normalizedHeight: relativeElevation,
    continentalness: continental,
    moisture,
    temperature,
    slopeHint: clamp(
      mountains * mountainMask * 0.52
      + foldedRidges * inlandMask * 0.33
      + (geology?.mountainStrength ?? 0) * geologicalExposure * 0.12,
    ),
    ridgeStrength: clamp(Math.max(
      foldedRidges * (0.45 + inlandMask * 0.55),
      (geology?.ridgeStrength ?? 0) * geologicalExposure,
    )),
    microReliefMeters: fineRelief * field.maxHeightMeters,
    geologicalBand,
    ocean,
    biome,
    color,
    biomeId,
    riverStrength,
    riverDepthMeters,
    riverDirection,
    drainage,
    lavaStrength,
    volcanoStrength,
    craterStrength,
    mineralRichness,
    vegetationDensity,
    cloudCoverage,
    weatherHumidity,
    ...(versionedGeology ? {
      macroReliefMeters,
      mountainStrength: (geology?.mountainStrength ?? 0) * geologicalExposure,
      plateauStrength: (geology?.plateauStrength ?? 0) * geologicalExposure,
      basinStrength: (geology?.basinStrength ?? 0) * geologicalExposure,
      canyonStrength: (geology?.canyonStrength ?? 0) * geologicalExposure,
      geologyFeatureId: geologicalExposure > 0 ? geology!.dominantFeatureId : null,
      geologyFeatureDirection: geologicalExposure > 0 ? geology!.dominantFeatureDirection : null,
    } : {}),
  };
}

export function sampleHeight(field: PlanetField | PlanetFieldInput, direction: Vec3Like): number {
  return samplePlanetField(field, direction).heightMeters;
}

export const sampleSurface = samplePlanetField;
