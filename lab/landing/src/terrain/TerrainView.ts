import type { Vec3 } from '../orbitCore';
import { PlanetLod, TileRenderer, TileWorkerPool, type LodSelection, type PlanetLodOptions } from '../lodCore';
import type { ContactWorldOptions } from '../physics/ContactWorld';
import type { TerrainConfig } from './TerrainConfig';
import type { Terrain } from './Surface';

/**
 * lab/lod's quadtree for a landing planet. Its finest level is the collision
 * level. Within reach of any observer, every tile and its neighbours are at
 * that level, so no drawn edge there is stitched to a coarser tile and the
 * drawn triangles are the ones Rapier collides with.
 */
export function landingLodOptions(terrain: Terrain, contact: ContactWorldOptions): PlanetLodOptions {
  const maxLevel = contact.tileLevel;
  // Widest tile at the finest level; the tangent warp keeps tiles within 1.5x of the face-centre width.
  const widest = ((Math.PI / 2) * terrain.radiusMeters) / 2 ** maxLevel * 1.5;
  // A finest-level tile's parent splits within this distance: the collision keep radius, one
  // neighbouring tile beyond it, its parent's half width, and the reach above the terrain band.
  const finestSplitMeters = contact.tileKeepMeters + 2 * widest + contact.tileReachMeters;
  const splitDistanceRatios: number[] = [];
  for (let level = 0; level < maxLevel; level += 1) {
    splitDistanceRatios.push(level < 3 ? Infinity : (finestSplitMeters * 2 ** (maxLevel - 1 - level)) / terrain.radiusMeters);
  }
  return {
    radiusMeters: terrain.radiusMeters,
    minSurfaceHeightMeters: 0,
    maxSurfaceHeightMeters: terrain.maxHeightMeters,
    occluderRadiusMeters: terrain.radiusMeters,
    lodSurfaceBandMeters: terrain.maxHeightMeters,
    resolution: contact.tileResolution,
    maxLevel,
    splitDistanceRatios,
  };
}

/** Streams, builds (in workers) and draws the planet's tiles around a set of observers. */
export class TerrainView {
  readonly lod: PlanetLod;
  readonly tiles: TileRenderer;
  private readonly workers: TileWorkerPool<TerrainConfig>;

  constructor(terrain: Terrain, config: TerrainConfig, contact: ContactWorldOptions, workerCount: number, onFatal: (error: Error) => void) {
    this.lod = new PlanetLod(landingLodOptions(terrain, contact));
    this.tiles = new TileRenderer({ resolution: contact.tileResolution, metersPerRenderUnit: 1 });
    this.workers = new TileWorkerPool(
      () => new Worker(new URL('./terrainTile.worker.ts', import.meta.url), { type: 'module' }),
      { radiusMeters: terrain.radiusMeters, resolution: contact.tileResolution }, config,
      (tile) => { this.lod.acceptTile(tile); this.lod.unpinBuild(tile.id); },
      onFatal, workerCount, (id) => this.lod.pinBuild(id));
  }

  /**
   * Observers (the rocket parts, lab/lod's probe) and the render origin in body-fixed metres.
   * Horizon culling follows lab/lod: a tile is hidden when it is below every observer's horizon.
   */
  update(observers: readonly Vec3[], renderOrigin: Vec3): LodSelection {
    const selection = this.lod.select({ observerPositions: observers, distanceScale: 1, horizonCulling: true });
    this.workers.setWanted(selection.requests);
    this.tiles.sync(selection.render, renderOrigin);
    return selection;
  }

  get queuedBuilds(): number { return this.workers.queuedCount + this.workers.inFlightCount; }

  /** Worker count and cumulative tile-build totals (milliseconds summed over every built tile). */
  buildTotals(): { workers: number; built: number; buildMs: number; sampleMs: number; finishMs: number } {
    const w = this.workers, built = w.totalBuilt;
    return { workers: w.workerCount, built, buildMs: w.averageBuildMilliseconds * built,
      sampleMs: w.averageSampleMilliseconds * built, finishMs: w.averageFinishMilliseconds * built };
  }

  dispose(): void {
    this.workers.dispose();
    this.tiles.dispose();
  }
}
