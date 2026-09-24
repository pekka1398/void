import type { Vec3 } from '../core/Vec3';
import { samplePlanetClimate, type PlanetField, type PlanetSurfaceSample, type Rgb } from '../fields/PlanetField';
import { hashCoordinates, hashUnit } from '../fields/noise';
import { createSurfaceTerrainPalette, samplePlanetSurfaceColor, samplePlanetWaterColor } from './SurfaceTerrainPresentation';

export const MAX_PLANET_PROXY_DETAIL = 4;

export interface PlanetProxyGeometryOptions {
  /** Only render units are scaled; the source field always retains its real radius. */
  readonly renderRadius: number;
  readonly detail?: number;
  readonly elevationExaggeration?: number;
  /** Reuse this exact topology for the body's physical mean-ocean reflection. */
  readonly includeWater?: boolean;
}

/** Plain transferable data, with no renderer, material, or live simulation state. */
export interface PlanetProxyGeometryBuffers {
  readonly positions: Float32Array;
  readonly colors: Float32Array;
  readonly normals: Float32Array;
  readonly waterColors: Float32Array;
  readonly wetness: Float32Array;
  readonly waterDepth: Float32Array;
  readonly facetTone: Float32Array;
  readonly renderRadius: number;
  readonly physicalRadiusMeters: number;
  readonly fieldSeed: number;
  readonly detail: number;
  readonly subdivisions: number;
  readonly triangleCount: number;
  readonly sampleCount: number;
  readonly antiAliasedCoastVertices: number;
  readonly hasWaterAttributes: boolean;
  readonly wetVertexCount: number;
  readonly byteLength: number;
}

interface SampledVertex {
  readonly direction: Vec3;
  readonly sample: PlanetSurfaceSample;
  readonly position: Vec3;
  readonly color: Rgb;
  readonly waterColor: Rgb;
  readonly neighbors: Set<number>;
}

const GOLDEN_RATIO = (1 + Math.sqrt(5)) / 2;
const BASE_VERTICES: readonly Readonly<Vec3>[] = [
  { x: -1, y: GOLDEN_RATIO, z: 0 }, { x: 1, y: GOLDEN_RATIO, z: 0 },
  { x: -1, y: -GOLDEN_RATIO, z: 0 }, { x: 1, y: -GOLDEN_RATIO, z: 0 },
  { x: 0, y: -1, z: GOLDEN_RATIO }, { x: 0, y: 1, z: GOLDEN_RATIO },
  { x: 0, y: -1, z: -GOLDEN_RATIO }, { x: 0, y: 1, z: -GOLDEN_RATIO },
  { x: GOLDEN_RATIO, y: 0, z: -1 }, { x: GOLDEN_RATIO, y: 0, z: 1 },
  { x: -GOLDEN_RATIO, y: 0, z: -1 }, { x: -GOLDEN_RATIO, y: 0, z: 1 },
];
const BASE_FACES = [
  0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11,
  1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8,
  3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9,
  4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1,
] as const;
const BASE_EDGE_RADIANS = Math.acos(1 / Math.sqrt(5));

/** Preserve the established 1,280 / 2,880 / 5,120-face quality levels. */
export function resolvePlanetProxyDetail(detail = 1): number {
  if (!Number.isFinite(detail)) throw new RangeError('Planet proxy detail must be finite.');
  return Math.max(0, Math.min(MAX_PLANET_PROXY_DETAIL, Math.round(detail * 2) / 2));
}

export function planetProxySubdivisions(detail = 1): number {
  const resolved = resolvePlanetProxyDetail(detail);
  const lower = Math.floor(resolved);
  return Math.max(1, Math.min(16, Math.round(2 ** lower * (1 + resolved - lower))));
}

function validateOptions(options: PlanetProxyGeometryOptions): void {
  if (!Number.isFinite(options.renderRadius) || options.renderRadius <= 0 ||
    (options.includeWater !== undefined && typeof options.includeWater !== 'boolean') ||
    (options.elevationExaggeration !== undefined &&
      (!Number.isFinite(options.elevationExaggeration) || options.elevationExaggeration < 0))) {
    throw new RangeError('Planet proxy geometry needs finite positive dimensions.');
  }
}

