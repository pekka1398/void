import { buildTileIndices, buildTileMesh, type TileKey, type TileMeshData } from '../lodCore';
import type { Terrain } from './Surface';

/** The finest level whose tiles are at least tileSizeMeters across at the equator of a face. */
export function levelForTileSize(radiusMeters: number, tileSizeMeters: number): number {
  if (!(radiusMeters > 0) || !(tileSizeMeters > 0)) throw new RangeError(`levelForTileSize(${radiusMeters}, ${tileSizeMeters})`);
  // A face spans a quarter circumference.
  const faceSpan = (Math.PI / 2) * radiusMeters;
  return Math.max(0, Math.floor(Math.log2(faceSpan / tileSizeMeters)));
}

/**
 * One terrain tile, built by lab/lod's mesh builder: the same function (and,
 * through TerrainConfig, the same sampler) the renderer's tile workers use,
 * so Rapier collides with exactly the triangles that are drawn.
 */
export function buildTerrainTile(key: TileKey, terrain: Terrain, resolution: number): TileMeshData {
  return buildTileMesh(key, terrain.sample, { radiusMeters: terrain.radiusMeters, resolution });
}

/** Surface vertices of a tile (its skirt vertices follow them), float32 relative to tile.origin. */
export function surfacePositions(tile: TileMeshData, resolution: number): Float32Array {
  return tile.positions.subarray(0, resolution * resolution * 3);
}

const surfaceIndexCache = new Map<number, Uint32Array>();

/** Surface triangles of every tile at a resolution, outward counter-clockwise, without skirts. */
export function surfaceIndices(resolution: number): Uint32Array {
  let indices = surfaceIndexCache.get(resolution);
  if (!indices) {
    const built = buildTileIndices(resolution);
    indices = built.indices.slice(0, built.gridIndexCount);
    surfaceIndexCache.set(resolution, indices);
  }
  return indices;
}
