import { BufferGeometry, Group, Mesh, MeshLambertMaterial, Vector3 } from 'three';
import { positionLocal, uniform } from 'three/tsl';
import type { MeshLambertNodeMaterial, Node, UniformNode } from 'three/webgpu';

import { createPlanetField, type PlanetField, type PlanetFieldInput } from '../fields';
import { clonePlanetLandMaterial } from '../render/planet/PlanetLandMaterial';
import {
  MAX_OPAQUE_SURFACE_COVERAGES,
  createSurfacePatchCoverageSetMask,
  surfacePatchCoverageContains,
  type SurfacePatchCoverage,
} from '../render/planet/SurfacePatchCoverage';
import { useNodeAwareMaterialCacheKey } from './ContactRenderMask';
import { CUBE_FACES, directionToFaceUv, faceUvToDirection } from './CubeSphere';
import {
  createPlanetMaterial,
  terrainGeometryFromBuffers,
  type TerrainEdgeStitching,
  type TerrainTileBuffers,
  type TerrainTileGeometryOptions,
} from './Geometry';
import {
  resolveTerrainViewDirections,
  selectTerrainTiles,
  type SelectedTerrainTile,
  type TerrainViewDirections,
} from './Quadtree';
import {
  childTileKeys,
  makeTileKey,
  neighborTileKey,
  parentTileKey,
  tileBounds,
  tileContainsDirection,
  tileKeyToString,
  type TileEdge,
  type TerrainTileKey,
} from './TileKey';
import { TerrainJobScheduler } from './TerrainJobScheduler';
import {
  advanceLodProgress,
  lodIntervalContains,
  lodIntervalMask,
  sampleScreenSpaceLodNoise,
  screenSpaceLodNoise,
} from './TerrainLodTransition';
import {
  conservativeTerrainInnerRadius,
  terrainSphereOccludedByBody,
  terrainSphereOutsideViewCone,
} from './TerrainRenderCulling';

export type TerrainLandMaterial = MeshLambertMaterial | MeshLambertNodeMaterial;
export type TerrainTileMesh = Mesh<BufferGeometry, TerrainLandMaterial>;

export interface TerrainTileMaterialContext {
  readonly key: TerrainTileKey;
  /** Stable mutable value of this tile's origin uniform, in render units. */
  readonly origin: Vector3;
  /** Includes the actual tile-local origin; never use positionLocal alone for weather. */
  readonly bodyPositionRenderUnits: Node<'vec3'>;
  /** Opaque global/parent/child/local coverage, already complementary to its siblings. */
  readonly maskNode: Node<'bool'>;
}

interface TilePresentation {
  readonly origin: UniformNode<'vec3', Vector3>;
  readonly lower: UniformNode<'float', number>;
  readonly upper: UniformNode<'float', number>;
  readonly localCoverage: ReturnType<typeof createSurfacePatchCoverageSetMask>;
}

export type TerrainTileState =
  | 'queued'
  | 'generating'
  | 'ready'
  | 'resident'
  | 'cooling'
  | 'obsolete';

interface TerrainRecord {
  key: TerrainTileKey;
  token: number;
  admittedToken?: number;
  priority: number;
  state: TerrainTileState;
  mesh?: TerrainTileMesh;
  presentation?: TilePresentation;
  /** Incoming opaque ownership from the parent, not material transparency. */
  fadeProgress: number;
  splitProgress: number;
  coverageLower: number;
  coverageUpper: number;
  locallyCovered: boolean;
  viewCulled: boolean;
  occlusionCulled: boolean;
  frustumCulled: boolean;
  stitchMask?: number;
  touchedFrame: number;
}

export interface TerrainWorkerRequest {
  key: TerrainTileKey;
  field: PlanetField;
  token: number;
  options: TerrainTileGeometryOptions;
}

export interface TerrainWorkerResponse {
  key: TerrainTileKey;
  token: number;
  buffers: TerrainTileBuffers;
}

export interface TerrainStreamerOptions {
  /** A game-owned scheduler shares workers/uploads with human-scale contact terrain. */
  scheduler?: TerrainJobScheduler;
  renderRadius?: number;
  radius?: number;
  maxDepth?: number;
  maxTiles?: number;
  maxResident?: number;
  maxQueued?: number;
  maxWorkers?: number;
  maxUploadsPerFrame?: number;
  tileSegments?: number;
  pixelError?: number;
  useWorkers?: boolean;
  material?: TerrainLandMaterial;
  /** Supply a fresh native/shared-style material with the exact tile origin and coverage nodes. */
  materialFactory?: (context: TerrainTileMaterialContext) => TerrainLandMaterial;
  /** GameApp owns the globe handoff; prewarming must not advance unseen presentation. */
  managedPresentation?: boolean;
  /** Conservative actual-bound culling; logical complete coverage remains resident. */
  renderCulling?: boolean;
  /** Transfer actual opaque coverage to complete child quartets over this duration. */
  fadeDurationSeconds?: number;
  /** Body-local predictive selection window; never changes actual tile positions. */
  predictionSeconds?: number;
  viewportHeight?: number;
  /** Recommended body-radius distance for an application's early prewarm. */
  prewarmDistanceRatio?: number;
}

export interface TerrainStreamingView {
  deltaSeconds?: number;
  /** Body-local render units per second, not compressed physical meters. */
  velocity?: { x: number; y: number; z: number };
  viewportHeight?: number;
  fieldOfViewDegrees?: number;
  /** Genuine camera-forward direction in the same body-fixed render frame. */
  lookDirection?: { x: number; y: number; z: number };
  /** Actual viewport aspect used to acquire both visible horizon edges. */
  viewportAspect?: number;
  prewarm?: boolean;
}

