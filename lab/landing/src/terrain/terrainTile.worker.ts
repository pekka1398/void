// Imports the worker host module directly: the lodCore barrel also pulls in the renderer, which a worker does not need.
import { serveTileBuilds } from '../../../lod/src/lod/TileWorkerHost';
import { terrainFromConfig, type TerrainConfig } from './TerrainConfig';

serveTileBuilds((config: TerrainConfig) => terrainFromConfig(config).sample);
