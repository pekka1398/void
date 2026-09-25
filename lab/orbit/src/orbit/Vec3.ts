/** Double-precision simulation vector. Right-handed, ecliptic frame: +Z is the ecliptic north pole. */
export interface Vec3 { x: number; y: number; z: number }

export function vec3(x: number, y: number, z: number): Vec3 {
  return { x, y, z };
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function scale(a: Vec3, s: number): Vec3 {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}

export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

export function length(a: Vec3): number {
  return Math.hypot(a.x, a.y, a.z);
}

export function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** A zero or non-finite vector has no direction; asking for one is a bug. */
export function normalize(a: Vec3): Vec3 {
  const len = length(a);
  if (!(len > 0) || !Number.isFinite(len)) {
    throw new RangeError(`normalize: vector (${a.x}, ${a.y}, ${a.z}) has no direction`);
  }
  return { x: a.x / len, y: a.y / len, z: a.z / len };
}

export function assertFiniteVec3(a: Vec3, label: string): void {
  if (!Number.isFinite(a.x) || !Number.isFinite(a.y) || !Number.isFinite(a.z)) {
    throw new RangeError(`${label}: non-finite vector (${a.x}, ${a.y}, ${a.z})`);
  }
}
