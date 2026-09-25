import type { Vec3 } from '../orbitCore';
import type { Quaternion } from '../physics/ContactWorld';

/** Row-major 3x3 matrix. */
export type Mat3 = readonly [number, number, number, number, number, number, number, number, number];

/** Rotation matrix of a unit quaternion: local axes to the frame the quaternion is expressed in. */
export function quatToMatrix(q: Quaternion): Mat3 {
  const { x, y, z, w } = q;
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
  ];
}

export function matVec(m: Mat3, v: Vec3): Vec3 {
  return { x: m[0] * v.x + m[1] * v.y + m[2] * v.z, y: m[3] * v.x + m[4] * v.y + m[5] * v.z, z: m[6] * v.x + m[7] * v.y + m[8] * v.z };
}

export function matMul(a: Mat3, b: Mat3): Mat3 {
  const r: number[] = [];
  for (let i = 0; i < 3; i += 1) for (let j = 0; j < 3; j += 1) r.push(a[i * 3]! * b[j]! + a[i * 3 + 1]! * b[3 + j]! + a[i * 3 + 2]! * b[6 + j]!);
  return r as unknown as Mat3;
}

export function transpose(m: Mat3): Mat3 {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}

export function scaleMat(m: Mat3, k: number): Mat3 {
  return m.map((v) => v * k) as unknown as Mat3;
}

export function addMat(a: Mat3, b: Mat3): Mat3 {
  return a.map((v, i) => v + b[i]!) as unknown as Mat3;
}

export function inverse(m: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!(Math.abs(det) > 0) || !Number.isFinite(det)) throw new RangeError(`Attitude: singular matrix ${JSON.stringify(m)}`);
  const k = 1 / det;
  return [A * k, -(b * i - c * h) * k, (b * f - c * e) * k, B * k, (a * i - c * g) * k, -(a * f - c * d) * k, C * k, -(a * h - b * g) * k, (a * e - b * d) * k];
}

/** Inertia of a point mass at offset d about the origin, per kilogram (parallel-axis term). */
export function parallelAxisPerKg(d: Vec3): Mat3 {
  const s = d.x * d.x + d.y * d.y + d.z * d.z;
  return [s - d.x * d.x, -d.x * d.y, -d.x * d.z, -d.y * d.x, s - d.y * d.y, -d.y * d.z, -d.z * d.x, -d.z * d.y, s - d.z * d.z];
}

export function quatMultiply(a: Quaternion, b: Quaternion): Quaternion {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

/**
 * One fixed step of Rapier's angular update, for a body that is not in a
 * Rapier world: torque and the gyroscopic term (explicit, from the current
 * angular momentum) change the angular velocity through the world-frame
 * inertia; the rotation advances by that velocity; then damping scales it by
 * 1 / (1 + dt * damping). Matches Rapier exactly for moderate spin; Rapier
 * treats the gyroscopic term implicitly, so at several rad/s off-axis the two
 * drift apart by a fraction of a degree over seconds.
 * rotation, angularVelocity: body-fixed planet frame (Rapier's frame near the ground).
 * inertiaLocal: kg m^2 in the part's local axes. torqueLocal: N m in local axes.
 */
export function stepAttitude(rotation: Quaternion, angularVelocity: Vec3, inertiaLocal: Mat3, torqueLocal: Vec3,
  damping: number, dt: number): { rotation: Quaternion; angularVelocity: Vec3 } {
  const r = quatToMatrix(rotation);
  const inverseWorld = matMul(matMul(r, inverse(inertiaLocal)), transpose(r));
  const torque = matVec(r, torqueLocal);
  const inertiaWorld = matMul(matMul(r, inertiaLocal), transpose(r));
  const momentum = matVec(inertiaWorld, angularVelocity);
  const gyro = { x: angularVelocity.y * momentum.z - angularVelocity.z * momentum.y, y: angularVelocity.z * momentum.x - angularVelocity.x * momentum.z, z: angularVelocity.x * momentum.y - angularVelocity.y * momentum.x };
  const kick = matVec(inverseWorld, { x: torque.x - gyro.x, y: torque.y - gyro.y, z: torque.z - gyro.z });
  const keep = 1 / (1 + dt * damping);
  const u = { x: angularVelocity.x + kick.x * dt, y: angularVelocity.y + kick.y * dt, z: angularVelocity.z + kick.z * dt };
  const w = { x: u.x * keep, y: u.y * keep, z: u.z * keep };
  const speed = Math.hypot(u.x, u.y, u.z);
  if (speed === 0) return { rotation, angularVelocity: w };
  const half = (speed * dt) / 2, s = Math.sin(half) / speed;
  const turned = quatMultiply({ x: u.x * s, y: u.y * s, z: u.z * s, w: Math.cos(half) }, rotation);
  const length = Math.hypot(turned.x, turned.y, turned.z, turned.w);
  return { rotation: { x: turned.x / length, y: turned.y / length, z: turned.z / length, w: turned.w / length }, angularVelocity: w };
}