export interface TerrainStreamerStats {
  selected: number;
  resident: number;
  queued: number;
  generating: number;
  discarded: number;
  maxDepth: number;
  triangleCount: number;
  visible: number;
  fading: number;
  ready: boolean;
  readiness: number;
  prewarming: boolean;
  predictedLeadMeters: number;
  pendingUploads: number;
  parentRetained: number;
  transitions: number;
  altitudeMeters: number;
  /** Six actual radial/predicted/forward/horizon body-fixed coverage probes. */
  coverageSamples: number;
  coveredSamples: number;
  horizonCoverage: number;
  forwardCoverage: number;
  predictedCoverage: number;
  coverageReady: boolean;
  horizonTiles: number;
  /** All six structural roots have real, opaque, retained mesh coverage. */
  sixRootCoverageReady: boolean;
  presentationAlpha: number;
  ownsWholeGlobe: boolean;
  viewCulled: number;
  occlusionCulled: number;
  frustumCulled: number;
}

export interface TerrainPresentationState {
  readonly alpha: number;
  readonly targetAlpha: number;
  readonly sixRootCoverageReady: boolean;
  /** The proxy may be completely masked only when this is true. */
  readonly ownsWholeGlobe: boolean;
}

const TERRAIN_TILE_EDGES: readonly TileEdge[] = ['left', 'right', 'bottom', 'top'];
let nextTerrainSchedulerOwner = 1;

/** Resolve only real 2:1 transitions from the current cube-face leaf topology. */
export function resolveTerrainTileStitchEdges(
  key: TerrainTileKey,
  selected: ReadonlySet<string>,
): TerrainEdgeStitching {
  const edges: TerrainEdgeStitching = {};

  for (const edge of TERRAIN_TILE_EDGES) {
    let neighbor: TerrainTileKey | null = neighborTileKey(key, edge);

    while (neighbor) {
      if (selected.has(tileKeyToString(neighbor))) {
        if (neighbor.level < key.level) edges[edge] = true;
        break;
      }

      neighbor = parentTileKey(neighbor);
    }
  }

  return edges;
}

function stitchMask(edges: TerrainEdgeStitching): number {
  return (
    (edges.left ? 1 : 0) |
    (edges.right ? 2 : 0) |
    (edges.bottom ? 4 : 0) |
    (edges.top ? 8 : 0)
  );
}

/** Bounded body-local tile residency with transferable worker-generated meshes. */
export class TerrainStreamer {
  readonly field: PlanetField;
  readonly group = new Group();
  readonly renderRadius: number;
  readonly material: TerrainLandMaterial;
  readonly prewarmDistanceRatio: number;
  /** Share this stable threshold with the old globe's complementary dissolve mask. */
  readonly presentationAlphaNode = uniform(1);

  private readonly ownsMaterial: boolean;
  private readonly materialFactory?: TerrainStreamerOptions['materialFactory'];
  private readonly renderCulling: boolean;
  private managedPresentation: boolean;
  private presentationTarget = 1;
  private localCoverage: readonly SurfacePatchCoverage[] = [];
  private localCoverageSignature = '';
  private readonly options: Required<
    Pick<
      TerrainStreamerOptions,
      | 'maxDepth'
      | 'maxTiles'
      | 'maxResident'
      | 'maxQueued'
      | 'maxWorkers'
      | 'maxUploadsPerFrame'
      | 'tileSegments'
      | 'pixelError'
      | 'useWorkers'
      | 'fadeDurationSeconds'
      | 'predictionSeconds'
      | 'viewportHeight'
    >
  >;
  private readonly records = new Map<string, TerrainRecord>();
  private readonly desired = new Set<string>();
  private readonly desiredKeys = new Map<string, TerrainTileKey>();
  private readonly required = new Set<string>();
  private readonly refinedDesired = new Set<string>();
  private readonly scheduler: TerrainJobScheduler;
  private readonly ownsScheduler: boolean;
  private readonly schedulerOwner = `orbital-terrain-${nextTerrainSchedulerOwner++}`;
  private frame = 0;
  private nextToken = 1;
  private disposed = false;
  private discarded = 0;
  private selectedCount = 0;
  private transitionCount = 0;
  private retainedParents = 0;
  private prewarming = false;
  private predictedLeadMeters = 0;
  private cameraAltitudeMeters = Number.POSITIVE_INFINITY;
  private previousCamera?: Vector3;
  private previousVelocity = new Vector3();
  private viewDirections?: TerrainViewDirections;
  private selectedHorizonTiles = 0;
  private readonly renderCamera = new Vector3();
  private renderLookDirection?: Vector3;
  private renderFieldOfView = 57;
  private renderAspect = 16 / 9;
  private hasRenderView = false;

  constructor(input: PlanetField | PlanetFieldInput, options: TerrainStreamerOptions = {}) {
    this.field = 'landable' in input ? input : createPlanetField(input);
    this.renderRadius = options.renderRadius ?? options.radius ?? this.field.radius;
    this.material = options.material ?? createPlanetMaterial({ flatShading: true }, this.field);
    this.ownsMaterial = !options.material;
    this.materialFactory = options.materialFactory;
    this.renderCulling = options.renderCulling ?? true;
    this.managedPresentation = options.managedPresentation ?? false;
    this.presentationTarget = this.managedPresentation ? 0 : 1;
    this.presentationAlphaNode.value = this.presentationTarget;
    this.group.visible = !this.managedPresentation;
    this.prewarmDistanceRatio = Math.max(1.4, Math.min(5, options.prewarmDistanceRatio ?? 3.1));
    this.options = {
      maxDepth: Math.max(0, Math.min(18, options.maxDepth ?? 12)),
      maxTiles: Math.max(6, options.maxTiles ?? 72),
      maxResident: Math.max(12, options.maxResident ?? 112),
      maxQueued: Math.max(6, options.maxQueued ?? 36),
      maxWorkers: Math.max(1, Math.min(4, options.maxWorkers ?? 2)),
      maxUploadsPerFrame: Math.max(1, options.maxUploadsPerFrame ?? 2),
      tileSegments: Math.max(4, Math.min(128, Math.round(options.tileSegments ?? 32))),
      pixelError: Math.max(8, options.pixelError ?? 74),
      useWorkers: options.useWorkers ?? true,
      fadeDurationSeconds: Math.max(0.08, Math.min(1.2, options.fadeDurationSeconds ?? 0.34)),
      predictionSeconds: Math.max(0, Math.min(2, options.predictionSeconds ?? 0.72)),
      viewportHeight: Math.max(180, Math.min(2_400, options.viewportHeight ?? 900)),
    };
    this.ownsScheduler = options.scheduler === undefined;
    this.scheduler = options.scheduler ?? new TerrainJobScheduler({
      maxWorkers: this.options.maxWorkers,
      maxQueued: this.options.maxQueued,
      maxUploadsPerFrame: this.options.maxUploadsPerFrame,
      useWorkers: this.options.useWorkers,
    });
    this.group.name = `terrain-${this.field.seed.toString(16)}`;
    this.group.userData.planetField = this.field;

  }

