import {
  BufferAttribute,
  BufferGeometry,
  Mesh,
  MeshLambertMaterial,
  Vector3,
} from 'three';

import {
  createPlanetField,
  samplePlanetClimate,
  type PlanetField,
  type PlanetFieldInput,
} from '../fields';
import { faceUvToDirection } from './CubeSphere';
import { buildPlanetProxyGeometryBuffers, type PlanetProxyGeometryBuffers } from './PlanetProxyGeometry';
import {
  createSurfaceTerrainPalette,
  PLANET_APPEARANCE_POLICY,
  samplePlanetSurfaceColor,
} from './SurfaceTerrainPresentation';
import { tileBounds, type TerrainTileKey } from './TileKey';

export interface PlanetGeometryOptions {
  /** Camera-relative renderer radius; the field always retains its true SI radius. */
  radius?: number;
  renderRadius?: number;
  resolution?: number;
  detail?: number;
  elevationExaggeration?: number;
  /** Attach shared mean-ocean inputs to the same physical proxy topology. */
  includeWater?: boolean;
  flatShading?: boolean;
  facetVariation?: number;
  /** Compatibility request metadata; all representations now use one linear appearance. */
  orbitalPalette?: 'field' | 'cinematic';
}

export interface TerrainEdgeStitching {
  left?: boolean;
  right?: boolean;
  bottom?: boolean;
  top?: boolean;
}

export interface TerrainTileGeometryOptions extends PlanetGeometryOptions {
  segments?: number;
  tileLocal?: boolean;
  stitchEdges?: TerrainEdgeStitching;
  /** Render-only radial walls close mixed-resolution seams without changing physical terrain. */
  renderSkirts?: boolean;
}

export interface TerrainTileBuffers {
  positions: Float32Array;
  colors: Float32Array;
  indices: Uint16Array | Uint32Array;
  /** The unchanged authoritative square grid is always the vertex/index prefix. */
  gridVertexCount: number;
  gridSegments: number;
  skirtVertexCount: number;
  hasWaterAttributes: boolean;
  /** Scalar mean-ocean inputs; empty when includeWater is false, dry on every skirt vertex. */
  wetness: Float32Array;
  /** Physical water depth normalized to the same 1,650 m range as planet proxies. */
  waterDepth: Float32Array;
  origin: readonly [number, number, number];
  boundsRadius: number;
  byteLength: number;
}

/** Bound expensive physical samples separately from cheap topology writes. */
export const TERRAIN_TILE_SAMPLE_BATCH_SIZE = 16;
export const TERRAIN_TILE_TOPOLOGY_BATCH_SIZE = 128;

function terrainTileLayout(options: TerrainTileGeometryOptions) {
  for (const value of [options.segments, options.renderRadius, options.radius, options.elevationExaggeration]) {
    if (value !== undefined && !Number.isFinite(value)) throw new RangeError('Terrain tile dimensions must be finite.');
  }
  const segments = Math.max(2, Math.min(128, Math.round(options.segments ?? 32)));
  const gridVertexCount = (segments + 1) ** 2;
  const skirtVertexCount = options.renderSkirts === true ? 4 * (segments + 1) : 0;
  const vertexCount = gridVertexCount + skirtVertexCount;
  const indexCount = segments * segments * 6 + (skirtVertexCount > 0 ? segments * 24 : 0);
  const hasWaterAttributes = options.includeWater === true;
  return { segments, gridVertexCount, skirtVertexCount, vertexCount, indexCount, hasWaterAttributes };
}

/** Exact reservation for the five transferable arrays, without sampling the field. */
export function estimateTerrainTileBytes(options: TerrainTileGeometryOptions = {}): number {
  const layout = terrainTileLayout(options);
  return layout.vertexCount * (24 + (layout.hasWaterAttributes ? 8 : 0)) +
    layout.indexCount * (layout.vertexCount > 65_535 ? 4 : 2);
}

export function terrainTileTransferList(
  buffers: Pick<TerrainTileBuffers, 'positions' | 'colors' | 'indices' | 'wetness' | 'waterDepth'>,
): ArrayBuffer[] {
  return [...new Set([buffers.positions.buffer, buffers.colors.buffer, buffers.indices.buffer,
    buffers.wetness.buffer, buffers.waterDepth.buffer])] as ArrayBuffer[];
}

