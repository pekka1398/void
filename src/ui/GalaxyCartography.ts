import { LIGHT_YEAR_METERS } from '../core/units';

const TWO_PI = Math.PI * 2;
const DEFAULT_SECTOR_COUNT = 12;
const CARDINAL_SECTORS = ['E', 'NE', 'N', 'NW', 'W', 'SW', 'S', 'SE'] as const;

/** A catalog-backed nearby system; supplied positions are already in light-years. */
export interface GalacticChartSource {
  id: string;
  name?: string;
  position?: { x: number; y: number; z?: number };
  distanceMeters?: number;
  color?: string;
  starCount?: number;
  spectralClass?: string;
}

export interface GalacticSector {
  index: number;
  angleRadians: number;
  count: number;
  meanDistanceMeters: number;
  memberIds: string[];
}

export interface GalaxyCartography {
  count: number;
  nearestDistanceMeters: number;
  farthestDistanceMeters: number;
  maximumPlanarDistanceLightYears: number;
  maximumDepthLightYears: number;
  spectralCounts: Record<string, number>;
  densitySectors: GalacticSector[];
  rangeBandsMeters: number[];
}

export interface GalacticSystemDescription {
  xLightYears: number;
  yLightYears: number;
  zLightYears: number;
  distanceMeters: number;
  bearingDegrees: number;
  elevationDegrees: number;
  sector: string;
}

export interface GalacticProjectionOptions {
  centerX: number;
  centerY: number;
  maximumPlanarDistanceLightYears: number;
  extent: number;
  flattening?: number;
}

export interface ProjectedGalacticSystem {
  x: number;
  y: number;
  radius: number;
  depthLightYears: number;
  normalizedDepth: number;
}

function finitePosition(source: GalacticChartSource): { x: number; y: number; z: number } | undefined {
  const position = source.position;
  if (!position) return undefined;
  const z = position.z ?? 0;
  if (!Number.isFinite(position.x) || !Number.isFinite(position.y) || !Number.isFinite(z)) return undefined;
  return { x: position.x, y: position.y, z };
}

function sourceDistanceMeters(source: GalacticChartSource): number | undefined {
  if (source.distanceMeters !== undefined && Number.isFinite(source.distanceMeters) && source.distanceMeters >= 0) {
    return source.distanceMeters;
  }

  const position = finitePosition(source);
  if (!position) return undefined;
  return Math.hypot(position.x, position.y, position.z) * LIGHT_YEAR_METERS;
}

function normalizeAngle(radians: number): number {
  return (radians % TWO_PI + TWO_PI) % TWO_PI;
}

function spectralFamily(spectralClass: string | undefined): string {
  const normalized = spectralClass?.trim().toUpperCase();
  const family = normalized?.match(/^[OBAFGKMLTY]/)?.[0];
  return family ?? 'UNCLASSIFIED';
}

function buildRangeBands(farthestDistanceMeters: number): number[] {
  const farthestLightYears = farthestDistanceMeters / LIGHT_YEAR_METERS;
  if (!Number.isFinite(farthestLightYears) || farthestLightYears <= 0) return [];

  const approximateSpacing = farthestLightYears / 4;
  const magnitude = 10 ** Math.floor(Math.log10(approximateSpacing));
  const normalizedSpacing = approximateSpacing / magnitude;
  const niceMultiplier = normalizedSpacing <= 1 ? 1 : normalizedSpacing <= 2 ? 2 : normalizedSpacing <= 5 ? 5 : 10;
  const spacingLightYears = niceMultiplier * magnitude;
  const count = Math.floor(farthestLightYears / spacingLightYears + 1e-9);

  return Array.from({ length: Math.min(count, 8) }, (_, index) =>
    (index + 1) * spacingLightYears * LIGHT_YEAR_METERS);
}

