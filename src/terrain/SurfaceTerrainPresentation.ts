import type { PlanetArchetype, PlanetField, PlanetSurfaceSample, Rgb } from '../fields/PlanetField';
import { hashCoordinates, hashUnit, type Vec3Like } from '../fields/noise';

export type SurfaceGeologicalPalette =
  | 'layered-indigo-basalt'
  | 'blue-violet-glacial-ice'
  | 'temperate-teal-indigo-valley'
  | 'rust-rose-desert-strata'
  | 'retro-neon-oceanic-shore';

/** One body-specific appearance palette, resolved once into linear-sRGB values. */
export interface SurfaceTerrainPalette {
  readonly archetype: PlanetArchetype;
  readonly frozenWorld: boolean;
  readonly desertWorld: boolean;
  readonly volcanicWorld: boolean;
  readonly lushWorld: boolean;
  readonly deep: Rgb;
  readonly shallow: Rgb;
  readonly accent: Rgb;
  readonly mint: Rgb;
  readonly nearshoreTeal: Rgb;
  readonly oceanIndigo: Rgb;
  readonly worldLand: Rgb;
  readonly worldHighland: Rgb;
  readonly midnightLand: Rgb;
  readonly indigoLand: Rgb;
  readonly violetLand: Rgb;
  readonly polarLand: Rgb;
  readonly lavaLand: Rgb;
  readonly lavaRegionLand: Rgb;
  readonly riverBankLand: Rgb;
  readonly vegetatedLand: Rgb;
  readonly nativeLandBlend: number;
  readonly variationAmplitude: number;
  readonly emissive: Rgb;
  readonly emissiveHex: string;
  readonly emissiveIntensity: number;
  readonly geologicalPalette: SurfaceGeologicalPalette;
  readonly geologicalFacetShadeRange: readonly [number, number];
}

type MutableRgb = [number, number, number];
type TerrainFieldIdentity = Pick<PlanetField, 'radius' | 'seed'>;

/** Rendering metadata only; physical field/generator versions are unchanged. */
export const PLANET_APPEARANCE_POLICY = 'body-fixed-linear-v1' as const;

const FACET_SHADES = Object.freeze([0.89, 0.965, 1.045, 1.115] as const);
const FACET_VIOLET = Object.freeze([0, 0.008, 0.017, 0.027] as const);
const FACET_SHADE_RANGE = Object.freeze([FACET_SHADES[0], FACET_SHADES[3]] as const);
const LITHOLOGY_AXIS_LENGTH = Math.sqrt(0.64 ** 2 + (-0.31) ** 2 + 0.71 ** 2);
const LITHOLOGY_AXIS = Object.freeze({
  x: 0.64 / LITHOLOGY_AXIS_LENGTH,
  y: -0.31 / LITHOLOGY_AXIS_LENGTH,
  z: 0.71 / LITHOLOGY_AXIS_LENGTH,
});

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function smoothRange(low: number, high: number, value: number): number {
  const progress = clamp01((value - low) / Math.max(Number.EPSILON, high - low));
  return progress * progress * (3 - 2 * progress);
}

/** Remove unresolved local color detail, never the body's broad biome palette. */
export function planetAppearanceDetailVisibility(footprintMeters: number, featureMeters: number): number {
  const footprint = Number.isFinite(footprintMeters) ? Math.max(0, footprintMeters) : Number.POSITIVE_INFINITY;
  const feature = Number.isFinite(featureMeters) ? Math.max(1, featureMeters) : 1;
  return 1 - smoothRange(feature * 0.45, feature * 1.8, footprint);
}

// Same transfer function as the pinned Three.js Color working space. Keep it
// here so terrain workers need neither Three.js nor a renderer material.
export function planetSrgbToLinear(value: number): number {
  const channel = Number.isFinite(value) ? clamp01(value) : 0;
  return channel < 0.04045
    ? channel * 0.0773993808
    : Math.pow(channel * 0.9478672986 + 0.0521327014, 2.4);
}

