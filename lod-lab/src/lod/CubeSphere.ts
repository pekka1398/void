import type { Vec3 } from './Vec3';
import type { CubeFace } from './TileKey';

interface FaceFrame {
  /** Outward face normal. */
  readonly n: Vec3;
  /** +u axis. */
  readonly a: Vec3;
  /** +v axis. a × b = n for every face, so grid winding is outward-CCW everywhere. */
  readonly b: Vec3;
}

const FACE_FRAMES: readonly FaceFrame[] = [
  { n: { x: 1, y: 0, z: 0 }, a: { x: 0, y: 0, z: -1 }, b: { x: 0, y: 1, z: 0 } },
  { n: { x: -1, y: 0, z: 0 }, a: { x: 0, y: 0, z: 1 }, b: { x: 0, y: 1, z: 0 } },
  { n: { x: 0, y: 1, z: 0 }, a: { x: 1, y: 0, z: 0 }, b: { x: 0, y: 0, z: -1 } },
  { n: { x: 0, y: -1, z: 0 }, a: { x: 1, y: 0, z: 0 }, b: { x: 0, y: 0, z: 1 } },
  { n: { x: 0, y: 0, z: 1 }, a: { x: 1, y: 0, z: 0 }, b: { x: 0, y: 1, z: 0 } },
  { n: { x: 0, y: 0, z: -1 }, a: { x: -1, y: 0, z: 0 }, b: { x: 0, y: 1, z: 0 } },
];

const QUARTER_PI = Math.PI / 4;

/**
 * Face parameters (u, v) in [-1, 1] to a unit body-fixed direction.
 * The tangent warp keeps cell areas far more uniform than a plain normalize.
 * Shared edges evaluate the same cube point from either face.
 */
export function cubeToSphere(face: CubeFace, u: number, v: number, out: Vec3 = { x: 0, y: 0, z: 0 }): Vec3 {
  const { n, a, b } = FACE_FRAMES[face];
  const su = Math.tan(u * QUARTER_PI);
  const sv = Math.tan(v * QUARTER_PI);
  const x = n.x + a.x * su + b.x * sv;
  const y = n.y + a.y * su + b.y * sv;
  const z = n.z + a.z * su + b.z * sv;
  const inv = 1 / Math.hypot(x, y, z);
  out.x = x * inv;
  out.y = y * inv;
  out.z = z * inv;
  return out;
}
