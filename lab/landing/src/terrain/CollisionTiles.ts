import type { Vec3 } from '../orbitCore';
import { cubeToSphere, sphereToCube, type CubeFace } from './CubeSphere';
import type { Terrain } from './Surface';

/** A tile of one cube face at one level; x, y count tiles along u, v. Same keys as lab/lod. */
export interface TileKey { face: CubeFace; level: number; x: number; y: number }

export function tileId(key: TileKey): string {
  return `${key.face}/${key.level}/${key.x}/${key.y}`;
}

/**
 * Collision geometry for one tile, in body-fixed axes: a (cells + 1)^2 grid
 * on the terrain, two triangles per cell, outward counter-clockwise.
 * Vertices are float32 relative to a float64 origin on the tile, so they
 * stay precise on a planet of any size.
 */
export interface CollisionTile {
  key: TileKey;
  id: string;
  /**
   * Body-fixed, metres: the terrain point at the tile centre, so vertex
   * offsets stay about a tile size and float32 keeps sub-0.1 mm precision.
   */
  origin: Vec3;
  vertices: Float32Array;
  indices: Uint32Array;
  minHeightMeters: number;
  maxHeightMeters: number;
}

/** The finest level whose tiles are at least tileSizeMeters across at the equator of a face. */
export function levelForTileSize(radiusMeters: number, tileSizeMeters: number): number {
  if (!(radiusMeters > 0) || !(tileSizeMeters > 0)) throw new RangeError(`levelForTileSize(${radiusMeters}, ${tileSizeMeters})`);
  // A face spans a quarter circumference.
  const faceSpan = (Math.PI / 2) * radiusMeters;
  return Math.max(0, Math.floor(Math.log2(faceSpan / tileSizeMeters)));
}

/**
 * Grid coordinate k of tile x at a level, in face parameter [-1, 1]. Integer
 * arithmetic up to the division makes shared edges bit-identical between
 * neighbouring tiles of a face.
 */
function faceParameter(tile: number, k: number, level: number, cells: number): number {
  return -1 + (2 * (tile * cells + k)) / (2 ** level * cells);
}

export function buildCollisionTile(key: TileKey, terrain: Terrain, cells: number): CollisionTile {
  if (!Number.isInteger(cells) || cells < 1) throw new RangeError(`buildCollisionTile: cells ${cells}`);
  const n = 2 ** key.level;
  if (!Number.isInteger(key.x) || !Number.isInteger(key.y) || key.x < 0 || key.y < 0 || key.x >= n || key.y >= n) {
    throw new RangeError(`buildCollisionTile: ${tileId(key)}`);
  }
  const centre = cubeToSphere(key.face, faceParameter(key.x, cells / 2, key.level, cells), faceParameter(key.y, cells / 2, key.level, cells));
  const R = terrain.radiusMeters;
  const centreRadius = R + terrain.sample(centre).heightMeters;
  const origin = { x: centre.x * centreRadius, y: centre.y * centreRadius, z: centre.z * centreRadius };
  const side = cells + 1;
  const vertices = new Float32Array(side * side * 3);
  let minHeightMeters = Infinity, maxHeightMeters = -Infinity;
  for (let j = 0; j <= cells; j += 1) {
    for (let i = 0; i <= cells; i += 1) {
      const d = cubeToSphere(key.face, faceParameter(key.x, i, key.level, cells), faceParameter(key.y, j, key.level, cells));
      const h = terrain.sample(d).heightMeters;
      minHeightMeters = Math.min(minHeightMeters, h);
      maxHeightMeters = Math.max(maxHeightMeters, h);
      const r = R + h;
      const o = (j * side + i) * 3;
      vertices[o] = d.x * r - origin.x;
      vertices[o + 1] = d.y * r - origin.y;
      vertices[o + 2] = d.z * r - origin.z;
    }
  }
  const indices = new Uint32Array(cells * cells * 6);
  let t = 0;
  for (let j = 0; j < cells; j += 1) {
    for (let i = 0; i < cells; i += 1) {
      const a = j * side + i, b = a + 1, c = a + side, d = c + 1;
      // (u, v) axes satisfy a x b = n, so (a, b, d) and (a, d, c) wind outward.
      indices.set([a, b, d, a, d, c], t);
      t += 6;
    }
  }
  return { key, id: tileId(key), origin, vertices, indices, minHeightMeters, maxHeightMeters };
}

/** The tile at a level containing a body-fixed direction. */
export function tileContaining(direction: Vec3, level: number): TileKey {
  const { face, u, v } = sphereToCube(direction);
  const n = 2 ** level;
  const index = (p: number) => Math.min(n - 1, Math.max(0, Math.floor(((p + 1) / 2) * n)));
  return { face, level, x: index(u), y: index(v) };
}

/**
 * Every tile at a level touching the surface within reachMeters of a
 * body-fixed point's ground position. Samples a tangent-plane grid finer
 * than a tile, so tiles on neighbouring faces are found too.
 */
export function tilesAround(point: Vec3, reachMeters: number, level: number, radiusMeters: number): TileKey[] {
  const r = Math.hypot(point.x, point.y, point.z);
  if (!(r > 0)) throw new RangeError('tilesAround: point at the centre');
  const d = { x: point.x / r, y: point.y / r, z: point.z / r };
  const t1n = Math.abs(d.z) < 0.9 ? { x: -d.y, y: d.x, z: 0 } : { x: 0, y: -d.z, z: d.y };
  const l1 = Math.hypot(t1n.x, t1n.y, t1n.z);
  const t1 = { x: t1n.x / l1, y: t1n.y / l1, z: t1n.z / l1 };
  const t2 = { x: d.y * t1.z - d.z * t1.y, y: d.z * t1.x - d.x * t1.z, z: d.x * t1.y - d.y * t1.x };
  // Tiles are at least this wide anywhere on a face (the tangent warp keeps
  // them within a factor 1.5). Sampling at half that, over the reach plus
  // one tile, puts a sample inside every tile that touches the reach.
  const smallest = ((Math.PI / 2) * radiusMeters) / 2 ** level / 1.5;
  const extent = reachMeters + smallest;
  const steps = Math.max(1, Math.ceil((2 * extent) / (smallest / 2)));
  const found = new Map<string, TileKey>();
  for (let a = 0; a <= steps; a += 1) {
    for (let b = 0; b <= steps; b += 1) {
      const s = (-extent + (2 * extent * a) / steps) / radiusMeters;
      const q = (-extent + (2 * extent * b) / steps) / radiusMeters;
      const p = { x: d.x + t1.x * s + t2.x * q, y: d.y + t1.y * s + t2.y * q, z: d.z + t1.z * s + t2.z * q };
      const key = tileContaining(p, level);
      found.set(tileId(key), key);
    }
  }
  return [...found.values()];
}
