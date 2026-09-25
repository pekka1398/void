import { buildTileMesh, type SurfaceSampler, type TileMeshData, type TileMeshOptions } from './TileMeshBuilder';
import type { TileKey } from './TileKey';

export type TileWorkerRequest<SurfaceConfig> =
  | { readonly type: 'init'; readonly options: TileMeshOptions; readonly surface: SurfaceConfig }
  | { readonly type: 'build'; readonly key: TileKey };

/** The parts of a dedicated worker's global scope this module uses; avoids requiring the WebWorker lib. */
interface WorkerScope {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: TileMeshData, transfer: ArrayBuffer[]): void;
}

/**
 * Worker entry side of TileWorkerPool. Call once from a worker module:
 * makeSampler turns the pool's surface config into this worker's sampler.
 */
export function serveTileBuilds<SurfaceConfig>(makeSampler: (surface: SurfaceConfig) => SurfaceSampler): void {
  const scope = globalThis as unknown as WorkerScope;
  let options: TileMeshOptions | undefined;
  let sampler: SurfaceSampler | undefined;
  scope.onmessage = (event: MessageEvent<TileWorkerRequest<SurfaceConfig>>) => {
    const message = event.data;
    if (message.type === 'init') {
      options = message.options;
      sampler = makeSampler(message.surface);
      return;
    }
    if (!options || !sampler) throw new Error(`TileWorkerHost.ts: build before init; key=${JSON.stringify(message.key)}`);
    const data = buildTileMesh(message.key, sampler, options);
    scope.postMessage(data, [
      data.positions.buffer as ArrayBuffer,
      data.normals.buffer as ArrayBuffer,
      data.colors.buffer as ArrayBuffer,
      data.grid.buffer as ArrayBuffer,
    ]);
  };
}
