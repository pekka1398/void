import { BufferGeometry, Material, Mesh } from 'three';
import { uniform } from 'three/tsl';
import type { Node } from 'three/webgpu';

import type { PlanetField } from '../../fields/PlanetField';
import { useNodeAwareMaterialCacheKey } from '../../terrain/ContactRenderMask';
import { planetProxyGeometryFromBuffers } from '../../terrain/Geometry';
import { resolvePlanetProxyDetail, type PlanetProxyGeometryBuffers } from '../../terrain/PlanetProxyGeometry';
import {
  advanceLodProgress,
  screenSpaceLodNoise,
  lodIntervalMask,
} from '../../terrain/TerrainLodTransition';
import type {
  PlanetProxyWorkerRequest,
  PlanetProxyWorkerResponse,
  TerrainJobCallbacks,
} from '../../terrain/TerrainJobScheduler';
import { clonePlanetLandMaterial } from './PlanetLandMaterial';

export const INITIAL_PLANET_PROXY_DETAIL = 1;
export const MAX_CACHED_PLANET_PROXY_LEVELS = 4;

type ProxyMaterial = Material & { maskNode?: Node<'bool'> | null };

export interface PlanetProxyLodView {
  readonly apparentDiameterPixels: number;
  readonly selected?: boolean;
  /** Actual observer distance divided by the body's physical radius. */
  readonly distanceRatio?: number;
  readonly onScreen?: boolean;
  readonly deltaSeconds?: number;
}

export interface PlanetProxyLodScheduler {
  schedulePlanetProxy(owner: string, request: PlanetProxyWorkerRequest, priority: number,
    callbacks: TerrainJobCallbacks<PlanetProxyWorkerResponse>): boolean;
  cancelOwner(owner: string): void;
  pump(): void;
}

/** Both masks include the original globe's physical terrain-ownership mask. */
export interface PlanetProxyTransitionState {
  readonly incomingGeometry: BufferGeometry;
  readonly outgoingGeometry: BufferGeometry | null;
  readonly progressUniform: Node<'float'> & { value: number };
  readonly incomingMask: Node<'bool'>;
  readonly outgoingMask: Node<'bool'>;
}

export interface PlanetProxyLodOptions {
  readonly bodyId: string;
  readonly field: PlanetField;
  readonly renderRadius: number;
  readonly mesh: Mesh<BufferGeometry>;
  readonly scheduler: PlanetProxyLodScheduler;
  readonly reducedQuality?: boolean;
  readonly transitionSeconds?: number;
  /** Called after the stable mesh takes its new geometry, before old disposal. */
  readonly onGeometryChanged?: (geometry: BufferGeometry, previousGeometry: BufferGeometry) => void;
  /** Called at transition start/end. The shared uniform advances without new node graphs. */
  readonly onTransitionChanged?: (state: PlanetProxyTransitionState) => void;
}

export interface PlanetProxyLodStats {
  readonly currentDetail: number;
  readonly desiredDetail: number;
  readonly pendingDetail: number | null;
  readonly cachedLevels: number;
  readonly maximumCachedLevels: number;
  readonly generated: number;
  readonly swaps: number;
  readonly transitioning: boolean;
  readonly transitionProgress: number;
  readonly state: 'idle' | 'queued' | 'generating' | 'ready' | 'failed' | 'disposed';
  readonly lastError: string | null;
}

// Eighty triangles are only acceptable while the physical body is unresolved.
// Promote before its silhouette or geographic sampling becomes conspicuous.
const PROMOTE_PIXELS = [0, 12, 48, 160] as const;
const DEMOTE_PIXELS = [0, 8, 32, 112] as const;
let nextProxyOwner = 1;

function levels(reducedQuality: boolean): readonly number[] {
  return [INITIAL_PLANET_PROXY_DETAIL, 2, 3, reducedQuality ? 3.5 : 4];
}

function closestLevelIndex(detail: number, available: readonly number[]): number {
  let closest = 0;
  for (let index = 1; index < available.length; index += 1) {
    if (Math.abs(available[index]! - detail) < Math.abs(available[closest]! - detail)) closest = index;
  }
  return closest;
}