  update(
    cameraPosition: { x: number; y: number; z: number },
    view: TerrainStreamingView = {},
  ): TerrainStreamerStats {
    if (this.disposed) return this.stats;

    this.frame += 1;
    if (this.ownsScheduler) this.scheduler.beginFrame(this.frame);
    const delta = Math.min(0.25, Math.max(0.001, view.deltaSeconds ?? 1 / 60));
    const camera = new Vector3(cameraPosition.x, cameraPosition.y, cameraPosition.z);
    const measuredVelocity = view.velocity
      ? new Vector3(view.velocity.x, view.velocity.y, view.velocity.z)
      : this.previousCamera
        ? camera.clone().sub(this.previousCamera).multiplyScalar(1 / delta)
        : new Vector3();
    this.previousVelocity.lerp(measuredVelocity, view.velocity ? 0.78 : 0.42);
    const viewLook = view.lookDirection
      ? new Vector3(view.lookDirection.x, view.lookDirection.y, view.lookDirection.z).normalize()
      : undefined;
    this.renderCamera.copy(camera);
    this.renderLookDirection = viewLook;
    this.renderFieldOfView = view.fieldOfViewDegrees ?? 57;
    this.renderAspect = view.viewportAspect ?? 16 / 9;
    this.hasRenderView = true;
    const cameraRadial = camera.lengthSq() > 0 ? camera.clone().normalize() : undefined;
    const grazingView = viewLook && cameraRadial
      ? 1 - Math.min(1, Math.abs(viewLook.dot(cameraRadial)))
      : 0;
    // Looking across a real spherical horizon needs a longer authentic
    // body-fixed lead than looking directly downward onto the radial tile.
    const predictionSeconds = Math.min(2,
      this.options.predictionSeconds * (1 + grazingView * 0.34),
    );
    const maximumLeadVelocity = this.renderRadius * 0.52 / Math.max(0.001, predictionSeconds);
    if (this.previousVelocity.length() > maximumLeadVelocity) {
      this.previousVelocity.setLength(maximumLeadVelocity);
    }
    this.previousCamera = camera.clone();
    this.cameraAltitudeMeters = Math.max(0, (camera.length() - this.renderRadius) * this.field.radius / this.renderRadius);
    this.predictedLeadMeters = this.previousVelocity.length() * predictionSeconds * this.field.radius / this.renderRadius;
    this.prewarming = view.prewarm ?? camera.length() > this.renderRadius * 1.36;
    const previousDesired = new Set(this.desired);
    this.viewDirections = resolveTerrainViewDirections(camera, {
      radius: this.renderRadius,
      velocity: this.previousVelocity,
      predictionSeconds,
      ...(view.lookDirection ? { lookDirection: view.lookDirection } : {}),
      ...(view.fieldOfViewDegrees !== undefined ? { fieldOfViewDegrees: view.fieldOfViewDegrees } : {}),
      ...(view.viewportAspect !== undefined ? { viewportAspect: view.viewportAspect } : {}),
    });
    const selected = selectTerrainTiles(cameraPosition, {
      radius: this.renderRadius,
      maxDepth: this.options.maxDepth,
      // A six-root quadtree with L leaves has (4L - 6) / 3 total
      // ancestors+leaves. Keep those real fallback meshes resident rather
      // than evicting a parent that a reversing transition will need.
      maxTiles: Math.min(this.options.maxTiles,
        Math.max(6, Math.floor((3 * this.options.maxResident + 6) / 4))),
      pixelError: this.options.pixelError * (this.prewarming ? 0.88 : 1),
      viewportHeight: view.viewportHeight ?? this.options.viewportHeight,
      fieldOfViewDegrees: view.fieldOfViewDegrees,
      velocity: this.previousVelocity,
      predictionSeconds,
      previousSelection: previousDesired,
      ...(view.lookDirection ? { lookDirection: view.lookDirection } : {}),
      ...(view.viewportAspect !== undefined ? { viewportAspect: view.viewportAspect } : {}),
    });

    const anchorPriority = (tile: SelectedTerrainTile): number => {
      if (!this.viewDirections) return 0;
      let focus = 0;
      if (tileContainsDirection(tile.key, this.viewDirections.radial)) focus += 8;
      if (tileContainsDirection(tile.key, this.viewDirections.forward)) focus += 9;
      if (tileContainsDirection(tile.key, this.viewDirections.predicted)) focus += 6;
      if (tileContainsDirection(tile.key, this.viewDirections.horizon)) focus += 5;
      if (tileContainsDirection(tile.key, this.viewDirections.leftHorizon)) focus += 3;
      if (tileContainsDirection(tile.key, this.viewDirections.rightHorizon)) focus += 3;
      return focus;
    };
    selected.sort((first, second) => anchorPriority(second) - anchorPriority(first) || second.priority - first.priority);
    this.selectedHorizonTiles = selected.filter((tile) => Boolean(
      this.viewDirections && (
        tileContainsDirection(tile.key, this.viewDirections.horizon) ||
        tileContainsDirection(tile.key, this.viewDirections.leftHorizon) ||
        tileContainsDirection(tile.key, this.viewDirections.rightHorizon)
      ),
    )).length;

    this.selectedCount = selected.length;
    this.desired.clear();
    this.desiredKeys.clear();
    this.required.clear();
    this.refinedDesired.clear();

    // Structural global coverage must win admission before any deep branch.
    // A ready near face alone is not permission to remove the whole globe.
    for (const face of CUBE_FACES) {
      const key = makeTileKey(face);
      this.required.add(tileKeyToString(key));
      this.ensure({ key, priority: 1_000_000_000 });
    }

    for (const tile of selected) {
      const id = tileKeyToString(tile.key);
      this.desired.add(id);
      this.desiredKeys.set(id, tile.key);
      const focusedPriority = tile.priority + anchorPriority(tile) * 250_000;
      const ancestors: TerrainTileKey[] = [];
      let ancestor = parentTileKey(tile.key);
      while (ancestor) {
        ancestors.push(ancestor);
        this.refinedDesired.add(tileKeyToString(ancestor));
        ancestor = parentTileKey(ancestor);
      }
      // Generate complete coarse coverage first, then successively finer work.
      for (const key of ancestors.reverse()) {
        this.required.add(tileKeyToString(key));
        const priority = key.level === 0 ? 1_000_000_000 :
          focusedPriority + (this.options.maxDepth - key.level + 1) * 1_000_000;
        this.ensure({ key, priority });
      }
      this.required.add(id);
      this.ensure({ ...tile, priority: tile.key.level === 0 ? 1_000_000_000 : focusedPriority });
    }

    this.refreshResidentStitching();
    this.cancelObsoleteQueue();
    this.schedule();
    this.uploadReadyTiles();
    this.updateVisibility(this.managedPresentation ? 0 : delta);
    this.evictColdTiles();

    return this.stats;
  }

