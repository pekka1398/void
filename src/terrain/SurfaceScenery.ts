import { Color, Matrix4, Quaternion, Vector3 } from 'three';

import type { Vec3 } from '../core/Vec3';
import {
  hashCoordinates,
  hashUnit,
  samplePlanetClimate,
  type PlanetField,
  type PlanetSurfaceSample,
} from '../fields';
import {
  createSurfaceFlowRegionTask,
  isValidSurfaceFlowRegion,
  type SurfaceFlowRegion,
} from './SurfaceFlowField';
import { surfaceFlowContains } from './SurfaceFlowGeometry';
import {
  findSurfacePatchNearbyShoreline,
  MAX_SURFACE_PATCH_SEGMENTS,
  surfacePatchCoordinateDirection,
  type SurfacePatchNearbyShoreline,
} from './SurfacePatchGeometry';
import { createSurfaceTerrainPalette } from './SurfaceTerrainPresentation';

/** Stable packed order shared by worker validation and the two scenery renderers. */
export const SURFACE_SCENERY_BATCH_KINDS = [
  'outcrops', 'minerals', 'vegetation', 'crystals', 'ridges',
  'ecologyFlora', 'ecologyRocks', 'ecologyVents',
] as const;
export type SurfaceSceneryBatchKind = typeof SURFACE_SCENERY_BATCH_KINDS[number];

export const SURFACE_SCENERY_FEATURE_KINDS = [
  'decoration', 'flora', 'ice-crystal', 'desert-mineral', 'mineral',
  'volcanic-rock', 'vent', 'crater',
] as const;
export type SurfaceSceneryFeatureKind = typeof SURFACE_SCENERY_FEATURE_KINDS[number];

/** 640 legacy instances + at most 85 flora, 115 rocks and 40 vents. */
export const MAX_SURFACE_SCENERY_INSTANCES = 880;
export const SURFACE_SCENERY_INSTANCE_BYTES = 16 * 4 + 3 * 4 + 3 * 8 + 2;

export interface SurfaceSceneryOptions {
  readonly renderRadius: number;
  readonly direction: Readonly<Vec3>;
  readonly size: number;
  readonly segments: number;
  readonly outcropCount: number;
  readonly mineralCount: number;
  readonly vegetationCount: number;
  readonly crystalCount: number;
  readonly ridgeCount: number;
  readonly nearbyShoreline?: SurfacePatchNearbyShoreline;
  /** Reuse a contact-pinned liquid region; its physical footprint never moves. */
  readonly flowRegion?: SurfaceFlowRegion;
  readonly includeEcology?: boolean;
  readonly ecologyMaxInstances?: number;
  /** Physics dependency: prepare only the immutable liquid region, never props. */
  readonly flowOnly?: boolean;
}

export interface SurfaceSceneryBatch {
  readonly kind: SurfaceSceneryBatchKind;
  readonly offset: number;
  readonly count: number;
  readonly maximumDistanceMeters: number;
}

export interface SurfaceSceneryBuffers {
  readonly fieldSeed: number;
  readonly fieldVersion: number;
  readonly bodyRadiusMeters: number;
  readonly centerDirection: Readonly<Vec3>;
  /** Every matrix translation is relative to this body-fixed render origin. */
  readonly origin: Readonly<Vec3>;
  readonly renderRadius: number;
  readonly patchSize: number;
  readonly batches: readonly SurfaceSceneryBatch[];
  readonly flowRegion: SurfaceFlowRegion | null;
  readonly instanceMatrices: Float32Array;
  readonly instanceColors: Float32Array;
  readonly instanceDirections: Float64Array;
  readonly instanceKinds: Uint16Array;
  readonly decorationCoverageRadiusMeters: number;
  readonly nearDecorationCoverageRadiusMeters: number;
  readonly ecologyCoverageRadiusMeters: number;
  readonly nearEcologyCoverageRadiusMeters: number;
  readonly ecologyMaximumInstances: number;
  /** Exact unique transferable bytes; the small bounded flow metadata is separate. */
  readonly byteLength: number;
}

interface Anchor {
  direction: Vector3;
  position: Vector3;
  sample: PlanetSurfaceSample;
  distance: number;
  variation: number;
  foreground: boolean;
  kind: SurfaceSceneryFeatureKind;
}

interface PreparedInstance {
  matrix: number[];
  color: readonly [number, number, number];
  direction: Readonly<Vec3>;
  distanceMeters: number;
  kind: number;
}

