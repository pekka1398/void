import type { Vec3 } from '../orbitCore';

/**
 * The same cube-sphere as lab/lod (face frames, tangent warp, tile keys), so a
 * collision tile and a rendered tile with the same key cover the same ground.
 */
export type CubeFace = 0 | 1 | 2 | 3 | 4 | 5;

interface FaceFrame { n: Vec3; a: Vec3; b: Vec3 }

/** Outward normal n, +u axis a, +v axis b, with a x b = n. */
export const FACE_FRAMES: readonly FaceFrame[] = [
  { n: { x: 1, y: 0, z: 0 }, a: { x: 0, y: 0, z: -1 }, b: { x: 0, y: 1, z: 0 } },
  { n: { x: -1, y: 0, z: 0 }, a: { x: 0, y: 0, z: 1 }, b: { x: 0, y: 1, z: 0 } },
  { n: { x: 0, y: 1, z: 0 }, a: { x: 1, y: 0, z: 0 }, b: { x: 0, y: 0, z: -1 } },
  { n: { x: 0, y: -1, z: 0 }, a: { x: 1, y: 0, z: 0 }, b: { x: 0, y: 0, z: 1 } },
  { n: { x: 0, y: 0, z: 1 }, a: { x: 1, y: 0, z: 0 }, b: { x: 0, y: 1, z: 0 } },
  { n: { x: 0, y: 0, z: -1 }, a: { x: -1, y: 0, z: 0 }, b: { x: 0, y: 1, z: 0 } },
];

const QUARTER_PI = Math.PI / 4;

/** Face parameters (u, v) in [-1, 1] to a unit body-fixed direction. */
export function cubeToSphere(face: CubeFace, u: number, v: number): Vec3 {
  const { n, a, b } = FACE_FRAMES[face]!;
  const su = Math.tan(u * QUARTER_PI);
  const sv = Math.tan(v * QUARTER_PI);
  const x = n.x + a.x * su + b.x * sv;
  const y = n.y + a.y * su + b.y * sv;
  const z = n.z + a.z * su + b.z * sv;
  const inv = 1 / Math.hypot(x, y, z);
  return { x: x * inv, y: y * inv, z: z * inv };
}

/** Inverse of cubeToSphere: the face whose normal is closest, and (u, v) on it. */
export function sphereToCube(d: Vec3): { face: CubeFace; u: number; v: number } {
  const ax = Math.abs(d.x), ay = Math.abs(d.y), az = Math.abs(d.z);
  if (!(ax > 0 || ay > 0 || az > 0)) throw new RangeError(`sphereToCube: zero direction`);
  const face: CubeFace = ax >= ay && ax >= az ? (d.x > 0 ? 0 : 1) : ay >= az ? (d.y > 0 ? 2 : 3) : (d.z > 0 ? 4 : 5);
  const { n, a, b } = FACE_FRAMES[face]!;
  const dn = d.x * n.x + d.y * n.y + d.z * n.z;
  const su = (d.x * a.x + d.y * a.y + d.z * a.z) / dn;
  const sv = (d.x * b.x + d.y * b.y + d.z * b.z) / dn;
  return { face, u: Math.atan(su) / QUARTER_PI, v: Math.atan(sv) / QUARTER_PI };
}