  /** Begin actual bounded worker acquisition before the streamed body fills the screen. */
  preload(
    cameraPosition: { x: number; y: number; z: number },
    view: TerrainStreamingView = {},
  ): TerrainStreamerStats {
    return this.update(cameraPosition, { ...view, prewarm: true });
  }

  private ensure(tile: Pick<SelectedTerrainTile, 'key' | 'priority'>): void {
    const id = tileKeyToString(tile.key);
    const existing = this.records.get(id);

    if (existing) {
      existing.priority = Math.max(existing.priority * 0.84, tile.priority);
      existing.touchedFrame = this.frame;
      if (existing.state === 'cooling') existing.state = 'resident';
      if (existing.state === 'obsolete') {
        // A canceled in-flight record is not part of queuedCount. Reviving it
        // without admission used to exceed the hard queue bound when grazing
        // prediction revisited a just-obsoleted cube-face branch.
        if (this.queuedCount >= this.options.maxQueued) return;
        existing.token = this.nextToken++;
        existing.admittedToken = undefined;
        existing.state = 'queued';
      }
      return;
    }

    if (this.queuedCount >= this.options.maxQueued) return;

    this.records.set(id, {
      key: tile.key,
      token: this.nextToken++,
      priority: tile.priority,
      state: 'queued',
      fadeProgress: 0,
      splitProgress: 0,
      coverageLower: 0,
      coverageUpper: 0,
      locallyCovered: false,
      viewCulled: false,
      occlusionCulled: false,
      frustumCulled: false,
      touchedFrame: this.frame,
    });
  }

  private refreshResidentStitching(): void {
    for (const id of this.desired) {
      const record = this.records.get(id);
      if (!record?.mesh || record.state !== 'resident') continue;
      if (this.queuedCount >= this.options.maxQueued) break;

      const nextMask = stitchMask(resolveTerrainTileStitchEdges(record.key, this.desired));
      if (nextMask === record.stitchMask) continue;

      // Keep the current geometry visible until the replacement is uploaded.
      record.token = this.nextToken++;
      record.admittedToken = undefined;
      record.state = 'queued';
    }
  }

  private cancelObsoleteQueue(): void {
    for (const [id, record] of this.records) {
      if (record.touchedFrame === this.frame) continue;
      if (record.state === 'queued') {
        if (record.mesh) {
          record.token = this.nextToken++;
          record.admittedToken = undefined;
          record.state = 'cooling';
        } else {
          this.records.delete(id);
        }
      } else if (record.state === 'generating' || record.state === 'ready') {
        if (record.mesh) {
          record.token = this.nextToken++;
          record.admittedToken = undefined;
          record.state = 'cooling';
        } else {
          record.state = 'obsolete';
        }
      } else if (record.state === 'resident') {
        record.state = 'cooling';
      }
    }
  }

