import type { Vec3 } from './Vec3';
import { FACE_FRAMES } from './CubeSphere';
import { tileId, type CubeFace, type TileKey } from './TileKey';

const QUARTER_PI = Math.PI / 4;

/**
 * Inverse of cubeToSphere. The face is the one whose normal is closest to the
 * direction; (u, v) are its face parameters in [-1, 1]. Any nonzero length is
 * accepted, since only the direction matters.
 */
export function sphereToCube(direction: Vec3): { face: CubeFace; u: number; v: number } {
  const ax = Math.abs(direction.x), ay = Math.abs(direction.y), az = Math.abs(direction.z);
  if (!Number.isFinite(ax + ay + az) || !(ax > 0 || ay > 0 || az > 0)) {
    throw new Error(`TileSearch.ts sphereToCube: invalid direction=${JSON.stringify(direction)}`);
  }
  const face: CubeFace = ax >= ay && ax >= az ? (direction.x > 0 ? 0 : 1) : ay >= az ? (direction.y > 0 ? 2 : 3) : (direction.z > 0 ? 4 : 5);
  const { n, a, b } = FACE_FRAMES[face]!;
  const dn = direction.x * n.x + direction.y * n.y + direction.z * n.z;
  const su = (direction.x * a.x + direction.y * a.y + direction.z * a.z) / dn;
  const sv = (direction.x * b.x + direction.y * b.y + direction.z * b.z) / dn;
  return { face, u: Math.atan(su) / QUARTER_PI, v: Math.atan(sv) / QUARTER_PI };
}

/** The tile at a level whose face-parameter square contains a direction. u = 1 (or v = 1) belongs to the last tile. */
export function tileContaining(direction: Vec3, level: number): TileKey {
  if (!Number.isInteger(level) || level < 0) throw new Error(`TileSearch.ts tileContaining: invalid level=${level}`);
  const { face, u, v } = sphereToCube(direction);
  const side = 2 ** level;
  const index = (p: number) => Math.min(side - 1, Math.floor(((p + 1) / 2) * side));
  return { face, level, x: index(u), y: index(v) };
}

/**
 * Every tile at a level touching the surface within reachMeters of a
 * body-fixed point's ground position, including tiles on neighbouring faces.
 * Samples a tangent-plane grid at half the smallest tile width, over the
 * reach plus one tile, so every touching tile contains a sample.
 */
export function tilesAround(point: Vec3, reachMeters: number, level: number, radiusMeters: number): TileKey[] {
  const r = Math.hypot(point.x, point.y, point.z);
  if (!(r > 0) || !Number.isFinite(r)) throw new Error(`TileSearch.ts tilesAround: invalid point=${JSON.stringify(point)}`);
  if (!(reachMeters >= 0) || !(radiusMeters > 0)) {
    throw new Error(`TileSearch.ts tilesAround: invalid reach=${reachMeters}; radius=${radiusMeters}`);
  }
  const d = { x: point.x / r, y: point.y / r, z: point.z / r };
  const t1n = Math.abs(d.z) < 0.9 ? { x: -d.y, y: d.x, z: 0 } : { x: 0, y: -d.z, z: d.y };
  const l1 = Math.hypot(t1n.x, t1n.y, t1n.z);
  const t1 = { x: t1n.x / l1, y: t1n.y / l1, z: t1n.z / l1 };
  const t2 = { x: d.y * t1.z - d.z * t1.y, y: d.z * t1.x - d.x * t1.z, z: d.x * t1.y - d.y * t1.x };
  // The tangent warp keeps every tile within a factor 1.5 of the face-centre width.
  const smallest = ((Math.PI / 2) * radiusMeters) / 2 ** level / 1.5;
  const extent = reachMeters + smallest;
  const steps = Math.max(1, Math.ceil((2 * extent) / (smallest / 2)));
  const found = new Map<string, TileKey>();
  for (let a = 0; a <= steps; a += 1) {
    for (let b = 0; b <= steps; b += 1) {
      const s = (-extent + (2 * extent * a) / steps) / radiusMeters;
      const q = (-extent + (2 * extent * b) / steps) / radiusMeters;
      const key = tileContaining({ x: d.x + t1.x * s + t2.x * q, y: d.y + t1.y * s + t2.y * q, z: d.z + t1.z * s + t2.z * q }, level);
      found.set(tileId(key), key);
    }
  }
  return [...found.values()];
}