function linearHex(hex: string): Rgb {
  let digits = hex.startsWith('#') ? hex.slice(1) : hex;
  if (/^[0-9a-f]{3}$/i.test(digits)) {
    digits = `${digits[0]}${digits[0]}${digits[1]}${digits[1]}${digits[2]}${digits[2]}`;
  }
  if (!/^[0-9a-f]{6}$/i.test(digits)) {
    throw new RangeError(`Surface terrain colors must be hexadecimal RGB: ${hex}`);
  }
  const value = Number.parseInt(digits, 16);
  return Object.freeze([
    planetSrgbToLinear(((value >>> 16) & 0xff) / 255),
    planetSrgbToLinear(((value >>> 8) & 0xff) / 255),
    planetSrgbToLinear((value & 0xff) / 255),
  ] as const);
}

function copyColor(color: Rgb): MutableRgb {
  return [color[0], color[1], color[2]];
}

/** Match Color.lerp, which deliberately does not clamp its blend argument. */
function lerpColor(color: MutableRgb, target: Rgb, blend: number): MutableRgb {
  color[0] += (target[0] - color[0]) * blend;
  color[1] += (target[1] - color[1]) * blend;
  color[2] += (target[2] - color[2]) * blend;
  return color;
}

function mixedColor(first: Rgb, second: Rgb, blend: number): Rgb {
  return Object.freeze(lerpColor(copyColor(first), second, blend));
}

/** Immutable and structured-cloneable; no scene, camera, or patch-local state. */
export function createSurfaceTerrainPalette(
  field: Pick<PlanetField, 'archetype' | 'colors'>,
): SurfaceTerrainPalette {
  const frozenWorld = field.archetype === 'frozen' || field.archetype === 'ice-moon';
  const desertWorld = field.archetype === 'desert';
  const volcanicWorld = field.archetype === 'volcanic';
  const lushWorld = field.archetype === 'temperate';
  const deep = linearHex(field.colors.deep);
  const shallow = linearHex(field.colors.shallow);
  const accent = linearHex(field.colors.accent);
  const worldLand = linearHex(field.colors.land);
  const worldHighland = linearHex(field.colors.highland);
  const mint = mixedColor(linearHex('#43FFE0'), linearHex(field.colors.atmosphere), frozenWorld ? 0.52 : 0.09);
  const midnightLand = frozenWorld
    ? mixedColor(linearHex('#203A63'), worldLand, 0.32)
    : desertWorld
      ? mixedColor(worldLand, linearHex('#543039'), 0.5)
      : volcanicWorld
        ? mixedColor(linearHex('#151322'), worldLand, 0.24)
        : lushWorld
          ? mixedColor(linearHex('#192E38'), worldLand, 0.22)
          : linearHex('#493460');
  const indigoLand = frozenWorld
    ? mixedColor(linearHex('#487AA2'), worldHighland, 0.23)
    : desertWorld
      ? mixedColor(worldHighland, linearHex('#996149'), 0.55)
      : volcanicWorld
        ? mixedColor(linearHex('#2A243D'), worldHighland, 0.2)
        : lushWorld
          ? mixedColor(linearHex('#376755'), worldHighland, 0.13)
          : linearHex('#76569B');
  const violetLand = frozenWorld
    ? mixedColor(worldHighland, linearHex('#9BCDEF'), 0.44)
    : desertWorld
      ? mixedColor(worldHighland, linearHex('#F4B27C'), 0.28)
      : volcanicWorld
        ? mixedColor(linearHex('#4B344C'), worldHighland, 0.18)
        : lushWorld
          ? mixedColor(linearHex('#688269'), worldHighland, 0.22)
          : mixedColor(linearHex('#B976C2'), worldHighland, 0.19);
  const emissiveHex = frozenWorld ? '#203956' : volcanicWorld ? '#191222' : lushWorld ? '#233928'
    : field.archetype === 'ocean' ? '#301944' : '#311942';

  return Object.freeze({
    archetype: field.archetype,
    frozenWorld,
    desertWorld,
    volcanicWorld,
    lushWorld,
    deep,
    shallow,
    accent,
    mint,
    // Orbital and close water used unrelated bright/dark palettes. Preserve a
    // jewel-teal macro color in one linear working space; real light, depth,
    // cloud shadows, and reflections provide the remaining contrast.
    nearshoreTeal: mixedColor(shallow, linearHex(frozenWorld ? '#2E8CAA' : '#00C6BF'), frozenWorld ? 0.35 : 0.25),
    oceanIndigo: mixedColor(deep, linearHex(frozenWorld ? '#174B6C' : '#087E99'), frozenWorld ? 0.42 : 0.65),
    worldLand,
    worldHighland,
    midnightLand,
    indigoLand,
    violetLand,
    polarLand: mixedColor(linearHex('#A6D3F5'), worldHighland, 0.28),
    lavaLand: linearHex('#583043'),
    lavaRegionLand: linearHex('#583440'),
    riverBankLand: linearHex(lushWorld ? '#3B8060' : '#44676C'),
    vegetatedLand: linearHex('#4BCDA4'),
    nativeLandBlend: frozenWorld ? 0.24 : desertWorld ? 0.47 : volcanicWorld ? 0.13 : lushWorld ? 0.22 : 0.2,
    variationAmplitude: volcanicWorld ? 0.03 : frozenWorld ? 0.038 : 0.05,
    emissive: linearHex(emissiveHex),
    emissiveHex,
    emissiveIntensity: frozenWorld ? 0.28 : volcanicWorld ? 0.2 : lushWorld ? 0.25
      : field.archetype === 'ocean' ? 0.29 : 0.24,
    geologicalPalette: volcanicWorld
      ? 'layered-indigo-basalt'
      : frozenWorld
        ? 'blue-violet-glacial-ice'
        : lushWorld
          ? 'temperate-teal-indigo-valley'
          : desertWorld
            ? 'rust-rose-desert-strata'
            : 'retro-neon-oceanic-shore',
    geologicalFacetShadeRange: FACET_SHADE_RANGE,
  });
}

