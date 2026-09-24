import { Vector3 } from 'three';

export enum CubeFace {
  PositiveX = 0,
  NegativeX = 1,
  PositiveY = 2,
  NegativeY = 3,
  PositiveZ = 4,
  NegativeZ = 5,
}

export const CUBE_FACES: readonly CubeFace[] = [
  CubeFace.PositiveX,
  CubeFace.NegativeX,
  CubeFace.PositiveY,
  CubeFace.NegativeY,
  CubeFace.PositiveZ,
  CubeFace.NegativeZ,
];

export interface FaceCoordinates {
  face: CubeFace;
  u: number;
  v: number;
}

/** Face coordinates are signed [-1, 1], not texture-space [0, 1]. */
export function faceUvToDirection(
  face: CubeFace,
  u: number,
  v: number,
  target = new Vector3(),
): Vector3 {
  switch (face) {
    case CubeFace.PositiveX:
      target.set(1, v, -u);
      break;
    case CubeFace.NegativeX:
      target.set(-1, v, u);
      break;
    case CubeFace.PositiveY:
      target.set(u, 1, -v);
      break;
    case CubeFace.NegativeY:
      target.set(u, -1, v);
      break;
    case CubeFace.PositiveZ:
      target.set(u, v, 1);
      break;
    case CubeFace.NegativeZ:
      target.set(-u, v, -1);
      break;
    default:
      throw new RangeError(`Invalid cube face: ${String(face)}`);
  }

  return target.normalize();
}

/** The inverse mapping deliberately preserves exact cube-edge sample directions. */
export function directionToFaceUv(direction: {
  x: number;
  y: number;
  z: number;
}): FaceCoordinates {
  const absoluteX = Math.abs(direction.x);
  const absoluteY = Math.abs(direction.y);
  const absoluteZ = Math.abs(direction.z);
  const maximum = Math.max(absoluteX, absoluteY, absoluteZ);

  if (maximum < Number.EPSILON) {
    return { face: CubeFace.PositiveY, u: 0, v: 0 };
  }

  if (absoluteX >= absoluteY && absoluteX >= absoluteZ) {
    return direction.x >= 0
      ? { face: CubeFace.PositiveX, u: -direction.z / absoluteX, v: direction.y / absoluteX }
      : { face: CubeFace.NegativeX, u: direction.z / absoluteX, v: direction.y / absoluteX };
  }

  if (absoluteY >= absoluteX && absoluteY >= absoluteZ) {
    return direction.y >= 0
      ? { face: CubeFace.PositiveY, u: direction.x / absoluteY, v: -direction.z / absoluteY }
      : { face: CubeFace.NegativeY, u: direction.x / absoluteY, v: direction.z / absoluteY };
  }

  return direction.z >= 0
    ? { face: CubeFace.PositiveZ, u: direction.x / absoluteZ, v: direction.y / absoluteZ }
    : { face: CubeFace.NegativeZ, u: -direction.x / absoluteZ, v: direction.y / absoluteZ };
}

export function faceName(face: CubeFace): string {
  return ['+X', '-X', '+Y', '-Y', '+Z', '-Z'][face] ?? 'unknown';
}

export function angularDistance(
  first: { x: number; y: number; z: number },
  second: { x: number; y: number; z: number },
): number {
  const firstLength = Math.hypot(first.x, first.y, first.z);
  const secondLength = Math.hypot(second.x, second.y, second.z);

  if (firstLength < Number.EPSILON || secondLength < Number.EPSILON) return 0;

  const cosine =
    (first.x * second.x + first.y * second.y + first.z * second.z) /
    (firstLength * secondLength);
  return Math.acos(Math.min(1, Math.max(-1, cosine)));
}