/** Screen-size hysteresis operates on real angular size, never a scaled-up beacon. */
export function selectPlanetProxyDetail(
  view: PlanetProxyLodView,
  previousDetail = INITIAL_PLANET_PROXY_DETAIL,
  reducedQuality = false,
): number {
  const available = levels(reducedQuality);
  const pixels = Number.isFinite(view.apparentDiameterPixels) ? Math.max(0, view.apparentDiameterPixels) : 0;
  const nearby = Number.isFinite(view.distanceRatio) && (view.distanceRatio ?? Infinity) > 0 &&
    (view.distanceRatio ?? Infinity) <= 3.2;
  if (nearby) return available[available.length - 1]!;
  const previous = closestLevelIndex(previousDetail, available);
  let selected = previous;
  while (selected + 1 < available.length && pixels >= PROMOTE_PIXELS[selected + 1]!) selected += 1;
  while (selected > 0 && pixels < DEMOTE_PIXELS[selected]!) selected -= 1;
  if (view.selected) selected = Math.max(pixels >= 24 ? 3 : 2, selected);
  // An offscreen remote planet keeps its inexpensive ready coverage. It can
  // still demote, but cannot consume a new high-detail job merely by existing.
  if (view.onScreen === false && !view.selected) selected = Math.min(previous, selected);
  return available[selected]!;
}

/**
 * Loading/system-entry must never present an unresolved 80-face placeholder
 * for a planet that already fills the view. Offscreen admission only governs
 * later background promotion, not this initial physical silhouette choice.
 */
export function initialPlanetProxyDetail(view: PlanetProxyLodView, reducedQuality = false): number {
  return selectPlanetProxyDetail({ ...view, onScreen: true }, INITIAL_PLANET_PROXY_DETAIL, reducedQuality);
}

/**
 * One real catalog body, one stable material, and one bounded shared-pool job.
 * Old geometry remains valid through generation and complementary opaque
 * coverage preserves the silhouette/terminator during a visible promotion.
 */
export class PlanetProxyLod {
  private readonly options: PlanetProxyLodOptions;
  private readonly owner: string;
  private readonly material: ProxyMaterial;
  private readonly originalMask: Node<'bool'> | null | undefined;
  private readonly hadOwnMask: boolean;
  private readonly progress = uniform(1);
  private readonly incomingMask: Node<'bool'>;
  private readonly outgoingMask: Node<'bool'>;
  private readonly cache = new Map<number, BufferGeometry>();
  private readonly initialGeometry: BufferGeometry;
  private readonly initialDetail: number;
  private currentDetail: number;
  private desiredDetail: number;
  private pending?: { token: number; detail: number };
  private nextToken = 1;
  private outgoing?: Mesh<BufferGeometry, ProxyMaterial>;
  private outgoingDetail?: number;
  private lastView: PlanetProxyLodView = { apparentDiameterPixels: 0 };
  private previousPixels = 0;
  private angularGrowth = 0;
  private elapsedSeconds = 0;
  private retryAfterSeconds = 0;
  private generated = 0;
  private swaps = 0;
  private disposed = false;
  private state: PlanetProxyLodStats['state'] = 'idle';
  private lastError: string | null = null;

  constructor(options: PlanetProxyLodOptions) {
    if (!options.bodyId || !Number.isFinite(options.renderRadius) || options.renderRadius <= 0 ||
      Array.isArray(options.mesh.material)) throw new RangeError('Planet proxy LOD needs one physical body and material.');
    this.options = options;
    this.owner = `planet-proxy-${nextProxyOwner++}:${options.bodyId}`;
    this.material = options.mesh.material as ProxyMaterial;
    this.originalMask = this.material.maskNode;
    this.hadOwnMask = Object.prototype.hasOwnProperty.call(this.material, 'maskNode');
    // Different tessellations intersect the same sight ray at different body
    // coordinates. Hash the actual framebuffer pixel so ownership, unlike
    // geographic albedo, remains exactly complementary at those two depths.
    const noise = screenSpaceLodNoise(options.field.seed);
    const incoming = lodIntervalMask(noise, 0, this.progress);
    const outgoing = lodIntervalMask(noise, this.progress, 1);
    this.incomingMask = this.originalMask ? this.originalMask.and(incoming) : incoming;
    this.outgoingMask = this.originalMask ? this.originalMask.and(outgoing) : outgoing;
    this.material.maskNode = this.incomingMask;
    useNodeAwareMaterialCacheKey(this.material);
    this.material.needsUpdate = true;
    this.initialGeometry = options.mesh.geometry;
    this.initialDetail = resolvePlanetProxyDetail(Number(options.mesh.geometry.userData.proxyDetail ?? INITIAL_PLANET_PROXY_DETAIL));
    this.currentDetail = this.initialDetail;
    this.desiredDetail = this.initialDetail;
    this.cache.set(this.initialDetail, this.initialGeometry);
    options.mesh.userData.proxyLodOwner = this.owner;
    options.mesh.userData.proxyLod = this.stats;
  }

  get transitionState(): PlanetProxyTransitionState {
    return { incomingGeometry: this.options.mesh.geometry,
      outgoingGeometry: this.outgoing?.geometry ?? null, progressUniform: this.progress,
      incomingMask: this.incomingMask, outgoingMask: this.outgoingMask };
  }

