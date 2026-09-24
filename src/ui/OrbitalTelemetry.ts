import {
  EARTH_MASS_KG,
  SECONDS_PER_DAY,
  SECONDS_PER_YEAR,
  SOLAR_MASS_KG,
  formatDistance,
  formatSpeed,
} from '../core';
import type { OrbitElements } from '../universe';

const TWO_PI = Math.PI * 2;

export interface OrbitalTelemetryDatum {
  readonly label: string;
  readonly value: string;
}

export interface OrbitalTelemetryInput {
  readonly orbitalPeriodSeconds?: number;
  readonly orbitalRadiusAu?: number;
  readonly eccentricity?: number;
  readonly inclinationRadians?: number;
  readonly orbitalSpeedMetersPerSecond?: number;
  readonly rotationPeriodSeconds?: number;
  readonly surfaceGravity?: number;
  readonly radiusMeters?: number;
  readonly massKg?: number;
  readonly moonCount?: number;
  readonly distanceMeters?: number;
  readonly parentId?: string;
}

export interface StellarTelemetryInput {
  readonly temperatureKelvin?: number;
  readonly radius?: number;
  readonly radiusMeters?: number;
  readonly massKg?: number;
  readonly luminositySolar?: number;
  readonly spectralClass?: string;
  readonly orbitalPeriodSeconds?: number;
  readonly distanceMeters?: number;
}

export interface OrbitalPosition {
  readonly x: number;
  readonly y: number;
  readonly z?: number;
}

export interface OrbitalMotion {
  readonly orbitalRadiusMeters: number;
  readonly orbitalPhaseRadians: number;
  readonly orbitalSpeedMetersPerSecond: number;
}

export interface OrbitalTrackOptions {
  readonly centerX: number;
  readonly centerY: number;
  readonly semiMajorAxis: number;
  readonly eccentricity?: number;
  readonly inclinationRadians?: number;
  readonly longitudeAscendingNodeRadians?: number;
  readonly argumentPeriapsisRadians?: number;
  readonly verticalScale?: number;
  readonly segments?: number;
}

function finite(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value);
}

function localized(value: number, maximumFractionDigits = 1): string {
  return value.toLocaleString('en-US', { maximumFractionDigits });
}

/** Render an actual supplied SI orbital period without inventing absent data. */
export function formatOrbitalPeriod(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  if (seconds < 60) return `${localized(seconds)} s`;
  if (seconds < 3_600) return `${localized(seconds / 60)} min`;
  if (seconds < SECONDS_PER_DAY) return `${localized(seconds / 3_600)} h`;
  if (seconds < SECONDS_PER_YEAR) return `${localized(seconds / SECONDS_PER_DAY)} d`;
  return `${localized(seconds / SECONDS_PER_YEAR, 2)} yr`;
}

/** Every row is sourced from an actual supplied planetary descriptor or pose. */
export function formatOrbitalTelemetry(entry: OrbitalTelemetryInput): OrbitalTelemetryDatum[] {
  const rows: OrbitalTelemetryDatum[] = [];
  if (finite(entry.orbitalPeriodSeconds) && entry.orbitalPeriodSeconds > 0) {
    rows.push({ label: 'ORBITAL PERIOD', value: formatOrbitalPeriod(entry.orbitalPeriodSeconds) });
  }
  if (finite(entry.orbitalRadiusAu) && entry.orbitalRadiusAu > 0) {
    rows.push({ label: 'ORBITAL AXIS', value: `${localized(entry.orbitalRadiusAu, 4)} AU` });
  }
  if (finite(entry.orbitalSpeedMetersPerSecond) && entry.orbitalSpeedMetersPerSecond >= 0) {
    rows.push({ label: 'ORBITAL SPEED', value: formatSpeed(entry.orbitalSpeedMetersPerSecond) });
  }
  if (finite(entry.eccentricity) && entry.eccentricity >= 0 && entry.eccentricity < 1) {
    rows.push({ label: 'ECCENTRICITY', value: entry.eccentricity.toFixed(4) });
  }
  if (finite(entry.inclinationRadians)) {
    rows.push({ label: 'INCLINATION', value: `${localized(entry.inclinationRadians * 180 / Math.PI, 2)}°` });
  }
  if (finite(entry.rotationPeriodSeconds) && entry.rotationPeriodSeconds > 0) {
    rows.push({ label: 'ROTATION', value: formatOrbitalPeriod(entry.rotationPeriodSeconds) });
  }
  if (finite(entry.surfaceGravity) && entry.surfaceGravity >= 0) {
    rows.push({ label: 'SURFACE GRAVITY', value: `${localized(entry.surfaceGravity, 2)} m/s²` });
  }
  if (finite(entry.radiusMeters) && entry.radiusMeters > 0) {
    rows.push({ label: 'RADIUS', value: formatDistance(entry.radiusMeters) });
  }
  if (finite(entry.massKg) && entry.massKg > 0) {
    rows.push({ label: 'MASS', value: `${localized(entry.massKg / EARTH_MASS_KG, 3)} M⊕` });
  }
  if (finite(entry.moonCount) && entry.moonCount >= 0) {
    rows.push({ label: 'SATELLITES', value: localized(Math.floor(entry.moonCount), 0) });
  }
  if (finite(entry.distanceMeters) && entry.distanceMeters >= 0) {
    rows.push({ label: 'RANGE', value: formatDistance(entry.distanceMeters) });
  }
  return rows;
}

