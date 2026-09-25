import { AU_METERS, DEGREES, SECONDS_PER_DAY } from '../orbit/Constants';
import type { BodySpec, LockedRotationSpec, RotationSpec, SystemSpec } from '../orbit/SystemSpec';

/**
 * Lab fixtures. Masses, radii and elements follow real bodies under fictional
 * names so results can be sanity-checked against known orbits. Planet
 * elements are J2000 mean heliocentric elements in the ecliptic frame (x at
 * the equinox), used as Jacobi elements; they are not a precise ephemeris.
 */

function spin(periodSeconds: number, obliquityDegrees: number, poleLongitudeDegrees = 0, angleDegrees = 0): RotationSpec {
  return {
    periodSeconds,
    obliquityRadians: obliquityDegrees * DEGREES,
    poleLongitudeRadians: poleLongitudeDegrees * DEGREES,
    angleAtEpochRadians: angleDegrees * DEGREES,
  };
}

/** J2000 mean obliquity of the ecliptic, for converting IAU pole directions. */
const ECLIPTIC_OBLIQUITY = 23.4392911 * DEGREES;

/**
 * Rotation from the IAU (WGCCRE) north pole, right ascension and declination
 * in the J2000 equatorial frame. IAU north is the pole on the north side of
 * the invariable plane; a retrograde rotator spins about the opposite pole.
 */
function spinIau(periodSeconds: number, raDegrees: number, decDegrees: number, retrograde = false): RotationSpec {
  const ra = raDegrees * DEGREES, dec = decDegrees * DEGREES, sign = retrograde ? -1 : 1;
  const x = sign * Math.cos(dec) * Math.cos(ra);
  const y = sign * Math.cos(dec) * Math.sin(ra);
  const z = sign * Math.sin(dec);
  const yEcliptic = y * Math.cos(ECLIPTIC_OBLIQUITY) + z * Math.sin(ECLIPTIC_OBLIQUITY);
  const zEcliptic = -y * Math.sin(ECLIPTIC_OBLIQUITY) + z * Math.cos(ECLIPTIC_OBLIQUITY);
  return {
    periodSeconds,
    obliquityRadians: Math.acos(zEcliptic),
    poleLongitudeRadians: Math.atan2(yEcliptic, x),
    angleAtEpochRadians: 0,
  };
}

/** Synchronous rotation with the mean sidereal period; see LockedRotationSpec. */
function locked(periodDays: number, obliquityToOrbitDegrees = 0): LockedRotationSpec {
  return { kind: 'locked', periodSeconds: periodDays * SECONDS_PER_DAY, obliquityToOrbitRadians: obliquityToOrbitDegrees * DEGREES };
}

function elements(aMeters: number, e: number, iDeg: number, nodeDeg: number, periDeg: number, meanDeg: number) {
  return {
    semiMajorAxisMeters: aMeters,
    eccentricity: e,
    inclinationRadians: iDeg * DEGREES,
    longitudeOfAscendingNodeRadians: nodeDeg * DEGREES,
    argumentOfPeriapsisRadians: periDeg * DEGREES,
    meanAnomalyRadians: meanDeg * DEGREES,
  };
}

/** Elements relative to the ecliptic. */
function orbit(aMeters: number, e: number, iDeg: number, nodeDeg: number, periDeg: number, meanDeg: number) {
  return { orbit: elements(aMeters, e, iDeg, nodeDeg, periDeg, meanDeg), orbitPlane: 'ecliptic' as const };
}

/** Elements relative to the parent's equator, for moons in their planet's equatorial plane. */
function equatorialOrbit(aMeters: number, e: number, iDeg: number, nodeDeg: number, periDeg: number, meanDeg: number) {
  return { orbit: elements(aMeters, e, iDeg, nodeDeg, periDeg, meanDeg), orbitPlane: 'parent-equator' as const };
}

/** Published unnormalised J2 with the reference radius it is quoted for. */
function j2(value: number, referenceRadiusMeters: number) {
  return { gravityField: { j2: value, referenceRadiusMeters } };
}

const HOUR = 3600;

