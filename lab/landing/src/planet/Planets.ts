import { buildSystem, Ephemeris, GRAVITATIONAL_CONSTANT, suggestedStepSeconds, type BodySpec, type SystemSpec } from '../orbitCore';
import { SYSTEM_PRESETS } from '../../../orbit/src/app/SystemPresets';
import { terrainFromConfig, type TerrainConfig } from '../terrain/TerrainConfig';
import type { Terrain } from '../terrain/Surface';

/** A planet to land on: its gravity and spin (as an orbit-lab system) and its terrain. */
export interface LandingPlanet {
  /** Short label for the page badge. */
  label: string;
  system: SystemSpec;
  bodyId: string;
  /** Data the terrain is built from; tile workers rebuild the same terrain from it. */
  terrainConfig: TerrainConfig;
  terrain: Terrain;
}

interface PlanetParameters {
  id: string;
  name: string;
  color: string;
  radiusMeters: number;
  surfaceGravity: number;
  rotationPeriodSeconds: number;
  terrain: { maxHeightMeters: number; wavelengthMeters: number; octaves: number };
}

function landingPlanet(p: PlanetParameters): LandingPlanet {
  const terrainConfig: TerrainConfig = { kind: 'hills', options: { name: `${p.name} hills`, radiusMeters: p.radiusMeters, ...p.terrain } };
  const hours = p.rotationPeriodSeconds / 3600;
  return {
    label: `${p.name.toUpperCase()} · ${p.radiusMeters >= 1e6 ? `${(p.radiusMeters / 1e3).toFixed(0)} km` : `${p.radiusMeters / 1e3} km`} RADIUS · ${p.surfaceGravity} m/s² · ${hours < 48 ? `${hours.toFixed(1)} h` : `${(hours / 24).toFixed(1)} d`} DAY`,
    bodyId: p.id,
    system: {
      name: p.name,
      root: {
        id: p.id, name: p.name, color: p.color,
        massKg: (p.surfaceGravity * p.radiusMeters ** 2) / GRAVITATIONAL_CONSTANT,
        radiusMeters: p.radiusMeters,
        rotation: { periodSeconds: p.rotationPeriodSeconds, obliquityRadians: 0, poleLongitudeRadians: 0, angleAtEpochRadians: 0 },
        children: [],
      },
    },
    terrainConfig,
    terrain: terrainFromConfig(terrainConfig),
  };
}

/**
 * Small starter planet: 100 km radius, Moon-like surface gravity 1.6 m/s^2
 * (far denser than real rock, for gameplay), and a fast 3.5 h spin so the
 * equator moves at 50 m/s and rotating-frame effects are large enough to test.
 */
export function pebble(): LandingPlanet {
  const radiusMeters = 100e3;
  return landingPlanet({ id: 'pebble', name: 'Pebble', color: '#6f8f5a', radiusMeters, surfaceGravity: 1.6,
    rotationPeriodSeconds: (2 * Math.PI * radiusMeters) / 50, terrain: { maxHeightMeters: 3000, wavelengthMeters: 8000, octaves: 6 } });
}

/** The Moon's radius, gravity and 27.3-day spin, with placeholder hills up to 6 km. */
export function moonSize(): LandingPlanet {
  return landingPlanet({ id: 'luna', name: 'Luna', color: '#9a9a92', radiusMeters: 1_737_400, surfaceGravity: 1.62,
    rotationPeriodSeconds: 27.321661 * 86_400, terrain: { maxHeightMeters: 6000, wavelengthMeters: 30_000, octaves: 8 } });
}

/** Earth's radius, gravity and sidereal day, with placeholder hills up to 8 km (the check's Earth-size terrain). */
export function earthSize(): LandingPlanet {
  return landingPlanet({ id: 'terra', name: 'Terra', color: '#4f7f4a', radiusMeters: 6_371_000, surfaceGravity: 9.81,
    rotationPeriodSeconds: 86_164.1, terrain: { maxHeightMeters: 8000, wavelengthMeters: 40_000, octaves: 8 } });
}