/** Aggregate only supplied reachable systems; empty sectors are measurement bins, never destinations. */
export function buildGalaxyCartography(
  entries: readonly GalacticChartSource[],
  sectorCount = DEFAULT_SECTOR_COUNT,
): GalaxyCartography {
  const count = Number.isFinite(sectorCount) ? Math.max(1, Math.min(36, Math.trunc(sectorCount))) : DEFAULT_SECTOR_COUNT;
  const sectorAngle = TWO_PI / count;
  const densitySectors: GalacticSector[] = Array.from({ length: count }, (_, index) => ({
    index,
    angleRadians: (index + 0.5) * sectorAngle,
    count: 0,
    meanDistanceMeters: 0,
    memberIds: [],
  }));
  const spectralCounts: Record<string, number> = Object.create(null) as Record<string, number>;
  let nearestDistanceMeters = Number.POSITIVE_INFINITY;
  let farthestDistanceMeters = 0;
  let maximumPlanarDistanceLightYears = 0;
  let maximumDepthLightYears = 0;

  for (const entry of entries) {
    const family = spectralFamily(entry.spectralClass);
    spectralCounts[family] = (spectralCounts[family] ?? 0) + 1;

    const distanceMeters = sourceDistanceMeters(entry);
    if (distanceMeters !== undefined) {
      nearestDistanceMeters = Math.min(nearestDistanceMeters, distanceMeters);
      farthestDistanceMeters = Math.max(farthestDistanceMeters, distanceMeters);
    }

    const position = finitePosition(entry);
    if (!position) continue;

    maximumPlanarDistanceLightYears = Math.max(maximumPlanarDistanceLightYears, Math.hypot(position.x, position.y));
    maximumDepthLightYears = Math.max(maximumDepthLightYears, Math.abs(position.z));

    const angle = normalizeAngle(Math.atan2(position.y, position.x));
    const sector = densitySectors[Math.min(count - 1, Math.floor(angle / sectorAngle))]!;
    sector.count += 1;
    sector.memberIds.push(entry.id);
    sector.meanDistanceMeters += distanceMeters ?? 0;
  }

  for (const sector of densitySectors) {
    if (sector.count > 0) sector.meanDistanceMeters /= sector.count;
    sector.memberIds.sort();
  }

  return {
    count: entries.length,
    nearestDistanceMeters: Number.isFinite(nearestDistanceMeters) ? nearestDistanceMeters : 0,
    farthestDistanceMeters,
    maximumPlanarDistanceLightYears,
    maximumDepthLightYears,
    spectralCounts,
    densitySectors,
    rangeBandsMeters: buildRangeBands(farthestDistanceMeters),
  };
}

/** Preserve the authoritative catalog coordinates and expose derived navigation telemetry. */
export function describeGalacticSystem(source: GalacticChartSource): GalacticSystemDescription | undefined {
  const position = finitePosition(source);
  if (!position) return undefined;

  const planarDistance = Math.hypot(position.x, position.y);
  const angle = normalizeAngle(Math.atan2(position.y, position.x));
  const bearingDegrees = angle * 180 / Math.PI;
  const elevationDegrees = Math.atan2(position.z, planarDistance) * 180 / Math.PI;
  const sector = CARDINAL_SECTORS[Math.round(bearingDegrees / 45) % CARDINAL_SECTORS.length]!;

  return {
    xLightYears: position.x,
    yLightYears: position.y,
    zLightYears: position.z,
    distanceMeters: sourceDistanceMeters(source)!,
    bearingDegrees,
    elevationDegrees,
    sector,
  };
}

/** Match the existing logarithmic chart exactly; depth remains truthful annotation metadata. */
export function projectGalacticSystem(
  source: GalacticChartSource,
  options: GalacticProjectionOptions,
): ProjectedGalacticSystem | undefined {
  const position = finitePosition(source);
  if (!position || !Number.isFinite(options.centerX) || !Number.isFinite(options.centerY)
    || !Number.isFinite(options.extent) || options.extent < 0) return undefined;

  const planarDistance = Math.hypot(position.x, position.y);
  const maximumPlanarDistance = Math.max(1, options.maximumPlanarDistanceLightYears);
  if (!Number.isFinite(maximumPlanarDistance)) return undefined;

  const phase = Math.atan2(position.y, position.x);
  const radius = options.extent * (0.25 + Math.log1p(planarDistance / maximumPlanarDistance * 8) / Math.log(9) * 0.75);
  const flattening = Number.isFinite(options.flattening) ? options.flattening! : 0.74;
  const normalizedDepth = Math.max(-1, Math.min(1, position.z / Math.max(maximumPlanarDistance, Math.abs(position.z))));

  return {
    x: options.centerX + Math.cos(phase) * radius,
    y: options.centerY + Math.sin(phase) * radius * flattening,
    radius,
    depthLightYears: position.z,
    normalizedDepth,
  };
}