/**
 * Shared ground/seabed albedo in linear RGB. Direction is normalized and
 * body-fixed. The footprint is the actual geometry/sample spacing in meters,
 * not a camera distance, patch index, or quality-tier identity.
 */
export function samplePlanetLandColor(
  palette: SurfaceTerrainPalette,
  field: TerrainFieldIdentity,
  sample: PlanetSurfaceSample,
  direction: Vec3Like,
  footprintMeters = 0,
): Rgb {
  if (sample.biome === 'gas-band') {
    return [planetSrgbToLinear(sample.color[0]), planetSrgbToLinear(sample.color[1]), planetSrgbToLinear(sample.color[2])];
  }
  const { frozenWorld, desertWorld, volcanicWorld, lushWorld } = palette;
  const elevationBlend = clamp01(sample.normalizedHeight * 2.8);
  const color = sample.ocean
    ? lerpColor(copyColor(palette.deep), palette.shallow, Math.max(0, 0.35 - sample.waterDepthMeters / 5_000))
    : lerpColor(
      lerpColor(
        lerpColor(copyColor(palette.midnightLand), palette.worldLand, palette.nativeLandBlend),
        palette.indigoLand, 0.3 + sample.slopeHint * 0.27,
      ),
      palette.violetLand, elevationBlend * (frozenWorld ? 0.9 : 0.76),
    );

  if (!sample.ocean && frozenWorld && sample.biome === 'polar') {
    lerpColor(color, palette.polarLand, 0.23);
  }
  if (!sample.ocean && volcanicWorld && sample.biome === 'lava') {
    lerpColor(color, palette.lavaLand, 0.16);
  }
  if (!sample.ocean && volcanicWorld && (sample.lavaStrength ?? 0) > 0.15) {
    lerpColor(color, palette.lavaRegionLand, Math.min(0.16, (sample.lavaStrength ?? 0) * 0.14));
  }
  if (!sample.ocean && !volcanicWorld && (sample.riverStrength ?? 0) > 0.22) {
    lerpColor(color, palette.riverBankLand, Math.min(0.17, ((sample.riverStrength ?? 0) - 0.18) * 0.23));
  }
  if (!sample.ocean && lushWorld && (sample.vegetationDensity ?? 0) > 0.48) {
    lerpColor(color, palette.vegetatedLand, ((sample.vegetationDensity ?? 0) - 0.48) * 0.27);
  }
  if (!sample.ocean && !frozenWorld && !desertWorld && !volcanicWorld) {
    lerpColor(color, palette.violetLand, Math.max(0, sample.ridgeStrength - 0.27) * (lushWorld ? 0.1 : 0.18));
  }
  if (!sample.ocean && (sample.craterStrength ?? 0) > 0.6) {
    lerpColor(color, palette.midnightLand, ((sample.craterStrength ?? 0) - 0.6) * 0.4);
  }
  if (!sample.ocean && sample.normalizedHeight < 0.025) {
    lerpColor(color, palette.mint, 0.045);
  }
  if (!sample.ocean && palette.archetype === 'ocean') {
    color[0] = Math.max(0.048, color[0] * 1.18);
    color[1] = Math.max(0.025, color[1] * 1.13);
    color[2] = Math.max(0.098, color[2] * 1.14);
  }

  const landFacet = hashUnit(hashCoordinates(
    Math.floor(direction.x * field.radius / 430),
    Math.floor(direction.y * field.radius / 430),
    Math.floor(direction.z * field.radius / 430),
    field.seed ^ 0x94d049bb,
  ));
  const geologicalTerrace = Math.floor(sample.geologicalBand * 5) * 0.021 +
    Math.floor((sample.mineralRichness ?? 0) * 3) * 0.011;
  const localDetail = planetAppearanceDetailVisibility(footprintMeters, 430);
  const landShade = 0.985 + (landFacet - 0.5) * 0.23 * localDetail + geologicalTerrace;
  color[0] = clamp01(color[0] * landShade);
  color[1] = clamp01(color[1] * landShade);
  color[2] = clamp01(color[2] * landShade);
  return color;
}

