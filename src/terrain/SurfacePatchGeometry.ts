import type { Vec3 } from '../core/Vec3';
import {
  samplePlanetClimate,
  samplePlanetField,
  type PlanetField,
  type PlanetSurfaceSample,
  type Rgb,
} from '../fields/PlanetField';
import { hashCoordinates, hashUnit } from '../fields/noise';
import {
  createSurfaceTerrainPalette,
  samplePlanetLandColor,
  samplePlanetWaterColor,
  shadeSurfaceTerrainFacet,
  type SurfaceTerrainPalette,
} from './SurfaceTerrainPresentation';

/** The signed authoritative field has one physical mean-sea datum. */
export const SURFACE_PATCH_SEA_LEVEL_METERS = 0;
export const MAX_SURFACE_PATCH_SEGMENTS = 192;
/** Maximum sampled vertices/cells per cooperative producer step. */
export const SURFACE_PATCH_GEOMETRY_BATCH_SIZE = 64;
const SURFACE_PATCH_PACK_BATCH_SIZE = 4_096;

/** Already-resolved visual dimensions; no renderer, child mask, or live clock. */
export interface SurfacePatchGeometryOptions {
  readonly renderRadius: number;
  readonly direction: Readonly<Vec3>;
  readonly size: number;
  readonly segments: number;
  /** Preserve the primary patch's additional, genuinely dry fissure lines. */
  readonly includeOutcropFacets?: boolean;
  /** Primary decoration needs the same field-derived coast as the wavelets. */
  readonly findShoreline?: boolean;
  /** Return the old grid's ordered candidates for the renderer's flow filter. */
  readonly mineralCandidates?: boolean;
}

export interface SurfacePatchNearbyShoreline {
  readonly waterward: Readonly<Vec3>;
  readonly alongshore: Readonly<Vec3>;
  readonly distanceMeters: number;
}

export interface SurfacePatchGeometryCounts {
  readonly vertices: number;
  readonly triangles: number;
  readonly oceanTriangles: number;
  readonly shorelineSegments: number;
  readonly facetSegments: number;
  readonly waveSegments: number;
  readonly biomeId: string;
}

export interface SurfacePatchGeometryArrays {
  /** One shared grid vertex per sample, in patch-relative render units. */
  readonly terrainPositions: Float32Array;
  readonly terrainColors: Float32Array;
  /** Area-weighted grid normals; the material still uses physical flat shading. */
  readonly terrainNormals: Float32Array;
  /** The unchanged outward-facing physical triangles; 193² vertices fit uint16. */
  readonly terrainIndices: Uint16Array;
  /** Clipped against signed terrain height, never a covering ocean square. */
  readonly oceanPositions: Float32Array;
  readonly oceanColors: Float32Array;
  /** Physical wave-displacement/foam inputs; depths remain real meters. */
  readonly oceanDepths: Float32Array;
  readonly oceanShoreProximities: Float32Array;
  readonly shorePositions: Float32Array;
  readonly facetPositions: Float32Array;
  readonly wavePositions: Float32Array;
  readonly waveColors: Float32Array;
  /** All qualified old-grid candidates, bounded by (192 + 1)^2, in grid order. */
  readonly mineralGridIndices: Uint32Array;
  readonly mineralDirections: Float64Array;
  readonly mineralPositions: Float64Array;
}

/** Immutable structured-clone data. It contains no Three.js objects or GPU resources. */
export interface SurfacePatchGeometryBuffers extends SurfacePatchGeometryArrays {
  readonly centerDirection: Readonly<Vec3>;
  /** Sea-level body-relative origin in render units, matching all returned positions. */
  readonly origin: Readonly<Vec3>;
  readonly originBodyFixedMeters: Readonly<Vec3>;
  readonly tangent: Readonly<Vec3>;
  readonly bitangent: Readonly<Vec3>;
  readonly renderRadius: number;
  readonly patchSize: number;
  readonly segments: number;
  readonly meterScale: number;
  readonly cellMeters: number;
  readonly centerSample: PlanetSurfaceSample;
  readonly nearbyShoreline?: SurfacePatchNearbyShoreline;
  readonly palette: SurfaceTerrainPalette;
  readonly counts: SurfacePatchGeometryCounts;
  /** Exact bytes of the unique transferable ArrayBuffers, excluding small metadata. */
  readonly byteLength: number;
}

