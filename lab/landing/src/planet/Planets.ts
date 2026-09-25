import { GRAVITATIONAL_CONSTANT, type SystemSpec } from '../orbitCore';
import { hillsTerrain } from '../terrain/HillsTerrain';
import type { Terrain } from '../terrain/Surface';

/** A planet to land on: its gravity and spin (as an orbit-lab system) and its terrain. */
export interface LandingPlanet {
  system: SystemSpec;
  bodyId: string;
  terrain: Terrain;
}

/**
 * Small starter planet: 100 km radius, Moon-like surface gravity 1.6 m/s^2
 * (far denser than real rock, for gameplay), and a fast 3.5 h spin so the
 * equator moves at 50 m/s and rotating-frame effects are large enough to test.
 */
export function pebble(): LandingPlanet {
  const radiusMeters = 100e3;
  const surfaceGravity = 1.6;
  const equatorSpeed = 50;
  return {
    bodyId: 'pebble',
    system: {
      name: 'Pebble',
      root: {
        id: 'pebble', name: 'Pebble', color: '#6f8f5a',
        massKg: (surfaceGravity * radiusMeters ** 2) / GRAVITATIONAL_CONSTANT,
        radiusMeters,
        rotation: {
          periodSeconds: (2 * Math.PI * radiusMeters) / equatorSpeed,
          obliquityRadians: 0, poleLongitudeRadians: 0, angleAtEpochRadians: 0,
        },
        children: [],
      },
    },
    terrain: hillsTerrain({ name: 'Pebble hills', radiusMeters, maxHeightMeters: 3000, wavelengthMeters: 8000, octaves: 6 }),
  };
}
