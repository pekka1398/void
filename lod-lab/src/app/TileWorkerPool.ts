import { tileId } from '../lod/TileKey';
import type { TileMeshData, TileMeshOptions } from '../lod/TileMeshBuilder';
import type { TileRequest } from '../lod/PlanetLod';
import type { TileWorkerRequest } from './tile.worker';
import type { PlanetPresetId } from './PlanetPresets';

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
  private sampleMillisecondsTotal = 0;
  private finishMillisecondsTotal = 0;

  constructor(
    options: TileMeshOptions,
    presetId: PlanetPresetId,
    private readonly onTile: (tile: TileMeshData) => void,
    private readonly onFatal: (error: Error) => void,
    workerCount: number,
    private readonly onBuildStart: (id: string) => void,
  ) {
    if (!Number.isInteger(workerCount) || workerCount < 1) {
      throw new Error(`TileWorkerPool.ts: invalid workerCount=${workerCount}`);
    }
    for (let index = 0; index < workerCount; index++) {
      const worker = new Worker(new URL('./tile.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (event: MessageEvent<TileMeshData>) => this.finish(worker, event.data);
      worker.onerror = (event) => {
        event.preventDefault();
        this.onFatal(new Error(`tile.worker.ts failed: ${event.message}; source=${event.filename}:${event.lineno}:${event.colno}; job=${this.busy.get(worker) ?? 'initialization'}; inFlight=${this.inFlight.size}`));
      };
      worker.onmessageerror = () => this.onFatal(new Error(`TileWorkerPool.ts: unreadable worker response; job=${this.busy.get(worker) ?? 'initialization'}`));
      const init: TileWorkerRequest = { type: 'init', options, presetId };
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
  get averageSampleMilliseconds(): number { return this.builtCount ? this.sampleMillisecondsTotal / this.builtCount : 0; }
  get averageFinishMilliseconds(): number { return this.builtCount ? this.finishMillisecondsTotal / this.builtCount : 0; }

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
      this.onBuildStart(id);
      this.busy.set(worker, id);
      this.inFlight.add(id);
      const message: TileWorkerRequest = { type: 'build', key: request.key };
      worker.postMessage(message);
    }
  }

  private finish(worker: Worker, tile: TileMeshData): void {
    const id = this.busy.get(worker);
    if (!id || tile.id !== id) {
      this.onFatal(new Error(`TileWorkerPool.ts: response does not match active job; expected=${id}; received=${tile.id}; key=${JSON.stringify(tile.key)}`));
      return;
    }
    this.busy.delete(worker);
    this.inFlight.delete(id);
    this.idle.push(worker);
    this.builtCount++;
    this.buildMillisecondsTotal += tile.buildMilliseconds;
    this.sampleMillisecondsTotal += tile.sampleMilliseconds;
    this.finishMillisecondsTotal += tile.finishMilliseconds;
    try {
      this.onTile(tile);
    } catch (cause) {
      this.onFatal(new Error(`TileWorkerPool.ts: onTile failed; id=${id}; key=${JSON.stringify(tile.key)}; buildMilliseconds=${tile.buildMilliseconds}; builtCount=${this.builtCount}`, { cause }));
      return;
    }
    this.pump();
  }
}