  get stats(): PlanetProxyLodStats {
    return { currentDetail: this.currentDetail, desiredDetail: this.desiredDetail,
      pendingDetail: this.pending?.detail ?? null, cachedLevels: this.cache.size,
      maximumCachedLevels: MAX_CACHED_PLANET_PROXY_LEVELS, generated: this.generated, swaps: this.swaps,
      transitioning: this.outgoing !== undefined, transitionProgress: this.progress.value,
      state: this.disposed ? 'disposed' : this.state, lastError: this.lastError };
  }

  update(view: PlanetProxyLodView): PlanetProxyLodStats {
    if (this.disposed) return this.stats;
    const delta = Number.isFinite(view.deltaSeconds) ? Math.max(0, Math.min(0.25, view.deltaSeconds!)) : 1 / 60;
    this.elapsedSeconds += delta;
    const pixels = Number.isFinite(view.apparentDiameterPixels) ? Math.max(0, view.apparentDiameterPixels) : 0;
    const measuredGrowth = this.previousPixels > 0 ? (pixels - this.previousPixels) / Math.max(0.001, delta) : 0;
    const growthBlend = 1 - Math.exp(-delta * 10);
    this.angularGrowth += (Math.max(0, measuredGrowth) - this.angularGrowth) * growthBlend;
    this.previousPixels = pixels;
    this.lastView = view;
    const predictedPixels = Math.min(pixels + this.angularGrowth * 0.75, Math.max(pixels * 2.5, pixels + 64));
    this.desiredDetail = selectPlanetProxyDetail({ ...view, apparentDiameterPixels: predictedPixels },
      this.desiredDetail, this.options.reducedQuality);
    if (this.outgoing) {
      const target = this.desiredDetail === this.outgoingDetail ? 0 : 1;
      this.progress.value = advanceLodProgress(this.progress.value, target, delta,
        this.options.transitionSeconds ?? 0.34);
      if (this.progress.value >= 1) this.finishTransition();
      else if (target === 0 && this.progress.value <= 0) this.reverseTransition();
    }
    if (this.pending && !this.pendingIsUseful(this.pending.detail)) this.cancelPending();
    if (!this.outgoing && this.currentDetail !== this.desiredDetail) {
      const cached = this.cache.get(this.desiredDetail);
      if (cached) {
        this.cancelPending();
        this.commit(cached, this.desiredDetail);
      } else if (!this.pending && this.elapsedSeconds >= this.retryAfterSeconds) {
        this.request(this.desiredDetail);
      }
    }
    this.options.mesh.userData.proxyLod = this.stats;
    return this.stats;
  }

  private pendingIsUseful(detail: number): boolean {
    return detail === this.desiredDetail || (detail > this.currentDetail && detail < this.desiredDetail);
  }

  private cancelPending(): void {
    if (!this.pending) return;
    this.pending = undefined;
    this.options.scheduler.cancelOwner(this.owner);
    this.state = 'idle';
  }

  private request(detail: number): void {
    const token = this.nextToken++;
    const pending = { token, detail };
    this.pending = pending;
    this.state = 'queued';
    const request: PlanetProxyWorkerRequest = { key: this.options.bodyId, token, field: this.options.field,
      options: { renderRadius: this.options.renderRadius, detail,
        includeWater: this.options.field.archetype === 'ocean' || this.options.field.archetype === 'temperate' } };
    const pixels = Number.isFinite(this.lastView.apparentDiameterPixels) ? Math.max(0, this.lastView.apparentDiameterPixels) : 0;
    const ratio = this.lastView.distanceRatio ?? Infinity;
    const priority = 100_000 + Math.min(100_000, pixels * 100) +
      (this.lastView.selected ? 150_000 : 0) + (Number.isFinite(ratio) && ratio > 0 && ratio <= 3.2 ? 200_000 : 0);
    const admitted = this.options.scheduler.schedulePlanetProxy(this.owner, request, priority, {
      isCurrent: () => !this.disposed && this.pending === pending && this.pendingIsUseful(detail),
      onStart: () => { if (this.pending === pending) this.state = 'generating'; },
      onGenerated: () => { if (this.pending === pending) this.state = 'ready'; },
      upload: (result) => {
        if (this.disposed || this.pending !== pending || !this.pendingIsUseful(detail)) return true;
        if (this.outgoing) return false;
        if (!this.validResult(result.buffers, detail)) {
          this.failPending(pending, new Error('Planet proxy result does not match its physical body.'));
          return true;
        }
        const geometry = planetProxyGeometryFromBuffers(result.buffers);
        geometry.userData.planetField = this.options.field;
        this.cache.set(detail, geometry);
        this.generated += 1;
        this.pending = undefined;
        this.lastError = null;
        this.state = 'idle';
        this.commit(geometry, detail);
        return true;
      },
      onDiscard: () => { if (this.pending === pending) { this.pending = undefined; this.state = 'idle'; } },
      onError: (error) => this.failPending(pending, error),
    });
    if (!admitted && this.pending === pending) { this.pending = undefined; this.state = 'idle'; }
    if (admitted) this.options.scheduler.pump();
  }

