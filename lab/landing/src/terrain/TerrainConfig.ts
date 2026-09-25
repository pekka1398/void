import { hillsTerrain, type HillsOptions } from './HillsTerrain';
import type { Terrain } from './Surface';

/**
 * Plain data that builds a Terrain. Tile workers receive this (a sampler
 * closure cannot cross to a worker) and rebuild the same sampler from it, so
 * a tile built in a worker equals the one built on the main thread.
 */
export type TerrainConfig = { readonly kind: 'hills'; readonly options: HillsOptions };

export function terrainFromConfig(config: TerrainConfig): Terrain {
  switch (config.kind) {
    case 'hills': return hillsTerrain(config.options);
  }
}
