import { tileId } from '../lod/TileKey';
import type { TileMeshData, TileMeshOptions } from '../lod/TileMeshBuilder';
import type { TileRequest } from '../lod/PlanetLod';
import type { TileWorkerRequest } from './tile.worker';

/**
 * Priority queue over a fixed set of workers. The wanted set is replaced
 * every frame, so tiles no longer needed are dropped before they start.
 * One job per worker keeps priorities fresh; in-flight jobs always complete.
 */
export class TileWorkerPool {
  private readonly idle: Worker[] = [];
  private readonly busy = new Map<Worker, string>();
  private wanted: TileRequest[] = [];
  private readonly inFlight = new Set<string>();
  private builtCount = 0;
  private buildMillisecondsTotal = 0;

  constructor(
    options: TileMeshOptions,
    private readonly onTile: (tile: TileMeshData) => void,
    workerCount = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1)),
  ) {
    for (let index = 0; index < workerCount; index++) {
      const worker = new Worker(new URL('./tile.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (event: MessageEvent<TileMeshData>) => this.finish(worker, event.data);
      worker.onerror = (event) => console.error('tile worker failed', event.message);
      const init: TileWorkerRequest = { type: 'init', options };
      worker.postMessage(init);
      this.idle.push(worker);
    }
  }

  get workerCount(): number { return this.idle.length + this.busy.size; }
  get queuedCount(): number { return this.wanted.length; }
  get inFlightCount(): number { return this.inFlight.size; }
  get totalBuilt(): number { return this.builtCount; }
  get averageBuildMilliseconds(): number {
    return this.builtCount ? this.buildMillisecondsTotal / this.builtCount : 0;
  }

  isInFlight(id: string): boolean { return this.inFlight.has(id); }

  /** Replace the wanted set; ids already in flight are ignored. */
  setWanted(requests: readonly TileRequest[]): void {
    this.wanted = requests
      .filter((request) => !this.inFlight.has(tileId(request.key)))
      .sort((left, right) => right.priority - left.priority);
    this.pump();
  }

  dispose(): void {
    for (const worker of [...this.idle, ...this.busy.keys()]) worker.terminate();
    this.idle.length = 0;
    this.busy.clear();
    this.wanted = [];
    this.inFlight.clear();
  }

  private pump(): void {
    while (this.idle.length && this.wanted.length) {
      const request = this.wanted.shift()!;
      const id = tileId(request.key);
      if (this.inFlight.has(id)) continue;
      const worker = this.idle.pop()!;
      this.busy.set(worker, id);
      this.inFlight.add(id);
      const message: TileWorkerRequest = { type: 'build', key: request.key };
      worker.postMessage(message);
    }
  }

  private finish(worker: Worker, tile: TileMeshData): void {
    const id = this.busy.get(worker);
    this.busy.delete(worker);
    if (id) this.inFlight.delete(id);
    this.idle.push(worker);
    this.builtCount++;
    this.buildMillisecondsTotal += tile.buildMilliseconds;
    this.onTile(tile);
    this.pump();
  }
}
