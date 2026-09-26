import { NORMAL_TERRAIN_PLANET } from '../../lod/src/app/PlanetPresets';
import { samplePlanetSurface } from '../../lod/src/app/DemoSurface';
import { aurelia } from './landingCore';
import type { Vec3 } from './Atmosphere';
import { DEFAULT_LAYERED, layeredTerrain, MAX_HEIGHT, SEA_LEVEL } from './LayeredTerrain';

/** A terrain the lab can show: its sampler on the main thread, and the worker that builds its tiles. */
export interface SceneryTerrain {
  readonly label: string;
  readonly radiusMeters: number;
  readonly maxHeightMeters: number;
  sample(direction: Vec3): { readonly heightMeters: number };
  createWorker(): Worker;
  /** What the worker's serveTileBuilds receives. */
  readonly workerConfig: unknown;
  readonly defaultSeaLevel: number;
  /** Heights where rock and snow begin on the land. */
  readonly rockHeight: number;
  readonly snowHeight: number;
}

/**
 * lab/lod's kilometre-scale planet: warped continents, flat ocean floor at 0 m, a 600 m
 * coastal shelf rising to ridged mountains up to 12 km.
 */
function lodTerrain(): SceneryTerrain {
  const preset = NORMAL_TERRAIN_PLANET;
  return {
    label: `lab/lod · ${preset.name}`,
    radiusMeters: preset.radiusMeters,
    maxHeightMeters: preset.maxSurfaceHeightMeters,
    sample: (direction) => samplePlanetSurface(direction, preset),
    createWorker: () => new Worker(new URL('../../lod/src/app/tile.worker.ts', import.meta.url), { type: 'module' }),
    workerConfig: 'normal',
    defaultSeaLevel: 300,
    rockHeight: preset.terrain.rockHeightMeters,
    snowHeight: preset.terrain.snowHeightMeters,
  };
}

/** lab/landing's Aurelia hills, the ground lab/flight flies over: 8 km noise hills, no continents. */
function hillsTerrain(): SceneryTerrain {
  const planet = aurelia();
  return {
    label: 'lab/landing · Aurelia hills',
    radiusMeters: planet.terrain.radiusMeters,
    maxHeightMeters: planet.terrain.maxHeightMeters,
    sample: (direction) => planet.terrain.sample(direction),
    createWorker: () => new Worker(new URL('../../landing/src/terrain/terrainTile.worker.ts', import.meta.url), { type: 'module' }),
    workerConfig: planet.terrainConfig,
    defaultSeaLevel: 1800,
    rockHeight: 4500,
    snowHeight: 6000,
  };
}

/** This lab's layered planet (src/LayeredTerrain.ts): continents, mountain belts, eroded hills down to metres. */
function layered(): SceneryTerrain {
  const sample = layeredTerrain(DEFAULT_LAYERED);
  return {
    label: 'scenery · layered',
    radiusMeters: DEFAULT_LAYERED.radiusMeters,
    maxHeightMeters: MAX_HEIGHT,
    // The camera stands on the full-detail surface.
    sample: (direction) => sample(direction, 1),
    createWorker: () => new Worker(new URL('./terrain.worker.ts', import.meta.url), { type: 'module' }),
    workerConfig: DEFAULT_LAYERED,
    defaultSeaLevel: SEA_LEVEL,
    rockHeight: SEA_LEVEL + 2600,
    snowHeight: SEA_LEVEL + 4800,
  };
}

export const TERRAINS: Record<string, () => SceneryTerrain> = { layered, lod: lodTerrain, hills: hillsTerrain };

export function sceneryTerrain(id: string): SceneryTerrain {
  const make = TERRAINS[id];
  if (!make) throw new Error(`Terrains.ts: unknown terrain ${JSON.stringify(id)}; valid: ${Object.keys(TERRAINS).join(', ')}`);
  return make();
}