  private schedule(): void {
    if (this.disposed) return;

    const queued = [...this.records.values()]
      .filter((record) => record.state === 'queued')
      .sort((first, second) => second.priority - first.priority);

    for (const record of queued) {
      const token = record.token;
      const id = tileKeyToString(record.key);
      if (this.records.get(id) !== record || record.state !== 'queued') continue;
      if (record.admittedToken === token) {
        if (this.scheduler.reprioritizeTerrain(this.schedulerOwner, record.key, token, record.priority)) continue;
        record.admittedToken = undefined;
      }
      const options = this.geometryOptionsFor(record.key);
      const request: TerrainWorkerRequest = {
        key: record.key,
        field: this.field,
        token,
        options,
      };
      const admitted = this.scheduler.scheduleTerrain(this.schedulerOwner, request, record.priority, {
        isCurrent: () => !this.disposed && this.records.get(id)?.token === token && this.records.get(id)?.state !== 'obsolete',
        onStart: () => {
          if (record.token !== token) return;
          record.admittedToken = undefined;
          record.stitchMask = stitchMask(options.stitchEdges ?? {});
          record.state = 'generating';
        },
        onGenerated: () => { if (record.token === token && record.state === 'generating') record.state = 'ready'; },
        upload: (completed) => this.uploadCompletedTile(completed),
        onDiscard: () => {
          this.discarded += 1;
          if (record.admittedToken === token) record.admittedToken = undefined;
          if (this.records.get(id)?.token === token && this.records.get(id)?.state === 'obsolete') this.records.delete(id);
        },
        onError: () => {
          if (record.token !== token || this.disposed) return;
          record.admittedToken = undefined;
          record.state = 'queued';
        },
      });
      if (admitted && record.token === token && record.state === 'queued') record.admittedToken = token;
    }
    this.scheduler.pump();
  }

  private geometryOptionsFor(key: TerrainTileKey): TerrainTileGeometryOptions {
    return {
      radius: this.renderRadius,
      segments: this.options.tileSegments,
      tileLocal: true,
      // The actual asynchronously published frontier can temporarily differ
      // from the selected 2:1 tree. Render-only skirts seal its chord gaps;
      // the authoritative radial field and collision remain unchanged.
      renderSkirts: true,
      includeWater: this.field.archetype === 'ocean' || this.field.archetype === 'temperate',
      stitchEdges: resolveTerrainTileStitchEdges(key, this.desired),
    };
  }

  private uploadReadyTiles(): void {
    this.scheduler.flushUploads();
  }

  private uploadCompletedTile(completed: TerrainWorkerResponse): boolean {
      const id = tileKeyToString(completed.key);
      const record = this.records.get(id);

      if (!record || record.token !== completed.token || record.state === 'obsolete') {
        this.discarded += 1;
        if (record?.state === 'obsolete') this.records.delete(id);
        return true;
      }

      if (!record.mesh && this.group.children.length >= this.options.maxResident &&
        !this.evictOneColdTile()) {
        // An opaque ancestor is preferable to exceeding the hard residency
        // budget or removing coverage while sibling tiles are crossfading.
        return false;
      }

      const geometry = terrainGeometryFromBuffers(completed.buffers);
      if (record.mesh) {
        record.mesh.geometry.dispose();
        record.mesh.geometry = geometry;
        record.mesh.position.fromArray(completed.buffers.origin);
        record.presentation?.origin.value.fromArray(completed.buffers.origin);
        this.refreshTileLocalCoverage(record);
        record.mesh.userData.stitchEdges = resolveTerrainTileStitchEdges(record.key, this.desired);
      } else {
        const origin = uniform(new Vector3().fromArray(completed.buffers.origin));
        const lower = uniform(0);
        const upper = uniform(0);
        const localCoverage = createSurfacePatchCoverageSetMask(MAX_OPAQUE_SURFACE_COVERAGES);
        const bodyPositionRenderUnits = positionLocal.add(origin);
        const noise = screenSpaceLodNoise(this.field.seed);
        const maskNode = lodIntervalMask(noise,
          lower.min(this.presentationAlphaNode), upper.min(this.presentationAlphaNode))
          .and(localCoverage.node);
        const supplied = this.materialFactory?.({
          key: record.key, origin: origin.value, bodyPositionRenderUnits, maskNode,
        });
        const material = supplied && supplied !== this.material
          ? supplied : clonePlanetLandMaterial(supplied ?? this.material);
        // A caller's weather/contact mask remains part of this material. The
        // factory may already have installed our exact ownership node.
        if (material.maskNode !== maskNode) {
          material.maskNode = material.maskNode
            ? (material.maskNode as Node<'bool'>).and(maskNode) : maskNode;
        }
        material.transparent = false;
        material.opacity = 1;
        material.depthWrite = true;
        material.depthTest = true;
        material.polygonOffset = false;
        useNodeAwareMaterialCacheKey(material);
        material.userData.opaqueTerrainLod = true;
        const mesh = new Mesh(geometry, material);
        mesh.name = `tile-${id}`;
        mesh.position.fromArray(completed.buffers.origin);
        mesh.userData.terrainKey = record.key;
        mesh.userData.stitchEdges = resolveTerrainTileStitchEdges(record.key, this.desired);
        mesh.userData.fadeProgress = record.key.level === 0 ? 1 : 0;
        mesh.userData.bodyFixedSeed = this.field.seed;
        mesh.userData.opaqueTerrainLod = true;
        mesh.frustumCulled = this.renderCulling;
        record.mesh = mesh;
        record.presentation = { origin, lower, upper, localCoverage };
        record.fadeProgress = record.key.level === 0 ? 1 : 0;
        this.refreshTileLocalCoverage(record);
        this.transitionCount += 1;
        this.group.add(mesh);
      }

      record.state = 'resident';
      record.touchedFrame = this.frame;
      return true;
  }

