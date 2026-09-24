import type { Vec3 } from './Vec3';
import { cubeToSphere } from './CubeSphere';
import { CUBE_FACES, childKeys, rootKey, tileId, tileUvBounds, type TileKey } from './TileKey';
import type { TileMeshData } from './TileMeshBuilder';

export interface TileRequest {
  readonly key: TileKey;
  /** Higher builds first. */
  readonly priority: number;
}

export interface PlanetLodOptions {
  readonly radiusMeters: number;
  /** Conservative bounds for a tile whose data does not exist yet. */
  readonly minSurfaceHeightMeters: number;
  readonly maxSurfaceHeightMeters: number;
  /** Surface radius nothing can be seen through; used for horizon culling. */
  readonly occluderRadiusMeters: number;
  readonly resolution: number;
  readonly maxLevel: number;
  /** Tiles with no use for this many selections may be evicted. */
  readonly retainFrames?: number;
  readonly maxCachedTiles?: number;
}

export interface LodView {
  /** Body-fixed camera position in meters. */
  readonly cameraPosition: Vec3;
  readonly viewportHeightPixels: number;
  readonly fovYRadians: number;
  readonly maxScreenErrorPixels: number;
  readonly horizonCulling: boolean;
  /** Optional frustum test on a body-fixed bounding sphere. */
  readonly isSphereVisible?: (center: Vec3, radius: number) => boolean;
}

export interface LodNode {
  readonly key: TileKey;
  readonly id: string;
  readonly parent: LodNode | undefined;
  children: [LodNode, LodNode, LodNode, LodNode] | undefined;
  /** Body-fixed bounding sphere; tightened once data arrives. */
  boundCenter: Vec3;
  boundRadius: number;
  /** Sample directions used for horizon culling (corners, edge midpoints, center). */
  readonly probeDirections: readonly Vec3[];
  minHeight: number;
  maxHeight: number;
  data: TileMeshData | undefined;
  lastUsedFrame: number;
  /** Diagnostics from the most recent selection. */
  screenErrorPixels: number;
}

export type CullReason = 'frustum' | 'horizon';

export interface LodSelection {
  readonly frame: number;
  readonly render: readonly LodNode[];
  readonly requests: readonly TileRequest[];
  readonly culled: Readonly<Record<CullReason, number>>;
  /** Nodes drawn at a finer level than wanted because their own data was missing. */
  readonly visited: number;
  readonly selectMilliseconds: number;
}

const PROBE_GRID = [0, 0.5, 1];

/**
 * Cube-sphere quadtree with screen-space-error refinement.
 *
 * Invariants:
 *  - A node is only replaced by its children once all four visible children
 *    have data, so refinement never opens a hole.
 *  - A selected node must have mesh data; missing data is an invariant failure.
 */
export class PlanetLod {
  readonly roots: readonly LodNode[];
  private readonly nodes = new Map<string, LodNode>();
  private frame = 0;
  private readonly retainFrames: number;
  private readonly maxCachedTiles: number;
  private readyCount = 0;

  constructor(readonly options: PlanetLodOptions) {
    this.retainFrames = options.retainFrames ?? 90;
    this.maxCachedTiles = options.maxCachedTiles ?? 2_500;
    this.roots = CUBE_FACES.map((face) => this.createNode(rootKey(face), undefined));
  }

  get cachedTileCount(): number { return this.readyCount; }
  get nodeCount(): number { return this.nodes.size; }

  getNode(id: string): LodNode | undefined { return this.nodes.get(id); }

  /** Nominal grid spacing at a level, meters. */
  spacingMeters(level: number): number {
    return this.options.radiusMeters * (Math.PI / 2) / 2 ** level / (this.options.resolution - 1);
  }

  /** Geometric error used for refinement. Measured when data exists, else a spacing estimate. */
  geometricErrorMeters(node: LodNode): number {
    const spacing = this.spacingMeters(node.key.level);
    // Floor: detail smaller than one grid cell cannot be measured by the tile itself.
    const floor = spacing * 0.01;
    if (!node.data) throw new Error(`PlanetLod.ts geometricErrorMeters: no mesh for id=${node.id}; frame=${this.frame}; level=${node.key.level}`);
    return Math.max(node.data.errorMeters, floor);
  }