const galileanMoons = (): BodySpec[] => [
  {
    id: 'ember', name: 'Ember', massKg: 8.9319e22, radiusMeters: 1.8216e6, color: '#e8c35a', ...j2(1.8459e-3, 1.8216e6),
    rotation: locked(1.769138), ...equatorialOrbit(4.217e8, 0.0041, 0.05, 43.9, 84.1, 342.0), children: [],
  },
  {
    id: 'rime', name: 'Rime', massKg: 4.7998e22, radiusMeters: 1.5608e6, color: '#cfc6b4', ...j2(4.355e-4, 1.5608e6),
    rotation: locked(3.551181), ...equatorialOrbit(6.709e8, 0.009, 0.47, 219.1, 88.97, 171.0), children: [],
  },
  {
    id: 'hollow', name: 'Hollow', massKg: 1.4819e23, radiusMeters: 2.6341e6, color: '#9c8f80', ...j2(1.2733e-4, 2.6341e6),
    rotation: locked(7.154553), ...equatorialOrbit(1.0704e9, 0.0013, 0.2, 63.55, 192.4, 317.5), children: [],
  },
  {
    id: 'umber', name: 'Umber', massKg: 1.075938e23, radiusMeters: 2.4103e6, color: '#6f6558', ...j2(3.27e-5, 2.4103e6),
    rotation: locked(16.689018), ...equatorialOrbit(1.8827e9, 0.0074, 0.192, 298.848, 52.643, 181.408), children: [],
  },
];

export const SOL_SYSTEM: SystemSpec = {
  name: 'Sol analogue',
  root: {
    id: 'sol', name: 'Sol', massKg: 1.98847e30, radiusMeters: 6.957e8, color: '#ffd27a', ...j2(2.2e-7, 6.957e8),
    rotation: spinIau(25.38 * SECONDS_PER_DAY, 286.13, 63.87),
    children: [
      {
        id: 'cinder', name: 'Cinder', massKg: 3.3011e23, radiusMeters: 2.4397e6, color: '#a39485', ...j2(5.03e-5, 2.44e6),
        rotation: spinIau(58.646 * SECONDS_PER_DAY, 281.0103, 61.4155),
        ...orbit(0.387098 * AU_METERS, 0.20563, 7.005, 48.331, 29.124, 174.796), children: [],
      },
      {
        id: 'vesper', name: 'Vesper', massKg: 4.8675e24, radiusMeters: 6.0518e6, color: '#e8d3a0', ...j2(4.458e-6, 6.0518e6),
        rotation: spinIau(243.0226 * SECONDS_PER_DAY, 272.76, 67.16, true),
        ...orbit(0.72333566 * AU_METERS, 0.00677672, 3.39467605, 76.67984255, 54.92262463, 50.37663232), children: [],
      },
      {
        id: 'aurelia', name: 'Aurelia', massKg: 5.9722e24, radiusMeters: 6.371e6, color: '#3f7fd6', ...j2(1.08262668e-3, 6.378137e6),
        // IAU pole RA 0, Dec 90: 23.44 deg toward ecliptic longitude 90.
        rotation: spin(23.9345 * HOUR, 23.44, 90),
        ...orbit(1.00000261 * AU_METERS, 0.01671, 0.00005, 348.74, 114.21, 358.617),
        children: [
          {
            id: 'selene', name: 'Selene', massKg: 7.342e22, radiusMeters: 1.7374e6, color: '#b8b8b0', ...j2(2.033e-4, 1.738e6),
            // Real sidereal month and pole tilt. The initial semi-major axis is
            // tuned so that, perturbed by the Sun, the simulated mean month is
            // the real 27.3217 d (mean distance then 384,830 km; the unperturbed
            // 384,400 km gives 27.64 d).
            rotation: locked(27.321661, 6.68),
            ...orbit(3.814869e8, 0.0549, 5.145, 125.08, 318.15, 135.27), children: [],
          },
        ],
      },
      {
        id: 'ares', name: 'Ares', massKg: 6.4171e23, radiusMeters: 3.3895e6, color: '#c1583a', ...j2(1.96045e-3, 3.3962e6),
        rotation: spinIau(24.6229 * HOUR, 317.269202, 54.432516),
        ...orbit(1.523679 * AU_METERS, 0.0934, 1.850, 49.558, 286.502, 19.412), children: [],
      },
      {
        id: 'velvet', name: 'Velvet', massKg: 1.89813e27, radiusMeters: 6.9911e7, color: '#c9a27a', ...j2(1.4736e-2, 7.1492e7),
        rotation: spinIau(9.925 * HOUR, 268.056595, 64.495303),
        ...orbit(5.2044 * AU_METERS, 0.0489, 1.303, 100.464, 273.867, 20.020),
        children: galileanMoons(),
      },
      {
        id: 'halo', name: 'Halo', massKg: 5.6834e26, radiusMeters: 6.0268e7, color: '#d9c38a', ...j2(1.6298e-2, 6.033e7),
        rotation: spinIau(10.6561 * HOUR, 40.589, 83.537),
        ...orbit(9.53667594 * AU_METERS, 0.05386179, 2.48599187, 113.66242448, 338.93645383, 317.35536592),
        children: [
          {
            id: 'haze', name: 'Haze', massKg: 1.3452e23, radiusMeters: 2.5747e6, color: '#d8a44a', ...j2(3.3089e-5, 2.575e6),
            rotation: locked(15.945421), ...equatorialOrbit(1.22187e9, 0.0288, 0.34854, 28.06, 180.532, 163.31), children: [],
          },
        ],
      },
      {
        id: 'azure', name: 'Azure', massKg: 8.681e25, radiusMeters: 2.5559e7, color: '#9fd8e0', ...j2(3.34343e-3, 2.5559e7),
        rotation: spinIau(17.24 * HOUR, 257.311, -15.175, true),
        ...orbit(19.18916464 * AU_METERS, 0.04725744, 0.77263783, 74.01692503, 96.93735127, 142.28382821), children: [],
      },
      {
        id: 'abyss', name: 'Abyss', massKg: 1.02413e26, radiusMeters: 2.4764e7, color: '#3f5fd0', ...j2(3.411e-3, 2.5225e7),
        rotation: spinIau(16.11 * HOUR, 299.36, 43.46),
        ...orbit(30.06992276 * AU_METERS, 0.00859048, 1.77004347, 131.78422574, 273.18053653, 259.91520804), children: [],
      },
    ],
  },
};

