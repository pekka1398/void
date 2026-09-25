import type { Vec3 } from './Vec3';
import { cubeToSphere } from './CubeSphere';
import { FACE_FRAMES } from './CubeSphere';
import { CUBE_FACES, childKeys, rootKey, tileId, tileUvBounds, type TileKey } from './TileKey';
import { FACE_EDGES } from './FaceAdjacency';
import { selectedNeighbor } from './TileNeighbors';
import { tileBufferBytes, type TileMeshData } from './TileMeshBuilder';

/** Priority offset that queues culled children of split tiles after every visible request. */
const CULLED_PREFETCH_PENALTY = 1e15;

export interface TileRequest {
  readonly key: TileKey;
  /** Higher builds first. */
  readonly priority: number;
}

export interface PlanetLodOptions {
  readonly radiusMeters: number;
  /** Declared terrain range for validation and a global horizon bound. */
  readonly minSurfaceHeightMeters: number;
  readonly maxSurfaceHeightMeters: number;
  /** Surface radius nothing can be seen through; used for horizon culling. */
  readonly occluderRadiusMeters: number;
  /** Fixed outward band ignored by the LOD distance test; never sampled from terrain. */
  readonly lodSurfaceBandMeters: number;
  readonly resolution: number;
  readonly maxLevel: number;
  /** Split distance at each level, divided by the reference radius. */
  readonly splitDistanceRatios: readonly number[];
  /** Tiles with no use for this many selections may be evicted. */
  readonly retainFrames?: number;
  readonly maxCachedTiles?: number;
}

/** HolmanDev Planet.cs distance table (Size = 1,000,000), normalized by Size. */
export const HOLMAN_SPLIT_DISTANCE_RATIOS: readonly number[] = [
  Infinity, Infinity, Infinity, 0.45, 0.2, 0.1, 0.05, 0.03,
  0.016, 0.008, 0.004, 0.0023, 0.0014, 0.00075, 0.0005, 0.0003,
];

export interface LodView {
  /**
   * Body-fixed observation points in meters, independent of the viewing
   * camera. A tile splits for its nearest observer and is horizon-culled only
   * when it is below every observer's horizon.
   */
  readonly observerPositions: readonly Vec3[];
  readonly distanceScale: number;
  readonly horizonCulling: boolean;
}

export interface LodNode {
  readonly key: TileKey;
  readonly id: string;
  readonly parent: LodNode | undefined;
  children: [LodNode, LodNode, LodNode, LodNode] | undefined;
  /** Fixed reference-sphere center used only for LOD distance. */
  readonly lodCenter: Vec3;
  readonly lodAxisU: Vec3;
  readonly lodAxisV: Vec3;
  readonly centerDirection: Vec3;
  /** Conservative angular cap for this UV patch, independent of terrain mesh. */
  readonly angularRadius: number;
  data: TileMeshData | undefined;
  lastUsedFrame: number;
  /** Diagnostics from the most recent selection. */
  splitPriority: number;
}

export type CullReason = 'horizon';

/**
 * One temporary coarsening by neighbor balancing: finer selected tiles under
 * `parent` were replaced by it, because a neighbor at least two levels coarser
 * could not be refined yet (its children were requested instead).
 */
export interface LodCollapse {
  readonly parent: string;
  readonly parentLevel: number;
  /** Selected tiles the parent replaced, and the finest level among them. */
  readonly replaced: number;
  readonly finestReplacedLevel: number;
  /** The coarse neighbor that forced it. */
  readonly coarseNeighbor: string;
  readonly coarseNeighborLevel: number;
}

export interface LodSelection {
  readonly frame: number;
  readonly render: readonly LodNode[];
  readonly requests: readonly TileRequest[];
  readonly culled: Readonly<Record<CullReason, number>>;
  /** Balancing coarsenings applied this frame; empty when the selection was balanced by refinement alone. */
  readonly balanceCollapses: readonly LodCollapse[];
  /** Nodes drawn at a finer level than wanted because their own data was missing. */
  readonly visited: number;
  readonly selectMilliseconds: number;
  readonly traversalMilliseconds: number;
  readonly balanceMilliseconds: number;
  readonly evictionMilliseconds: number;
}

