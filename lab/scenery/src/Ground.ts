import { HOLMAN_SPLIT_DISTANCE_RATIOS, PlanetLod, TileRenderer, TileWorkerPool, type LodSelection } from './lodCore';
import type { SceneryTerrain } from './Terrains';
import type { Vec3 } from './Atmosphere';

/** Vertices per tile side, as lab/landing's collision tiles. */
const RESOLUTION = 33;
/** Finest level: about 4.8 m cells on a 6,371 km planet. */
const MAX_LEVEL = HOLMAN_SPLIT_DISTANCE_RATIOS.length;

/**
 * The planet's visible ground: lab/lod's quadtree driven by the camera alone
 * (it is also the only observer), tiles built by the terrain's own worker.
 */
export class Ground {
  readonly lod: PlanetLod;
  readonly tiles: TileRenderer;
  private readonly workers: TileWorkerPool<unknown>;

  constructor(terrain: SceneryTerrain, workerCount: number, onFatal: (error: Error) => void) {
    this.lod = new PlanetLod({
      radiusMeters: terrain.radiusMeters,
      minSurfaceHeightMeters: 0,
      maxSurfaceHeightMeters: terrain.maxHeightMeters,
      occluderRadiusMeters: terrain.radiusMeters,
      lodSurfaceBandMeters: terrain.maxHeightMeters,
      resolution: RESOLUTION,
      maxLevel: MAX_LEVEL,
      splitDistanceRatios: HOLMAN_SPLIT_DISTANCE_RATIOS,
      maxCachedTiles: 2400,
    });
    this.tiles = new TileRenderer({ resolution: RESOLUTION, metersPerRenderUnit: 1 });
    this.tiles.setMeshWireframe(false);
    this.tiles.setTileBoundaries(false);
    this.workers = new TileWorkerPool(
      () => terrain.createWorker(),
      { radiusMeters: terrain.radiusMeters, resolution: RESOLUTION }, terrain.workerConfig,
      (tile) => { this.lod.acceptTile(tile); this.lod.unpinBuild(tile.id); },
      onFatal, workerCount, (id) => this.lod.pinBuild(id));
  }

  /** `camera` is body-fixed, metres; `focalPixels` is viewport height over 2 tan(fov / 2). */
  update(camera: Vec3, focalPixels: number): LodSelection {
    const selection = this.lod.select({
      observerPositions: [camera],
      camera: { position: camera, distanceScale: 1, maxLevel: MAX_LEVEL, focalPixels, minObserverCellPixels: 2 },
      distanceScale: 1,
      horizonCulling: true,
    });
    this.workers.setWanted(selection.requests);
    this.tiles.sync(selection.render, camera);
    return selection;
  }

  get queuedBuilds(): number { return this.workers.queuedCount + this.workers.inFlightCount; }
}
