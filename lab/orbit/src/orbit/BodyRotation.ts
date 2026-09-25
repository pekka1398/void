import type { CelestialBody } from './SystemSpec';
import { cross, type Vec3 } from './Vec3';

/** Orthonormal right-handed axes expressed in the ecliptic frame. */
export interface Basis { x: Vec3; y: Vec3; z: Vec3 }

export function spinAxis(body: CelestialBody): Vec3 {
  const { obliquityRadians: ob, poleLongitudeRadians: lon } = body.rotation;
  return { x: Math.sin(ob) * Math.cos(lon), y: Math.sin(ob) * Math.sin(lon), z: Math.cos(ob) };
}

/**
 * Non-rotating equatorial axes (the body's ECI): z is the spin axis, x the
 * equinox, i.e. the node of the equator on the ecliptic, (-sin lon, cos lon, 0).
 * The node is defined for every obliquity, including zero.
 */
export function equatorialAxes(body: CelestialBody): Basis {
  const pole = spinAxis(body);
  const lon = body.rotation.poleLongitudeRadians;
  const x: Vec3 = { x: -Math.sin(lon), y: Math.cos(lon), z: 0 };
  return { x, y: cross(pole, x), z: pole };
}

/**
 * Body-fixed axes at time t: z is the spin axis, x the prime meridian on the
 * equator. The equator's reference direction is the node of the equator on
 * the ecliptic, (-sin lon, cos lon, 0), which is defined for every obliquity.
 */
export function bodyOrientation(body: CelestialBody, t: number): Basis {
  const { x: node, y: quadrature, z: pole } = equatorialAxes(body);
  const angle = body.rotation.angleAtEpochRadians + (2 * Math.PI * t) / body.rotation.periodSeconds;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const x: Vec3 = {
    x: c * node.x + s * quadrature.x,
    y: c * node.y + s * quadrature.y,
    z: c * node.z + s * quadrature.z,
  };
  return { x, y: cross(pole, x), z: pole };
}