/**
 * The supported v1/v2 rendered field cannot fall below this radial shell.
 * Wet terrain uses mean sea level; signed desert/volcanic base relief is
 * >=(-.9788-seaLevel)*maxHeight and later dry additions cannot cross zero.
 * A whole root-cell diagonal fits within 2*atan(sqrt(2)/segments), so its
 * chord is a conservative lower bound even beside an unsplit root tile.
 * Unknown envelopes fall back to the body center, never a guessed small gap.
 */
function terrainTileSkirtRadius(field: PlanetField, radius: number, segments: number, exaggeration: number): number {
  if (!field.landable || field.generatorVersion < 1 || field.generatorVersion > 2 ||
    !Number.isFinite(field.radius) || field.radius <= 0 || !Number.isFinite(field.maxHeightMeters) ||
    field.maxHeightMeters < 0 || !Number.isFinite(field.seaLevel) || exaggeration < 0) return 0;
  const signedDry = field.archetype === 'desert' || field.archetype === 'volcanic';
  const minimumHeightMeters = (signedDry
    ? Math.min(0, (-1 - field.seaLevel) * field.maxHeightMeters * exaggeration) : 0) - 2;
  const minimumRadius = radius * Math.max(0, 1 + minimumHeightMeters / field.radius);
  const rootChordRatio = Math.cos(2 * Math.atan(Math.SQRT2 / segments));
  // This also covers conversion of body-centered render coordinates to float32.
  return Math.max(0, minimumRadius * rootChordRatio - radius * 0.000_001);
}

function resolveField(input: PlanetField | PlanetFieldInput): PlanetField {
  return 'landable' in input ? input : createPlanetField(input);
}

function resolveRenderRadius(field: PlanetField, options: PlanetGeometryOptions): number {
  return Math.max(Number.EPSILON, options.renderRadius ?? options.radius ?? field.radius);
}

function resolveDetail(options: PlanetGeometryOptions): number {
  const requested = options.detail ?? options.resolution ?? 3;
  const detail = requested > 6 ? Math.round(Math.log2(requested / 3)) : requested;
  return Math.max(0, Math.min(4, Math.round(detail * 2) / 2));
}

/** Install already generated worker data without resampling the physical field. */
export function planetProxyGeometryFromBuffers(buffers: PlanetProxyGeometryBuffers): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(buffers.positions, 3));
  geometry.setAttribute('color', new BufferAttribute(buffers.colors, 3));
  geometry.setAttribute('normal', new BufferAttribute(buffers.normals, 3));
  if (buffers.hasWaterAttributes) {
    geometry.setAttribute('waterColor', new BufferAttribute(buffers.waterColors, 3));
    geometry.setAttribute('wetness', new BufferAttribute(buffers.wetness, 1));
    geometry.setAttribute('waterDepth', new BufferAttribute(buffers.waterDepth, 1));
    geometry.setAttribute('facetTone', new BufferAttribute(buffers.facetTone, 1));
  }
  geometry.computeBoundingSphere();
  geometry.userData.planetFieldSeed = buffers.fieldSeed;
  geometry.userData.physicalRadiusMeters = buffers.physicalRadiusMeters;
  geometry.userData.renderRadius = buffers.renderRadius;
  geometry.userData.proxyDetail = buffers.detail;
  geometry.userData.proxySubdivisions = buffers.subdivisions;
  geometry.userData.planetAppearancePolicy = PLANET_APPEARANCE_POLICY;
  geometry.userData.linearPlanetVertexColors = true;
  geometry.userData.bodyFixedGeologicalFacets = true;
  geometry.userData.authenticRegionalStrata = true;
  geometry.userData.triangleCount = buffers.triangleCount;
  geometry.userData.antiAliasedCoastVertices = buffers.antiAliasedCoastVertices;
  geometry.userData.sharedFieldSamples = buffers.sampleCount;
  geometry.userData.sharedFieldWetVertices = buffers.wetVertexCount;
  geometry.userData.hasWaterAttributes = buffers.hasWaterAttributes;
  return geometry;
}

/** The real worker and synchronous callers use one proxy topology/color producer. */
export function createPlanetGeometry(
  input: PlanetField | PlanetFieldInput,
  options: PlanetGeometryOptions = {},
): BufferGeometry {
  const field = resolveField(input);
  const buffers = buildPlanetProxyGeometryBuffers(field, {
    renderRadius: resolveRenderRadius(field, options),
    detail: resolveDetail(options),
    elevationExaggeration: options.elevationExaggeration,
    includeWater: options.includeWater,
  });
  const geometry = planetProxyGeometryFromBuffers(buffers);
  geometry.userData.planetField = field;
  // Retain this request metadata for old callers, not a second color policy.
  geometry.userData.orbitalPalette = options.orbitalPalette ?? 'field';
  return geometry;
}

