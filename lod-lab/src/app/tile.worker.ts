/// <reference lib="webworker" />
import { buildTileMesh, type TileMeshOptions } from '../lod/TileMeshBuilder';
import type { TileKey } from '../lod/TileKey';
import { sampleDemoSurface } from './DemoSurface';

export type TileWorkerRequest =
  | { readonly type: 'init'; readonly options: TileMeshOptions }
  | { readonly type: 'build'; readonly key: TileKey };

let options: TileMeshOptions | undefined;

self.onmessage = (event: MessageEvent<TileWorkerRequest>) => {
  const message = event.data;
  if (message.type === 'init') {
    options = message.options;
    return;
  }
  if (!options) throw new Error('tile worker used before init');
  const data = buildTileMesh(message.key, sampleDemoSurface, options);
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(data, [
    data.positions.buffer,
    data.normals.buffer,
    data.colors.buffer,
    data.grid.buffer,
  ]);
};
