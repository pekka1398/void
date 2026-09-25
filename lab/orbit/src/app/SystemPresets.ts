import { AU_METERS, DEGREES, SECONDS_PER_DAY } from '../orbit/Constants';
import type { BodySpec, RotationSpec, SystemSpec } from '../orbit/SystemSpec';

/**
 * Lab fixtures. Masses, radii and elements follow real bodies (Sun, Mercury,
 * Earth, Moon, Mars, Jupiter and its Galilean moons) under fictional names so
 * results can be sanity-checked against known orbits. Elements are Jacobi
 * elements in the ecliptic frame, not a real ephemeris epoch.
 */

function spin(periodSeconds: number, obliquityDegrees: number, poleLongitudeDegrees = 0, angleDegrees = 0): RotationSpec {
  return {
    periodSeconds,
    obliquityRadians: obliquityDegrees * DEGREES,
    poleLongitudeRadians: poleLongitudeDegrees * DEGREES,
    angleAtEpochRadians: angleDegrees * DEGREES,
  };
}

/** Synchronous rotation with the mean sidereal period; see LockedRotationSpec. */
function locked(periodDays: number, obliquityToOrbitDegrees = 0) {
  return { kind: 'locked' as const, periodSeconds: periodDays * SECONDS_PER_DAY, obliquityToOrbitRadians: obliquityToOrbitDegrees * DEGREES };
}

function orbit(aMeters: number, e: number, iDeg: number, nodeDeg: number, periDeg: number, meanDeg: number) {
  return {
    semiMajorAxisMeters: aMeters,
    eccentricity: e,
    inclinationRadians: iDeg * DEGREES,
    longitudeOfAscendingNodeRadians: nodeDeg * DEGREES,
    argumentOfPeriapsisRadians: periDeg * DEGREES,
    meanAnomalyRadians: meanDeg * DEGREES,
  };
}

const HOUR = 3600;

const galileanMoons = (): BodySpec[] => [
  {
    id: 'ember', name: 'Ember', massKg: 8.9319e22, radiusMeters: 1.8216e6, color: '#e8c35a',
    rotation: locked(1.769138), orbit: orbit(4.217e8, 0.0041, 0.05, 43.9, 84.1, 342.0), children: [],
  },
  {
    id: 'rime', name: 'Rime', massKg: 4.7998e22, radiusMeters: 1.5608e6, color: '#cfc6b4',
    rotation: locked(3.551181), orbit: orbit(6.709e8, 0.009, 0.47, 219.1, 88.97, 171.0), children: [],
  },
  {
    id: 'hollow', name: 'Hollow', massKg: 1.4819e23, radiusMeters: 2.6341e6, color: '#9c8f80',
    rotation: locked(7.154553), orbit: orbit(1.0704e9, 0.0013, 0.2, 63.55, 192.4, 317.5), children: [],
  },
];

export const SOL_SYSTEM: SystemSpec = {
  name: 'Sol analogue',
  root: {
    id: 'sol', name: 'Sol', massKg: 1.98847e30, radiusMeters: 6.957e8, color: '#ffd27a',
    rotation: spin(25.38 * SECONDS_PER_DAY, 7.25),
    children: [
      {
        id: 'cinder', name: 'Cinder', massKg: 3.3011e23, radiusMeters: 2.4397e6, color: '#a39485',
        rotation: spin(58.646 * SECONDS_PER_DAY, 0.03),
        orbit: orbit(0.387098 * AU_METERS, 0.20563, 7.005, 48.331, 29.124, 174.796), children: [],
      },
      {
        id: 'aurelia', name: 'Aurelia', massKg: 5.9722e24, radiusMeters: 6.371e6, color: '#3f7fd6',
        rotation: spin(23.9345 * HOUR, 23.44, 90),
        orbit: orbit(1.00000261 * AU_METERS, 0.01671, 0.00005, 348.74, 114.21, 358.617),
        children: [
          {
            id: 'selene', name: 'Selene', massKg: 7.342e22, radiusMeters: 1.7374e6, color: '#b8b8b0',
            // Real sidereal month and pole tilt. The initial semi-major axis is
            // tuned so that, perturbed by the Sun, the simulated mean month is
            // the real 27.3217 d (mean distance then 384,830 km; the unperturbed
            // 384,400 km gives 27.64 d).
            rotation: locked(27.321661, 6.68),
            orbit: orbit(3.814869e8, 0.0549, 5.145, 125.08, 318.15, 135.27), children: [],
          },
        ],
      },
      {
        id: 'ares', name: 'Ares', massKg: 6.4171e23, radiusMeters: 3.3895e6, color: '#c1583a',
        rotation: spin(24.6229 * HOUR, 25.19, 170),
        orbit: orbit(1.523679 * AU_METERS, 0.0934, 1.850, 49.558, 286.502, 19.412), children: [],
      },
      {
        id: 'velvet', name: 'Velvet', massKg: 1.89813e27, radiusMeters: 6.9911e7, color: '#c9a27a',
        rotation: spin(9.925 * HOUR, 3.13, 250),
        orbit: orbit(5.2044 * AU_METERS, 0.0489, 1.303, 100.464, 273.867, 20.020),
        children: galileanMoons(),
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
        orbit: orbit(0.12 * AU_METERS, 0.05, 0.4, 0, 30, 0), children: [],
      },
      {
        id: 'cinder-wake', name: 'Cinder Wake', massKg: 4.1e23, radiusMeters: 2.9e6, color: '#d0653c',
        rotation: spin(71 * HOUR, 2),
        orbit: orbit(0.52 * AU_METERS, 0.03, 1.2, 40, 10, 86), children: [],
      },
      {
        id: 'aurelia-veil', name: 'Aurelia Veil', massKg: 5.9722e24, radiusMeters: 6.371e6, color: '#2f86d8',
        rotation: spin(26 * HOUR, 19, 40),
        orbit: orbit(0.82 * AU_METERS, 0.02, 0.8, 120, 70, 19.5),
        children: [
          {
            id: 'lumen', name: 'Lumen', massKg: 6.1e22, radiusMeters: 1.65e6, color: '#c4c0b6',
            rotation: locked(18.3679),
            orbit: orbit(2.9e8, 0.04, 4.6, 80, 200, 12), children: [],
          },
        ],
      },
      {
        id: 'velvet-crown', name: 'Velvet Crown', massKg: 1.2e27, radiusMeters: 6.3e7, color: '#9770ff',
        rotation: spin(11 * HOUR, 12, 300),
        orbit: orbit(2.68 * AU_METERS, 0.035, 1.6, 200, 150, 243.5),
        children: [
          {
            id: 'crown-i', name: 'Crown I', massKg: 5.5e22, radiusMeters: 1.6e6, color: '#d9c7a0',
            rotation: locked(3.04703), orbit: orbit(5.2e8, 0.006, 0.3, 10, 50, 100), children: [],
          },
          {
            id: 'crown-ii', name: 'Crown II', massKg: 1.1e23, radiusMeters: 2.3e6, color: '#8fa7c2',
            rotation: locked(7.40538), orbit: orbit(9.4e8, 0.011, 0.7, 170, 240, 300), children: [],
          },
        ],
      },
    ],
  },
};

export const SYSTEM_PRESETS = { sol: SOL_SYSTEM, binary: BINARY_SYSTEM } as const;
export type SystemPresetId = keyof typeof SYSTEM_PRESETS;
