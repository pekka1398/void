/// <reference lib="webworker" />
import { createPlanetField, samplePlanetField, type PlanetField } from '../fields';
import { buildTileMesh, type SurfaceSampler, type TileMeshOptions } from './TileMeshBuilder';
import type { TileKey } from './TileKey';

export type TileWorkerRequest =
  | { readonly type: 'init'; readonly field: PlanetField; readonly options: TileMeshOptions }
  | { readonly type: 'build'; readonly key: TileKey };

let sampler: SurfaceSampler | undefined;
let options: TileMeshOptions | undefined;

self.onmessage = (event: MessageEvent<TileWorkerRequest>) => {
  const message = event.data;
  if (message.type === 'init') {
    const field = createPlanetField(message.field);
    // The flight envelope surface: flat sea level over ocean, real ground on land.
    sampler = (direction) => {
      const sample = samplePlanetField(field, direction);
      return { heightMeters: sample.radialMeters - field.radiusMeters, color: sample.color };
    };
    options = message.options;
    return;
  }
  if (!sampler || !options) throw new Error('tile worker used before init');
  const data = buildTileMesh(message.key, sampler, options);
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(data, [
    data.positions.buffer,
    data.normals.buffer,
    data.colors.buffer,
    data.grid.buffer,
  ]);
};