/** Legacy-compatible material; live render paths use createPlanetLandMaterial. */
export function createPlanetMaterial(
  options: PlanetGeometryOptions = {},
  input: PlanetField | PlanetFieldInput = {},
): MeshLambertMaterial {
  const field = resolveField(input);
  const palette = createSurfaceTerrainPalette(field);
  const material = new MeshLambertMaterial({
    color: '#FFFFFF',
    vertexColors: true,
    flatShading: options.flatShading ?? true,
    emissive: palette.emissiveHex,
    emissiveIntensity: palette.emissiveIntensity,
  });
  material.userData.planetAppearancePolicy = PLANET_APPEARANCE_POLICY;
  material.userData.linearPlanetVertexColors = true;
  material.userData.geologicalPalette = palette.geologicalPalette;
  return material;
}

export function createPlanetMesh(
  input: PlanetField | PlanetFieldInput,
  options: PlanetGeometryOptions = {},
): Mesh<BufferGeometry, MeshLambertMaterial> {
  const field = resolveField(input);
  const mesh = new Mesh(createPlanetGeometry(field, options), createPlanetMaterial(options, field));
  mesh.name = `planet-${field.archetype}-${field.seed.toString(16)}`;
  mesh.userData.planetField = field;
  mesh.userData.physicalRadiusMeters = field.radius;
  mesh.userData.renderRadius = resolveRenderRadius(field, options);
  return mesh;
}

function snapFineBoundary(
  coordinate: number,
  segments: number,
  shouldSnap: boolean,
): number {
  if (!shouldSnap || coordinate % 2 === 0 || coordinate === segments) return coordinate;
  return coordinate - 1;
}

/**
 * One exact producer for native workers and the time-sliced no-worker path.
 * Yield only between completed vertices/cells, never expose partial buffers,
 * and preserve the authoritative square-grid prefix before render-only walls.
 */