/**
 * Cube-sphere quadtree with per-level distance thresholds.
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
  private readyMeshBytes = 0;
  /** Worker jobs must keep their node alive until the response is accepted. */
  private readonly pinnedBuilds = new Set<string>();

  constructor(readonly options: PlanetLodOptions) {
    if (!Number.isFinite(options.radiusMeters) || options.radiusMeters <= 0 ||
      !Number.isFinite(options.occluderRadiusMeters) || options.occluderRadiusMeters <= 0 ||
      !Number.isFinite(options.maxSurfaceHeightMeters) ||
      !Number.isFinite(options.lodSurfaceBandMeters) || options.lodSurfaceBandMeters < 0 ||
      options.lodSurfaceBandMeters > options.maxSurfaceHeightMeters ||
      options.radiusMeters + options.maxSurfaceHeightMeters < options.occluderRadiusMeters) {
      throw new Error(`PlanetLod.ts: invalid radii or LOD surface band; radius=${options.radiusMeters}; occluder=${options.occluderRadiusMeters}; globalMaxHeight=${options.maxSurfaceHeightMeters}; lodSurfaceBand=${options.lodSurfaceBandMeters}`);
    }
    if (!Number.isInteger(options.maxLevel) || options.maxLevel < 0 || options.splitDistanceRatios.length < options.maxLevel) {
      throw new Error(`PlanetLod.ts: invalid split distance table; maxLevel=${options.maxLevel}; ratios=${options.splitDistanceRatios.length}`);
    }
    for (let level = 0; level < options.maxLevel; level++) {
      const ratio = options.splitDistanceRatios[level];
      if (ratio === undefined || !(ratio > 0)) throw new Error(`PlanetLod.ts: invalid split distance ratio; level=${level}; ratio=${ratio}`);
    }
    this.retainFrames = options.retainFrames ?? 90;
    this.maxCachedTiles = options.maxCachedTiles ?? 2_500;
    this.roots = CUBE_FACES.map((face) => this.createNode(rootKey(face), undefined));
  }

  get cachedTileCount(): number { return this.readyCount; }
  get cachedMeshBytes(): number { return this.readyMeshBytes; }
  get nodeCount(): number { return this.nodes.size; }

  getNode(id: string): LodNode | undefined { return this.nodes.get(id); }

  pinBuild(id: string): void {
    const node = this.nodes.get(id);
    if (!node) throw new Error(`PlanetLod.ts pinBuild: request has no node; id=${id}; frame=${this.frame}; nodes=${this.nodes.size}`);
    if (node.data) throw new Error(`PlanetLod.ts pinBuild: request already has mesh; id=${id}; frame=${this.frame}`);
    if (this.pinnedBuilds.has(id)) throw new Error(`PlanetLod.ts pinBuild: duplicate in-flight job; id=${id}; frame=${this.frame}`);
    this.pinnedBuilds.add(id);
  }

  unpinBuild(id: string): void {
    if (!this.pinnedBuilds.delete(id)) throw new Error(`PlanetLod.ts unpinBuild: job was not pinned; id=${id}; frame=${this.frame}`);
    if (!this.nodes.get(id)?.data) throw new Error(`PlanetLod.ts unpinBuild: accepted mesh is missing; id=${id}; frame=${this.frame}`);
  }

  /** Nominal grid spacing at a level, meters. */
  spacingMeters(level: number): number {
    return this.options.radiusMeters * (Math.PI / 2) / 2 ** level / (this.options.resolution - 1);
  }

  acceptTile(tile: TileMeshData): void {
    const node = this.nodes.get(tile.id);
    if (!node) throw new Error(`PlanetLod.ts acceptTile: unknown tile id=${tile.id}; key=${JSON.stringify(tile.key)}; frame=${this.frame}; nodes=${this.nodes.size}`);
    if (!Number.isFinite(tile.minHeightMeters) || !Number.isFinite(tile.maxHeightMeters) ||
      tile.minHeightMeters < this.options.minSurfaceHeightMeters || tile.maxHeightMeters > this.options.maxSurfaceHeightMeters ||
      tile.minHeightMeters > tile.maxHeightMeters) {
      throw new Error(`PlanetLod.ts acceptTile: tile exceeds declared terrain bounds; id=${tile.id}; tileMin=${tile.minHeightMeters}; tileMax=${tile.maxHeightMeters}; declaredMin=${this.options.minSurfaceHeightMeters}; declaredMax=${this.options.maxSurfaceHeightMeters}`);
    }
    if (!node.data) this.readyCount++;
    else this.readyMeshBytes -= tileBufferBytes(node.data);
    node.data = tile;
    this.readyMeshBytes += tileBufferBytes(tile);
    node.lastUsedFrame = this.frame;
  }

  select(view: LodView): LodSelection {
    const started = performance.now();
    this.frame++;
    const render: LodNode[] = [];
    const requests = new Map<string, TileRequest>();
    const culled: Record<CullReason, number> = { horizon: 0 };
    let visited = 0;
    if (!Number.isFinite(view.distanceScale) || view.distanceScale <= 0) {
      throw new Error(`PlanetLod.ts select: invalid distance scale=${view.distanceScale}; frame=${this.frame}`);
    }
    if (view.observerPositions.length === 0) throw new Error(`PlanetLod.ts select: no observers; frame=${this.frame}`);
    for (const observer of view.observerPositions) {
      if (!Number.isFinite(observer.x) || !Number.isFinite(observer.y) || !Number.isFinite(observer.z)) {
        throw new Error(`PlanetLod.ts select: invalid observer=${JSON.stringify(observer)}; frame=${this.frame}`);
      }
    }

    const request = (node: LodNode, priority: number) => {
      if (!node.data && !requests.has(node.id)) requests.set(node.id, { key: node.key, priority });
    };

    const cullReason = (node: LodNode): CullReason | undefined => {
      if (view.horizonCulling && view.observerPositions.every((observer) => this.belowHorizon(node, observer))) return 'horizon';
      return undefined;
    };

    const distanceToPatch = (node: LodNode) => {
      const halfSide = this.options.radiusMeters / 2 ** node.key.level;
      let nearest = Number.POSITIVE_INFINITY;
      for (const observer of view.observerPositions) {
        const delta = {
          x: observer.x - node.lodCenter.x,
          y: observer.y - node.lodCenter.y,
          z: observer.z - node.lodCenter.z,
        };
        const u = Math.max(0, Math.abs(dot3(delta, node.lodAxisU)) - halfSide);
        const v = Math.max(0, Math.abs(dot3(delta, node.lodAxisV)) - halfSide);
        const radial = Math.max(0, Math.abs(dot3(delta, node.centerDirection)) - this.options.lodSurfaceBandMeters);
        nearest = Math.min(nearest, Math.hypot(u, v, radial));
      }
      return nearest;
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
      const distance = distanceToPatch(node);
      const threshold = node.key.level < this.options.maxLevel
        ? this.options.radiusMeters * this.options.splitDistanceRatios[node.key.level]! * view.distanceScale : 0;
      node.splitPriority = threshold - distance;
      const wantsSplit = distance < threshold && node.key.level < this.options.maxLevel;
      if (!wantsSplit) {
        if (!node.data) throw new Error(`PlanetLod.ts select: selected tile has no mesh; id=${node.id}; frame=${this.frame}; level=${node.key.level}; patchDistance=${distance}; threshold=${threshold}`);
        render.push(node);
        return;
      }
      const children = this.ensureChildren(node);
      let ready = true;
      for (const child of children) {
        child.lastUsedFrame = this.frame;
        if (child.data) continue;
        // A child we cannot see does not need to exist before we split, but it is built
        // anyway (after every visible tile): when it comes over a widening horizon the parent
        // can stay split, instead of redrawing coarse and forcing neighbor balancing to
        // collapse the fine ground next to it.
        if (cullReason(child)) {
          request(child, node.splitPriority - CULLED_PREFETCH_PENALTY);
          continue;
        }
        ready = false;
        request(child, node.splitPriority);
      }
      if (ready) {
        for (const child of children) visit(child);
      } else {
        // Keeping a ready parent visible while its children build is the
        // defined split transition, not recovery from an invalid state.
        if (!node.data) throw new Error(`PlanetLod.ts select: split parent has no mesh; id=${node.id}; frame=${this.frame}; readyChildren=${children.filter((child) => !!child.data).length}/4; patchDistance=${distance}; threshold=${threshold}`);
        render.push(node);
      }
    };

    for (const root of this.roots) {
      if (!root.data) request(root, Number.POSITIVE_INFINITY);
    }
    if (this.roots.every((root) => root.data)) {
      for (const root of this.roots) visit(root);
    }

    const traversalFinished = performance.now();
    const balanceCollapses: LodCollapse[] = [];
    const balanced = this.balanceSelection(render, requests, balanceCollapses);
    const balanceFinished = performance.now();
    const renderedIds = new Set(balanced.map((node) => node.id));
    for (const node of balanced) node.lastUsedFrame = this.frame;
    this.evict(renderedIds);
    const finished = performance.now();
    return {
      frame: this.frame,
      render: balanced,
      requests: [...requests.values()],
      culled,
      balanceCollapses,
      visited,
      selectMilliseconds: finished - started,
      traversalMilliseconds: traversalFinished - started,
      balanceMilliseconds: balanceFinished - traversalFinished,
      evictionMilliseconds: finished - balanceFinished,
    };
  }

  /** Refine coarse neighbors when ready; otherwise request them and temporarily coarsen the fine side. */
  private balanceSelection(render: readonly LodNode[], requests: Map<string, TileRequest>, collapses: LodCollapse[]): LodNode[] {
    const selected = new Map(render.map((node) => [node.id, node]));
    let refining = true;
    for (let pass = 0; pass < 10_000; pass++) {
      const collapse = new Map<string, LodNode>();
      const collapseCause = new Map<string, LodNode>();
      const split = new Map<string, [LodNode, LodNode, LodNode, LodNode]>();
      for (const node of selected.values()) {
        for (const edge of FACE_EDGES) {
          const neighbor = selectedNeighbor(selected, node.key, edge);
          if (neighbor && node.key.level - neighbor.key.level > 1) {
            const children = refining ? this.ensureChildren(neighbor) : neighbor.children;
            if (refining && children?.every((child) => !!child.data)) split.set(neighbor.id, children);
            else {
              if (refining && children) for (const child of children) {
                if (!child.data && !requests.has(child.id)) requests.set(child.id, { key: child.key, priority: node.splitPriority });
              }
              const parent = node.parent;
              if (!parent?.data) throw new Error(`PlanetLod.ts balanceSelection: fine tile has no ready parent; tile=${node.id}; edge=${edge}; neighbor=${neighbor.id}; frame=${this.frame}`);
              collapse.set(parent.id, parent);
              if (!collapseCause.has(parent.id)) collapseCause.set(parent.id, neighbor);
            }
          }
        }
      }
      if (split.size === 0 && refining) {
        // A stable selection needs neither the collapse pass nor another full
        // neighbor scan. At high tile counts this was repeating the dominant work.
        if (collapse.size === 0) return [...selected.values()];
        refining = false;
        continue;
      }
      if (collapse.size === 0 && split.size === 0) return [...selected.values()];
      for (const [id, children] of split) {
        if (!selected.delete(id)) continue;
        for (const child of children) selected.set(child.id, child);
      }
      if (refining) continue;
      for (const parent of [...collapse.values()].sort((a, b) => a.key.level - b.key.level)) {
        let selectedAncestor = parent.parent;
        let alreadyCovered = false;
        while (selectedAncestor) {
          if (selected.has(selectedAncestor.id)) { alreadyCovered = true; break; }
          selectedAncestor = selectedAncestor.parent;
        }
        if (alreadyCovered) continue;
        let replaced = 0;
        let finestReplacedLevel = parent.key.level;
        for (const node of selected.values()) {
          const levelDifference = node.key.level - parent.key.level;
          if (levelDifference >= 0 && node.key.face === parent.key.face &&
            Math.floor(node.key.x / 2 ** levelDifference) === parent.key.x &&
            Math.floor(node.key.y / 2 ** levelDifference) === parent.key.y) {
            selected.delete(node.id);
            replaced++;
            finestReplacedLevel = Math.max(finestReplacedLevel, node.key.level);
          }
        }
        selected.set(parent.id, parent);
        const cause = collapseCause.get(parent.id);
        if (!cause) throw new Error(`PlanetLod.ts balanceSelection: collapse has no recorded cause; parent=${parent.id}; frame=${this.frame}`);
        collapses.push({ parent: parent.id, parentLevel: parent.key.level, replaced, finestReplacedLevel,
          coarseNeighbor: cause.id, coarseNeighborLevel: cause.key.level });
      }
    }
    throw new Error(`PlanetLod.ts balanceSelection: failed to converge; frame=${this.frame}; selected=${selected.size}; maxLevel=${this.options.maxLevel}`);
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
    const centerU = (u0 + u1) / 2;
    const centerV = (v0 + v1) / 2;
    const centerDirection = cubeToSphere(key.face, centerU, centerV);
    const lodAxisU = tangentAxis(FACE_FRAMES[key.face]!.a, centerDirection);
    const node: LodNode = {
      key,
      id: tileId(key),
      parent,
      children: undefined,
      lodCenter: {
        x: centerDirection.x * this.options.radiusMeters,
        y: centerDirection.y * this.options.radiusMeters,
        z: centerDirection.z * this.options.radiusMeters,
      },
      lodAxisU,
      lodAxisV: cross3(centerDirection, lodAxisU),
      centerDirection,
      angularRadius: tileAngularRadius(u0, v0, u1, v1),
      data: undefined,
      lastUsedFrame: this.frame,
      splitPriority: 0,
    };
    this.nodes.set(node.id, node);
    return node;
  }

  /**
   * A tile is hidden only when its full direction cap lies beyond the largest
   * horizon angle allowed by the declared global surface radius. This uses no
   * per-tile mesh heights or mesh-derived bounds.
   */
  private belowHorizon(node: LodNode, observer: Vec3): boolean {
    const observerRadius = Math.hypot(observer.x, observer.y, observer.z);
    const occluder = this.options.occluderRadiusMeters;
    if (!Number.isFinite(observerRadius)) throw new Error(`PlanetLod.ts belowHorizon: invalid observer=${JSON.stringify(observer)}; node=${node.id}`);
    if (observerRadius <= occluder) return false;
    const topRadius = this.options.radiusMeters + this.options.maxSurfaceHeightMeters;
    const horizonAngle = Math.acos(occluder / observerRadius) + Math.acos(occluder / topRadius);
    const centerAngle = Math.acos(clamp(dot3(observer, node.centerDirection) / observerRadius, -1, 1));
    return centerAngle - node.angularRadius > horizonAngle;
  }

  private evict(renderedIds: ReadonlySet<string>): void {
    if (this.readyCount <= this.maxCachedTiles) return;
    const candidates: LodNode[] = [];
    for (const node of this.nodes.values()) {
      if (node.data && !node.children && node.key.level > 1 && !renderedIds.has(node.id) &&
        this.frame - node.lastUsedFrame > this.retainFrames) {
        candidates.push(node);
      }
    }
    candidates.sort((left, right) => left.lastUsedFrame - right.lastUsedFrame);
    for (const node of candidates) {
      if (this.readyCount <= this.maxCachedTiles * 0.85) break;
      if (!node.data) throw new Error(`PlanetLod.ts evict: selected candidate lost mesh; id=${node.id}; frame=${this.frame}`);
      this.readyMeshBytes -= tileBufferBytes(node.data);
      node.data = undefined;
      this.readyCount--;
    }
    this.pruneUnusedBranches();
  }

  /** Drop subtrees with no data anywhere below and no recent use. */
  private pruneUnusedBranches(): void {
    const prune = (node: LodNode): boolean => {
      if (!node.children) return !node.data && !this.pinnedBuilds.has(node.id) && this.frame - node.lastUsedFrame > this.retainFrames;
      const removable = node.children.map(prune).every(Boolean);
      if (removable) {
        for (const child of node.children) this.nodes.delete(child.id);
        node.children = undefined;
      }
      return removable && !node.data && !this.pinnedBuilds.has(node.id) && this.frame - node.lastUsedFrame > this.retainFrames;
    };
    for (const root of this.roots) prune(root);
  }
}