  acceptTile(tile: TileMeshData): void {
    const node = this.nodes.get(tile.id);
    if (!node) throw new Error(`PlanetLod.ts acceptTile: unknown tile id=${tile.id}; key=${JSON.stringify(tile.key)}; frame=${this.frame}; nodes=${this.nodes.size}`);
    if (!node.data) this.readyCount++;
    node.data = tile;
    node.minHeight = tile.minHeightMeters;
    node.maxHeight = tile.maxHeightMeters;
    this.updateBounds(node);
    // Children inherit a tighter conservative range than the global one.
    if (node.children) {
      for (const child of node.children) {
        if (child.data) continue;
        child.minHeight = Math.max(this.options.minSurfaceHeightMeters, tile.minHeightMeters - tile.errorMeters);
        child.maxHeight = Math.min(this.options.maxSurfaceHeightMeters, tile.maxHeightMeters + tile.errorMeters);
        this.updateBounds(child);
      }
    }
  }

  select(view: LodView): LodSelection {
    const started = performance.now();
    this.frame++;
    const render: LodNode[] = [];
    const requests = new Map<string, TileRequest>();
    const culled: Record<CullReason, number> = { frustum: 0, horizon: 0 };
    let visited = 0;
    const pixelsPerMeterAtUnitDistance = view.viewportHeightPixels / (2 * Math.tan(view.fovYRadians / 2));

    const request = (node: LodNode, priority: number) => {
      if (!node.data && !requests.has(node.id)) requests.set(node.id, { key: node.key, priority });
    };

    const cullReason = (node: LodNode): CullReason | undefined => {
      if (view.isSphereVisible && !view.isSphereVisible(node.boundCenter, node.boundRadius)) return 'frustum';
      if (view.horizonCulling && this.belowHorizon(node, view.cameraPosition)) return 'horizon';
      return undefined;
    };

    const screenError = (node: LodNode) => {
      const distance = Math.max(
        1e-3,
        distance3(view.cameraPosition, node.boundCenter) - node.boundRadius,
      );
      return this.geometricErrorMeters(node) * pixelsPerMeterAtUnitDistance / distance;
    };

    const visit = (node: LodNode) => {
      visited++;
      node.lastUsedFrame = this.frame;
      const reason = cullReason(node);
      if (reason) {
        culled[reason]++;
        return;
      }
      if (!node.data) throw new Error(`PlanetLod.ts visit: visible node has no mesh; id=${node.id}; frame=${this.frame}; parent=${node.parent?.id ?? 'root'}`);
      const error = screenError(node);
      node.screenErrorPixels = error;
      const wantsSplit = error > view.maxScreenErrorPixels && node.key.level < this.options.maxLevel;
      if (!wantsSplit) {
        if (!node.data) throw new Error(`PlanetLod.ts select: selected tile has no mesh; id=${node.id}; frame=${this.frame}; level=${node.key.level}; errorPixels=${error}; threshold=${view.maxScreenErrorPixels}`);
        render.push(node);
        return;
      }
      const children = this.ensureChildren(node);
      let ready = true;
      for (const child of children) {
        child.lastUsedFrame = this.frame;
        if (child.data) continue;
        // A child we cannot see does not need to exist before we split.
        if (cullReason(child)) continue;
        ready = false;
        request(child, error);
      }
      if (ready) {
        for (const child of children) visit(child);
      } else {
        // Keeping a ready parent visible while its children build is the
        // defined split transition, not recovery from an invalid state.
        if (!node.data) throw new Error(`PlanetLod.ts select: split parent has no mesh; id=${node.id}; frame=${this.frame}; readyChildren=${children.filter((child) => !!child.data).length}/4; errorPixels=${error}`);
        render.push(node);
      }
    };

    for (const root of this.roots) {
      if (!root.data) request(root, Number.POSITIVE_INFINITY);
    }
    if (this.roots.every((root) => root.data)) {
      for (const root of this.roots) visit(root);
    }

    this.evict();
    return {
      frame: this.frame,
      render,
      requests: [...requests.values()],
      culled,
      visited,
      selectMilliseconds: performance.now() - started,
    };
  }

  private ensureChildren(node: LodNode): [LodNode, LodNode, LodNode, LodNode] {
    if (!node.children) {
      const keys = childKeys(node.key);
      node.children = [
        this.createNode(keys[0], node),
        this.createNode(keys[1], node),
        this.createNode(keys[2], node),
        this.createNode(keys[3], node),
      ];
    }
    return node.children;
  }