  private updateVisibility(deltaSeconds: number): void {
    this.retainedParents = 0;
    const globalAlpha = this.managedPresentation ? this.presentationAlphaNode.value :
      this.group.visible ? 1 : 0;
    const canAdvance = globalAlpha > 0 && this.group.visible && deltaSeconds > 0;
    this.updateRenderCulling();
    for (const record of this.records.values()) {
      if (!record.mesh) continue;
      record.mesh.visible = false;
      record.fadeProgress = record.key.level === 0 ? 1 : 0;
      record.coverageLower = 0;
      record.coverageUpper = 0;
      record.mesh.userData.fadeProgress = record.fadeProgress;
      record.mesh.userData.lodCoverageLower = 0;
      record.mesh.userData.lodCoverageUpper = 0;
      if (record.presentation) {
        record.presentation.lower.value = 0;
        record.presentation.upper.value = 0;
      }
    }

    const visit = (record: TerrainRecord | undefined, incoming: number): void => {
      if (!record?.mesh || !record.presentation || record.state === 'obsolete') return;
      const children = childTileKeys(record.key).map((key) => this.records.get(tileKeyToString(key)));
      const completeChildren = children.every((child) => Boolean(child?.mesh && child.state !== 'obsolete'));
      const wantsChildren = this.refinedDesired.has(tileKeyToString(record.key));
      if (!completeChildren) {
        // No fragment is relinquished to an incomplete quartet.
        record.splitProgress = 0;
      } else if (canAdvance && (!wantsChildren || incoming >= 1 && !record.viewCulled && !record.locallyCovered)) {
        record.splitProgress = advanceLodProgress(record.splitProgress, wantsChildren ? 1 : 0,
          deltaSeconds, this.options.fadeDurationSeconds);
      } else if (globalAlpha === 0 && !wantsChildren) {
        // An entirely unseen retiring branch can be made evictable without
        // consuming or advancing an incoming visible fade.
        record.splitProgress = 0;
      }

      const outgoing = completeChildren ? Math.min(incoming, record.splitProgress) : 0;
      record.presentation.lower.value = outgoing;
      record.presentation.upper.value = incoming;
      record.fadeProgress = incoming;
      record.coverageLower = Math.min(outgoing, globalAlpha);
      record.coverageUpper = Math.min(incoming, globalAlpha);
      record.mesh.visible = !record.locallyCovered && !record.viewCulled && record.coverageUpper > record.coverageLower;
      record.mesh.userData.fadeProgress = incoming;
      record.mesh.userData.childCoverageProgress = record.splitProgress;
      record.mesh.userData.lodCoverageLower = record.coverageLower;
      record.mesh.userData.lodCoverageUpper = record.coverageUpper;
      if (completeChildren && record.splitProgress > 0 && record.splitProgress < 1 && incoming > 0) {
        this.retainedParents += 1;
      }
      if (completeChildren) for (const child of children) visit(child, outgoing);
    };
    for (const face of CUBE_FACES) visit(this.records.get(tileKeyToString(makeTileKey(face))), 1);
  }

  private updateRenderCulling(): void {
    const innerRadius = this.renderCulling && this.hasRenderView
      ? conservativeTerrainInnerRadius(this.field, this.renderRadius, this.options.tileSegments,
        this.presentationAlphaNode.value < 1) : 0;
    for (const record of this.records.values()) {
      if (!record.mesh) continue;
      const bounds = record.mesh.geometry.boundingSphere;
      record.occlusionCulled = false;
      record.frustumCulled = false;
      if (this.renderCulling && this.hasRenderView && bounds) {
        const center = {
          x: bounds.center.x + record.mesh.position.x,
          y: bounds.center.y + record.mesh.position.y,
          z: bounds.center.z + record.mesh.position.z,
        };
        const sphere = { center, radius: bounds.radius };
        record.occlusionCulled = terrainSphereOccludedByBody(sphere, this.renderCamera, innerRadius);
        record.frustumCulled = !record.occlusionCulled && terrainSphereOutsideViewCone(sphere,
          this.renderCamera, this.renderLookDirection, this.renderFieldOfView, this.renderAspect);
      }
      record.viewCulled = record.occlusionCulled || record.frustumCulled;
      record.mesh.userData.terrainViewCulled = record.viewCulled;
      record.mesh.userData.terrainOcclusionCulled = record.occlusionCulled;
      record.mesh.userData.terrainFrustumCulled = record.frustumCulled;
      record.mesh.userData.terrainOpaqueInnerRadius = innerRadius;
    }
  }

  private refreshTileLocalCoverage(record: TerrainRecord): void {
    if (!record.mesh || !record.presentation) return;
    const metersPerRenderUnit = this.field.radius / this.renderRadius;
    const origin = record.presentation.origin.value;
    record.presentation.localCoverage.set(this.localCoverage, {
      originBodyFixedMeters: {
        x: origin.x * metersPerRenderUnit,
        y: origin.y * metersPerRenderUnit,
        z: origin.z * metersPerRenderUnit,
      },
      metersPerLocalUnit: metersPerRenderUnit,
    });
    const bounds = tileBounds(record.key);
    const corners = [
      [bounds.minU, bounds.minV], [bounds.maxU, bounds.minV],
      [bounds.minU, bounds.maxV], [bounds.maxU, bounds.maxV],
      [(bounds.minU + bounds.maxU) / 2, (bounds.minV + bounds.maxV) / 2],
    ] as const;
    // A single convex, front-hemisphere gnomonic footprint containing every
    // corner contains the whole cube-face tile. Failure to prove containment
    // merely keeps a harmless masked draw; it never removes valid coverage.
    record.locallyCovered = this.localCoverage.some((coverage) => corners.every(([u, v]) =>
      surfacePatchCoverageContains(coverage,
        faceUvToDirection(record.key.face, u, v).multiplyScalar(this.field.radius), { cutout: true })));
    record.mesh.userData.fullyCoveredByLocalSurface = record.locallyCovered;
  }

  private setLocalCoverage(coverages: readonly SurfacePatchCoverage[]): void {
    const bounded = coverages.slice(0, MAX_OPAQUE_SURFACE_COVERAGES);
    const signature = bounded.map((coverage) => [
      coverage.centerDirection.x, coverage.centerDirection.y, coverage.centerDirection.z,
      coverage.tangentBodyFixed.x, coverage.tangentBodyFixed.y, coverage.tangentBodyFixed.z,
      coverage.bitangentBodyFixed.x, coverage.bitangentBodyFixed.y, coverage.bitangentBodyFixed.z,
      coverage.bodyRadiusMeters, coverage.halfWidthMeters, coverage.cellMeters,
      coverage.overlapMeters, coverage.cutoutHalfWidthMeters,
    ].join(':')).join('|');
    if (signature === this.localCoverageSignature) return;
    this.localCoverageSignature = signature;
    this.localCoverage = bounded;
    for (const record of this.records.values()) this.refreshTileLocalCoverage(record);
  }