/** Circumbinary layout in the spirit of the game's Astris Prime, with real-scale bodies. */
export const BINARY_SYSTEM: SystemSpec = {
  name: 'Astris binary',
  root: {
    id: 'astris', name: 'Astris', massKg: 1.05 * 1.98847e30, radiusMeters: 1.1 * 6.957e8, color: '#ffd986',
    rotation: spin(24 * SECONDS_PER_DAY, 4),
    children: [
      {
        id: 'lyric', name: 'Lyric', massKg: 0.78 * 1.98847e30, radiusMeters: 0.8 * 6.957e8, color: '#ff8c78',
        rotation: spin(31 * SECONDS_PER_DAY, 6),
        ...orbit(0.12 * AU_METERS, 0.05, 0.4, 0, 30, 0), children: [],
      },
      {
        id: 'cinder-wake', name: 'Cinder Wake', massKg: 4.1e23, radiusMeters: 2.9e6, color: '#d0653c',
        rotation: spin(71 * HOUR, 2),
        ...orbit(0.52 * AU_METERS, 0.03, 1.2, 40, 10, 86), children: [],
      },
      {
        id: 'aurelia-veil', name: 'Aurelia Veil', massKg: 5.9722e24, radiusMeters: 6.371e6, color: '#2f86d8',
        rotation: spin(26 * HOUR, 19, 40),
        ...orbit(0.82 * AU_METERS, 0.02, 0.8, 120, 70, 19.5),
        children: [
          {
            id: 'lumen', name: 'Lumen', massKg: 6.1e22, radiusMeters: 1.65e6, color: '#c4c0b6',
            // Fictional; the period is the simulated mean month.
            rotation: locked(18.3679),
            ...orbit(2.9e8, 0.04, 4.6, 80, 200, 12), children: [],
          },
        ],
      },
      {
        id: 'velvet-crown', name: 'Velvet Crown', massKg: 1.2e27, radiusMeters: 6.3e7, color: '#9770ff',
        rotation: spin(11 * HOUR, 12, 300),
        ...orbit(2.68 * AU_METERS, 0.035, 1.6, 200, 150, 243.5),
        children: [
          {
            id: 'crown-i', name: 'Crown I', massKg: 5.5e22, radiusMeters: 1.6e6, color: '#d9c7a0',
            rotation: locked(3.04703), ...orbit(5.2e8, 0.006, 0.3, 10, 50, 100), children: [],
          },
          {
            id: 'crown-ii', name: 'Crown II', massKg: 1.1e23, radiusMeters: 2.3e6, color: '#8fa7c2',
            rotation: locked(7.40538), ...orbit(9.4e8, 0.011, 0.7, 170, 240, 300), children: [],
          },
        ],
      },
    ],
  },
};

export const SYSTEM_PRESETS = { sol: SOL_SYSTEM, binary: BINARY_SYSTEM } as const;
export type SystemPresetId = keyof typeof SYSTEM_PRESETS;