  private createNode(key: TileKey, parent: LodNode | undefined): LodNode {
    const { u0, v0, u1, v1 } = tileUvBounds(key);
    const probeDirections: Vec3[] = [];
    for (const fv of PROBE_GRID) {
      for (const fu of PROBE_GRID) {
        probeDirections.push(cubeToSphere(key.face, u0 + (u1 - u0) * fu, v0 + (v1 - v0) * fv));
      }
    }
    const inheritedMin = parent?.data
      ? Math.max(this.options.minSurfaceHeightMeters, parent.data.minHeightMeters - parent.data.errorMeters)
      : parent?.minHeight ?? this.options.minSurfaceHeightMeters;
    const inheritedMax = parent?.data
      ? Math.min(this.options.maxSurfaceHeightMeters, parent.data.maxHeightMeters + parent.data.errorMeters)
      : parent?.maxHeight ?? this.options.maxSurfaceHeightMeters;
    const node: LodNode = {
      key,
      id: tileId(key),
      parent,
      children: undefined,
      boundCenter: { x: 0, y: 0, z: 0 },
      boundRadius: 0,
      probeDirections,
      minHeight: inheritedMin,
      maxHeight: inheritedMax,
      data: undefined,
      lastUsedFrame: this.frame,
      screenErrorPixels: 0,
    };
    this.updateBounds(node);
    this.nodes.set(node.id, node);
    return node;
  }

  /**
   * Sphere around the tile's curved shell between min and max height. The
   * center sits on the tile's center direction; the radius covers the probe
   * grid at both radii plus the chord sag between probes.
   */
  private updateBounds(node: LodNode): void {
    const radius = this.options.radiusMeters;
    const inner = radius + node.minHeight;
    const outer = radius + node.maxHeight;
    const center = node.probeDirections[4];
    const mid = (inner + outer) / 2;
    node.boundCenter = { x: center.x * mid, y: center.y * mid, z: center.z * mid };
    let worst = 0;
    let maxProbeAngle = 0;
    for (const direction of node.probeDirections) {
      for (const r of [inner, outer]) {
        worst = Math.max(worst, distance3(node.boundCenter, {
          x: direction.x * r, y: direction.y * r, z: direction.z * r,
        }));
      }
      maxProbeAngle = Math.max(maxProbeAngle, Math.acos(clamp(dot3(direction, center), -1, 1)));
    }
    // Between probes the shell bulges outward by at most r(1 - cos(half probe spacing)).
    const sag = outer * (1 - Math.cos(maxProbeAngle / 2));
    node.boundRadius = worst + sag;
  }

  /**
   * Conservative horizon test. Over an occluder of radius Ro, a camera at
   * radius rc can see a point at radius rp only within
   * √(rc² − Ro²) + √(rp² − Ro²). No point of the tile is higher than its top
   * shell or nearer than its bounding sphere, so beyond that range the whole
   * tile is hidden. Sampling points on the tile instead is not conservative:
   * a large tile's samples can all be past the horizon while the part under
   * the camera is not.
   */
  private belowHorizon(node: LodNode, camera: Vec3): boolean {
    const occluderSq = this.options.occluderRadiusMeters ** 2;
    const cameraHorizonSq = dot3(camera, camera) - occluderSq;
    if (cameraHorizonSq <= 0) return false;
    const top = this.options.radiusMeters + node.maxHeight;
    const reach = Math.sqrt(cameraHorizonSq) + Math.sqrt(Math.max(0, top * top - occluderSq));
    return distance3(camera, node.boundCenter) - node.boundRadius > reach;
  }

  private evict(): void {
    if (this.readyCount <= this.maxCachedTiles) return;
    const candidates: LodNode[] = [];
    for (const node of this.nodes.values()) {
      if (node.data && !node.children && node.key.level > 1 && this.frame - node.lastUsedFrame > this.retainFrames) {
        candidates.push(node);
      }
    }
    candidates.sort((left, right) => left.lastUsedFrame - right.lastUsedFrame);
    for (const node of candidates) {
      if (this.readyCount <= this.maxCachedTiles * 0.85) break;
      node.data = undefined;
      this.readyCount--;
    }
    this.pruneUnusedBranches();
  }

  /** Drop subtrees with no data anywhere below and no recent use. */
  private pruneUnusedBranches(): void {
    const prune = (node: LodNode): boolean => {
      if (!node.children) return !node.data && this.frame - node.lastUsedFrame > this.retainFrames;
      const removable = node.children.map(prune).every(Boolean);
      if (removable) {
        for (const child of node.children) this.nodes.delete(child.id);
        node.children = undefined;
      }
      return removable && !node.data && this.frame - node.lastUsedFrame > this.retainFrames;
    };
    for (const root of this.roots) prune(root);
  }
}

function dot3(left: Vec3, right: Vec3): number {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

function distance3(left: Vec3, right: Vec3): number {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