const UP = new Vector3(0, 1, 0);
const GOLDEN_ANGLE = 2.399_963_229_728_653;
const vector = (value: Readonly<Vec3>): Vector3 => new Vector3(value.x, value.y, value.z);
const plain = (value: Readonly<Vec3>): Readonly<Vec3> => ({ x: value.x, y: value.y, z: value.z });
const boundedCount = (value: number, maximum: number): number =>
  Number.isFinite(value) ? Math.max(0, Math.min(maximum, Math.round(value))) : 0;

function budgets(options: SurfaceSceneryOptions) {
  const outcrops = options.flowOnly ? 0 : boundedCount(options.outcropCount, 128);
  const includeEcology = options.flowOnly || (options.includeEcology ?? outcrops > 0);
  return {
    outcrops,
    minerals: options.flowOnly ? 0 : boundedCount(options.mineralCount, 160),
    vegetation: options.flowOnly ? 0 : boundedCount(options.vegetationCount, 160),
    crystals: options.flowOnly ? 0 : boundedCount(options.crystalCount, 128),
    ridges: options.flowOnly ? 0 : boundedCount(options.ridgeCount, 64),
    includeEcology,
    ecology: includeEcology
      ? boundedCount(options.ecologyMaxInstances ?? 160, 160) : 0,
  };
}

/** Conservative packed-buffer reservation, independent of field sampling. */
export function estimateSurfaceSceneryBytes(options: SurfaceSceneryOptions): number {
  if (options.flowOnly) return 0;
  const count = budgets(options);
  const maximum = count.outcrops + count.minerals + count.vegetation + count.crystals + count.ridges +
    Math.round(count.ecology * .53) + Math.round(count.ecology * .72) + Math.round(count.ecology * .25);
  return Math.min(MAX_SURFACE_SCENERY_INSTANCES, maximum) * SURFACE_SCENERY_INSTANCE_BYTES;
}

export function surfaceSceneryTransferList(buffers: SurfaceSceneryBuffers): ArrayBuffer[] {
  return [...new Set([
    buffers.instanceMatrices.buffer, buffers.instanceColors.buffer,
    buffers.instanceDirections.buffer, buffers.instanceKinds.buffer,
  ])] as ArrayBuffer[];
}

export function getSurfaceSceneryBatch(buffers: SurfaceSceneryBuffers, kind: SurfaceSceneryBatchKind): SurfaceSceneryBatch {
  const batch = buffers.batches[SURFACE_SCENERY_BATCH_KINDS.indexOf(kind)];
  if (!batch || batch.kind !== kind) throw new Error(`Missing prepared surface scenery batch ${kind}.`);
  return batch;
}

/** Query the exact shared channel banks, including tapered and joined sections. */
export function surfaceSceneryOccupiesFlow(
  region: SurfaceFlowRegion | null | undefined,
  directionInput: Readonly<Vec3>,
  safetyMeters = 8,
): boolean {
  if (!region) return false;
  const direction = vector(directionInput).normalize();
  const margin = 6 + Math.max(0, Number.isFinite(safetyMeters) ? safetyMeters : 8);
  for (const flow of region.flows) {
    if (flow.appearance === 'cascade') continue;
    // Published descriptor extents conservatively bound the actual banks.
    // Keep the numerous far-away ecology candidates allocation-free; only a
    // nearby candidate needs the exact convex polygon/margin query.
    const center = flow.centerDirection; const heading = flow.headingBodyFixed;
    const ox = (direction.x - center.x) * region.bodyRadiusMeters;
    const oy = (direction.y - center.y) * region.bodyRadiusMeters;
    const oz = (direction.z - center.z) * region.bodyRadiusMeters;
    const broadMargin = margin * 2 + 1;
    if (Math.abs(ox * heading.x + oy * heading.y + oz * heading.z) > flow.halfLengthMeters + broadMargin) continue;
    const ax = center.y * heading.z - center.z * heading.y;
    const ay = center.z * heading.x - center.x * heading.z;
    const az = center.x * heading.y - center.y * heading.x;
    if (Math.abs(ox * ax + oy * ay + oz * az) > flow.halfWidthMeters + broadMargin) continue;
    if (surfaceFlowContains(region.bodyRadiusMeters, flow, direction, margin)) return true;
  }
  return false;
}