// Keep the former Vector3 arithmetic order, including sqrt normalization and
// quaternion rotation. That preserves existing float32 geometry byte-for-byte
// without making the terrain worker import a renderer or the Three.js bundle.
class PatchVector implements Vec3 {
  constructor(public x = 0, public y = 0, public z = 0) {}
  set(x: number, y: number, z: number): this { this.x = x; this.y = y; this.z = z; return this; }
  copy(v: Readonly<Vec3>): this { return this.set(v.x, v.y, v.z); }
  clone(): PatchVector { return new PatchVector(this.x, this.y, this.z); }
  record(): Vec3 { return { x: this.x, y: this.y, z: this.z }; }
  add(v: Readonly<Vec3>): this { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
  sub(v: Readonly<Vec3>): this { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
  addScaledVector(v: Readonly<Vec3>, scale: number): this {
    this.x += v.x * scale; this.y += v.y * scale; this.z += v.z * scale; return this;
  }
  multiplyScalar(scale: number): this { this.x *= scale; this.y *= scale; this.z *= scale; return this; }
  lengthSq(): number { return this.x * this.x + this.y * this.y + this.z * this.z; }
  normalize(): this { return this.multiplyScalar(1 / (Math.sqrt(this.lengthSq()) || 1)); }
  crossVectors(a: Readonly<Vec3>, b: Readonly<Vec3>): this {
    return this.set(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
  }
  lerp(v: Readonly<Vec3>, alpha: number): this {
    this.x += (v.x - this.x) * alpha;
    this.y += (v.y - this.y) * alpha;
    this.z += (v.z - this.z) * alpha;
    return this;
  }
  applyAxisAngle(axis: Readonly<Vec3>, angle: number): this {
    const sine = Math.sin(angle / 2);
    const qx = axis.x * sine, qy = axis.y * sine, qz = axis.z * sine, qw = Math.cos(angle / 2);
    const vx = this.x, vy = this.y, vz = this.z;
    const tx = 2 * (qy * vz - qz * vy);
    const ty = 2 * (qz * vx - qx * vz);
    const tz = 2 * (qx * vy - qy * vx);
    return this.set(vx + qw * tx + qy * tz - qz * ty,
      vy + qw * ty + qz * tx - qx * tz, vz + qw * tz + qx * ty - qy * tx);
  }
}

const vector = (value: Readonly<Vec3>): PatchVector => new PatchVector(value.x, value.y, value.z);

function drainTask<T>(task: Generator<void, T, void>): T {
  let result = task.next();
  while (!result.done) result = task.next();
  return result.value;
}

function* packNumbers<T extends Float32Array | Float64Array | Uint32Array>(
  values: readonly number[], create: (length: number) => T,
): Generator<void, T, void> {
  const packed = create(values.length);
  for (let start = 0; start < values.length; start += SURFACE_PATCH_PACK_BATCH_SIZE) {
    const end = Math.min(values.length, start + SURFACE_PATCH_PACK_BATCH_SIZE);
    for (let index = start; index < end; index += 1) packed[index] = values[index]!;
    yield;
  }
  return packed;
}

function resolvedSegments(value: number): number {
  if (!Number.isFinite(value)) throw new RangeError('Surface patch segments must be finite.');
  return Math.max(8, Math.min(MAX_SURFACE_PATCH_SEGMENTS, Math.round(value)));
}

function coordinateVector(center: Readonly<Vec3>, tangent: Readonly<Vec3>, bitangent: Readonly<Vec3>,
  x: number, y: number, radius: number): PatchVector {
  return vector(center).addScaledVector(tangent, x / radius).addScaledVector(bitangent, y / radius).normalize();
}

/** Exact gnomonic direction used by both worker geometry and retained decoration. */
export function surfacePatchCoordinateDirection(center: Readonly<Vec3>, tangent: Readonly<Vec3>,
  bitangent: Readonly<Vec3>, x: number, y: number, radius: number): Vec3 {
  return coordinateVector(center, tangent, bitangent, x, y, radius).record();
}

interface NearbyShorelineVectors {
  waterward: PatchVector;
  alongshore: PatchVector;
  distanceMeters: number;
}

function* nearbyShorelineTask(field: PlanetField, center: Readonly<Vec3>, tangent: Readonly<Vec3>,
  bitangent: Readonly<Vec3>): Generator<void, NearbyShorelineVectors | undefined, void> {
  if (samplePlanetClimate(field, center).ocean) return undefined;
  const waterward = new PatchVector();
  const direction = new PatchVector();
  for (let index = 0; index < 16; index += 1) {
    const angle = index * Math.PI / 8;
    const x = Math.cos(angle), y = Math.sin(angle);
    for (const meters of [480, 840, 1_260, 1_860, 2_620, 3_400]) {
      direction.copy(center).addScaledVector(tangent, x * meters / field.radius)
        .addScaledVector(bitangent, y * meters / field.radius).normalize();
      if (!samplePlanetClimate(field, direction).ocean) continue;
      const weight = 1 / (0.55 + meters / 950);
      waterward.addScaledVector(tangent, x * weight).addScaledVector(bitangent, y * weight);
      break;
    }
    yield;
  }
  if (waterward.lengthSq() < 0.025) return undefined;
  waterward.normalize();
  let distanceMeters = 0;
  let searchSamples = 0;
  for (let meters = 80; meters <= 3_520; meters += 64) {
    direction.copy(center).addScaledVector(waterward, meters / field.radius).normalize();
    if (samplePlanetClimate(field, direction).ocean) {
      distanceMeters = meters;
      break;
    }
    if (++searchSamples % 8 === 0) yield;
  }
  if (distanceMeters <= 0) return undefined;
  let dry = distanceMeters - 64, wet = distanceMeters;
  for (let iteration = 0; iteration < 7; iteration += 1) {
    const midpoint = (dry + wet) * 0.5;
    direction.copy(center).addScaledVector(waterward, midpoint / field.radius).normalize();
    if (samplePlanetClimate(field, direction).ocean) wet = midpoint;
    else dry = midpoint;
  }
  return { waterward, alongshore: new PatchVector().crossVectors(center, waterward).normalize(), distanceMeters: wet };
}

function shorelineRecord(value: NearbyShorelineVectors): SurfacePatchNearbyShoreline {
  return { waterward: value.waterward.record(), alongshore: value.alongshore.record(), distanceMeters: value.distanceMeters };
}

/** Find the existing real nearby coast; never infer it from a camera or fabricated plane. */
export function findSurfacePatchNearbyShoreline(field: PlanetField, center: Readonly<Vec3>,
  tangent: Readonly<Vec3>, bitangent: Readonly<Vec3>): SurfacePatchNearbyShoreline | undefined {
  const result = drainTask(nearbyShorelineTask(field, center, tangent, bitangent));
  return result ? shorelineRecord(result) : undefined;
}

/** Conservative worst case, including every possible clipped wet triangle/crossing. */
export function estimateSurfacePatchGeometryBytes(options: SurfacePatchGeometryOptions): number {
  const segments = resolvedSegments(options.segments);
  const cells = segments * segments;
  const gridVertices = (segments + 1) ** 2;
  // Land: one position/color/normal per grid vertex and six uint16 indices per cell.
  // Ocean: at most 12 clipped vertices × 8 floats.
  // A four-crossing cell contributes two shore segments. Extra lines are capped.
  return gridVertices * 36 + cells * (12 + 384 + 48) + 72 * 6 * 4 + 128 * 12 * 4 +
    (options.mineralCandidates ? gridVertices * (4 + 6 * 8) : 0);
}

/** Transfer each owned buffer exactly once, including the bounded mineral metadata. */
export function surfacePatchTransferables(buffers: SurfacePatchGeometryArrays): ArrayBuffer[] {
  return [...new Set([
    buffers.terrainPositions.buffer, buffers.terrainColors.buffer, buffers.terrainNormals.buffer,
    buffers.terrainIndices.buffer,
    buffers.oceanPositions.buffer, buffers.oceanColors.buffer, buffers.oceanDepths.buffer,
    buffers.oceanShoreProximities.buffer, buffers.shorePositions.buffer, buffers.facetPositions.buffer,
    buffers.wavePositions.buffer, buffers.waveColors.buffer, buffers.mineralGridIndices.buffer,
    buffers.mineralDirections.buffer, buffers.mineralPositions.buffer,
  ])] as ArrayBuffer[];
}

interface PatchVertex {
  sample: PlanetSurfaceSample;
  direction: PatchVector;
  terrainPosition: PatchVector;
  oceanPosition: PatchVector;
  waterColor: Rgb;
}

interface OceanVertex {
  position: PatchVector;
  color: Rgb;
  heightMeters: number;
  waterDepthMeters: number;
  ocean: boolean;
}

function appendPosition(output: number[], position: Readonly<Vec3>): void {
  output.push(position.x, position.y, position.z);
}

function lerpColor(first: Rgb, second: Rgb, progress: number): Rgb {
  return [first[0] + (second[0] - first[0]) * progress,
    first[1] + (second[1] - first[1]) * progress, first[2] + (second[2] - first[2]) * progress];
}

function appendClippedOceanTriangle(first: PatchVertex, second: PatchVertex, third: PatchVertex,
  positions: number[], colors: number[], depths: number[], shoreProximities: number[]): void {
  if (!first.sample.ocean && !second.sample.ocean && !third.sample.ocean) return;
  const triangle: OceanVertex[] = [first, second, third].map((value) => ({
    position: value.oceanPosition, color: value.waterColor, heightMeters: value.sample.heightMeters,
    waterDepthMeters: value.sample.waterDepthMeters, ocean: value.sample.ocean,
  }));
  const clipped: OceanVertex[] = [];
  for (let index = 0; index < triangle.length; index += 1) {
    const current = triangle[index]!, next = triangle[(index + 1) % triangle.length]!;
    if (current.ocean) clipped.push(current);
    if (current.ocean !== next.ocean) {
      const progress = Math.min(1, Math.max(0, -current.heightMeters / (next.heightMeters - current.heightMeters)));
      clipped.push({ position: current.position.clone().lerp(next.position, progress),
        color: lerpColor(current.color, next.color, progress), heightMeters: 0, waterDepthMeters: 0, ocean: true });
    }
  }
  for (let index = 1; index + 1 < clipped.length; index += 1) {
    for (const item of [clipped[0]!, clipped[index]!, clipped[index + 1]!]) {
      appendPosition(positions, item.position);
      colors.push(item.color[0], item.color[1], item.color[2]);
      depths.push(item.waterDepthMeters);
      shoreProximities.push(Math.exp(-item.waterDepthMeters / 115));
    }
  }
}

function shoreIntersection(first: PatchVertex, second: PatchVertex): PatchVector | null {
  if (first.sample.ocean === second.sample.ocean) return null;
  const denominator = second.sample.heightMeters - first.sample.heightMeters;
  const progress = Math.abs(denominator) < 0.000_000_001
    ? 0.5 : Math.min(1, Math.max(0, -first.sample.heightMeters / denominator));
  return first.oceanPosition.clone().lerp(second.oceanPosition, progress);
}

// Exact linear-sRGB values of the original #278F83 / #126F80 wavelet colors.
const BRIGHT_WAVE_COLOR: Rgb = [0.02028856305209031, 0.2746773120495699, 0.22696587349938613];
const DARK_WAVE_COLOR: Rgb = [0.006048833020386069, 0.158960835050774, 0.21586050010324417];

/**
 * Cooperatively produce the complete close-surface geometry in deterministic order.
 * Every height, wet decision, geological albedo, and world-coordinate hash is
 * sampled from the same deterministic field as collision and orbital terrain.
 * Normal workers drain this task synchronously; the no-worker scheduler can
 * retain it between frames instead of generating a complete patch in one frame.
 */
export function* createSurfacePatchGeometryTask(field: PlanetField,
  options: SurfacePatchGeometryOptions): Generator<void, SurfacePatchGeometryBuffers, void> {
  const renderRadius = Math.max(Number.EPSILON, options.renderRadius);
  const patchSize = options.size;
  if (!Number.isFinite(renderRadius) || !Number.isFinite(patchSize) || patchSize <= 0 ||
    !Number.isFinite(field.radius) || field.radius <= 0 ||
    ![options.direction.x, options.direction.y, options.direction.z].every(Number.isFinite)) {
    throw new RangeError('Surface patch geometry needs finite physical dimensions and direction.');
  }
  const centerDirection = vector(options.direction).normalize();
  if (centerDirection.lengthSq() < 0.5) throw new RangeError('Surface patch direction must be nonzero.');
  const origin = centerDirection.clone().multiplyScalar(renderRadius);
  const reference = Math.abs(centerDirection.y) > 0.9 ? new PatchVector(0, 0, 1) : new PatchVector(0, 1, 0);
  const tangent = new PatchVector().crossVectors(reference, centerDirection).normalize();
  const bitangent = new PatchVector().crossVectors(centerDirection, tangent).normalize();
  const segments = resolvedSegments(options.segments);
  const side = segments + 1;
  const meterScale = renderRadius / field.radius;
  const cellMeters = patchSize / segments / meterScale;
  const centerSample = samplePlanetField(field, centerDirection);
  const palette = createSurfaceTerrainPalette(field);
  let shoreline: NearbyShorelineVectors | undefined;
  if ((options.findShoreline || patchSize / renderRadius <= 0.006) &&
      field.archetype !== 'volcanic' && field.archetype !== 'desert') {
    shoreline = yield* nearbyShorelineTask(field, centerDirection, tangent, bitangent);
  }
  const waveEligible = shoreline !== undefined && patchSize / renderRadius <= 0.006;
  const vertices: PatchVertex[] = [];
  const terrainPositions = new Float32Array(side * side * 3);
  const terrainColors = new Float32Array(terrainPositions.length);
  const terrainNormals = new Float32Array(terrainPositions.length);
  const terrainIndices = new Uint16Array(segments * segments * 6);
  // Keep accurate sums until the final float32 upload; no expanded triangle
  // copies or renderer-side normal calculation are needed.
  const normalSums = new Float64Array(terrainPositions.length);
  const oceanPositions: number[] = [], oceanColors: number[] = [], oceanDepths: number[] = [];
  const oceanShoreProximities: number[] = [], shorePositions: number[] = [], facetPositions: number[] = [];
  const wavePositions: number[] = [], waveColors: number[] = [];
  const mineralGridIndices: number[] = [], mineralDirections: number[] = [], mineralPositions: number[] = [];
  let gridWork = 0;

  for (let row = 0; row <= segments; row += 1) {
    for (let column = 0; column <= segments; column += 1) {
      const x = (column / segments - 0.5) * patchSize;
      const y = (row / segments - 0.5) * patchSize;
      const direction = coordinateVector(centerDirection, tangent, bitangent, x, y, renderRadius);
      // Only riverDirection differs from samplePlanetField; no geometry or
      // palette consumer below reads that expensive downhill heading.
      const sample = samplePlanetClimate(field, direction);
      const terrainPosition = direction.clone().multiplyScalar(renderRadius + sample.heightMeters * meterScale).sub(origin);
      const oceanPosition = direction.clone()
        .multiplyScalar(renderRadius + meterScale * SURFACE_PATCH_SEA_LEVEL_METERS).sub(origin);
      const vertex = row * side + column;
      const offset = vertex * 3;
      terrainPositions[offset] = terrainPosition.x;
      terrainPositions[offset + 1] = terrainPosition.y;
      terrainPositions[offset + 2] = terrainPosition.z;
      const color = samplePlanetLandColor(palette, field, sample, direction, cellMeters);
      terrainColors[offset] = color[0]; terrainColors[offset + 1] = color[1]; terrainColors[offset + 2] = color[2];

      // The same body-fixed, footprint-filtered water albedo is used at every
      // scale. Clipping interpolates it but must not add another tile tint.
      const water = samplePlanetWaterColor(palette, field, sample, direction, cellMeters);
      vertices.push({ sample, direction, terrainPosition, oceanPosition,
        waterColor: [Math.fround(water[0]), Math.fround(water[1]), Math.fround(water[2])] });

      if (options.mineralCandidates && !sample.ocean && sample.normalizedHeight <= 0.17 &&
        hashUnit(field.seed ^ Math.imul(vertex + 1, 2_654_435_761)) <= 0.026) {
        mineralGridIndices.push(vertex);
        appendPosition(mineralDirections, direction);
        appendPosition(mineralPositions, terrainPosition);
      }
      if (++gridWork === SURFACE_PATCH_GEOMETRY_BATCH_SIZE) { gridWork = 0; yield; }
    }
  }
  if (gridWork > 0) yield;

  let terrainIndexOffset = 0;
  const appendTerrainTriangle = (first: number, second: number, third: number): void => {
    terrainIndices[terrainIndexOffset++] = first;
    terrainIndices[terrainIndexOffset++] = second;
    terrainIndices[terrainIndexOffset++] = third;
    const a = first * 3, b = second * 3, c = third * 3;
    const abx = terrainPositions[b]! - terrainPositions[a]!;
    const aby = terrainPositions[b + 1]! - terrainPositions[a + 1]!;
    const abz = terrainPositions[b + 2]! - terrainPositions[a + 2]!;
    const acx = terrainPositions[c]! - terrainPositions[a]!;
    const acy = terrainPositions[c + 1]! - terrainPositions[a + 1]!;
    const acz = terrainPositions[c + 2]! - terrainPositions[a + 2]!;
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    for (const offset of [a, b, c]) {
      normalSums[offset] = normalSums[offset]! + nx;
      normalSums[offset + 1] = normalSums[offset + 1]! + ny;
      normalSums[offset + 2] = normalSums[offset + 2]! + nz;
    }
  };

  let cellWork = 0;
  for (let row = 0; row < segments; row += 1) {
    for (let column = 0; column < segments; column += 1) {
      const bottomLeft = row * side + column, bottomRight = bottomLeft + 1;
      const topLeft = bottomLeft + side, topRight = topLeft + 1;
      appendTerrainTriangle(bottomLeft, bottomRight, topLeft);
      appendTerrainTriangle(bottomRight, topRight, topLeft);
      const first = vertices[bottomLeft]!, second = vertices[bottomRight]!;
      const third = vertices[topRight]!, fourth = vertices[topLeft]!;
      appendClippedOceanTriangle(first, second, fourth, oceanPositions, oceanColors, oceanDepths,
        oceanShoreProximities);
      appendClippedOceanTriangle(second, third, fourth, oceanPositions, oceanColors, oceanDepths,
        oceanShoreProximities);
      const crossings = [shoreIntersection(first, second), shoreIntersection(second, third),
        shoreIntersection(third, fourth), shoreIntersection(fourth, first)]
        .filter((value): value is PatchVector => value !== null);
      if (crossings.length >= 2) { appendPosition(shorePositions, crossings[0]!); appendPosition(shorePositions, crossings[1]!); }
      if (crossings.length === 4) { appendPosition(shorePositions, crossings[2]!); appendPosition(shorePositions, crossings[3]!); }

      const allDry = !first.sample.ocean && !second.sample.ocean && !third.sample.ocean && !fourth.sample.ocean;
      const nearSea = (first.sample.heightMeters + third.sample.heightMeters) * 0.5 < Math.max(700, field.maxHeightMeters * 0.075);
      if (allDry && nearSea && facetPositions.length < 72 * 6 && cellMeters <= 750) {
        const accentSeed = hashCoordinates(Math.floor(first.direction.x * field.radius / 310),
          Math.floor(first.direction.y * field.radius / 310), Math.floor(first.direction.z * field.radius / 310),
          field.seed ^ 0x27d4eb2d);
        const accent = hashUnit(accentSeed);
        if (accent < 0.055) {
          const destination = accent < 0.021 ? third : accent < 0.038 ? second : fourth;
          appendPosition(facetPositions, first.terrainPosition.clone().addScaledVector(first.direction, meterScale * 9));
          appendPosition(facetPositions, destination.terrainPosition.clone().addScaledVector(destination.direction, meterScale * 9));
        }
      }

      const allWet = first.sample.ocean && second.sample.ocean && third.sample.ocean && fourth.sample.ocean;
      if (waveEligible && allWet && wavePositions.length < 128 * 6) {
        const waveSeed = hashCoordinates(column, row, segments, field.seed ^ 0x31c6_8e75);
        const chance = hashUnit(waveSeed);
        if (chance < (cellMeters < 220 ? 0.13 : 0.095)) {
          const center = first.oceanPosition.clone().add(second.oceanPosition).add(third.oceanPosition)
            .add(fourth.oceanPosition).multiplyScalar(0.25);
          const length = meterScale * Math.min(cellMeters * (0.26 + chance * 1.35), 145);
          const crossingAngle = (hashUnit(waveSeed ^ 0x5bc1_4e73) - 0.5) * 1.28;
          const crest = shoreline!.alongshore.clone().applyAxisAngle(centerDirection, crossingAngle);
          const firstDirection = center.clone().addScaledVector(crest, -length * 0.5).add(origin).normalize();
          const secondDirection = center.clone().addScaledVector(crest, length * 0.5).add(origin).normalize();
          if (samplePlanetClimate(field, firstDirection).ocean && samplePlanetClimate(field, secondDirection).ocean) {
            const radius = renderRadius + meterScale * (9 + chance * 18);
            appendPosition(wavePositions, firstDirection.multiplyScalar(radius).sub(origin));
            appendPosition(wavePositions, secondDirection.multiplyScalar(radius).sub(origin));
            const wave = chance < 0.024 ? BRIGHT_WAVE_COLOR : DARK_WAVE_COLOR;
            waveColors.push(...wave, ...wave);
          }
        }
      }
      if (++cellWork === SURFACE_PATCH_GEOMETRY_BATCH_SIZE) { cellWork = 0; yield; }
    }
  }
  if (cellWork > 0) yield;

  for (let vertex = 0; vertex < vertices.length; vertex += 1) {
    const offset = vertex * 3;
    const direction = vertices[vertex]!.direction;
    const normal = new PatchVector(normalSums[offset]!, normalSums[offset + 1]!, normalSums[offset + 2]!);
    if (Number.isFinite(normal.lengthSq()) && normal.lengthSq() > 0) normal.normalize();
    else normal.copy(direction);
    terrainNormals[offset] = normal.x;
    terrainNormals[offset + 1] = normal.y;
    terrainNormals[offset + 2] = normal.z;
    const base: Rgb = [terrainColors[offset]!, terrainColors[offset + 1]!, terrainColors[offset + 2]!];
    const shaded = shadeSurfaceTerrainFacet(palette, field, direction, normal, base, base, cellMeters);
    terrainColors[offset] = shaded[0];
    terrainColors[offset + 1] = shaded[1];
    terrainColors[offset + 2] = shaded[2];
    if ((vertex + 1) % SURFACE_PATCH_GEOMETRY_BATCH_SIZE === 0) yield;
  }
  if (vertices.length % SURFACE_PATCH_GEOMETRY_BATCH_SIZE > 0) yield;

  if (options.includeOutcropFacets && facetPositions.length < 72 * 6) {
    for (let index = 0; index < 176 && facetPositions.length < 72 * 6; index += 1) {
      if (index > 0 && index % 16 === 0) yield;
      const foreground = shoreline !== undefined && index < 48;
      const phase = index * 2.399_963_229_728_653 + hashUnit(field.seed ^ 0x947d_13ab) * Math.PI * 2;
      const spreadMeters = 120 + Math.pow(index / 175, 1.25) * 5_600;
      const coastalGroup = index % 6;
      const alongMeters = [365, 460, 615, 820, 1_105, 735][coastalGroup]! + (Math.floor(index / 6) - 3.5) * 31;
      const inlandMeters = [630, 390, 430, 640, 660, 500][coastalGroup]! +
        (hashUnit(field.seed ^ Math.imul(index + 1, 0x1b87_3593)) - 0.5) * 95;
      const startDirection = foreground
        ? centerDirection.clone().addScaledVector(shoreline!.alongshore, alongMeters / field.radius)
          .addScaledVector(shoreline!.waterward, -inlandMeters / field.radius).normalize()
        : centerDirection.clone().addScaledVector(tangent, Math.cos(phase) * spreadMeters / field.radius)
          .addScaledVector(bitangent, Math.sin(phase) * spreadMeters / field.radius).normalize();
      const startSample = samplePlanetClimate(field, startDirection);
      if (startSample.ocean || startSample.heightMeters <= 0) continue;
      const heading = shoreline?.alongshore.clone() ?? tangent.clone();
      heading.applyAxisAngle(startDirection, (hashUnit(field.seed ^ Math.imul(index + 1, 0x85eb_ca6b)) - 0.5) * 1.9);
      const lengthMeters = (foreground ? 44 : 38) +
        hashUnit(field.seed ^ Math.imul(index + 1, 0xc2b2_ae35)) * (foreground ? 118 : 175);
      const endDirection = startDirection.clone().addScaledVector(heading, lengthMeters / field.radius).normalize();
      const endSample = samplePlanetClimate(field, endDirection);
      if (endSample.ocean || endSample.heightMeters <= 0) continue;
      const start = startDirection.clone().multiplyScalar(renderRadius + (startSample.heightMeters + 2.1) * meterScale).sub(origin);
      const end = endDirection.clone().multiplyScalar(renderRadius + (endSample.heightMeters + 2.1) * meterScale).sub(origin);
      appendPosition(facetPositions, start); appendPosition(facetPositions, end);
      if (index % 5 === 0 && facetPositions.length < 72 * 6) {
        const branchHeading = heading.clone().applyAxisAngle(endDirection, index % 2 === 0 ? 0.79 : -0.76);
        const branchDirection = endDirection.clone().addScaledVector(branchHeading, lengthMeters * 0.46 / field.radius).normalize();
        const branchSample = samplePlanetClimate(field, branchDirection);
        if (!branchSample.ocean && branchSample.heightMeters > 0) {
          appendPosition(facetPositions, end);
          appendPosition(facetPositions, branchDirection.multiplyScalar(renderRadius +
            (branchSample.heightMeters + 2.1) * meterScale).sub(origin));
        }
      }
    }
  }

  const arrays: SurfacePatchGeometryArrays = {
    terrainPositions, terrainColors, terrainNormals, terrainIndices,
    oceanPositions: (yield* packNumbers(oceanPositions, (length) => new Float32Array(length))),
    oceanColors: (yield* packNumbers(oceanColors, (length) => new Float32Array(length))),
    oceanDepths: (yield* packNumbers(oceanDepths, (length) => new Float32Array(length))),
    oceanShoreProximities: (yield* packNumbers(oceanShoreProximities, (length) => new Float32Array(length))),
    shorePositions: (yield* packNumbers(shorePositions, (length) => new Float32Array(length))),
    facetPositions: (yield* packNumbers(facetPositions, (length) => new Float32Array(length))),
    wavePositions: (yield* packNumbers(wavePositions, (length) => new Float32Array(length))),
    waveColors: (yield* packNumbers(waveColors, (length) => new Float32Array(length))),
    mineralGridIndices: (yield* packNumbers(mineralGridIndices, (length) => new Uint32Array(length))),
    mineralDirections: (yield* packNumbers(mineralDirections, (length) => new Float64Array(length))),
    mineralPositions: (yield* packNumbers(mineralPositions, (length) => new Float64Array(length))),
  };
  return {
    ...arrays, centerDirection: centerDirection.record(), origin: origin.record(),
    originBodyFixedMeters: centerDirection.clone().multiplyScalar(field.radius).record(),
    tangent: tangent.record(), bitangent: bitangent.record(), renderRadius, patchSize, segments, meterScale, cellMeters,
    centerSample, ...(shoreline ? { nearbyShoreline: shorelineRecord(shoreline) } : {}), palette,
    counts: { vertices: side * side, triangles: segments * segments * 2, oceanTriangles: oceanPositions.length / 9,
      shorelineSegments: shorePositions.length / 6, facetSegments: facetPositions.length / 6,
      waveSegments: wavePositions.length / 6, biomeId: centerSample.biomeId ?? `${field.archetype}:${centerSample.biome}` },
    byteLength: surfacePatchTransferables(arrays).reduce((total, buffer) => total + buffer.byteLength, 0),
  };
}

/** Worker/fixture convenience path: exactly the same ordered cooperative producer. */
export function buildSurfacePatchGeometryBuffers(field: PlanetField,
  options: SurfacePatchGeometryOptions): SurfacePatchGeometryBuffers {
  return drainTask(createSurfacePatchGeometryTask(field, options));
}
