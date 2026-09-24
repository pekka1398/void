import { Vector3 } from 'three';

import { samplePlanetClimate, type PlanetField } from '../../fields';
import { directionToFaceUv, faceUvToDirection } from '../../terrain/CubeSphere';

export interface SurfaceDetailLayer {
  readonly name: 'regional' | 'horizon' | 'middle' | 'near' | 'fine' | 'ground';
  readonly widthMeters: number;
  readonly segments: number;
  readonly minerals: number;
  readonly outcrops: number;
  readonly fullBelowMeters: number;
  readonly hiddenAboveMeters: number;
}

function smoothstep(value: number, low: number, high: number): number {
  const t = Math.max(0, Math.min(1, (value - low) / Math.max(Number.EPSILON, high - low)));
  return t * t * (3 - 2 * t);
}

/** Actual clearance above signed dry ground, or the physical mean ocean surface. */
export function surfaceDetailClearanceMeters(
  field: PlanetField,
  bodyFixedPositionMeters: Readonly<{ x: number; y: number; z: number }>,
): number {
  const sample = samplePlanetClimate(field, bodyFixedPositionMeters);
  return Math.hypot(bodyFixedPositionMeters.x, bodyFixedPositionMeters.y, bodyFixedPositionMeters.z) -
    field.radius - (sample.ocean ? 0 : sample.heightMeters);
}

/** One bounded hierarchy; its last ring resolves the view at human scale. */
export function createSurfaceDetailLayout(
  radiusMeters: number,
  reducedQuality: boolean,
  atmosphereHeightMeters: number,
  atmosphereDensity: number,
): readonly SurfaceDetailLayer[] {
  const radius = Math.max(1, radiusMeters);
  const horizonScale = (altitude: number, minimum: number) => Math.min(0.26,
    Math.max(minimum, 2.04 * Math.sqrt(altitude * (2 * radius + altitude)) / radius));
  const far = horizonScale(5_600, 0.086);
  const middle = Math.min(far * 0.66, horizonScale(560, reducedQuality ? 0.025 : 0.027));
  const near = Math.min(middle * 0.56, Math.max(reducedQuality ? 0.003 : 0.0035,
    (reducedQuality ? 19_600 : 22_400) / radius));
  const fine = Math.min(near * 0.44, Math.max(reducedQuality ? 0.00048 : 0.0006,
    (reducedQuality ? 3_100 : 3_800) / radius));
  const atmospheric = atmosphereDensity > 0.035 && atmosphereHeightMeters > 250;
  const layer = (name: SurfaceDetailLayer['name'], widthMeters: number, segments: number,
    minerals: number, outcrops: number, fullBelowMeters: number, hiddenAboveMeters: number): SurfaceDetailLayer =>
    Object.freeze({ name, widthMeters, segments, minerals, outcrops, fullBelowMeters, hiddenAboveMeters });
  return Object.freeze([
    layer('regional', radius * 0.34, reducedQuality ? 72 : 84, 36, 64,
      atmospheric ? Math.max(18_000, atmosphereHeightMeters * 0.34) : 38_000,
      atmospheric ? Math.max(90_000, atmosphereHeightMeters * 1.13) : 125_000),
    layer('horizon', radius * far, reducedQuality ? 112 : 128, 0, 0, 160_000, 365_000),
    layer('middle', radius * middle, reducedQuality ? 128 : 160, 0, 0, 28_000, 125_000),
    layer('near', radius * near, reducedQuality ? 112 : 144, 18, 0, 2_400, 16_000),
    layer('fine', radius * fine, reducedQuality ? 128 : 160, 0, 0, 1_800, 3_600),
    // One extra land/wet-water pair, not a full-planet resolution increase.
    // Its <=3.5 m cells meet the existing 1/1.5 m contact mesh at a much
    // smaller interpolation error than the former 24 m innermost ring.
    layer('ground', Math.min(radius * fine * 0.42, reducedQuality ? 384 : 512),
      reducedQuality ? 112 : 160, 0, 0, 360, 1_800),
  ]);
}

export function surfaceDetailPresentation(
  layers: readonly SurfaceDetailLayer[],
  groundClearanceMeters: number,
): readonly number[] {
  const clearance = Math.max(0, Number.isFinite(groundClearanceMeters) ? groundClearanceMeters : Infinity);
  const regional = layers[0];
  if (!regional) return [];
  const parent = 1 - smoothstep(clearance, regional.fullBelowMeters, regional.hiddenAboveMeters);
  return layers.map((layer, index) => index === 0 ? parent :
    parent * (1 - smoothstep(clearance, layer.fullBelowMeters, layer.hiddenAboveMeters)));
}

/** Quantization is in an actual cube-face frame, including negative coordinates and poles. */
export function snapSurfaceDetailDirection(
  direction: Readonly<{ x: number; y: number; z: number }>,
  radiusMeters: number,
  spacingMeters: number,
): Vector3 {
  const face = directionToFaceUv(direction);
  const step = Math.max(0.25, spacingMeters) / Math.max(1, radiusMeters);
  return faceUvToDirection(face.face,
    Math.max(-1, Math.min(1, Math.round(face.u / step) * step)),
    Math.max(-1, Math.min(1, Math.round(face.v / step) * step)));
}

/** Request before the view reaches the edge; queued work never moves published geometry. */
export function surfaceDetailRecenterDistance(layer: SurfaceDetailLayer, clearanceMeters: number): number {
  if (layer.name === 'regional' && clearanceMeters < 38_000) {
    // The scenery has a real ~24 km neighborhood. Retain it across ordinary
    // movement instead of reseeding every 2.2 km alongside the tiny ground ring.
    return Math.min(layer.widthMeters * 0.22, 8_000);
  }
  return Math.max(layer.widthMeters / layer.segments * 4, layer.widthMeters * 0.18);
}

export function surfaceDetailPrewarmClearance(layer: SurfaceDetailLayer, closingSpeedMetersPerSecond: number): number {
  const lead = Math.max(0, Math.min(180_000, closingSpeedMetersPerSecond * 2.5));
  return layer.hiddenAboveMeters + Math.max(layer.name === 'ground' ? 1_200 : 8_000, lead);
}