/**
 * All expensive field and placement work is renderer-independent. Workers
 * drain this generator; CPU fallback resumes it between small candidate units.
 * No yield changes the order, seed, transform, or physical liquid footprint.
 */
export function* createSurfaceSceneryTask(
  field: PlanetField,
  options: SurfaceSceneryOptions,
): Generator<void, SurfaceSceneryBuffers, void> {
  const renderRadius = Math.max(Number.EPSILON, options.renderRadius);
  const patchSize = options.size;
  const center = vector(options.direction).normalize();
  if (!Number.isFinite(renderRadius) || !Number.isFinite(patchSize) || patchSize <= 0 ||
    !Number.isFinite(field.radius) || field.radius <= 0 || !Number.isFinite(center.lengthSq()) || center.lengthSq() < .5) {
    throw new RangeError('Surface scenery needs finite physical dimensions and direction.');
  }
  const count = budgets(options);
  const meterScale = renderRadius / field.radius;
  const origin = center.clone().multiplyScalar(renderRadius);
  const reference = Math.abs(center.y) > .9 ? new Vector3(0, 0, 1) : UP;
  const tangent = new Vector3().crossVectors(reference, center).normalize();
  const bitangent = new Vector3().crossVectors(center, tangent).normalize();
  const directionAt = (x: number, y: number): Vector3 => vector(
    surfacePatchCoordinateDirection(center, tangent, bitangent, x, y, renderRadius),
  );
  const localPosition = (direction: Vector3, sample: PlanetSurfaceSample): Vector3 => direction.clone()
    .multiplyScalar(renderRadius + sample.heightMeters * meterScale).sub(origin);
  const palette = createSurfaceTerrainPalette(field);
  const { frozenWorld, desertWorld, volcanicWorld, lushWorld } = palette;
  const color = (rgb: readonly [number, number, number]): Color => new Color().setRGB(...rgb);
  const mint = color(palette.mint);
  const worldHighland = color(palette.worldHighland);
  const midnightLand = color(palette.midnightLand);
  const indigoLand = color(palette.indigoLand);
  const violetLand = color(palette.violetLand);
  const extraBudget = count.vegetation + count.crystals + count.ridges;
  const shorelineRecord = options.nearbyShoreline ?? (extraBudget > 0 &&
    field.archetype !== 'volcanic' && field.archetype !== 'desert'
    ? findSurfacePatchNearbyShoreline(field, center, tangent, bitangent) : undefined);
  const shoreline = shorelineRecord ? {
    waterward: vector(shorelineRecord.waterward), alongshore: vector(shorelineRecord.alongshore),
    distanceMeters: shorelineRecord.distanceMeters,
  } : undefined;
  let flowRegion: SurfaceFlowRegion | null = options.flowRegion ?? null;
  if (flowRegion && !isValidSurfaceFlowRegion(flowRegion, field)) {
    throw new Error('Prepared surface scenery must use the same actual planet liquid region.');
  }
  if (count.includeEcology && !flowRegion) {
    flowRegion = yield* createSurfaceFlowRegionTask(field, {
      centerDirection: center, patchSizeMeters: patchSize / meterScale, maxInstances: count.ecology,
    });
  }
  const occupiesFlow = (direction: Vector3): boolean => surfaceSceneryOccupiesFlow(flowRegion, direction);
  const groups = new Map<SurfaceSceneryBatchKind, PreparedInstance[]>(
    SURFACE_SCENERY_BATCH_KINDS.map((kind) => [kind, []]),
  );
  const transform = new Matrix4();
  const orientation = new Quaternion();
  const yawRotation = new Quaternion();
  const scale = new Vector3();
  const addInstance = (kind: SurfaceSceneryBatchKind, anchor: Pick<Anchor, 'direction' | 'position' | 'distance' | 'kind'>,
    width: number, height: number, depth: number, yaw: number, tone: Color): void => {
    orientation.setFromUnitVectors(UP, anchor.direction).multiply(yawRotation.setFromAxisAngle(UP, yaw));
    transform.compose(anchor.position, orientation, scale.set(width, height, depth));
    groups.get(kind)!.push({ matrix: transform.toArray(), color: [tone.r, tone.g, tone.b],
      direction: plain(anchor.direction), distanceMeters: anchor.distance / meterScale,
      kind: SURFACE_SCENERY_FEATURE_KINDS.indexOf(anchor.kind) });
  };

  const outcrops: Anchor[] = [];
  const outcropAttempts = count.outcrops > 0 ? 384 : 0;
  const minimumOutcropDistance = Math.min(meterScale * 1_150, patchSize * .08);
  const maximumOutcropDistance = patchSize * .46;
  for (let index = 0; index < outcropAttempts; index += 1) {
    yield;
    const angle = index * GOLDEN_ANGLE + hashUnit(field.seed) * Math.PI * 2;
    const progress = index / Math.max(1, outcropAttempts - 1);
    const distance = minimumOutcropDistance + progress * progress * Math.max(0, maximumOutcropDistance - minimumOutcropDistance);
    const direction = directionAt(Math.cos(angle) * distance, Math.sin(angle) * distance);
    const sample = samplePlanetClimate(field, direction);
    if (sample.ocean || sample.heightMeters < .75 || occupiesFlow(direction)) continue;
    if (hashUnit(hashCoordinates(index, 7, 31, field.seed)) > (distance < .023 ? .78 : .56)) continue;
    outcrops.push({ direction, position: localPosition(direction, sample), sample, distance,
      variation: 0, foreground: false, kind: 'decoration' });
    if (outcrops.length >= count.outcrops) break;
  }
  const outcropColors = (frozenWorld ? ['#79A8D2', '#A3D7EF', '#BDEBFA', '#718FC7']
    : desertWorld ? ['#875341', '#B26E51', '#DA8E5F', '#79546B']
      : volcanicWorld ? ['#2D2638', '#423346', '#674556', '#334151']
        : lushWorld ? ['#36555D', '#47636F', '#705B87', '#426F68']
          : ['#443267', '#704487', '#A454AF', '#315B78']).map((value) => new Color(value));
  for (let index = 0; index < outcrops.length; index += 1) {
    yield;
    const anchor = outcrops[index]!;
    const variation = hashUnit(field.seed ^ Math.imul(index + 1, 0x9e3779b1));
    const maximumHeight = Math.min(field.maxHeightMeters * meterScale * .68, patchSize * .026,
      anchor.distance * .095, meterScale * 360);
    const height = maximumHeight * (.24 + variation * .74);
    const width = Math.min(anchor.distance * .09, height * (.9 + variation * .9), meterScale * 440);
    addInstance('outcrops', anchor, width, height, Math.min(width * (.72 + variation * .38), meterScale * 440),
      variation * Math.PI, outcropColors[index % outcropColors.length]!.clone().lerp(violetLand, anchor.sample.slopeHint * .25));
  }

  const vegetation: Anchor[] = [], crystals: Anchor[] = [], ridges: Anchor[] = [];
  const decorationAttempts = extraBudget > 0 ? 720 : 0;
  const shorelineClusterAttempts = shoreline ? Math.min(480, decorationAttempts) : 0;
  const closeShorelineAttempts = Math.min(18, shorelineClusterAttempts);
  const foregroundShorelineAttempts = Math.min(114, shorelineClusterAttempts);
  const maximumDecorationDistance = Math.min(patchSize * .43, meterScale * 64_000);
  const nearDecorationDistance = Math.min(maximumDecorationDistance, meterScale * 24_000);
  const minimumDecorationDistance = Math.min(maximumDecorationDistance * .32, Math.max(meterScale * 42, patchSize * .000_003));
  for (let index = 0; index < decorationAttempts; index += 1) {
    yield;
    let direction: Vector3;
    let distance: number;
    if (shoreline && index < shorelineClusterAttempts) {
      const cluster = Math.floor(index / 6);
      const clusterSeed = hashCoordinates(cluster, 29, 71, field.seed ^ 0x9b32_71d5);
      const close = index < closeShorelineAttempts;
      const foreground = !close && index < foregroundShorelineAttempts;
      const distant = !close && !foreground && cluster % 8 === 7;
      const middle = !close && !foreground && cluster % 8 === 6;
      const foregroundGroup = Math.floor((index - closeShorelineAttempts) / 6);
      const targetInland = [650, 410, 420, 660, 680, 520][foregroundGroup % 6]!;
      const targetAlong = [360, 455, 610, 810, 1_105, 720][foregroundGroup % 6]!;
      const inland = close ? shoreline.distanceMeters * (.1 + hashUnit(clusterSeed) * .5)
        : foreground ? -(targetInland + (hashUnit(clusterSeed ^ 0x41d2_908f) - .5) * 115)
          : -(120 + hashUnit(clusterSeed ^ 0x41d2_908f) * 1_080);
      const sign = close ? 1 : foreground ? (foregroundGroup % 6 === 5 ? -1 : 1) : cluster % 2 === 0 ? 1 : -1;
      const lateral = close ? (hashUnit(clusterSeed ^ 0x68bc_21eb) * 2 - 1) * Math.max(200, shoreline.distanceMeters * .72)
        : foreground ? sign * (targetAlong + (hashUnit(clusterSeed ^ 0x68bc_21eb) - .5) * 95)
          : distant ? sign * Math.min(maximumDecorationDistance / meterScale * .96, 26_000 + hashUnit(clusterSeed ^ 0x68bc_21eb) * 35_000)
            : middle ? sign * Math.min(maximumDecorationDistance / meterScale * .8, 11_000 + hashUnit(clusterSeed ^ 0x68bc_21eb) * 15_000)
              : sign * (1_250 + hashUnit(clusterSeed ^ 0x68bc_21eb) * 9_300);
      const jitterAngle = hashUnit(hashCoordinates(index, 13, 47, field.seed)) * Math.PI * 2;
      const jitter = (close ? 18 : foreground ? 11 : 55) +
        hashUnit(clusterSeed ^ Math.imul(index + 1, 0x9e37_79b1)) * (close ? 85 : foreground ? 44 : 290);
      const shoreward = inland + Math.cos(jitterAngle) * jitter;
      const alongshore = lateral + Math.sin(jitterAngle) * jitter;
      distance = Math.hypot(shoreward, alongshore) * meterScale;
      direction = center.clone().addScaledVector(shoreline.waterward, shoreward / field.radius)
        .addScaledVector(shoreline.alongshore, alongshore / field.radius).normalize();
    } else {
      const angle = index * GOLDEN_ANGLE + hashUnit(field.seed ^ 0xd815_9a4b) * Math.PI * 2;
      const progress = index / Math.max(1, decorationAttempts - 1);
      const ringSeed = hashUnit(hashCoordinates(index, 61, 89, field.seed ^ 0x6fa2_33c1));
      distance = index >= 24 && index % 8 === 7 ? maximumDecorationDistance * (.53 + ringSeed * .43)
        : index >= 24 && index % 8 === 6 ? maximumDecorationDistance * (.2 + ringSeed * .32)
          : minimumDecorationDistance + Math.pow(progress, 1.78) * Math.max(0, nearDecorationDistance - minimumDecorationDistance);
      direction = directionAt(Math.cos(angle) * distance, Math.sin(angle) * distance);
    }
    const sample = samplePlanetClimate(field, direction);
    if (sample.ocean || sample.heightMeters < .3 || sample.slopeHint > .94 || occupiesFlow(direction)) continue;
    const selector = hashUnit(hashCoordinates(index, 17, 53, field.seed ^ 0x51ed_4a27));
    const variation = hashUnit(hashCoordinates(index, 43, 11, field.seed ^ 0x721e_5b93));
    const anchor: Anchor = { direction, position: localPosition(direction, sample), sample, distance, variation,
      foreground: shoreline !== undefined && index >= closeShorelineAttempts && index < foregroundShorelineAttempts,
      kind: 'decoration' };
    if (selector < .48 && vegetation.length < count.vegetation) vegetation.push(anchor);
    else if (selector < .78 && crystals.length < count.crystals) crystals.push(anchor);
    else if (ridges.length < count.ridges && distance > meterScale * 95) ridges.push(anchor);
    if (vegetation.length >= count.vegetation && crystals.length >= count.crystals && ridges.length >= count.ridges) break;
  }
  if (shoreline) for (let index = 0; index < ridges.length; index += 1) {
    yield;
    const foreground = index < 4;
    if (!foreground && ridges[index]!.distance > meterScale * 1_300) continue;
    const along = foreground ? 950 + index * 620 : 1_450 + index * 180;
    const inland = foreground ? 380 + index % 3 * 150 : 460 + index % 5 * 130;
    const direction = center.clone().addScaledVector(shoreline.alongshore, along / field.radius)
      .addScaledVector(shoreline.waterward, -inland / field.radius).normalize();
    const sample = samplePlanetClimate(field, direction);
    if (sample.ocean || sample.heightMeters <= 0 || occupiesFlow(direction)) continue;
    ridges[index] = { direction, position: localPosition(direction, sample), sample,
      distance: Math.hypot(along, inland) * meterScale,
      variation: hashUnit(hashCoordinates(index, 79, 19, field.seed ^ 0xac24_619b)), foreground, kind: 'decoration' };
  }
  const vegetationColors = (frozenWorld ? ['#6D91A7', '#86AAB6', '#7D789C', '#628A98']
    : desertWorld ? ['#85664F', '#898052', '#986F5C', '#6C795B']
      : ['#A45692', '#B3729E', '#8762AB', '#974884', '#41968E']).map((value) => new Color(value));
  for (let index = 0; index < vegetation.length; index += 1) {
    yield;
    const anchor = vegetation[index]!;
    const visualHeight = frozenWorld ? 9 + anchor.variation * 24
      : anchor.foreground ? 24 + anchor.variation * 23 : 16 + anchor.variation * 22;
    const height = Math.min(meterScale * visualHeight, anchor.distance * (anchor.foreground ? .16 : .11));
    const width = height * (frozenWorld ? .77 : desertWorld ? .91 : .94 + anchor.variation * .31);
    addInstance('vegetation', anchor, width, height, width * (.75 + anchor.variation * .34), anchor.variation * Math.PI * 2,
      vegetationColors[index % vegetationColors.length]!.clone().lerp(worldHighland, anchor.sample.geologicalBand * .13));
  }
  const crystalStone = worldHighland.clone().lerp(indigoLand, .56).lerp(midnightLand, .12);
  const crystalColors = [new Color(field.colors.accent).lerp(crystalStone, .67),
    new Color(field.colors.atmosphere).lerp(crystalStone, .7), worldHighland.clone().lerp(indigoLand, .44),
    mint.clone().lerp(crystalStone, .74)];
  for (let index = 0; index < crystals.length; index += 1) {
    yield;
    const anchor = crystals[index]!;
    const height = Math.min(meterScale * (anchor.foreground ? 12 + anchor.variation * 16 : 7 + anchor.variation * 13),
      anchor.distance * (anchor.foreground ? .125 : .09));
    const width = height * (.23 + anchor.variation * .19);
    addInstance('crystals', anchor, width, height * .5, width * (.74 + anchor.variation * .42),
      anchor.variation * Math.PI, crystalColors[index % crystalColors.length]!);
  }
  for (const anchor of ridges) {
    yield;
    const height = Math.min(meterScale * (anchor.foreground
      ? 46 + anchor.variation * 39 + anchor.sample.ridgeStrength * 12
      : 52 + anchor.variation * 68 + anchor.sample.ridgeStrength * 21), anchor.distance * .085, meterScale * 142);
    addInstance('ridges', anchor, Math.min(height * (.9 + anchor.variation * .39), meterScale * 155, anchor.distance * .09),
      height, height * .53, anchor.variation * Math.PI,
      indigoLand.clone().lerp(violetLand, .3 + anchor.sample.geologicalBand * .55));
  }

  const minerals: Array<Pick<Anchor, 'direction' | 'position' | 'distance' | 'kind'>> = [];
  if (count.minerals > 0 && count.outcrops > 0 && vegetation.length + crystals.length + ridges.length > 0) {
    const nearby = [...vegetation, ...crystals, ...ridges];
    for (let index = 0; index < nearby.length && minerals.length < count.minerals; index += 1) {
      yield;
      const anchor = nearby[index * 19 % nearby.length]!;
      const bearing = shoreline?.alongshore.clone() ?? tangent.clone();
      bearing.applyAxisAngle(anchor.direction, hashUnit(field.seed ^ index) * Math.PI * 2);
      const direction = anchor.direction.clone().addScaledVector(bearing,
        (9 + hashUnit(field.seed ^ Math.imul(index + 1, 0x27d4_eb2d)) * 38) / field.radius).normalize();
      const sample = samplePlanetClimate(field, direction);
      if (sample.ocean || sample.heightMeters <= 0 || occupiesFlow(direction)) continue;
      minerals.push({ direction, position: localPosition(direction, sample), distance: direction.distanceTo(center) * renderRadius,
        kind: 'decoration' });
    }
  } else if (count.minerals > 0) {
    const segments = boundedCount(options.segments, MAX_SURFACE_PATCH_SEGMENTS);
    const resolved = Math.max(8, segments);
    const side = resolved + 1;
    for (let vertex = 0; vertex < side * side && minerals.length < count.minerals; vertex += 1) {
      if (vertex % 32 === 0) yield;
      if (hashUnit(field.seed ^ Math.imul(vertex + 1, 2_654_435_761)) > .026) continue;
      const direction = directionAt((vertex % side / resolved - .5) * patchSize,
        (Math.floor(vertex / side) / resolved - .5) * patchSize);
      const sample = samplePlanetClimate(field, direction);
      if (sample.ocean || sample.normalizedHeight > .17 || occupiesFlow(direction)) continue;
      minerals.push({ direction, position: localPosition(direction, sample), distance: direction.distanceTo(center) * renderRadius,
        kind: 'decoration' });
    }
  }
  for (let index = 0; index < minerals.length; index += 1) {
    yield;
    const scale = .44 + hashUnit(field.seed ^ index) * .68;
    addInstance('minerals', minerals[index]!, scale, scale, scale, 0, new Color(1, 1, 1));
  }

  const maximumEcologyMeters = Math.min(68_000, patchSize / meterScale * .44);
  const nearEcologyMeters = Math.min(maximumEcologyMeters, 31_000);
  if (!options.flowOnly && count.ecology > 0 && field.landable) {
    const waterBearing = field.archetype === 'ocean' || field.archetype === 'temperate';
    const volcanic = field.archetype === 'volcanic';
    const frozen = field.archetype === 'frozen' || field.archetype === 'ice-moon';
    const desert = field.archetype === 'desert';
    const floraBudget = waterBearing ? Math.round(count.ecology * .53) : 0;
    const rockBudget = Math.round(count.ecology * (frozen || desert ? .72 : .4));
    const ventBudget = volcanic ? Math.round(count.ecology * .25) : 0;
    const attempts = Math.max(240, Math.min(520, count.ecology * 4));
    const minimumMeters = Math.min(maximumEcologyMeters * .24, 48);
    const flora: Anchor[] = [], rocks: Anchor[] = [], vents: Anchor[] = [];
    for (let index = 0; index < attempts; index += 1) {
      yield;
      const phase = index * GOLDEN_ANGLE + hashUnit(field.seed ^ 0x42cf_761d) * Math.PI * 2;
      const progress = index / Math.max(1, attempts - 1);
      const radialVariation = hashUnit(hashCoordinates(index, 53, 97, field.seed ^ 0x54bd_7163));
      const distanceMeters = index >= 24 && index % 8 === 7 ? maximumEcologyMeters * (.52 + radialVariation * .44)
        : index >= 24 && index % 8 === 6 ? maximumEcologyMeters * (.19 + radialVariation * .34)
          : minimumMeters + Math.pow(progress, 1.63) * Math.max(0, nearEcologyMeters - minimumMeters);
      const direction = center.clone().addScaledVector(tangent, Math.cos(phase) * distanceMeters / field.radius)
        .addScaledVector(bitangent, Math.sin(phase) * distanceMeters / field.radius).normalize();
      // Direction is needed only to construct channels, which were prepared
      // above. Ecology classification uses the cheaper identical climate data.
      const sample = samplePlanetClimate(field, direction);
      if (sample.ocean || sample.heightMeters <= 0 || occupiesFlow(direction)) continue;
      const anchorSeed = hashCoordinates(Math.round(direction.x * 65_536), Math.round(direction.y * 65_536),
        Math.round(direction.z * 65_536), field.seed);
      const variation = hashUnit(anchorSeed ^ 0x91e1_0da5);
      const anchor = (kind: SurfaceSceneryFeatureKind): Anchor => ({ direction, position: localPosition(direction, sample),
        sample, variation, distance: distanceMeters * meterScale, foreground: false, kind });
      if (volcanic && vents.length < ventBudget && (sample.lavaStrength ?? 0) > 0 &&
        (sample.volcanoStrength ?? 0) > .27 && distanceMeters >= 310 && distanceMeters <= 4_400 && variation < .62) {
        vents.push(anchor((sample.craterStrength ?? 0) > .34 ? 'crater' : 'vent'));
      } else if (waterBearing && flora.length < floraBudget && (sample.vegetationDensity ?? 0) > .2 &&
        sample.moisture > .18 && variation < .75) {
        flora.push(anchor('flora'));
      } else if (rocks.length < rockBudget && (sample.mineralRichness ?? 0) > (frozen || desert ? .3 : .38)) {
        rocks.push(anchor(frozen ? 'ice-crystal' : desert ? 'desert-mineral' : volcanic ? 'volcanic-rock' : 'mineral'));
      }
    }
    const populate = function* (kind: SurfaceSceneryBatchKind, anchors: Anchor[], colors: readonly string[],
      minimumHeight: number, maximumHeight: number, widthRatio: number): Generator<void, void, void> {
      const tones = colors.map((value) => new Color(value));
      for (let index = 0; index < anchors.length; index += 1) {
        yield;
        const anchor = anchors[index]!;
        const visibleHeight = minimumHeight + anchor.variation * (maximumHeight - minimumHeight);
        const height = Math.min(visibleHeight * meterScale, Math.max(anchor.distance / meterScale, 36) * meterScale * .17);
        const width = height * widthRatio * (.78 + anchor.variation * .38);
        addInstance(kind, anchor, width, height, width * (.78 + anchor.variation * .32), anchor.variation * Math.PI * 2,
          tones[index % tones.length]!);
      }
    };
    yield* populate('ecologyFlora', flora, field.archetype === 'temperate'
      ? ['#479980', '#73A67C', '#9873AE', '#6189A3'] : ['#9F598F', '#7F61A5', '#489489', '#A96B93'], 10, 31, .94);
    yield* populate('ecologyRocks', rocks, frozen ? ['#9ADBE7', '#74B8D4', '#AEC8E4', '#91D5DF']
      : desert ? ['#D4AB78', '#BA8B62', '#CA996B', '#9F7077']
        : volcanic ? ['#783B51', '#A45852', '#5B3348', '#AA715B'] : ['#64BAAE', '#987AC9', '#55A8A8', '#BB95CE'],
    frozen ? 15 : 9, frozen ? 62 : 37, frozen ? .46 : .66);
    yield* populate('ecologyVents', vents, ['#FFCC72', '#FF8550', '#E85741'], 23, 62, 1.42);
  }

  const total = [...groups.values()].reduce((sum, entries) => sum + entries.length, 0);
  if (total > MAX_SURFACE_SCENERY_INSTANCES) throw new RangeError('Surface scenery exceeded its shared instance bound.');
  const instanceMatrices = new Float32Array(total * 16);
  const instanceColors = new Float32Array(total * 3);
  const instanceDirections = new Float64Array(total * 3);
  const instanceKinds = new Uint16Array(total);
  const batches: SurfaceSceneryBatch[] = [];
  let offset = 0;
  for (const kind of SURFACE_SCENERY_BATCH_KINDS) {
    yield;
    const entries = groups.get(kind)!;
    let maximumDistanceMeters = 0;
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]!;
      instanceMatrices.set(entry.matrix, (offset + index) * 16);
      instanceColors.set(entry.color, (offset + index) * 3);
      instanceDirections.set([entry.direction.x, entry.direction.y, entry.direction.z], (offset + index) * 3);
      instanceKinds[offset + index] = entry.kind;
      maximumDistanceMeters = Math.max(maximumDistanceMeters, entry.distanceMeters);
    }
    batches.push({ kind, offset, count: entries.length, maximumDistanceMeters });
    offset += entries.length;
  }
  return {
    fieldSeed: field.seed, fieldVersion: field.generatorVersion, bodyRadiusMeters: field.radius,
    centerDirection: plain(center), origin: plain(origin), renderRadius, patchSize, batches, flowRegion,
    instanceMatrices, instanceColors, instanceDirections, instanceKinds,
    decorationCoverageRadiusMeters: extraBudget > 0 ? maximumDecorationDistance / meterScale : 0,
    nearDecorationCoverageRadiusMeters: extraBudget > 0 ? nearDecorationDistance / meterScale : 0,
    ecologyCoverageRadiusMeters: count.ecology > 0 ? maximumEcologyMeters : 0,
    nearEcologyCoverageRadiusMeters: count.ecology > 0 ? nearEcologyMeters : 0,
    ecologyMaximumInstances: count.ecology,
    byteLength: instanceMatrices.byteLength + instanceColors.byteLength + instanceDirections.byteLength + instanceKinds.byteLength,
  };
}

/** The worker and synchronous fixtures produce exactly the same packed bytes. */
export function buildSurfaceSceneryBuffers(field: PlanetField, options: SurfaceSceneryOptions): SurfaceSceneryBuffers {
  const task = createSurfaceSceneryTask(field, options);
  for (;;) {
    const step = task.next();
    if (step.done) return step.value;
  }
}
