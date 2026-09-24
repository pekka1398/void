/** Lightweight double-precision simulation vectors. GPU vectors stay separate. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const ZERO_VEC3: Readonly<Vec3> = Object.freeze({ x: 0, y: 0, z: 0 });

export function vec3(x = 0, y = 0, z = 0): Vec3 {
  return { x, y, z };
}

export function cloneVec3(value: Vec3): Vec3 {
  return { x: value.x, y: value.y, z: value.z };
}

export function addVec3(left: Vec3, right: Vec3): Vec3 {
  return { x: left.x + right.x, y: left.y + right.y, z: left.z + right.z };
}

export function subVec3(left: Vec3, right: Vec3): Vec3 {
  return { x: left.x - right.x, y: left.y - right.y, z: left.z - right.z };
}

export function scaleVec3(value: Vec3, scalar: number): Vec3 {
  return { x: value.x * scalar, y: value.y * scalar, z: value.z * scalar };
}

export function dotVec3(left: Vec3, right: Vec3): number {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

export function crossVec3(left: Vec3, right: Vec3): Vec3 {
  return {
    x: left.y * right.z - left.z * right.y,
    y: left.z * right.x - left.x * right.z,
    z: left.x * right.y - left.y * right.x,
  };
}

export function lengthSquaredVec3(value: Vec3): number {
  return dotVec3(value, value);
}

export function lengthVec3(value: Vec3): number {
  return Math.hypot(value.x, value.y, value.z);
}

export function distanceVec3(left: Vec3, right: Vec3): number {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

export function normalizeVec3(value: Vec3): Vec3 {
  const magnitude = lengthVec3(value);
  return magnitude === 0 ? vec3() : scaleVec3(value, 1 / magnitude);
}

export function lerpVec3(start: Vec3, end: Vec3, amount: number): Vec3 {
  return {
    x: start.x + (end.x - start.x) * amount,
    y: start.y + (end.y - start.y) * amount,
    z: start.z + (end.z - start.z) * amount,
  };
}

export function almostEqualVec3(left: Vec3, right: Vec3, epsilon = 1e-6): boolean {
  return (
    Math.abs(left.x - right.x) <= epsilon &&
    Math.abs(left.y - right.y) <= epsilon &&
    Math.abs(left.z - right.z) <= epsilon
  );
}

export function vec3ToArray(value: Vec3): [number, number, number] {
  return [value.x, value.y, value.z];
}

export function vec3FromArray(value: readonly [number, number, number]): Vec3 {
  return vec3(value[0], value[1], value[2]);
}