/** Exact bytes of the nonindexed float32 attributes, including optional water inputs. */
export function estimatePlanetProxyGeometryBytes(options: PlanetProxyGeometryOptions): number {
  validateOptions(options);
  return 20 * planetProxySubdivisions(options.detail) ** 2 * (options.includeWater === true ? 180 : 108);
}

export function planetProxyTransferables(
  buffers: Pick<PlanetProxyGeometryBuffers,
    'positions' | 'colors' | 'normals' | 'waterColors' | 'wetness' | 'waterDepth' | 'facetTone'>,
): ArrayBuffer[] {
  return [...new Set([buffers.positions.buffer, buffers.colors.buffer, buffers.normals.buffer,
    buffers.waterColors.buffer, buffers.wetness.buffer, buffers.waterDepth.buffer, buffers.facetTone.buffer])] as ArrayBuffer[];
}

function normalize(x: number, y: number, z: number): Vec3 {
  const length = Math.sqrt(x * x + y * y + z * z) || 1;
  return { x: x / length, y: y / length, z: z / length };
}

function directionKey(direction: Readonly<Vec3>): string {
  // Adjacent base faces reach their common edge through different arithmetic
  // orders. This key joins only sub-millimeter Earth-scale roundoff, not geography.
  return `${Math.round(direction.x * 1e11)}:${Math.round(direction.y * 1e11)}:${Math.round(direction.z * 1e11)}`;
}

/** One restrained specular tone per actual body-fixed water triangle. */
export function samplePlanetProxyWaterFacetTone(bodyFixedFaceCenter: Readonly<Vec3>, seed: number): number {
  const direction = normalize(bodyFixedFaceCenter.x, bodyFixedFaceCenter.y, bodyFixedFaceCenter.z);
  const cell = (component: number) => Math.floor((component + 1) * 65_536);
  return hashUnit(hashCoordinates(cell(direction.x), cell(direction.y), cell(direction.z), seed ^ 0x4f1b_9c7d));
}

function lerp(first: Readonly<Vec3>, second: Readonly<Vec3>, amount: number): Vec3 {
  return { x: first.x + (second.x - first.x) * amount,
    y: first.y + (second.y - first.y) * amount,
    z: first.z + (second.z - first.z) * amount };
}

/**
 * Cooperative version of the same producer used in real module workers.
 * A yield covers at most 17 grid candidates, 32 coast vertices, or 64 faces.
 * A blocked Worker therefore need not move one whole resolved planet build
 * onto a single render frame.
 */