/**
 * One mean-water albedo for the globe, worker tiles, and local wave meshes.
 * The water geometry, signed wet mask, and physical zero-meter sea datum are
 * owned by the authoritative field; this function only chooses linear color.
 */
export function samplePlanetWaterColor(
  palette: SurfaceTerrainPalette,
  field: TerrainFieldIdentity,
  sample: PlanetSurfaceSample,
  direction: Vec3Like,
  footprintMeters = 0,
): Rgb {
  const depth = clamp01(Math.pow(Math.max(0, sample.waterDepthMeters) / 3_400, 0.78));
  const color = lerpColor(copyColor(palette.nearshoreTeal), palette.oceanIndigo, 0.12 + depth * 0.64);
  const regional = Math.sin(direction.x * 61.3 + direction.y * 39.7 + direction.z * 83.1 +
    hashUnit(field.seed) * Math.PI * 2) * 0.022;
  const cell = hashUnit(hashCoordinates(
    Math.floor(direction.x * field.radius / 640),
    Math.floor(direction.y * field.radius / 640),
    Math.floor(direction.z * field.radius / 640),
    field.seed ^ 0x45d9f3b,
  ));
  const local = (cell - 0.5) * 0.1 * planetAppearanceDetailVisibility(footprintMeters, 640);
  const shade = 1 + regional + local;
  // Keep truly deep water readable without an orbit-only brightness floor.
  // This is shared albedo, not emission: the actual night side stays dark.
  const luminance = (color[0] * 0.2126 + color[1] * 0.7152 + color[2] * 0.0722) * shade;
  const lift = palette.frozenWorld ? 1 : Math.max(1, 0.18 / Math.max(0.000_01, luminance));
  return [clamp01(color[0] * shade * lift), clamp01(color[1] * shade * lift), clamp01(color[2] * shade * lift)];
}