/**
 * The orbit lab's Earth analogue inside its full solar system (Sun, planets,
 * moons, axial tilt), with terra's placeholder hills: landing here feels the
 * Sun's and Selene's tides and orbits among real neighbours.
 */
export function aurelia(): LandingPlanet {
  return aureliaWithSpin(1);
}

/**
 * Aurelia spinning ten times faster (a 2.4 h day): the ground moves 4.5 km/s
 * at the launch site and the centrifugal pull is a third of gravity, so the
 * rotating frame's effects are plain to see in flight. Everything else,
 * including J2, is the sol preset's.
 */
export function aureliaFast(): LandingPlanet {
  return aureliaWithSpin(10);
}

function aureliaWithSpin(spinFactor: number): LandingPlanet {
  const system = spinFactor === 1 ? SYSTEM_PRESETS.sol : withFasterSpin(SYSTEM_PRESETS.sol, 'aurelia', spinFactor);
  const body = buildSystem(system).bodies.find((b) => b.id === 'aurelia');
  if (!body) throw new Error('Planets.ts: the sol preset has no aurelia');
  const terrainConfig: TerrainConfig = { kind: 'hills', options: { name: 'Aurelia hills', radiusMeters: body.radiusMeters,
    maxHeightMeters: 8000, wavelengthMeters: 40_000, octaves: 8 } };
  const gravity = body.gm / body.radiusMeters ** 2;
  return {
    label: `AURELIA${spinFactor === 1 ? '' : ` (SPIN ×${spinFactor})`} · SOL SYSTEM · ${(body.radiusMeters / 1e3).toFixed(0)} km RADIUS · ${gravity.toFixed(2)} m/s² · ${(body.rotation.periodSeconds / 3600).toFixed(1)} h DAY`,
    bodyId: body.id, system, terrainConfig, terrain: terrainFromConfig(terrainConfig),
  };
}

/** A copy of the system with one body's (free, not locked) spin sped up by `factor`. */
function withFasterSpin(system: SystemSpec, bodyId: string, factor: number): SystemSpec {
  let found = false;
  const copy = (node: BodySpec): BodySpec => {
    if (node.id !== bodyId) return { ...node, children: node.children.map(copy) };
    if ('kind' in node.rotation) throw new Error(`Planets.ts: ${bodyId} is tidally locked; its spin follows its orbit`);
    found = true;
    return { ...node, rotation: { ...node.rotation, periodSeconds: node.rotation.periodSeconds / factor }, children: node.children.map(copy) };
  };
  const root = copy(system.root);
  if (!found) throw new Error(`Planets.ts: ${bodyId} is not in system ${system.name}`);
  return { ...system, root };
}

export const PLANETS = { pebble, luna: moonSize, terra: earthSize, aurelia, 'aurelia-fast': aureliaFast } as const;

/**
 * The planet's system integrated as an ephemeris, and the planet's index in it.
 * A lone planet has no orbits to size a step from; its ephemeris is trivial
 * and steps a minute.
 */
export function planetEphemeris(planet: LandingPlanet): { ephemeris: Ephemeris; bodyIndex: number } {
  const system = buildSystem(planet.system);
  const body = system.bodies.find((b) => b.id === planet.bodyId);
  if (!body) throw new Error(`Planets.ts: ${planet.bodyId} is not in system ${planet.system.name}`);
  const stepSeconds = system.bodies.length > 1 ? suggestedStepSeconds(system.bodies, 256) : 60;
  const ephemeris = new Ephemeris(system, { stepSeconds, chunkSteps: 1024 });
  ephemeris.extendTo(stepSeconds);
  return { ephemeris, bodyIndex: body.index };
}
export type PlanetId = keyof typeof PLANETS;

export function planetById(id: string): LandingPlanet {
  if (!Object.hasOwn(PLANETS, id)) throw new Error(`Planets.ts: unknown planet ${JSON.stringify(id)}; valid=${Object.keys(PLANETS).join(',')}`);
  return PLANETS[id as PlanetId]();
}
