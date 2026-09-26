import { HOLMAN_SPLIT_DISTANCE_RATIOS } from '../lod/PlanetLod';

/** Snapshot of the lab planet that was visually checked for seams on 2026-09-25. */
export const SEAM_TEST_PLANET = {
  name: 'Earth-size exaggerated seam test',
  radiusMeters: 6_371_000,
  minSurfaceHeightMeters: 0,
  maxSurfaceHeightMeters: 500_000,
  occluderRadiusMeters: 6_371_000,
  lodSurfaceBandMeters: 0,
  tileResolution: 33,
  maxLevel: 13,
  splitDistanceRatios: HOLMAN_SPLIT_DISTANCE_RATIOS,
  initialDistanceScale: 1,
  maxCachedTiles: 1800,
  workerCount: 4,
  metersPerRenderUnit: 10_000,
  camera: {
    initialDirection: [0.48, 0.33, 0.81] as const,
    initialDistanceRadii: 2.7,
    maxDistanceRadii: 31,
    fovDegrees: 60,
  },
  /** The viewing camera's split test: the same distance table, scaled, and capped at a level. */
  lodCamera: {
    distanceScale: 1,
    maxLevel: 13,
  },
  probe: {
    initialRadiusRadii: 1.35,
    initialPhiOffsetRadians: -0.4,
  },
  terrain: {
    warpFrequency: 3.1,
    warpOctaves: 3,
    warpStrength: 0.6,
    warpOffsets: [17, -11, 23] as const,
    continentFrequency: 2.7,
    continentOctaves: 5,
    coastStart: -0.11,
    coastEnd: 0.1,
    ridgeFrequencies: [10.5, 23, 49] as const,
    ridgePowers: [4, 3, 2] as const,
    ridgeWeights: [0.56, 0.29, 0.15] as const,
    landBaseHeightFraction: 0.05,
    landMountainHeightFraction: 0.95,
    snowHeightMeters: 330_000,
    rockHeightMeters: 180_000,
    oceanColor: [0.025, 0.12, 0.29] as const,
    snowColor: [0.77, 0.76, 0.72] as const,
    rockColor: [0.38, 0.34, 0.3] as const,
  },
  debug: {
    cameraLod: true,
    horizonCulling: true,
    skirts: false,
    meshWireframe: true,
    tileBoundaries: true,
    colorMode: 'tint',
  },
} as const;

/** Kilometer-scale terrain using the same noise layout for direct comparison. */
export const NORMAL_TERRAIN_PLANET = {
  ...SEAM_TEST_PLANET,
  name: 'Earth-size kilometer-scale terrain',
  maxSurfaceHeightMeters: 12_000,
  terrain: {
    ...SEAM_TEST_PLANET.terrain,
    snowHeightMeters: 7_920,
    rockHeightMeters: 4_320,
  },
} as const;

/** 2 m ground-resolution experiment; the L18 nominal cell is 1.19 m. */
export const LANDING_TEST_PLANET = {
  ...NORMAL_TERRAIN_PLANET,
  name: 'Earth-size landing L18 (~1.2 m/cell)',
  maxLevel: 18,
  // Covers any point from the reference sphere through the declared 12 km terrain range.
  // This is fixed configuration, not a tile-mesh height query.
  lodSurfaceBandMeters: NORMAL_TERRAIN_PLANET.maxSurfaceHeightMeters,
  splitDistanceRatios: [
    Infinity, Infinity, Infinity, 0.45, 0.2, 0.1, 0.05, 0.03,
    0.016, 0.008, 0.004, 0.0023, 0.0014,
    0.0002, 0.00008, 0.00003, 0.000012, 0.0000047,
  ],
  maxCachedTiles: 2400,
  // L14 is about 19 m per cell: ground far from the probe stays readable without an L18 region per camera.
  lodCamera: {
    ...NORMAL_TERRAIN_PLANET.lodCamera,
    maxLevel: 14,
  },
  probe: {
    ...NORMAL_TERRAIN_PLANET.probe,
    initialRadiusRadii: 1 + NORMAL_TERRAIN_PLANET.maxSurfaceHeightMeters / NORMAL_TERRAIN_PLANET.radiusMeters,
  },
  debug: {
    ...NORMAL_TERRAIN_PLANET.debug,
    meshWireframe: false,
    tileBoundaries: false,
  },
} as const;

export const PLANET_PRESETS = {
  seam: SEAM_TEST_PLANET,
  normal: NORMAL_TERRAIN_PLANET,
  landing: LANDING_TEST_PLANET,
} as const;

export type PlanetPresetId = keyof typeof PLANET_PRESETS;
export type PlanetPreset = (typeof PLANET_PRESETS)[PlanetPresetId];

export function planetPreset(id: string): PlanetPreset {
  if (!Object.hasOwn(PLANET_PRESETS, id)) {
    throw new Error(`PlanetPresets.ts: unknown planet preset id=${JSON.stringify(id)}; valid=${Object.keys(PLANET_PRESETS).join(',')}`);
  }
  return PLANET_PRESETS[id as PlanetPresetId];
}
