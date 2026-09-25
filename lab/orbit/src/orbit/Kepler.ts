import { cross, dot, length, vec3, type Vec3 } from './Vec3';

const TAU = Math.PI * 2;

/** Closed elliptic orbit, angles in radians, referred to the ecliptic frame. */
export interface EllipticElements {
  semiMajorAxisMeters: number;
  eccentricity: number;
  inclinationRadians: number;
  longitudeOfAscendingNodeRadians: number;
  argumentOfPeriapsisRadians: number;
  meanAnomalyRadians: number;
}

export function assertEllipticElements(el: EllipticElements, label: string): void {
  const values = [
    el.semiMajorAxisMeters, el.eccentricity, el.inclinationRadians,
    el.longitudeOfAscendingNodeRadians, el.argumentOfPeriapsisRadians, el.meanAnomalyRadians,
  ];
  if (!values.every(Number.isFinite)) throw new RangeError(`${label}: non-finite orbital element`);
  if (!(el.semiMajorAxisMeters > 0)) throw new RangeError(`${label}: semi-major axis ${el.semiMajorAxisMeters} must be positive`);
  if (!(el.eccentricity >= 0 && el.eccentricity < 1)) {
    throw new RangeError(`${label}: eccentricity ${el.eccentricity} is not elliptic`);
  }
  if (!(el.inclinationRadians >= 0 && el.inclinationRadians <= Math.PI)) {
    throw new RangeError(`${label}: inclination ${el.inclinationRadians} outside [0, pi]`);
  }
}

export function orbitalPeriodSeconds(semiMajorAxisMeters: number, gm: number): number {
  if (!(semiMajorAxisMeters > 0) || !(gm > 0)) {
    throw new RangeError(`orbitalPeriodSeconds: a=${semiMajorAxisMeters}, gm=${gm}`);
  }
  return TAU * Math.sqrt(semiMajorAxisMeters ** 3 / gm);
}

/** Solve M = E - e sin E for 0 <= e < 1. Non-convergence is a bug, not a case to paper over. */
export function solveKeplerElliptic(meanAnomalyRadians: number, eccentricity: number): number {
  if (!Number.isFinite(meanAnomalyRadians)) throw new RangeError(`solveKepler: M=${meanAnomalyRadians}`);
  if (!(eccentricity >= 0 && eccentricity < 1)) throw new RangeError(`solveKepler: e=${eccentricity} is not elliptic`);
  const m = meanAnomalyRadians - TAU * Math.floor(meanAnomalyRadians / TAU);
  // Starting at pi for high eccentricity keeps Newton monotone (Danby 1987).
  let e = eccentricity < 0.8 ? m : Math.PI;
  for (let i = 0; i < 64; i += 1) {
    const f = e - eccentricity * Math.sin(e) - m;
    const df = 1 - eccentricity * Math.cos(e);
    const step = f / df;
    e -= step;
    if (Math.abs(step) <= 4e-16 * Math.max(1, Math.abs(e))) return e;
  }
  throw new Error(`solveKepler: no convergence for M=${meanAnomalyRadians}, e=${eccentricity}`);
}

export interface StateVector { position: Vec3; velocity: Vec3 }

/** Relative two-body state for the given gravitational parameter G(m1 + m2). */
export function stateFromElements(el: EllipticElements, gm: number): StateVector {
  assertEllipticElements(el, 'stateFromElements');
  if (!(gm > 0)) throw new RangeError(`stateFromElements: gm=${gm}`);
  const a = el.semiMajorAxisMeters;
  const e = el.eccentricity;
  const bigE = solveKeplerElliptic(el.meanAnomalyRadians, e);
  const nu = 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(bigE / 2), Math.sqrt(1 - e) * Math.cos(bigE / 2));
  const r = a * (1 - e * Math.cos(bigE));
  const p = a * (1 - e * e);
  const px = r * Math.cos(nu);
  const py = r * Math.sin(nu);
  const vScale = Math.sqrt(gm / p);
  const vx = -vScale * Math.sin(nu);
  const vy = vScale * (e + Math.cos(nu));

  const cO = Math.cos(el.longitudeOfAscendingNodeRadians);
  const sO = Math.sin(el.longitudeOfAscendingNodeRadians);
  const cw = Math.cos(el.argumentOfPeriapsisRadians);
  const sw = Math.sin(el.argumentOfPeriapsisRadians);
  const ci = Math.cos(el.inclinationRadians);
  const si = Math.sin(el.inclinationRadians);
  const m11 = cO * cw - sO * sw * ci;
  const m12 = -cO * sw - sO * cw * ci;
  const m21 = sO * cw + cO * sw * ci;
  const m22 = -sO * sw + cO * cw * ci;
  const m31 = sw * si;
  const m32 = cw * si;
  return {
    position: vec3(m11 * px + m12 * py, m21 * px + m22 * py, m31 * px + m32 * py),
    velocity: vec3(m11 * vx + m12 * vy, m21 * vx + m22 * vy, m31 * vx + m32 * vy),
  };
}

/**
 * Osculating two-body quantities. Only quantities defined for every conic are
 * returned; angles that are undefined for circular or equatorial orbits are not.
 */
export interface OsculatingOrbit {
  /** Negative for hyperbolic orbits, infinite for exactly parabolic. */
  semiMajorAxisMeters: number;
  eccentricity: number;
  inclinationRadians: number;
  periapsisRadiusMeters: number;
  /** Infinite when the orbit is open (e >= 1). */
  apoapsisRadiusMeters: number;
  /** Infinite when the orbit is open (e >= 1). */
  periodSeconds: number;
  specificEnergy: number;
}

export function osculatingOrbit(relativePosition: Vec3, relativeVelocity: Vec3, gm: number): OsculatingOrbit {
  if (!(gm > 0)) throw new RangeError(`osculatingOrbit: gm=${gm}`);
  const r = length(relativePosition);
  if (!(r > 0)) throw new RangeError('osculatingOrbit: zero relative position');
  const v2 = dot(relativeVelocity, relativeVelocity);
  const h = cross(relativePosition, relativeVelocity);
  const hLen = length(h);
  const energy = v2 / 2 - gm / r;
  const rv = dot(relativePosition, relativeVelocity);
  const ex = ((v2 - gm / r) * relativePosition.x - rv * relativeVelocity.x) / gm;
  const ey = ((v2 - gm / r) * relativePosition.y - rv * relativeVelocity.y) / gm;
  const ez = ((v2 - gm / r) * relativePosition.z - rv * relativeVelocity.z) / gm;
  const eccentricity = Math.hypot(ex, ey, ez);
  const p = (hLen * hLen) / gm;
  const closed = eccentricity < 1;
  const semiMajorAxisMeters = -gm / (2 * energy);
  return {
    semiMajorAxisMeters,
    eccentricity,
    inclinationRadians: hLen > 0 ? Math.acos(Math.max(-1, Math.min(1, h.z / hLen))) : Number.NaN,
    periapsisRadiusMeters: p / (1 + eccentricity),
    apoapsisRadiusMeters: closed ? p / (1 - eccentricity) : Number.POSITIVE_INFINITY,
    periodSeconds: closed ? orbitalPeriodSeconds(semiMajorAxisMeters, gm) : Number.POSITIVE_INFINITY,
    specificEnergy: energy,
  };
}
