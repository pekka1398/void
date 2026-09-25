/// <reference lib="webworker" />
import { serveTileBuilds } from '../lod/TileWorkerHost';
import { samplePlanetSurface } from './DemoSurface';
import { planetPreset, type PlanetPresetId } from './PlanetPresets';

serveTileBuilds((presetId: PlanetPresetId) => {
  const preset = planetPreset(presetId);
  return (direction) => samplePlanetSurface(direction, preset);
});
