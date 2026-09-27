import { hillsTerrain, type HillsOptions } from './HillsTerrain';
import type { Terrain } from './Surface';
import { layeredTerrain, MAX_HEIGHT, type LayeredOptions } from '../../../scenery/src/LayeredTerrain';

/**
 * Plain data that builds a Terrain. Tile workers receive this (a sampler
 * closure cannot cross to a worker) and rebuild the same sampler from it, so
 * a tile built in a worker equals the one built on the main thread.
 */
export type TerrainConfig =
  | { readonly kind: 'hills'; readonly options: HillsOptions }
  | { readonly kind: 'layered'; readonly options: LayeredOptions };

export function terrainFromConfig(config: TerrainConfig): Terrain {
  switch (config.kind) {
    case 'hills': return hillsTerrain(config.options);
    case 'layered': {
      const sampler = layeredTerrain(config.options);
      return { name: 'Scenery layered terrain', radiusMeters: config.options.radiusMeters,
        maxHeightMeters: MAX_HEIGHT, sample: (direction, cellMeters = 1) => sampler(direction, cellMeters) };
    }
    default: throw new Error(`TerrainConfig: unknown terrain ${JSON.stringify(config)}`);
  }
}