export function* createTerrainTileGeometryTask(
  fieldInput: PlanetField | PlanetFieldInput,
  key: TerrainTileKey,
  options: TerrainTileGeometryOptions = {},
): Generator<void, TerrainTileBuffers, void> {
  const field = resolveField(fieldInput);
  const layout = terrainTileLayout(options);
  if (!Number.isFinite(field.radius) || field.radius <= 0) throw new RangeError('Terrain tiles need a finite positive body radius.');
  const radius = resolveRenderRadius(field, options);
  const segments = layout.segments;
  const verticesPerSide = segments + 1;
  const { vertexCount, gridVertexCount, skirtVertexCount, hasWaterAttributes } = layout;
  const positions = new Float32Array(vertexCount * 3);
  const colors = new Float32Array(vertexCount * 3);
  const wetness = new Float32Array(hasWaterAttributes ? vertexCount : 0);
  const waterDepth = new Float32Array(wetness.length);
  const IndexArray = vertexCount > 65_535 ? Uint32Array : Uint16Array;
  const indices = new IndexArray(layout.indexCount);
  const bounds = tileBounds(key);
  const palette = createSurfaceTerrainPalette(field);
  const footprintMeters = field.radius * Math.max(bounds.maxU - bounds.minU, bounds.maxV - bounds.minV) / segments;
  const centerDirection = faceUvToDirection(
    key.face,
    (bounds.minU + bounds.maxU) / 2,
    (bounds.minV + bounds.maxV) / 2,
  );
  const centerSample = samplePlanetClimate(field, centerDirection);
  const centerRadius = radius * (1 + (centerSample.ocean ? 0 : centerSample.heightMeters) / field.radius);
  const originVector = options.tileLocal
    ? centerDirection.multiplyScalar(centerRadius)
    : new Vector3();
  const origin: [number, number, number] = [originVector.x, originVector.y, originVector.z];
  const direction = new Vector3();
  let maximumDistanceSquared = 0;
  // Allocation, palette setup, and the single center sample form their own
  // bounded step instead of being added to the first expensive sampling batch.
  yield;

  let sampleWork = 0;
  for (let row = 0; row <= segments; row += 1) {
    for (let column = 0; column <= segments; column += 1) {
      let sampledColumn = column;
      let sampledRow = row;

      if (column === 0) sampledRow = snapFineBoundary(row, segments, options.stitchEdges?.left ?? false);
      if (column === segments) sampledRow = snapFineBoundary(row, segments, options.stitchEdges?.right ?? false);
      if (row === 0) sampledColumn = snapFineBoundary(column, segments, options.stitchEdges?.bottom ?? false);
      if (row === segments) sampledColumn = snapFineBoundary(column, segments, options.stitchEdges?.top ?? false);

      const u = bounds.minU + (sampledColumn / segments) * (bounds.maxU - bounds.minU);
      const v = bounds.minV + (sampledRow / segments) * (bounds.maxV - bounds.minV);
      faceUvToDirection(key.face, u, v, direction);
      const sample = samplePlanetClimate(field, direction);
      const surfaceHeight = (sample.ocean ? 0 : sample.heightMeters) * (options.elevationExaggeration ?? 1);
      const surfaceRadius = radius * (1 + surfaceHeight / field.radius);
      const vertex = row * verticesPerSide + column;
      const offset = vertex * 3;
      const x = direction.x * surfaceRadius - originVector.x;
      const y = direction.y * surfaceRadius - originVector.y;
      const z = direction.z * surfaceRadius - originVector.z;
      positions[offset] = x;
      positions[offset + 1] = y;
      positions[offset + 2] = z;
      const color = samplePlanetSurfaceColor(palette, field, sample, direction, footprintMeters);
      colors[offset] = color[0];
      colors[offset + 1] = color[1];
      colors[offset + 2] = color[2];
      if (hasWaterAttributes) {
        wetness[vertex] = sample.ocean ? 1 : 0;
        waterDepth[vertex] = Math.max(0, Math.min(1, sample.waterDepthMeters / 1_650));
      }
      maximumDistanceSquared = Math.max(maximumDistanceSquared, x * x + y * y + z * z);
      if (++sampleWork === TERRAIN_TILE_SAMPLE_BATCH_SIZE) { sampleWork = 0; yield; }
    }
  }
  if (sampleWork > 0) yield;

  let index = 0;
  let indexWork = 0;

  for (let row = 0; row < segments; row += 1) {
    for (let column = 0; column < segments; column += 1) {
      const bottomLeft = row * verticesPerSide + column;
      const bottomRight = bottomLeft + 1;
      const topLeft = bottomLeft + verticesPerSide;
      const topRight = topLeft + 1;

      indices[index++] = bottomLeft;
      indices[index++] = bottomRight;
      indices[index++] = topLeft;
      indices[index++] = bottomRight;
      indices[index++] = topRight;
      indices[index++] = topLeft;
      if (++indexWork === TERRAIN_TILE_TOPOLOGY_BATCH_SIZE) { indexWork = 0; yield; }
    }
  }
  if (indexWork > 0) yield;

  if (skirtVertexCount > 0) {
    const bottomRadius = terrainTileSkirtRadius(field, radius, segments, options.elevationExaggeration ?? 1);
    // Counter-clockwise perimeter traversal, viewed from above the real grid.
    // Each edge keeps its own corner so the appended ring remains regular.
    const edgeVertex = (edge: number, step: number): number => edge === 0 ? step
      : edge === 1 ? step * verticesPerSide + segments
        : edge === 2 ? segments * verticesPerSide + segments - step
          : (segments - step) * verticesPerSide;
    for (let edge = 0; edge < 4; edge += 1) {
      const bottomStart = gridVertexCount + edge * verticesPerSide;
      let skirtVertexWork = 0;
      for (let step = 0; step <= segments; step += 1) {
        const top = edgeVertex(edge, step);
        const source = top * 3;
        const destination = (bottomStart + step) * 3;
        // Derive the ray from the actual published float32 top, including any
        // fine/coarse stitch snap. Do not resample a different seam direction.
        const x = positions[source]! + originVector.x;
        const y = positions[source + 1]! + originVector.y;
        const z = positions[source + 2]! + originVector.z;
        const radialScale = bottomRadius / Math.max(Number.EPSILON, Math.hypot(x, y, z));
        positions[destination] = x * radialScale - originVector.x;
        positions[destination + 1] = y * radialScale - originVector.y;
        positions[destination + 2] = z * radialScale - originVector.z;
        colors[destination] = colors[source]!;
        colors[destination + 1] = colors[source + 1]!;
        colors[destination + 2] = colors[source + 2]!;
        maximumDistanceSquared = Math.max(maximumDistanceSquared,
          positions[destination]! ** 2 + positions[destination + 1]! ** 2 + positions[destination + 2]! ** 2);
        // The new scalar arrays are zero-initialized: skirts are not ocean.
        if (++skirtVertexWork === TERRAIN_TILE_TOPOLOGY_BATCH_SIZE) { skirtVertexWork = 0; yield; }
      }
      if (skirtVertexWork > 0) yield;
      let skirtIndexWork = 0;
      for (let step = 0; step < segments; step += 1) {
        const first = edgeVertex(edge, step);
        const second = edgeVertex(edge, step + 1);
        const lowerFirst = bottomStart + step;
        const lowerSecond = lowerFirst + 1;
        indices[index++] = first;
        indices[index++] = lowerFirst;
        indices[index++] = second;
        indices[index++] = second;
        indices[index++] = lowerFirst;
        indices[index++] = lowerSecond;
        if (++skirtIndexWork === TERRAIN_TILE_TOPOLOGY_BATCH_SIZE) { skirtIndexWork = 0; yield; }
      }
      if (skirtIndexWork > 0) yield;
    }
  }

  return {
    positions,
    colors,
    indices,
    gridVertexCount,
    gridSegments: segments,
    skirtVertexCount,
    hasWaterAttributes,
    wetness,
    waterDepth,
    origin,
    boundsRadius: Math.sqrt(maximumDistanceSquared),
    byteLength: positions.byteLength + colors.byteLength + indices.byteLength + wetness.byteLength + waterDepth.byteLength,
  };
}