export function* generatePlanetProxyGeometryBuffers(
  field: PlanetField,
  options: PlanetProxyGeometryOptions,
): Generator<void, PlanetProxyGeometryBuffers, void> {
  validateOptions(options);
  if (!Number.isFinite(field.radius) || field.radius <= 0) {
    throw new RangeError('Planet proxy field radius must be finite and positive.');
  }
  const detail = resolvePlanetProxyDetail(options.detail);
  const subdivisions = planetProxySubdivisions(detail);
  const triangleCount = 20 * subdivisions * subdivisions;
  const renderRadius = options.renderRadius;
  const elevationExaggeration = options.elevationExaggeration ?? 1;
  const includeWater = options.includeWater === true;
  const footprintMeters = field.radius * BASE_EDGE_RADIANS / subdivisions;
  const palette = createSurfaceTerrainPalette(field);
  const vertices: SampledVertex[] = [];
  const vertexIndices = new Map<string, number>();
  const samples = new Map<string, { sample: PlanetSurfaceSample; color: Rgb }>();
  const faces = new Uint32Array(triangleCount * 3);
  let faceOffset = 0;

  const sampleAt = (direction: Vec3): { sample: PlanetSurfaceSample; color: Rgb } => {
    const key = directionKey(direction);
    let value = samples.get(key);
    if (!value) {
      const sample = samplePlanetClimate(field, direction);
      value = { sample, color: samplePlanetSurfaceColor(palette, field, sample, direction, footprintMeters) };
      samples.set(key, value);
    }
    return value;
  };
  const vertexAt = (point: Readonly<Vec3>): number => {
    const direction = normalize(point.x, point.y, point.z);
    const key = directionKey(direction);
    const cached = vertexIndices.get(key);
    if (cached !== undefined) return cached;
    const { sample, color } = sampleAt(direction);
    const surfaceHeight = (sample.ocean ? 0 : sample.heightMeters) * elevationExaggeration;
    const radius = renderRadius * (1 + surfaceHeight / field.radius);
    const index = vertices.length;
    const waterColor = includeWater
      ? samplePlanetWaterColor(palette, field, sample, direction, footprintMeters) : color;
    vertices.push({ direction, sample, color, waterColor, neighbors: new Set(),
      position: { x: direction.x * radius, y: direction.y * radius, z: direction.z * radius } });
    vertexIndices.set(key, index);
    return index;
  };
  const appendFace = (first: number, second: number, third: number): void => {
    faces[faceOffset++] = first;
    faces[faceOffset++] = second;
    faces[faceOffset++] = third;
    vertices[first]!.neighbors.add(second).add(third);
    vertices[second]!.neighbors.add(first).add(third);
    vertices[third]!.neighbors.add(first).add(second);
  };

  for (let face = 0; face < BASE_FACES.length; face += 3) {
    const first = BASE_VERTICES[BASE_FACES[face]!]!;
    const second = BASE_VERTICES[BASE_FACES[face + 1]!]!;
    const third = BASE_VERTICES[BASE_FACES[face + 2]!]!;
    const grid: number[][] = [];
    for (let column = 0; column <= subdivisions; column += 1) {
      const left = lerp(first, third, column / subdivisions);
      const right = lerp(second, third, column / subdivisions);
      const remaining = subdivisions - column;
      const row: number[] = [];
      for (let offset = 0; offset <= remaining; offset += 1) {
        row.push(vertexAt(remaining === 0 ? left : lerp(left, right, offset / remaining)));
      }
      grid.push(row);
      yield;
    }
    for (let column = 0; column < subdivisions; column += 1) {
      for (let faceInRow = 0; faceInRow < 2 * (subdivisions - column) - 1; faceInRow += 1) {
        const row = Math.floor(faceInRow / 2);
        if (faceInRow % 2 === 0) appendFace(grid[column]![row + 1]!, grid[column + 1]![row]!, grid[column]![row]!);
        else appendFace(grid[column]![row + 1]!, grid[column + 1]![row + 1]!, grid[column + 1]![row]!);
      }
    }
  }

  // A sparse dry sample surrounded by genuine ocean should represent its
  // covered area, not paint a continent-sized black pinhole. Every extra
  // sample is on an actual shared-field edge; no invented geographic texture.
  const coverageColors: Rgb[] = [];
  let antiAliasedCoastVertices = 0;
  for (let index = 0; index < vertices.length; index += 1) {
    const vertex = vertices[index]!;
    let color = vertex.color;
    if (!vertex.sample.ocean && vertex.neighbors.size >= 4) {
      const wet = [...vertex.neighbors].filter((neighbor) => vertices[neighbor]!.sample.ocean);
      if (wet.length >= Math.ceil(vertex.neighbors.size * 0.5)) {
        let contributors = 0, red = 0, green = 0, blue = 0;
        for (const neighborIndex of wet) {
          const neighbor = vertices[neighborIndex]!;
          const edge = sampleAt(normalize(vertex.direction.x + neighbor.direction.x,
            vertex.direction.y + neighbor.direction.y, vertex.direction.z + neighbor.direction.z));
          if (edge.sample.ocean) {
            contributors += 1;
            red += edge.color[0]; green += edge.color[1]; blue += edge.color[2];
          }
          contributors += 1;
          red += neighbor.color[0]; green += neighbor.color[1]; blue += neighbor.color[2];
        }
        const coverage = contributors / (vertex.neighbors.size + wet.length);
        const blend = Math.min(0.93, 0.33 + coverage * 0.67);
        color = [color[0] * (1 - blend) + red / contributors * blend,
          color[1] * (1 - blend) + green / contributors * blend,
          color[2] * (1 - blend) + blue / contributors * blend];
        antiAliasedCoastVertices += 1;
      }
    }
    coverageColors.push(color);
    if ((index + 1) % 32 === 0) yield;
  }

  const positions = new Float32Array(triangleCount * 9);
  const colors = new Float32Array(positions.length);
  const normals = new Float32Array(positions.length);
  const waterColors = new Float32Array(includeWater ? positions.length : 0);
  const wetness = new Float32Array(includeWater ? triangleCount * 3 : 0);
  const waterDepth = new Float32Array(wetness.length);
  const facetTone = new Float32Array(wetness.length);
  let wetVertexCount = 0;
  for (let face = 0; face < triangleCount; face += 1) {
    const first = faces[face * 3]!, second = faces[face * 3 + 1]!, third = faces[face * 3 + 2]!;
    const ids = [first, second, third];
    const offset = face * 9;
    const firstDirection = vertices[first]!.direction, secondDirection = vertices[second]!.direction;
    const thirdDirection = vertices[third]!.direction;
    const waterFacet = includeWater ? samplePlanetProxyWaterFacetTone({
      x: firstDirection.x + secondDirection.x + thirdDirection.x,
      y: firstDirection.y + secondDirection.y + thirdDirection.y,
      z: firstDirection.z + secondDirection.z + thirdDirection.z,
    }, field.seed) : 0;
    for (let corner = 0; corner < 3; corner += 1) {
      const index = ids[corner]!;
      const position = vertices[index]!.position;
      const color = coverageColors[index]!;
      const destination = offset + corner * 3;
      positions[destination] = position.x;
      positions[destination + 1] = position.y;
      positions[destination + 2] = position.z;
      colors[destination] = color[0];
      colors[destination + 1] = color[1];
      colors[destination + 2] = color[2];
      if (includeWater) {
        const vertex = vertices[index]!;
        const scalarIndex = face * 3 + corner;
        const wet = vertex.sample.ocean;
        wetness[scalarIndex] = wet ? 1 : 0;
        if (wet) wetVertexCount += 1;
        waterDepth[scalarIndex] = Math.max(0, Math.min(1, vertex.sample.waterDepthMeters / 1_650));
        // One value belongs to one genuine flat triangle. Its seed is the
        // actual body-fixed face center, never the changing triangle index.
        facetTone[scalarIndex] = waterFacet;
        waterColors[destination] = vertex.waterColor[0];
        waterColors[destination + 1] = vertex.waterColor[1];
        waterColors[destination + 2] = vertex.waterColor[2];
      }
    }
    const abx = positions[offset + 3]! - positions[offset]!;
    const aby = positions[offset + 4]! - positions[offset + 1]!;
    const abz = positions[offset + 5]! - positions[offset + 2]!;
    const acx = positions[offset + 6]! - positions[offset]!;
    const acy = positions[offset + 7]! - positions[offset + 1]!;
    const acz = positions[offset + 8]! - positions[offset + 2]!;
    const normal = normalize(aby * acz - abz * acy, abz * acx - abx * acz, abx * acy - aby * acx);
    for (let corner = 0; corner < 3; corner += 1) {
      normals[offset + corner * 3] = normal.x;
      normals[offset + corner * 3 + 1] = normal.y;
      normals[offset + corner * 3 + 2] = normal.z;
    }
    if ((face + 1) % 64 === 0) yield;
  }

  return { positions, colors, normals, waterColors, wetness, waterDepth, facetTone,
    renderRadius, physicalRadiusMeters: field.radius,
    fieldSeed: field.seed, detail, subdivisions, triangleCount, sampleCount: samples.size,
    antiAliasedCoastVertices, hasWaterAttributes: includeWater, wetVertexCount,
    byteLength: positions.byteLength + colors.byteLength + normals.byteLength + waterColors.byteLength +
      wetness.byteLength + waterDepth.byteLength + facetTone.byteLength };
}

export function buildPlanetProxyGeometryBuffers(
  field: PlanetField,
  options: PlanetProxyGeometryOptions,
): PlanetProxyGeometryBuffers {
  const task = generatePlanetProxyGeometryBuffers(field, options);
  let result = task.next();
  while (!result.done) result = task.next();
  return result.value;
}
