import type { Basis, Vec3 } from './orbitCore';

export interface Quat { x: number; y: number; z: number; w: number }

/**
 * Ecliptic (x, y, z), z up, to three.js render axes (x, z, -y), y up. Same
 * mapping as the view lab's toThree, without three.js so checks run headless.
 */
export function renderAxes(v: Vec3): Vec3 {
  return { x: v.x, y: v.z, z: -v.y };
}

/**
 * Rotation taking the planet's body-fixed axes to render axes, given the
 * body-fixed axes in the ecliptic frame at some instant (bodyOrientation).
 * Terrain tiles and rocket attitudes are body-fixed; this turns them into the
 * inertial scene.
 */
export function bodyFixedToRender(axes: Basis): Quat {
  const x = renderAxes(axes.x), y = renderAxes(axes.y), z = renderAxes(axes.z);
  // Rotation matrix with columns x, y, z; standard matrix-to-quaternion conversion.
  const m00 = x.x, m01 = y.x, m02 = z.x, m10 = x.y, m11 = y.y, m12 = z.y, m20 = x.z, m21 = y.z, m22 = z.z;
  const trace = m00 + m11 + m22;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    return { w: 0.25 / s, x: (m21 - m12) * s, y: (m02 - m20) * s, z: (m10 - m01) * s };
  }
  if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    return { w: (m21 - m12) / s, x: 0.25 * s, y: (m01 + m10) / s, z: (m02 + m20) / s };
  }
  if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    return { w: (m02 - m20) / s, x: (m01 + m10) / s, y: 0.25 * s, z: (m12 + m21) / s };
  }
  const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
  return { w: (m10 - m01) / s, x: (m02 + m20) / s, y: (m12 + m21) / s, z: 0.25 * s };
}

export function quatMultiply(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

export function quatRotate(q: Quat, v: Vec3): Vec3 {
  // v + 2 w (u x v) + 2 u x (u x v), u = (x, y, z).
  const tx = 2 * (q.y * v.z - q.z * v.y), ty = 2 * (q.z * v.x - q.x * v.z), tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  };
}