  get sixRootCoverageReady(): boolean {
    return !this.disposed && CUBE_FACES.every((face) => {
      const record = this.records.get(tileKeyToString(makeTileKey(face)));
      return Boolean(record?.mesh && record.state !== 'obsolete' &&
        record.mesh.material.depthWrite && !record.mesh.material.transparent);
    });
  }

  get presentationState(): TerrainPresentationState {
    const sixRootCoverageReady = this.sixRootCoverageReady;
    const alpha = this.presentationAlphaNode.value;
    return { alpha, targetAlpha: this.presentationTarget, sixRootCoverageReady,
      ownsWholeGlobe: sixRootCoverageReady && alpha >= 1 };
  }

  /**
   * Advance the reversible globe handoff only after real six-face coverage is
   * safe. GameApp uses the same alpha for its outgoing proxy/ocean masks.
   * Local cutouts are exact published opaque footprints, never desired jobs.
   */
  present(targetAlpha: number, deltaSeconds: number,
    opaqueLocalCoverage: readonly SurfacePatchCoverage[] = []): TerrainPresentationState {
    if (this.disposed) return this.presentationState;
    this.managedPresentation = true;
    this.presentationTarget = Number.isFinite(targetAlpha) ? Math.max(0, Math.min(1, targetAlpha)) : 0;
    this.setLocalCoverage(opaqueLocalCoverage);
    this.presentationAlphaNode.value = this.sixRootCoverageReady
      ? advanceLodProgress(this.presentationAlphaNode.value, this.presentationTarget,
        deltaSeconds, this.options.fadeDurationSeconds * 1.5)
      : 0;
    this.group.visible = this.presentationAlphaNode.value > 0 && this.sixRootCoverageReady;
    this.updateVisibility(deltaSeconds);
    return this.presentationState;
  }

  /** Visible owners plus, optionally, one genuinely complete next quartet. */
  getRenderableTiles(includeImminent = false): TerrainTileMesh[] {
    const permitted = this.group.visible || includeImminent && this.presentationTarget > 0 && this.sixRootCoverageReady;
    if (!permitted) return [];
    const result: TerrainTileMesh[] = [];
    for (const record of this.records.values()) {
      if (!record.mesh || record.locallyCovered || record.viewCulled || record.state === 'obsolete') continue;
      if (record.mesh.visible) {
        result.push(record.mesh);
        continue;
      }
      if (!includeImminent || !this.required.has(tileKeyToString(record.key))) continue;
      const parentKey = parentTileKey(record.key);
      const parent = parentKey ? this.records.get(tileKeyToString(parentKey)) : undefined;
      if (!parentKey || parent?.mesh && parent.fadeProgress >= 1 &&
        this.refinedDesired.has(tileKeyToString(parentKey)) && childTileKeys(parentKey)
          .every((key) => Boolean(this.records.get(tileKeyToString(key))?.mesh))) result.push(record.mesh);
    }
    return result;
  }

  /** CPU mirror of logical shader ownership; optional visibleOnly includes render-work culling. */
  getCoverageOwnersAt(direction: Readonly<{ x: number; y: number; z: number }>,
    pixel: Readonly<{ x: number; y: number }> = { x: 0, y: 0 },
    options: { readonly visibleOnly?: boolean } = {}): TerrainTileKey[] {
    if (!this.group.visible) return [];
    const normal = new Vector3(direction.x, direction.y, direction.z);
    if (!Number.isFinite(normal.lengthSq()) || normal.lengthSq() <= Number.EPSILON) return [];
    normal.normalize();
    const coordinates = directionToFaceUv(normal);
    const noise = sampleScreenSpaceLodNoise(pixel.x, pixel.y, this.field.seed);
    const bodyPosition = normal.multiplyScalar(this.renderRadius);
    const result: TerrainTileKey[] = [];
    for (const record of this.records.values()) {
      if (!record.mesh || record.locallyCovered || !record.presentation || record.key.face !== coordinates.face ||
        options.visibleOnly && !record.mesh.visible) continue;
      const width = 2 ** record.key.level;
      const x = Math.min(width - 1, Math.max(0, Math.floor((coordinates.u + 1) * .5 * width)));
      const y = Math.min(width - 1, Math.max(0, Math.floor((coordinates.v + 1) * .5 * width)));
      if (record.key.x !== x || record.key.y !== y ||
        !lodIntervalContains(noise, record.coverageLower, record.coverageUpper)) continue;
      const origin = record.presentation.origin.value;
      if (record.presentation.localCoverage.isVisibleAtLocal({
        x: bodyPosition.x - origin.x, y: bodyPosition.y - origin.y, z: bodyPosition.z - origin.z,
      })) result.push(record.key);
    }
    return result;
  }

  private evictColdTiles(): void {
    while (this.group.children.length > this.options.maxResident) {
      if (!this.evictOneColdTile()) break;
    }
  }