/** Native worker/legacy callers synchronously drain the identical producer. */
export function buildTerrainTileBuffers(
  fieldInput: PlanetField | PlanetFieldInput,
  key: TerrainTileKey,
  options: TerrainTileGeometryOptions = {},
): TerrainTileBuffers {
  const task = createTerrainTileGeometryTask(fieldInput, key, options);
  let result = task.next();
  while (!result.done) result = task.next();
  return result.value;
}

export function terrainGeometryFromBuffers(buffers: TerrainTileBuffers): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(buffers.positions, 3));
  geometry.setAttribute('color', new BufferAttribute(buffers.colors, 3));
  if (buffers.hasWaterAttributes) {
    geometry.setAttribute('wetness', new BufferAttribute(buffers.wetness, 1));
    geometry.setAttribute('waterDepth', new BufferAttribute(buffers.waterDepth, 1));
  }
  const gridIndexCount = buffers.gridSegments * buffers.gridSegments * 6;
  // Keep the original grid normals byte-identical. A render wall must not
  // pull a physical edge normal sideways or corrupt square-grid GPU inputs.
  geometry.setIndex(new BufferAttribute(buffers.skirtVertexCount > 0
    ? buffers.indices.subarray(0, gridIndexCount) : buffers.indices, 1));
  geometry.computeVertexNormals();
  if (buffers.skirtVertexCount > 0) {
    const normals = geometry.getAttribute('normal') as BufferAttribute;
    const values = normals.array as Float32Array;
    const first = new Vector3(); const second = new Vector3(); const third = new Vector3();
    const cross = new Vector3(); const edge = new Vector3();
    for (let index = gridIndexCount; index < buffers.indices.length; index += 3) {
      const a = buffers.indices[index]!, b = buffers.indices[index + 1]!, c = buffers.indices[index + 2]!;
      first.fromArray(buffers.positions, a * 3);
      second.fromArray(buffers.positions, b * 3);
      third.fromArray(buffers.positions, c * 3);
      cross.subVectors(third, second);
      edge.subVectors(first, second);
      cross.cross(edge);
      for (const vertex of [a, b, c]) {
        if (vertex < buffers.gridVertexCount) continue;
        const offset = vertex * 3;
        values[offset] += cross.x;
        values[offset + 1] += cross.y;
        values[offset + 2] += cross.z;
      }
    }
    for (let vertex = buffers.gridVertexCount; vertex < buffers.positions.length / 3; vertex += 1) {
      first.fromArray(values, vertex * 3).normalize().toArray(values, vertex * 3);
    }
    normals.needsUpdate = true;
    geometry.setIndex(new BufferAttribute(buffers.indices, 1));
  }
  geometry.computeBoundingSphere();
  geometry.userData.origin = buffers.origin;
  geometry.userData.gridVertexCount = buffers.gridVertexCount;
  geometry.userData.gridSegments = buffers.gridSegments;
  geometry.userData.skirtVertexCount = buffers.skirtVertexCount;
  geometry.userData.hasWaterAttributes = buffers.hasWaterAttributes;
  geometry.userData.geometryBytes = buffers.byteLength;
  return geometry;
}

export function createTerrainTileGeometry(
  field: PlanetField | PlanetFieldInput,
  key: TerrainTileKey,
  options: TerrainTileGeometryOptions = {},
): BufferGeometry {
  return terrainGeometryFromBuffers(buildTerrainTileBuffers(field, key, options));
}