/** The stellar card never substitutes made-up temperatures or masses. */
export function formatStellarTelemetry(star: StellarTelemetryInput): OrbitalTelemetryDatum[] {
  const rows: OrbitalTelemetryDatum[] = [];
  if (star.spectralClass) rows.push({ label: 'SPECTRAL CLASS', value: star.spectralClass.toUpperCase() });
  if (finite(star.temperatureKelvin) && star.temperatureKelvin > 0) {
    rows.push({ label: 'TEMPERATURE', value: `${localized(star.temperatureKelvin, 0)} K` });
  }
  if (finite(star.luminositySolar) && star.luminositySolar >= 0) {
    rows.push({ label: 'LUMINOSITY', value: `${localized(star.luminositySolar, 3)} L☉` });
  }
  if (finite(star.massKg) && star.massKg > 0) {
    rows.push({ label: 'MASS', value: `${localized(star.massKg / SOLAR_MASS_KG, 3)} M☉` });
  }
  const radiusMeters = star.radiusMeters ?? star.radius;
  if (finite(radiusMeters) && radiusMeters > 0) {
    rows.push({ label: 'RADIUS', value: formatDistance(radiusMeters) });
  }
  if (finite(star.orbitalPeriodSeconds) && star.orbitalPeriodSeconds > 0) {
    rows.push({ label: 'ORBITAL PERIOD', value: formatOrbitalPeriod(star.orbitalPeriodSeconds) });
  }
  if (finite(star.distanceMeters) && star.distanceMeters >= 0) {
    rows.push({ label: 'RANGE', value: formatDistance(star.distanceMeters) });
  }
  return rows;
}

/** Mass-weighted positions stay in the caller's actual projected coordinate units. */
export function computeBarycenter(
  stars: readonly { readonly position?: OrbitalPosition; readonly massKg?: number }[],
): { x: number; y: number; z: number } {
  let mass = 0;
  let x = 0;
  let y = 0;
  let z = 0;
  for (const star of stars) {
    if (!star.position || !finite(star.massKg) || star.massKg <= 0) continue;
    const position = star.position;
    if (!Number.isFinite(position.x) || !Number.isFinite(position.y) ||
      (position.z !== undefined && !Number.isFinite(position.z))) continue;
    mass += star.massKg;
    x += position.x * star.massKg;
    y += position.y * star.massKg;
    z += (position.z ?? 0) * star.massKg;
  }
  return mass > 0 ? { x: x / mass, y: y / mass, z: z / mass } : { x: 0, y: 0, z: 0 };
}

/** Instantaneous parent-relative SI range and vis-viva velocity from a real ephemeris. */
export function measureOrbitalMotion(
  elements: Pick<OrbitElements, 'semiMajorAxisMeters' | 'periodSeconds'>,
  positionMeters: { readonly x: number; readonly y: number; readonly z: number },
  parentPositionMeters: { readonly x: number; readonly y: number; readonly z: number } = {
    x: 0,
    y: 0,
    z: 0,
  },
): OrbitalMotion {
  const x = positionMeters.x - parentPositionMeters.x;
  const y = positionMeters.y - parentPositionMeters.y;
  const z = positionMeters.z - parentPositionMeters.z;
  const orbitalRadiusMeters = Math.hypot(x, y, z);
  const axis = elements.semiMajorAxisMeters;
  const period = elements.periodSeconds;
  const meanMotion = axis > 0 && period > 0 ? TWO_PI / period : 0;
  const gravitationalParameter = meanMotion * meanMotion * axis ** 3;
  const orbitalSpeedMetersPerSecond = orbitalRadiusMeters > 0 && gravitationalParameter > 0
    ? Math.sqrt(Math.max(0, gravitationalParameter * (2 / orbitalRadiusMeters - 1 / axis)))
    : 0;
  return {
    orbitalRadiusMeters,
    orbitalPhaseRadians: Math.atan2(z, x),
    orbitalSpeedMetersPerSecond,
  };
}

/** Sample the same inclined Kepler ellipse used by the authoritative orbit propagator. */
export function sampleOrbitalTrack(options: OrbitalTrackOptions): Array<{ x: number; y: number }> {
  const count = Math.max(24, Math.min(128, Math.round(options.segments ?? 64)));
  const axis = Number.isFinite(options.semiMajorAxis) ? Math.max(0, options.semiMajorAxis) : 0;
  const eccentricity = Math.max(0, Math.min(options.eccentricity ?? 0, 0.999_999));
  const inclination = options.inclinationRadians ?? 0;
  const ascending = options.longitudeAscendingNodeRadians ?? 0;
  const periapsis = options.argumentPeriapsisRadians ?? 0;
  const verticalScale = options.verticalScale ?? 0.62;
  const periCos = Math.cos(periapsis);
  const periSin = Math.sin(periapsis);
  const inclinationCos = Math.cos(inclination);
  const ascendingCos = Math.cos(ascending);
  const ascendingSin = Math.sin(ascending);
  const minorAxis = axis * Math.sqrt(1 - eccentricity * eccentricity);
  const points: Array<{ x: number; y: number }> = [];

  for (let index = 0; index <= count; index += 1) {
    const anomaly = index / count * TWO_PI;
    const orbitX = axis * (Math.cos(anomaly) - eccentricity);
    const orbitZ = minorAxis * Math.sin(anomaly);
    const periX = orbitX * periCos - orbitZ * periSin;
    const periZ = orbitX * periSin + orbitZ * periCos;
    const inclinedZ = periZ * inclinationCos;
    const projectedX = periX * ascendingCos - inclinedZ * ascendingSin;
    const projectedZ = periX * ascendingSin + inclinedZ * ascendingCos;
    points.push({
      x: options.centerX + projectedX,
      y: options.centerY + projectedZ * verticalScale,
    });
  }
  return points;
}
