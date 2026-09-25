/// <reference lib="webworker" />
import { buildTileMesh, type TileMeshOptions } from '../lod/TileMeshBuilder';
import type { TileKey } from '../lod/TileKey';
import { samplePlanetSurface } from './DemoSurface';
import { planetPreset, type PlanetPreset, type PlanetPresetId } from './PlanetPresets';

export type TileWorkerRequest =
  | { readonly type: 'init'; readonly options: TileMeshOptions; readonly presetId: PlanetPresetId }
  | { readonly type: 'build'; readonly key: TileKey };

let options: TileMeshOptions | undefined;
let preset: PlanetPreset | undefined;

self.onmessage = (event: MessageEvent<TileWorkerRequest>) => {
  const message = event.data;
  if (message.type === 'init') {
    options = message.options;
    preset = planetPreset(message.presetId);
    return;
  }
  if (!options || !preset) throw new Error(`tile.worker.ts: build before init; key=${JSON.stringify(message.key)}; options=${!!options}; preset=${preset?.name ?? 'missing'}`);
  const activePreset = preset;
  const data = buildTileMesh(message.key, (direction) => samplePlanetSurface(direction, activePreset), options);
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(data, [
    data.positions.buffer,
    data.normals.buffer,
    data.colors.buffer,
    data.grid.buffer,
  ]);
};