  private validResult(buffers: PlanetProxyGeometryBuffers, detail: number): boolean {
    return buffers.fieldSeed === this.options.field.seed && buffers.physicalRadiusMeters === this.options.field.radius &&
      buffers.renderRadius === this.options.renderRadius && buffers.detail === detail;
  }

  private failPending(pending: { token: number; detail: number }, error: unknown): void {
    if (this.pending !== pending || this.disposed) return;
    this.pending = undefined;
    this.lastError = String(error instanceof Error ? error.message : error).slice(0, 240);
    this.retryAfterSeconds = this.elapsedSeconds + 2;
    this.state = 'failed';
  }

  private commit(geometry: BufferGeometry, detail: number): void {
    const previous = this.options.mesh.geometry;
    if (previous === geometry) return;
    const visibleSwap = this.lastView.onScreen !== false && this.lastView.apparentDiameterPixels >= 28 &&
      (this.options.transitionSeconds ?? 0.34) > 0;
    this.progress.value = visibleSwap ? 0 : 1;
    if (visibleSwap) {
      const material = clonePlanetLandMaterial(this.material) as ProxyMaterial;
      material.maskNode = this.outgoingMask;
      material.transparent = false;
      material.depthWrite = true;
      useNodeAwareMaterialCacheKey(material);
      const outgoing = new Mesh(previous, material);
      outgoing.name = `${this.options.bodyId} / retiring physical planet LOD`;
      outgoing.frustumCulled = this.options.mesh.frustumCulled;
      outgoing.renderOrder = this.options.mesh.renderOrder;
      outgoing.userData = { bodyId: this.options.bodyId, physicalProxyLodTransition: true };
      this.options.mesh.add(outgoing);
      this.outgoing = outgoing;
      this.outgoingDetail = this.currentDetail;
    }
    this.options.mesh.geometry = geometry;
    this.currentDetail = detail;
    this.swaps += 1;
    this.options.mesh.userData.proxyDetail = detail;
    this.options.onGeometryChanged?.(geometry, previous);
    this.options.onTransitionChanged?.(this.transitionState);
    this.trimCache();
  }

  private finishTransition(): void {
    const outgoing = this.outgoing;
    if (!outgoing) return;
    this.progress.value = 1;
    this.outgoing = undefined;
    this.outgoingDetail = undefined;
    // Reflection consumers must release their old geometry before eviction.
    this.options.onTransitionChanged?.(this.transitionState);
    outgoing.removeFromParent();
    outgoing.material.dispose();
    this.trimCache();
  }

  private reverseTransition(): void {
    const outgoing = this.outgoing;
    const detail = this.outgoingDetail;
    if (!outgoing || detail === undefined) return;
    const previous = this.options.mesh.geometry;
    this.options.mesh.geometry = outgoing.geometry;
    this.currentDetail = detail;
    this.swaps += 1;
    this.options.mesh.userData.proxyDetail = detail;
    this.progress.value = 1;
    this.outgoing = undefined;
    this.outgoingDetail = undefined;
    this.options.onGeometryChanged?.(this.options.mesh.geometry, previous);
    this.options.onTransitionChanged?.(this.transitionState);
    outgoing.removeFromParent();
    outgoing.material.dispose();
    this.trimCache();
  }

  private trimCache(): void {
    for (const [detail, geometry] of this.cache) {
      if (this.cache.size <= MAX_CACHED_PLANET_PROXY_LEVELS) break;
      if (geometry === this.initialGeometry || geometry === this.options.mesh.geometry || geometry === this.outgoing?.geometry) continue;
      this.cache.delete(detail);
      geometry.dispose();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pending = undefined;
    this.options.scheduler.cancelOwner(this.owner);
    this.finishTransition();
    for (const geometry of new Set(this.cache.values())) {
      // The application still owns the stable mesh and its currently attached
      // geometry. It disposes those after this controller, exactly once.
      if (geometry !== this.options.mesh.geometry) geometry.dispose();
    }
    this.cache.clear();
    if (this.material.maskNode === this.incomingMask) {
      if (this.hadOwnMask) this.material.maskNode = this.originalMask;
      else delete this.material.maskNode;
      this.material.needsUpdate = true;
    }
    this.state = 'disposed';
  }
}