/** Color of the physical flight envelope: mean ocean where wet, ground elsewhere. */
export function samplePlanetSurfaceColor(
  palette: SurfaceTerrainPalette,
  field: TerrainFieldIdentity,
  sample: PlanetSurfaceSample,
  direction: Vec3Like,
  footprintMeters = 0,
): Rgb {
  return sample.ocean
    ? samplePlanetWaterColor(palette, field, sample, direction, footprintMeters)
    : samplePlanetLandColor(palette, field, sample, direction, footprintMeters);
}

/**
 * Compatibility name for contact/legacy callers. Patch-local additive jitter
 * is intentionally ignored: revisiting the same body coordinate cannot
 * repaint its ground when a grid recenters or changes subdivision count.
 */
export function sampleSurfaceTerrainColor(
  palette: SurfaceTerrainPalette,
  field: TerrainFieldIdentity,
  sample: PlanetSurfaceSample,
  direction: Vec3Like,
  _legacyVariation = 0,
): Rgb {
  return samplePlanetLandColor(palette, field, sample, direction);
}

/**
 * Shade one corner of a physical triangle. Pass its three-corner mean to
 * retain the old 77% plane / 23% corner blend, or omit it for a single color.
 * A numeric slope is 1 - abs(dot(unit normal, unit radial direction)).
 */
export function shadeSurfaceTerrainFacet(
  palette: SurfaceTerrainPalette,
  field: TerrainFieldIdentity,
  centerDirection: Vec3Like,
  physicalNormalOrSlope: Vec3Like | number,
  baseColor: Rgb,
  meanBaseColor: Rgb = baseColor,
  footprintMeters = 0,
): Rgb {
  const geologicalSeed = hashCoordinates(
    Math.floor(centerDirection.x * field.radius / 720),
    Math.floor(centerDirection.y * field.radius / 720),
    Math.floor(centerDirection.z * field.radius / 720),
    field.seed ^ 0x62d4_93ae,
  );
  const planeIndex = Math.min(3, Math.floor(hashUnit(geologicalSeed) * 4));
  const detailVisibility = planetAppearanceDetailVisibility(footprintMeters, 720);
  const planeShade = 1 + (FACET_SHADES[planeIndex]! - 1) * detailVisibility;
  const geologicalViolet = !palette.frozenWorld && !palette.desertWorld && !palette.volcanicWorld
    ? FACET_VIOLET[planeIndex]! * detailVisibility
    : 0;
  const rawSlope = typeof physicalNormalOrSlope === 'number'
    ? physicalNormalOrSlope
    : 1 - Math.abs(
      physicalNormalOrSlope.x * centerDirection.x +
      physicalNormalOrSlope.y * centerDirection.y +
      physicalNormalOrSlope.z * centerDirection.z,
    );
  const physicalSlope = Number.isFinite(rawSlope) ? clamp01(rawSlope) : 0;
  const sediment = Math.sin((
    centerDirection.x * LITHOLOGY_AXIS.x +
    centerDirection.y * LITHOLOGY_AXIS.y +
    centerDirection.z * LITHOLOGY_AXIS.z
  ) * field.radius / 920 + hashUnit(field.seed ^ 0x54e9_716d) * Math.PI * 2);
  const slopeLight = Math.min(0.095, physicalSlope * 0.43) * detailVisibility;
  const sedimentTint = sediment * (!palette.volcanicWorld && !palette.desertWorld ? 0.016 : 0.009) * detailVisibility;
  const meanWeight = 0.77 * detailVisibility;

  return [
    clamp01((meanBaseColor[0] * meanWeight + baseColor[0] * (1 - meanWeight)) *
      (planeShade + slopeLight * 0.56) + geologicalViolet * 0.46 + sedimentTint * 0.52),
    clamp01((meanBaseColor[1] * meanWeight + baseColor[1] * (1 - meanWeight)) *
      (planeShade + slopeLight * 0.3) + sedimentTint * 0.18),
    clamp01((meanBaseColor[2] * meanWeight + baseColor[2] * (1 - meanWeight)) *
      (planeShade + slopeLight) + geologicalViolet + sedimentTint),
  ];
}