function dot3(left: Vec3, right: Vec3): number {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

function cross3(left: Vec3, right: Vec3): Vec3 {
  return {
    x: left.y * right.z - left.z * right.y,
    y: left.z * right.x - left.x * right.z,
    z: left.x * right.y - left.y * right.x,
  };
}

function tangentAxis(axis: Vec3, radial: Vec3): Vec3 {
  const projection = dot3(axis, radial);
  const tangent = { x: axis.x - radial.x * projection, y: axis.y - radial.y * projection, z: axis.z - radial.z * projection };
  const length = Math.hypot(tangent.x, tangent.y, tangent.z);
  if (!Number.isFinite(length) || length < 1e-12) throw new Error(`PlanetLod.ts tangentAxis: invalid local basis; axis=${JSON.stringify(axis)}; radial=${JSON.stringify(radial)}; length=${length}`);
  return { x: tangent.x / length, y: tangent.y / length, z: tangent.z / length };
}

/** Upper angular radius of a tangent-warped cube-face UV rectangle. */
function tileAngularRadius(u0: number, v0: number, u1: number, v1: number): number {
  const quarterPi = Math.PI / 4;
  const centerU = Math.tan((u0 + u1) * quarterPi / 2);
  const centerV = Math.tan((v0 + v1) * quarterPi / 2);
  const du = Math.max(Math.abs(Math.tan(u0 * quarterPi) - centerU), Math.abs(Math.tan(u1 * quarterPi) - centerU));
  const dv = Math.max(Math.abs(Math.tan(v0 * quarterPi) - centerV), Math.abs(Math.tan(v1 * quarterPi) - centerV));
  // Normalizing cube vectors of length >= 1 cannot enlarge their chord distance.
  return 2 * Math.asin(Math.min(1, Math.hypot(du, dv) / 2));
}

function distance3(left: Vec3, right: Vec3): number {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
