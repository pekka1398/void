import {
  addressToApproximateMeters,
  deriveSeed,
  LIGHT_YEAR_METERS,
  SeededRandom,
} from '../../core';
import { valueNoise3 } from '../../fields';
import {
  DEFAULT_UNIVERSE_SEED,
  type PlanetArchetype,
  type PlanetDescriptor,
  type SpectralType,
  type StarDescriptor,
  type StarSystem,
} from '../../universe';

export const SYSTEM_VISUAL_THEME_VERSION = 1;
export const SYSTEM_VISUAL_SECTOR_LIGHT_YEARS = 8;

export type SystemVisualFamily =
  | 'aurora-tide'
  | 'crimson-glacial'
  | 'glacial-aurora'
  | 'ember-forge'
  | 'sapphire-ion'
  | 'amber-drift'
  | 'verdant-veil'
  | 'violet-prism';

export interface SystemVisualColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export interface SystemVisualPosition {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface SystemVisualTheme {
  readonly version: typeof SYSTEM_VISUAL_THEME_VERSION;
  readonly id: string;
  readonly systemId: string;
  readonly name: string;
  readonly family: SystemVisualFamily;
  readonly seed: number;
  readonly dominantStarId: string;
  readonly dominantSpectralType: SpectralType;
  readonly dominantBiome: PlanetArchetype | 'none';
  readonly dominantPlanetId?: string;
  readonly primaryHex: string;
  readonly secondaryHex: string;
  readonly accentHex: string;
  readonly shadowHex: string;
  readonly dustHex: string;
  readonly stellarHex: string;
  readonly starTint: SystemVisualColor;
  readonly density: number;
  readonly coverage: number;
  readonly curtainWidth: number;
  readonly filamentWidth: number;
  readonly turbulence: number;
  readonly brightness: number;
  readonly orientationRadians: number;
  readonly inclinationRadians: number;
  readonly galacticPositionLightYears: SystemVisualPosition;
  readonly sectorDensity: number;
  readonly sectorSeed: number;
  readonly nebulaPalette: readonly string[];
  readonly formationPalette: readonly string[];
  readonly dustPalette: readonly string[];
}

interface FamilyPalette {
  readonly name: string;
  readonly primary: string;
  readonly secondary: string;
  readonly accent: string;
  readonly shadow: string;
  readonly dust: string;
}

const FAMILY_PALETTES: Readonly<Record<SystemVisualFamily, FamilyPalette>> = Object.freeze({
  'aurora-tide': {
    name: 'AURELIAN PRISM VEIL',
    primary: '#713DCE',
    secondary: '#1299AC',
    accent: '#F03BB7',
    shadow: '#150B2D',
    dust: '#62DDEF',
  },
  'crimson-glacial': {
    name: 'CRIMSON RIME CATHEDRAL',
    primary: '#9B284C',
    secondary: '#284B9D',
    accent: '#83E8FA',
    shadow: '#1A0B1D',
    dust: '#F46B98',
  },
  'glacial-aurora': {
    name: 'GLACIAL AURORA RIBBON',
    primary: '#3867A8',
    secondary: '#26ACC1',
    accent: '#AFF2FF',
    shadow: '#11172E',
    dust: '#86DFF1',
  },
  'ember-forge': {
    name: 'OBSIDIAN EMBER FORGE',
    primary: '#A13E51',
    secondary: '#78315B',
    accent: '#FF9955',
    shadow: '#1B0C20',
    dust: '#FB765A',
  },
  'sapphire-ion': {
    name: 'SAPPHIRE ION CHOIR',
    primary: '#354FA6',
    secondary: '#198DBB',
    accent: '#77E4FF',
    shadow: '#0D142C',
    dust: '#A3CBFF',
  },
  'amber-drift': {
    name: 'AMBER DUST RELIQUARY',
    primary: '#9B5656',
    secondary: '#8A4981',
    accent: '#FFB36E',
    shadow: '#200F1D',
    dust: '#F3B075',
  },
  'verdant-veil': {
    name: 'VIRIDIAN TIDAL VEIL',
    primary: '#347973',
    secondary: '#376CA0',
    accent: '#73E9C0',
    shadow: '#101B2B',
    dust: '#80D9C5',
  },
  'violet-prism': {
    name: 'VIOLET SPECTRAL LANTERN',
    primary: '#6B46B0',
    secondary: '#465F9C',
    accent: '#DC65CE',
    shadow: '#140F2A',
    dust: '#AAA4EF',
  },
});

const BIOME_VISUAL_WEIGHT: Readonly<Record<PlanetArchetype, number>> = Object.freeze({
  ocean: 3.9,
  temperate: 3.25,
  frozen: 3.15,
  volcanic: 2.7,
  desert: 2.6,
  barren: 1.45,
  'ice-moon': 2.2,
  'gas-giant': 1.35,
  'ice-giant': 1.7,
});

const THEME_CACHE = new WeakMap<StarSystem, Map<string, Readonly<SystemVisualTheme>>>();

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function parseHex(value: string): SystemVisualColor {
  const match = /^#?([\da-f]{6})$/i.exec(value);
  if (!match) throw new RangeError(`A real system visual color must be a six-digit hex value: ${value}`);
  const packed = Number.parseInt(match[1]!, 16);
  return {
    r: ((packed >>> 16) & 0xff) / 255,
    g: ((packed >>> 8) & 0xff) / 255,
    b: (packed & 0xff) / 255,
  };
}

function formatHex(color: SystemVisualColor): string {
  const red = Math.round(clamp(color.r, 0, 1) * 255);
  const green = Math.round(clamp(color.g, 0, 1) * 255);
  const blue = Math.round(clamp(color.b, 0, 1) * 255);
  return `#${((red << 16) | (green << 8) | blue).toString(16).padStart(6, '0').toUpperCase()}`;
}

function mixHex(left: string, right: string, amount: number): string {
  const first = parseHex(left);
  const second = parseHex(right);
  const weight = clamp(amount, 0, 1);
  return formatHex({
    r: first.r + (second.r - first.r) * weight,
    g: first.g + (second.g - first.g) * weight,
    b: first.b + (second.b - first.b) * weight,
  });
}

function actualDominantStar(system: StarSystem): StarDescriptor {
  let dominant: StarDescriptor | undefined;
  for (const star of system.stars) {
    if (star.systemId !== system.id || !Number.isFinite(star.luminositySolar)) continue;
    if (!dominant || star.luminositySolar > dominant.luminositySolar) dominant = star;
  }
  if (!dominant) throw new RangeError(`System ${system.id} has no real descriptor-backed luminous star.`);
  return dominant;
}

function actualFeaturedPlanet(system: StarSystem): PlanetDescriptor | undefined {
  let featured: PlanetDescriptor | undefined;
  let strongest = Number.NEGATIVE_INFINITY;
  for (const planet of system.planets) {
    if (planet.systemId !== system.id) continue;
    const weight = BIOME_VISUAL_WEIGHT[planet.archetype] +
      (planet.ring ? 0.66 : 0) +
      clamp(planet.atmosphere.density, 0, 1) * 0.18;
    if (weight > strongest) {
      featured = planet;
      strongest = weight;
    }
  }
  return featured;
}

function actualStellarSpectrum(system: StarSystem): SystemVisualColor {
  let total = 0;
  let red = 0;
  let green = 0;
  let blue = 0;
  for (const star of system.stars) {
    if (star.systemId !== system.id || !Number.isFinite(star.luminositySolar)) continue;
    const spectrum = parseHex(star.color);
    const weight = Math.max(0.035, Math.sqrt(Math.max(0, star.luminositySolar)));
    red += spectrum.r * weight;
    green += spectrum.g * weight;
    blue += spectrum.b * weight;
    total += weight;
  }
  if (total <= Number.EPSILON) {
    throw new RangeError(`System ${system.id} cannot derive a spectrum without actual stellar descriptors.`);
  }
  return Object.freeze({ r: red / total, g: green / total, b: blue / total });
}

function chooseVisualFamily(
  dominantStar: StarDescriptor,
  featured: PlanetDescriptor | undefined,
): SystemVisualFamily {
  if (dominantStar.spectralType === 'A' || dominantStar.spectralType === 'F') {
    return 'sapphire-ion';
  }

  const biome = featured?.archetype;
  if (biome === 'frozen' || biome === 'ice-moon' || biome === 'ice-giant') {
    return dominantStar.spectralType === 'M' ? 'crimson-glacial' : 'glacial-aurora';
  }
  if (biome === 'volcanic') return 'ember-forge';
  if (biome === 'desert') return 'amber-drift';
  if (biome === 'temperate') return 'verdant-veil';
  if (biome === 'ocean') return 'aurora-tide';
  return dominantStar.spectralType === 'M' ? 'crimson-glacial' : 'violet-prism';
}

function freezePalette(colors: readonly string[]): readonly string[] {
  return Object.freeze(colors.map((color) => formatHex(parseHex(color))));
}

/**
 * Describe an existing system without changing its bodies, generator, save,
 * stellar identities, or authoritative galactic coordinates. Nearby systems
 * sample one continuous seeded eight-light-year interstellar density field.
 */
export function deriveSystemVisualTheme(
  system: StarSystem,
  universeSeed: string | number = DEFAULT_UNIVERSE_SEED,
): Readonly<SystemVisualTheme> {
  const cacheKey = `${typeof universeSeed}:${String(universeSeed)}`;
  const cached = THEME_CACHE.get(system)?.get(cacheKey);
  if (cached) return cached;

  const seed = deriveSeed(system.seed, 'system-visual-theme', SYSTEM_VISUAL_THEME_VERSION);
  const random = new SeededRandom(seed);
  const dominant = actualDominantStar(system);
  const featured = actualFeaturedPlanet(system);
  const family = chooseVisualFamily(dominant, featured);
  const familyPalette = FAMILY_PALETTES[family];
  const spectrum = actualStellarSpectrum(system);
  const stellarHex = formatHex(spectrum);
  const positionMeters = addressToApproximateMeters(system.position);
  const galacticPositionLightYears = Object.freeze({
    x: positionMeters.x / LIGHT_YEAR_METERS,
    y: positionMeters.y / LIGHT_YEAR_METERS,
    z: positionMeters.z / LIGHT_YEAR_METERS,
  });

  const regionSeed = deriveSeed(universeSeed, 'continuous-galactic-gas', SYSTEM_VISUAL_THEME_VERSION);
  const x = galacticPositionLightYears.x / SYSTEM_VISUAL_SECTOR_LIGHT_YEARS;
  const y = galacticPositionLightYears.y / SYSTEM_VISUAL_SECTOR_LIGHT_YEARS;
  const z = galacticPositionLightYears.z / SYSTEM_VISUAL_SECTOR_LIGHT_YEARS;
  const broadGas = valueNoise3(x, y * 0.84, z, regionSeed);
  const softGas = valueNoise3(
    x * 0.53 + 3.71,
    y * 0.53 - 1.94,
    z * 0.53 + 2.36,
    regionSeed ^ 0x9e37_79b9,
  );
  const sectorDensity = clamp((broadGas * 0.72 + softGas * 0.28 + 1) * 0.5, 0, 1);
  const sectorSeed = deriveSeed(
    universeSeed,
    'galactic-visual-sector',
    Math.floor(x),
    Math.floor(y),
    Math.floor(z),
    SYSTEM_VISUAL_THEME_VERSION,
  );

  const planetLand = featured?.colors.land ?? familyPalette.primary;
  const planetAtmosphere = featured?.colors.atmosphere ?? familyPalette.secondary;
  const physicalAccent = featured?.ring?.color ?? featured?.colors.accent ?? familyPalette.accent;
  const localVariance = random.range(-0.034, 0.034);
  const primaryHex = mixHex(
    mixHex(familyPalette.primary, planetLand, 0.12),
    stellarHex,
    0.055 + sectorDensity * 0.035 + localVariance * 0.4,
  );
  const secondaryHex = mixHex(familyPalette.secondary, planetAtmosphere, 0.23 + sectorDensity * 0.07);
  const accentHex = mixHex(familyPalette.accent, physicalAccent, featured?.ring ? 0.74 : 0.48);
  const shadowHex = mixHex(familyPalette.shadow, featured?.colors.deep ?? familyPalette.shadow, 0.19);
  const dustHex = mixHex(familyPalette.dust, stellarHex, 0.14 + localVariance * 0.6);

  const nebulaPalette = freezePalette([
    mixHex(shadowHex, primaryHex, 0.23),
    mixHex(shadowHex, primaryHex, 0.49),
    mixHex(primaryHex, secondaryHex, 0.22),
    mixHex(primaryHex, accentHex, 0.31),
    mixHex(shadowHex, secondaryHex, 0.54),
    mixHex(secondaryHex, primaryHex, 0.19),
    mixHex(secondaryHex, accentHex, 0.24),
    mixHex(accentHex, primaryHex, 0.32),
    mixHex(primaryHex, stellarHex, 0.2),
  ]);
  const formationPalette = freezePalette([
    shadowHex,
    mixHex(shadowHex, primaryHex, 0.38),
    mixHex(primaryHex, shadowHex, 0.18),
    primaryHex,
    mixHex(primaryHex, accentHex, 0.46),
    accentHex,
    mixHex(primaryHex, secondaryHex, 0.4),
    mixHex(shadowHex, secondaryHex, 0.6),
    secondaryHex,
    mixHex(secondaryHex, accentHex, 0.28),
    mixHex(accentHex, stellarHex, 0.22),
    mixHex(primaryHex, stellarHex, 0.18),
  ]);
  const dustPalette = freezePalette([
    dustHex,
    mixHex(secondaryHex, stellarHex, 0.24),
    mixHex(accentHex, stellarHex, 0.16),
    stellarHex,
  ]);

  const hot = dominant.spectralType === 'A' || dominant.spectralType === 'F';
  const atmosphericRichness = clamp(featured?.atmosphere.density ?? 0, 0, 1);
  const density = clamp(0.44 + sectorDensity * 0.38 + atmosphericRichness * 0.065, 0.38, 0.93);
  const coverage = clamp(0.36 + sectorDensity * 0.27 + atmosphericRichness * 0.085, 0.33, 0.79);
  const curtainWidth = clamp(0.112 + sectorDensity * 0.081 + atmosphericRichness * 0.017, 0.108, 0.206);
  const filamentWidth = clamp(0.035 + sectorDensity * 0.036, 0.031, 0.079);
  const turbulence = clamp(
    0.31 + sectorDensity * 0.35 +
      (family === 'ember-forge' ? 0.12 : hot ? 0.065 : 0) +
      random.range(0, 0.06),
    0.28,
    0.91,
  );
  const brightness = clamp(0.81 + sectorDensity * 0.19 + (hot ? 0.07 : 0) + localVariance, 0.72, 1.13);
  const orientationField = valueNoise3(x * 0.4 + 9.4, y * 0.4, z * 0.4 - 6.1, regionSeed ^ 0x85eb_ca6b);
  const orientationRadians = ((orientationField + 1) * Math.PI + random.range(-0.17, 0.17) +
    Math.PI * 2) % (Math.PI * 2);
  const inclinationRadians = clamp(
    0.075 + sectorDensity * 0.15 + Math.abs(galacticPositionLightYears.y) * 0.0008,
    0.065,
    0.245,
  );

  const theme: Readonly<SystemVisualTheme> = Object.freeze({
    version: SYSTEM_VISUAL_THEME_VERSION,
    id: system.id,
    systemId: system.id,
    name: familyPalette.name,
    family,
    seed,
    dominantStarId: dominant.id,
    dominantSpectralType: dominant.spectralType,
    dominantBiome: featured?.archetype ?? 'none',
    ...(featured ? { dominantPlanetId: featured.id } : {}),
    primaryHex,
    secondaryHex,
    accentHex,
    shadowHex,
    dustHex,
    stellarHex,
    starTint: spectrum,
    density,
    coverage,
    curtainWidth,
    filamentWidth,
    turbulence,
    brightness,
    orientationRadians,
    inclinationRadians,
    galacticPositionLightYears,
    sectorDensity,
    sectorSeed,
    nebulaPalette,
    formationPalette,
    dustPalette,
  });

  let entries = THEME_CACHE.get(system);
  if (!entries) {
    entries = new Map<string, Readonly<SystemVisualTheme>>();
    THEME_CACHE.set(system, entries);
  }
  entries.set(cacheKey, theme);
  return theme;
}