  private evictOneColdTile(): boolean {
    const resident = [...this.records.values()]
      .filter((record) => record.mesh)
      .sort((first, second) => second.key.level - first.key.level || first.touchedFrame - second.touchedFrame);

    for (const oldest of resident) {
      if (this.required.has(tileKeyToString(oldest.key))) continue;
      if (oldest.key.level === 0) continue;
      // Always keep an actual ancestor behind resident descendants. The
      // selector budget reserves room for this closed tree, so coarsening and
      // outward reversal can restore coverage without a new worker round trip.
      if (childTileKeys(oldest.key).some((key) => Boolean(this.records.get(tileKeyToString(key))?.mesh))) continue;
      if (oldest.coverageUpper > 0) continue;
      const parent = parentTileKey(oldest.key);
      const ancestor = parent ? this.records.get(tileKeyToString(parent)) : undefined;
      if (!ancestor?.mesh) continue;

      if (!oldest.mesh) continue;
      this.group.remove(oldest.mesh);
      oldest.mesh.geometry.dispose();
      oldest.mesh.material.dispose();
      ancestor.splitProgress = 0;
      this.records.delete(tileKeyToString(oldest.key));
      return true;
    }

    return false;
  }

  hasResidentTileAt(direction: { x: number; y: number; z: number }): boolean {
    for (const record of this.records.values()) {
      if (record.mesh && record.state === 'resident' && tileContainsDirection(record.key, direction)) {
        return true;
      }
    }

    return false;
  }

  /** Loaded physical coverage, including prewarmed opaque ancestors that are not presented yet. */
  isReadyAt(direction: { x: number; y: number; z: number }, minimumDepth = 0): boolean {
    for (const record of this.records.values()) {
      if (!record.mesh || record.state === 'obsolete') continue;
      if (record.key.level < minimumDepth) continue;
      if (tileContainsDirection(record.key, direction)) return true;
    }
    return false;
  }

  surfaceDirection(cameraPosition: { x: number; y: number; z: number }): Vector3 {
    return new Vector3(cameraPosition.x, cameraPosition.y, cameraPosition.z).normalize();
  }

  get stats(): TerrainStreamerStats {
    let resident = 0;
    let queued = 0;
    let generating = 0;
    let maxDepth = 0;
    let triangleCount = 0;
    let visible = 0;
    let fading = 0;
    let covered = 0;
    let viewCulled = 0;
    let occlusionCulled = 0;
    let frustumCulled = 0;

    for (const record of this.records.values()) {
      if (record.state === 'queued') queued += 1;
      if (record.state === 'generating') generating += 1;

      if (record.mesh) {
        resident += 1;
        if (record.viewCulled) viewCulled += 1;
        if (record.occlusionCulled) occlusionCulled += 1;
        if (record.frustumCulled) frustumCulled += 1;
        maxDepth = Math.max(maxDepth, record.key.level);
        if (record.mesh.visible) {
          visible += 1;
          const geometry = record.mesh.geometry;
          triangleCount += (geometry.index?.count ?? geometry.getAttribute('position').count) / 3;
          if (record.fadeProgress < 1) fading += 1;
        }
      }
    }

    for (const id of this.desired) {
      let key = this.desiredKeys.get(id);
      if (!key) continue;
      while (key) {
        const candidate = this.records.get(tileKeyToString(key));
        if (candidate?.mesh && candidate.state !== 'obsolete') {
          covered += 1;
          break;
        }
        const parent = parentTileKey(key);
        if (!parent) break;
        key = parent;
      }
    }

    const readiness = this.selectedCount > 0 ? Math.min(1, covered / this.selectedCount) : 0;
    const directions = this.viewDirections;
    const coverageDirections = directions
      ? [
        directions.radial,
        directions.predicted,
        directions.forward,
        directions.horizon,
        directions.leftHorizon,
        directions.rightHorizon,
      ]
      : [];
    const coverage = coverageDirections.map((direction) => this.isReadyAt(direction));
    const coveredSamples = coverage.filter(Boolean).length;
    const radialCoverage = coverage[0] === true;
    const predictedCoverage = coverage[1] ? 1 : 0;
    const forwardCoverage = coverage[2] ? 1 : 0;
    const horizonCoverage = coverage.length >= 6
      ? Number(coverage[3]) / 3 + Number(coverage[4]) / 3 + Number(coverage[5]) / 3
      : 0;
    const coverageReady = radialCoverage && forwardCoverage === 1 && horizonCoverage >= 2 / 3;

    return {
      selected: this.selectedCount,
      resident,
      queued,
      generating,
      discarded: this.discarded,
      maxDepth,
      triangleCount,
      visible,
      fading,
      ready: resident > 0 && readiness >= 0.5,
      readiness,
      prewarming: this.prewarming,
      predictedLeadMeters: this.predictedLeadMeters,
      pendingUploads: this.scheduler.getOwnerStats(this.schedulerOwner).pendingUploads,
      parentRetained: this.retainedParents,
      transitions: this.transitionCount,
      altitudeMeters: this.cameraAltitudeMeters,
      coverageSamples: coverage.length,
      coveredSamples,
      horizonCoverage,
      forwardCoverage,
      predictedCoverage,
      coverageReady,
      horizonTiles: this.selectedHorizonTiles,
      sixRootCoverageReady: this.sixRootCoverageReady,
      presentationAlpha: this.presentationAlphaNode.value,
      ownsWholeGlobe: this.presentationState.ownsWholeGlobe,
      viewCulled,
      occlusionCulled,
      frustumCulled,
    };
  }

  private get queuedCount(): number {
    let total = 0;
    for (const record of this.records.values()) {
      if (record.state === 'queued') total += 1;
    }
    return total;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.presentationAlphaNode.value = 0;
    this.presentationTarget = 0;
    this.group.visible = false;

    this.scheduler.cancelOwner(this.schedulerOwner);
    if (this.ownsScheduler) this.scheduler.dispose();

    for (const record of this.records.values()) {
      if (record.mesh) {
        this.group.remove(record.mesh);
        record.mesh.geometry.dispose();
        record.mesh.material.dispose();
      }
    }

    this.records.clear();
    this.required.clear();
    this.refinedDesired.clear();
    if (this.ownsMaterial) this.material.dispose();
  }
}
