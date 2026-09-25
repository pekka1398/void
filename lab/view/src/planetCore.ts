/**
 * The landing lab's terrain and its tile streaming (lab/lod's quadtree,
 * renderer and workers), imported so the planet drawn here is the one the
 * landing lab lands on. Changes they need are made in those labs, whose
 * checks must keep passing.
 */
export { TerrainView, landingLodOptions } from '../../landing/src/terrain/TerrainView';
export { levelForTileSize } from '../../landing/src/terrain/TerrainTiles';
export { terrainFromConfig, type TerrainConfig } from '../../landing/src/terrain/TerrainConfig';
export type { Terrain } from '../../landing/src/terrain/Surface';
export type { ContactWorldOptions } from '../../landing/src/physics/ContactWorld';
export { LabLog } from '../../landing/src/debug/LabLog';
