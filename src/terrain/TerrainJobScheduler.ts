import type { PlanetField } from '../fields';
import { createTerrainTileGeometryTask, estimateTerrainTileBytes, type TerrainTileBuffers } from './Geometry';
import {
  CONTACT_SURFACE_LIMITS,
  createContactSurfaceGenerationTask,
  type ContactGeometryOptions,
  type ContactLease,
  type ContactSurfaceGeneration,
} from './ContactGeometry';
import {
  MAX_SURFACE_PATCH_SEGMENTS,
  createSurfacePatchGeometryTask,
  estimateSurfacePatchGeometryBytes,
  type SurfacePatchGeometryArrays,
  type SurfacePatchGeometryBuffers,
  type SurfacePatchGeometryOptions,
} from './SurfacePatchGeometry';
import {
  estimatePlanetProxyGeometryBytes,
  generatePlanetProxyGeometryBuffers,
  planetProxySubdivisions,
  resolvePlanetProxyDetail,
  type PlanetProxyGeometryBuffers,
  type PlanetProxyGeometryOptions,
} from './PlanetProxyGeometry';
import {
  MAX_SURFACE_SCENERY_INSTANCES,
  SURFACE_SCENERY_BATCH_KINDS,
  SURFACE_SCENERY_INSTANCE_BYTES,
  createSurfaceSceneryTask,
  estimateSurfaceSceneryBytes,
  type SurfaceSceneryBuffers,
  type SurfaceSceneryOptions,
} from './SurfaceScenery';
import type { TerrainWorkerRequest, TerrainWorkerResponse } from './TerrainStreamer';
import { freezeSurfaceFlowRegion, isValidSurfaceFlowRegion } from './SurfaceFlowField';

export interface ContactWorkerRequest {
  field: PlanetField;
  lease: ContactLease;
  options?: ContactGeometryOptions;
}

export interface SurfacePatchWorkerRequest {
  /** Stable body/layer identity; token changes only when its requested geometry changes. */
  key: string;
  token: number;
  field: PlanetField;
  options: SurfacePatchGeometryOptions;
}

export interface SurfacePatchWorkerResponse {
  key: string;
  token: number;
  buffers: SurfacePatchGeometryBuffers;
}

export interface PlanetProxyWorkerRequest {
  key: string;
  token: number;
  field: PlanetField;
  options: PlanetProxyGeometryOptions;
}

export interface PlanetProxyWorkerResponse {
  key: string;
  token: number;
  buffers: PlanetProxyGeometryBuffers;
}

export interface SurfaceSceneryWorkerRequest {
  key: string;
  token: number;
  field: PlanetField;
  options: SurfaceSceneryOptions;
  /** Only a current contact lease's immutable flow-preparation dependency may set this. */
  contactCritical?: true;
}

export interface SurfaceSceneryWorkerResponse {
  key: string;
  token: number;
  buffers: SurfaceSceneryBuffers;
}

export type TerrainJobKind = 'terrain' | 'contact' | 'surface-patch' | 'planet-proxy' | 'surface-scenery';

export type SharedTerrainWorkerRequest =
  | (TerrainWorkerRequest & { kind: 'terrain'; jobId: string })
  | (ContactWorkerRequest & { kind: 'contact'; jobId: string })
  | (SurfacePatchWorkerRequest & { kind: 'surface-patch'; jobId: string })
  | (PlanetProxyWorkerRequest & { kind: 'planet-proxy'; jobId: string })
  | (SurfaceSceneryWorkerRequest & { kind: 'surface-scenery'; jobId: string });

export type SharedTerrainWorkerResponse =
  | (TerrainWorkerResponse & { kind?: 'terrain'; jobId?: string })
  | { kind: 'contact'; jobId: string; generation: ContactSurfaceGeneration }
  | (SurfacePatchWorkerResponse & { kind: 'surface-patch'; jobId: string })
  | (PlanetProxyWorkerResponse & { kind: 'planet-proxy'; jobId: string })
  | (SurfaceSceneryWorkerResponse & { kind: 'surface-scenery'; jobId: string });

export interface TerrainJobCallbacks<T> {
  isCurrent(): boolean;
  /** Called once when generation first starts, including transparently retried jobs. */
  onStart?(): void;
  onGenerated?(result: T): void;
  /** Return false only when a completed result must wait for a safe atomic upload. */
  upload(result: T): boolean;
  onDiscard?(): void;
  /** Terminal producer/result failure; recovered worker transport failures are diagnostic only. */
  onError?(error: unknown): void;
}

export interface TerrainJobSchedulerOptions {
  maxWorkers?: number;
  /** Admission cap for queued + generating jobs; completed buffers have separate limits. */
  maxQueued?: number;
  maxUploadsPerFrame?: number;
  maxPendingResults?: number;
  maxPendingBytes?: number;
  /** Soft transferred-buffer admission cap for CPU publication callbacks, not GPU uploads. */
  maxPublicationBytesPerFrame?: number;
  /** Cooperative CPU producer budget; one indivisible step can exceed it. */
  maxCpuGenerationMsPerFrame?: number;
  /** Hard yield-step cap also bounds deterministic clocks that do not advance. */
  maxCpuGenerationStepsPerFrame?: number;
  /** Synchronous draining is only for deliberate deterministic fixtures/offline tools. */
  cpuExecution?: 'cooperative' | 'synchronous';
  useWorkers?: boolean;
  /** Generous accumulated active/pump-time budget, not elapsed suspended-tab wall time. */
  workerTimeoutMs?: number;
  /** Monotonic clock injection for deterministic worker-liveness tests. */
  now?: () => number;
}

export interface TerrainJobSchedulerStats {
  workers: number;
  maxWorkers: number;
  executionMode: 'workers' | 'cpu';
  cpuExecution: 'cooperative' | 'synchronous';
  /** Transport failures retire workers permanently for this scheduler's lifetime. */
  workerFailures: number;
  workerTimeouts: number;
  /** Still-current jobs retained after a worker was retired. */
  workerRetries: number;
  /** Last transport failure only, bounded to avoid accumulating worker error payloads. */
  lastWorkerError: string | null;
  workerTimeoutMs: number;
  oldestWorkerSilenceMs: number;
  queued: number;
  generating: number;
  pendingUploads: number;
  pendingBytes: number;
  /** Completed buffers plus conservative reservations for actually running jobs. */
  reservedBytes: number;
  maximumPendingBytes: number;
  /** Maximum admitted queued + generating jobs, excluding completed buffers. */
  maximumQueued: number;
  maximumBackgroundJobs: number;
  maximumUploadsPerFrame: number;
  uploadsThisFrame: number;
  /** These count CPU result-publication callbacks, not asynchronous driver/GPU uploads. */
  publicationBytesThisFrame: number;
  sceneryPublicationsThisFrame: number;
  maximumPublicationBytesPerFrame: number;
  totalPublicationBytes: number;
  largestPublicationBytes: number;
  oversizePublications: number;
  cpuGenerationMsThisFrame: number;
  cpuGenerationStepsThisFrame: number;
  maximumCpuGenerationMsPerFrame: number;
  maximumCpuGenerationStepsPerFrame: number;
  largestCpuSliceMs: number;
  largestCpuStepMs: number;
  cpuPreemptions: number;
  cpuActiveKind: TerrainJobKind | null;
  byKind: Record<TerrainJobKind, TerrainJobOwnerStats>;
  generated: number;
  uploaded: number;
  discarded: number;
}

export interface TerrainJobOwnerStats {
  queued: number;
  generating: number;
  pendingUploads: number;
  pendingBytes: number;
}

interface BaseJob {
  id: string;
  owner: string;
  priority: number;
  order: number;
  state: 'queued' | 'generating' | 'ready';
  bytes: number;
  reservationBytes: number;
  canceled: boolean;
  started: boolean;
}

type TerrainJob = BaseJob & {
  kind: 'terrain';
  request: TerrainWorkerRequest;
  callbacks: TerrainJobCallbacks<TerrainWorkerResponse>;
  result?: TerrainWorkerResponse;
};

type ContactJob = BaseJob & {
  kind: 'contact';
  request: ContactWorkerRequest;
  callbacks: TerrainJobCallbacks<ContactSurfaceGeneration>;
  result?: ContactSurfaceGeneration;
};

type SurfacePatchJob = BaseJob & {
  kind: 'surface-patch';
  request: SurfacePatchWorkerRequest;
  callbacks: TerrainJobCallbacks<SurfacePatchWorkerResponse>;
  result?: SurfacePatchWorkerResponse;
};

type PlanetProxyJob = BaseJob & {
  kind: 'planet-proxy';
  request: PlanetProxyWorkerRequest;
  callbacks: TerrainJobCallbacks<PlanetProxyWorkerResponse>;
  result?: PlanetProxyWorkerResponse;
};

type SurfaceSceneryJob = BaseJob & {
  kind: 'surface-scenery';
  request: SurfaceSceneryWorkerRequest;
  callbacks: TerrainJobCallbacks<SurfaceSceneryWorkerResponse>;
  result?: SurfaceSceneryWorkerResponse;
};

type Job = TerrainJob | ContactJob | SurfacePatchJob | PlanetProxyJob | SurfaceSceneryJob;
type JobResult = TerrainWorkerResponse | ContactSurfaceGeneration | SurfacePatchWorkerResponse |
  PlanetProxyWorkerResponse | SurfaceSceneryWorkerResponse;
interface CpuTask {
  job: Job;
  iterator: Generator<void, JobResult, void>;
}
type WorkerFailurePhase = 'construction' | 'error' | 'messageerror' | 'postMessage' | 'response' | 'timeout';

const DEFAULT_WORKER_TIMEOUT_MS = 30_000;
const MAX_WATCHDOG_PUMP_DELTA_MS = 250;
const DEFAULT_PUBLICATION_BYTES_PER_FRAME = 4 * 1_048_576;
const DEFAULT_CPU_GENERATION_MS_PER_FRAME = 4;
const DEFAULT_CPU_GENERATION_STEPS_PER_FRAME = 64;
const IMPLICIT_CPU_FRAME_DELAY_MS = 16;

function jobPriorityClass(job: Job): number {
  return job.kind === 'contact' ? 3
    : job.kind === 'surface-scenery' && job.request.contactCritical === true ? 2
    : job.kind === 'planet-proxy' || job.kind === 'surface-scenery' ? 0 : 1;
}

function* mappedTask<T, U extends JobResult>(task: Generator<void, T, void>, map: (result: T) => U): Generator<void, U, void> {
  return map(yield* task);
}

function terrainJobId(owner: string, key: TerrainWorkerRequest['key'], token: number): string {
  return `${owner}:terrain:${key.face}/${key.level}/${key.x}/${key.y}:${token}`;
}

function compareJobs(first: Job, second: Job): number {
  // Human-scale collision readiness must not lose to an arbitrarily large
  // visual screen-error score during a fast planetary approach.
  return jobPriorityClass(second) - jobPriorityClass(first) ||
    second.priority - first.priority || first.order - second.order;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

type TypedArrayName = 'Float32Array' | 'Float64Array' | 'Uint16Array' | 'Uint32Array';
type TransferTypes = Readonly<Record<string, TypedArrayName | readonly TypedArrayName[]>>;

const SURFACE_PATCH_TRANSFER_TYPES = {
  terrainPositions: 'Float32Array', terrainColors: 'Float32Array', terrainNormals: 'Float32Array',
  terrainIndices: 'Uint16Array',
  oceanPositions: 'Float32Array', oceanColors: 'Float32Array', oceanDepths: 'Float32Array',
  oceanShoreProximities: 'Float32Array', shorePositions: 'Float32Array', facetPositions: 'Float32Array',
  wavePositions: 'Float32Array', waveColors: 'Float32Array', mineralGridIndices: 'Uint32Array',
  mineralDirections: 'Float64Array', mineralPositions: 'Float64Array',
} as const satisfies Record<keyof SurfacePatchGeometryArrays, TypedArrayName>;

/** Inspect bounded metadata only; do not rescan every generated vertex on the main thread. */
function transferableBytes(value: Record<string, unknown>, types: TransferTypes): number | undefined {
  const buffers = new Set<ArrayBufferLike>();
  for (const [key, expected] of Object.entries(types)) {
    const array = value[key];
    if (!ArrayBuffer.isView(array)) return undefined;
    const names = typeof expected === 'string' ? [expected] : expected;
    if (!names.some((name) => Object.prototype.toString.call(array) === `[object ${name}]`) ||
      Object.prototype.toString.call(array.buffer) !== '[object ArrayBuffer]') return undefined;
    buffers.add(array.buffer);
  }
  return [...buffers].reduce((total, buffer) => total + buffer.byteLength, 0);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isFiniteTuple(value: unknown, length: number): boolean {
  return Array.isArray(value) && value.length === length && value.every(isFiniteNumber);
}

function isFiniteVector(value: unknown): boolean {
  return isRecord(value) && isFiniteNumber(value.x) && isFiniteNumber(value.y) && isFiniteNumber(value.z);
}

function validSurfacePatchPayload(job: SurfacePatchJob, value: unknown): boolean {
  if (!isRecord(value)) return false;
  const bytes = transferableBytes(value, SURFACE_PATCH_TRANSFER_TYPES);
  if (bytes === undefined || bytes !== value.byteLength || bytes > job.reservationBytes) return false;
  const arrays = value as unknown as SurfacePatchGeometryArrays;
  const segments = Math.max(8, Math.min(MAX_SURFACE_PATCH_SEGMENTS, Math.round(job.request.options.segments)));
  const counts = value.counts;
  const palette = value.palette;
  const sample = value.centerSample;
  if (value.segments !== segments || value.renderRadius !== Math.max(Number.EPSILON, job.request.options.renderRadius) ||
    value.patchSize !== job.request.options.size || !isFiniteNumber(value.meterScale) || value.meterScale <= 0 ||
    !isFiniteNumber(value.cellMeters) || value.cellMeters <= 0 ||
    !['centerDirection', 'origin', 'originBodyFixedMeters', 'tangent', 'bitangent'].every((key) => isFiniteVector(value[key])) ||
    !isRecord(sample) || !isFiniteNumber(sample.heightMeters) || typeof sample.ocean !== 'boolean' ||
    !isRecord(palette) || !isRecord(counts)) return false;
  if (arrays.terrainPositions.length !== (segments + 1) ** 2 * 3 ||
    arrays.terrainColors.length !== arrays.terrainPositions.length || arrays.terrainNormals.length !== arrays.terrainPositions.length ||
    arrays.terrainIndices.length !== segments * segments * 6 ||
    arrays.oceanPositions.length % 9 !== 0 || arrays.oceanColors.length !== arrays.oceanPositions.length ||
    arrays.oceanDepths.length * 3 !== arrays.oceanPositions.length || arrays.oceanShoreProximities.length !== arrays.oceanDepths.length ||
    arrays.shorePositions.length % 6 !== 0 || arrays.facetPositions.length % 6 !== 0 || arrays.wavePositions.length % 6 !== 0 ||
    arrays.waveColors.length !== arrays.wavePositions.length || arrays.mineralGridIndices.length > (segments + 1) ** 2 ||
    arrays.mineralDirections.length !== arrays.mineralGridIndices.length * 3 ||
    arrays.mineralPositions.length !== arrays.mineralDirections.length) return false;
  if (counts.vertices !== (segments + 1) ** 2 || counts.triangles !== segments * segments * 2 ||
    counts.oceanTriangles !== arrays.oceanPositions.length / 9 || counts.shorelineSegments !== arrays.shorePositions.length / 6 ||
    counts.facetSegments !== arrays.facetPositions.length / 6 || counts.waveSegments !== arrays.wavePositions.length / 6 ||
    typeof counts.biomeId !== 'string') return false;
  if (!['mint', 'nearshoreTeal', 'oceanIndigo', 'worldHighland', 'midnightLand', 'indigoLand', 'violetLand', 'emissive']
    .every((key) => isFiniteTuple(palette[key], 3)) || !isFiniteTuple(palette.geologicalFacetShadeRange, 2) ||
    typeof palette.geologicalPalette !== 'string' || !isFiniteNumber(palette.emissiveIntensity) ||
    !['frozenWorld', 'desertWorld', 'volcanicWorld', 'lushWorld'].every((key) => typeof palette[key] === 'boolean')) return false;
  const shoreline = value.nearbyShoreline;
  return shoreline === undefined || (isRecord(shoreline) && isFiniteVector(shoreline.waterward) &&
    isFiniteVector(shoreline.alongshore) && isFiniteNumber(shoreline.distanceMeters));
}

function validPlanetProxyPayload(job: PlanetProxyJob, value: unknown): boolean {
  if (!isRecord(value)) return false;
  const bytes = transferableBytes(value, { positions: 'Float32Array', colors: 'Float32Array', normals: 'Float32Array',
    waterColors: 'Float32Array', wetness: 'Float32Array', waterDepth: 'Float32Array', facetTone: 'Float32Array' });
  if (bytes === undefined || bytes !== value.byteLength || bytes !== job.reservationBytes) return false;
  const payload = value as unknown as PlanetProxyGeometryBuffers;
  const detail = resolvePlanetProxyDetail(job.request.options.detail);
  const subdivisions = planetProxySubdivisions(detail);
  const triangles = 20 * subdivisions * subdivisions;
  const hasWater = job.request.options.includeWater ?? false;
  return payload.fieldSeed === job.request.field.seed && payload.physicalRadiusMeters === job.request.field.radius &&
    payload.renderRadius === job.request.options.renderRadius && payload.detail === detail &&
    payload.subdivisions === subdivisions && payload.triangleCount === triangles &&
    Number.isInteger(payload.sampleCount) && payload.sampleCount >= 0 &&
    Number.isInteger(payload.antiAliasedCoastVertices) && payload.antiAliasedCoastVertices >= 0 &&
    payload.positions.length === triangles * 9 && payload.colors.length === payload.positions.length &&
    payload.normals.length === payload.positions.length && payload.hasWaterAttributes === hasWater &&
    payload.waterColors.length === (hasWater ? payload.positions.length : 0) &&
    payload.wetness.length === (hasWater ? triangles * 3 : 0) && payload.waterDepth.length === payload.wetness.length &&
    payload.facetTone.length === payload.wetness.length && Number.isInteger(payload.wetVertexCount) &&
    payload.wetVertexCount >= 0 && payload.wetVertexCount <= payload.wetness.length;
}

function validSurfaceSceneryPayload(job: SurfaceSceneryJob, value: unknown): boolean {
  if (!isRecord(value)) return false;
  const bytes = transferableBytes(value, { instanceMatrices: 'Float32Array', instanceColors: 'Float32Array',
    instanceDirections: 'Float64Array', instanceKinds: 'Uint16Array' });
  if (bytes === undefined || bytes !== value.byteLength || bytes > job.reservationBytes) return false;
  const payload = value as unknown as SurfaceSceneryBuffers;
  const instances = payload.instanceKinds.length;
  if (instances > MAX_SURFACE_SCENERY_INSTANCES || bytes !== instances * SURFACE_SCENERY_INSTANCE_BYTES ||
    payload.instanceMatrices.length !== instances * 16 || payload.instanceColors.length !== instances * 3 ||
    payload.instanceDirections.length !== instances * 3 || payload.fieldSeed !== job.request.field.seed ||
    payload.fieldVersion !== job.request.field.generatorVersion || payload.bodyRadiusMeters !== job.request.field.radius ||
    payload.renderRadius !== Math.max(Number.EPSILON, job.request.options.renderRadius) || payload.patchSize !== job.request.options.size ||
    !isFiniteVector(payload.centerDirection) || !isFiniteVector(payload.origin) ||
    !Array.isArray(payload.batches) || payload.batches.length !== SURFACE_SCENERY_BATCH_KINDS.length ||
    !['decorationCoverageRadiusMeters', 'nearDecorationCoverageRadiusMeters', 'ecologyCoverageRadiusMeters', 'nearEcologyCoverageRadiusMeters']
      .every((key) => isFiniteNumber(value[key]) && (value[key] as number) >= 0) ||
    !Number.isInteger(payload.ecologyMaximumInstances) || payload.ecologyMaximumInstances < 0 || payload.ecologyMaximumInstances > 160) return false;
  let offset = 0;
  for (let index = 0; index < SURFACE_SCENERY_BATCH_KINDS.length; index += 1) {
    const batch = payload.batches[index];
    if (!batch || batch.kind !== SURFACE_SCENERY_BATCH_KINDS[index] || batch.offset !== offset ||
      !Number.isInteger(batch.count) || batch.count < 0 || !isFiniteNumber(batch.maximumDistanceMeters) || batch.maximumDistanceMeters < 0) return false;
    offset += batch.count;
  }
  if (offset !== instances) return false;
  const region = payload.flowRegion;
  if (job.request.options.flowOnly === true && (instances !== 0 || region === null)) return false;
  if (region === null) return true;
  if (!isValidSurfaceFlowRegion(region, job.request.field)) return false;
  freezeSurfaceFlowRegion(region);
  return true;
}

function validTerrainTilePayload(job: TerrainJob, value: unknown): boolean {
  if (!isRecord(value)) return false;
  const segments = Math.max(2, Math.min(128, Math.round(job.request.options.segments ?? 32)));
  const gridVertices = (segments + 1) ** 2;
  const skirtVertices = job.request.options.renderSkirts === true ? 4 * (segments + 1) : 0;
  const vertices = gridVertices + skirtVertices;
  const hasWater = job.request.options.includeWater === true;
  const bytes = transferableBytes(value, { positions: 'Float32Array', colors: 'Float32Array',
    indices: vertices > 65_535 ? 'Uint32Array' : 'Uint16Array', wetness: 'Float32Array', waterDepth: 'Float32Array' });
  if (bytes === undefined || bytes !== value.byteLength || bytes !== job.reservationBytes) return false;
  const payload = value as unknown as TerrainTileBuffers;
  return payload.gridVertexCount === gridVertices && payload.gridSegments === segments &&
    payload.skirtVertexCount === skirtVertices && payload.hasWaterAttributes === hasWater &&
    payload.positions.length === vertices * 3 && payload.colors.length === payload.positions.length &&
    payload.indices.length === segments * segments * 6 + (skirtVertices > 0 ? segments * 24 : 0) &&
    payload.wetness.length === (hasWater ? vertices : 0) && payload.waterDepth.length === payload.wetness.length &&
    isFiniteTuple(payload.origin, 3) && isFiniteNumber(payload.boundsRadius) && payload.boundsRadius >= 0;
}

/** Do not let a late or malformed reply complete a different active job. */
function matchesWorkerResponse(job: Job, value: unknown): value is SharedTerrainWorkerResponse {
  if (!isRecord(value) || (value.jobId !== undefined && value.jobId !== job.id)) return false;
  if (job.kind === 'contact') {
    const generation = value.generation;
    if (value.kind !== 'contact' || value.jobId !== job.id || !isRecord(generation)) return false;
    const bytes = transferableBytes(generation, { vertices: 'Float32Array', colors: 'Float32Array', indices: 'Uint32Array' });
    if (bytes === undefined || bytes !== generation.byteLength || bytes > job.reservationBytes) return false;
    const payload = generation as unknown as ContactSurfaceGeneration;
    const side = payload.segments + 1;
    return Number.isInteger(payload.segments) && payload.segments >= 2 && payload.segments <= CONTACT_SURFACE_LIMITS.maximumSegments &&
      payload.vertices.length === side * side * 3 && payload.colors.length === payload.vertices.length &&
      payload.indices.length === payload.segments * payload.segments * 6 &&
      payload.bodyRadiusMeters === job.request.field.radius && isFiniteNumber(payload.radiusMeters) && payload.radiusMeters > 0 &&
      isFiniteNumber(payload.cellMeters) && payload.cellMeters > 0 &&
      generation.bodyId === job.request.lease.bodyId && generation.leaseId === job.request.lease.id &&
      generation.token === job.request.lease.token && generation.fieldSeed === job.request.field.seed &&
      generation.fieldVersion === job.request.field.generatorVersion &&
      ['originBodyFixedMeters', 'centerDirection', 'eastBodyFixed', 'upBodyFixed', 'northBodyFixed']
        .every((key) => isFiniteVector(generation[key])) &&
      Array.isArray(generation.solids) && Array.isArray(generation.flows);
  }
  if (job.kind === 'surface-patch') {
    return value.kind === 'surface-patch' && value.jobId === job.id &&
      value.key === job.request.key && value.token === job.request.token && validSurfacePatchPayload(job, value.buffers);
  }
  if (job.kind === 'planet-proxy') {
    return value.kind === 'planet-proxy' && value.jobId === job.id && value.key === job.request.key &&
      value.token === job.request.token && validPlanetProxyPayload(job, value.buffers);
  }
  if (job.kind === 'surface-scenery') {
    return value.kind === 'surface-scenery' && value.jobId === job.id && value.key === job.request.key &&
      value.token === job.request.token && validSurfaceSceneryPayload(job, value.buffers);
  }
  // The older orbital-only worker fixtures omit kind/jobId. Their complete
  // tile key and token are still required; production replies include both.
  const key = value.key;
  return (value.kind === undefined || value.kind === 'terrain') && value.token === job.request.token &&
    isRecord(key) && key.face === job.request.key.face && key.level === job.request.key.level &&
    key.x === job.request.key.x && key.y === job.request.key.y && validTerrainTilePayload(job, value.buffers);
}

function workerErrorMessage(error: unknown): string {
  const message = typeof error === 'string' ? error
    : isRecord(error) && typeof error.message === 'string' ? error.message
      : 'Unknown terrain worker failure';
  return message.replace(/\s+/g, ' ').trim().slice(0, 256) || 'Unknown terrain worker failure';
}

/** One bounded worker/upload queue for orbital tiles, visual patches, and real contact. */
export class TerrainJobScheduler {
  private readonly options: Required<TerrainJobSchedulerOptions>;
  private readonly workers: Worker[] = [];
  private readonly activeWorkers = new Map<Worker, Job>();
  private readonly workerSilenceMs = new Map<Worker, number>();
  private readonly jobs = new Map<string, Job>();
  private nextOrder = 0;
  private frameKey: number | string | undefined;
  private autoFrame = 0;
  private explicitlyFramed = false;
  private implicitFrameActive = false;
  private implicitCpuTimer: ReturnType<typeof setTimeout> | undefined;
  private uploadsThisFrame = 0;
  private publicationBytesThisFrame = 0;
  private sceneryPublicationsThisFrame = 0;
  private totalPublicationBytes = 0;
  private largestPublicationBytes = 0;
  private oversizePublications = 0;
  private cpuTask: CpuTask | undefined;
  private cpuGenerationMsThisFrame = 0;
  private cpuGenerationStepsThisFrame = 0;
  private largestCpuSliceMs = 0;
  private largestCpuStepMs = 0;
  private cpuPreemptions = 0;
  private generated = 0;
  private uploaded = 0;
  private discarded = 0;
  private workerFailures = 0;
  private workerTimeouts = 0;
  private workerRetries = 0;
  private lastWorkerError: string | null = null;
  private lastPumpTime: number | undefined;
  private disposed = false;
  private pumping = false;

  constructor(options: TerrainJobSchedulerOptions = {}) {
    const maxWorkers = Math.max(1, Math.min(4, Math.floor(options.maxWorkers ?? 2)));
    const maxUploadsPerFrame = Math.max(1, Math.min(4, Math.floor(options.maxUploadsPerFrame ?? 2)));
    this.options = {
      maxWorkers,
      maxQueued: Math.max(4, Math.min(128, Math.floor(options.maxQueued ?? 64))),
      maxUploadsPerFrame,
      maxPendingResults: Math.max(maxWorkers, Math.min(16,
        Math.floor(options.maxPendingResults ?? Math.max(maxWorkers, maxUploadsPerFrame * 2)))),
      maxPendingBytes: Math.max(2 * 1_048_576, Math.min(64 * 1_048_576, options.maxPendingBytes ?? 20 * 1_048_576)),
      maxPublicationBytesPerFrame: Math.max(65_536, Math.min(64 * 1_048_576,
        isFiniteNumber(options.maxPublicationBytesPerFrame) ? options.maxPublicationBytesPerFrame : DEFAULT_PUBLICATION_BYTES_PER_FRAME)),
      maxCpuGenerationMsPerFrame: Math.max(0.25, Math.min(32,
        isFiniteNumber(options.maxCpuGenerationMsPerFrame) ? options.maxCpuGenerationMsPerFrame : DEFAULT_CPU_GENERATION_MS_PER_FRAME)),
      maxCpuGenerationStepsPerFrame: Math.max(1, Math.min(1_024, Math.floor(
        isFiniteNumber(options.maxCpuGenerationStepsPerFrame) ? options.maxCpuGenerationStepsPerFrame : DEFAULT_CPU_GENERATION_STEPS_PER_FRAME))),
      cpuExecution: options.cpuExecution ?? 'cooperative',
      useWorkers: options.useWorkers ?? true,
      workerTimeoutMs: Math.max(1_000, Math.min(120_000,
        isFiniteNumber(options.workerTimeoutMs) ? options.workerTimeoutMs : DEFAULT_WORKER_TIMEOUT_MS)),
      now: options.now ?? (() => performance.now()),
    };
    if (this.options.useWorkers && typeof Worker !== 'undefined') this.initializeWorkers();
  }

  private initializeWorkers(): void {
    for (let index = 0; index < this.options.maxWorkers; index += 1) {
      let worker: Worker;
      try {
        worker = new Worker(new URL('./worker/terrain.worker.ts', import.meta.url), {
          type: 'module', name: `void-terrain-${index}`,
        });
      } catch (error) {
        this.recordWorkerFailure('construction', error);
        // Keep any workers already created successfully. Do not repeatedly
        // retry a blocked worker URL or construct an unbounded replacement pool.
        break;
      }
      worker.onmessage = (event: MessageEvent<unknown>) => this.receiveWorkerMessage(worker, event.data);
      worker.onerror = (error) => this.retireWorker(worker, 'error', error);
      worker.onmessageerror = () => this.retireWorker(worker, 'messageerror',
        new Error('Terrain worker response could not be deserialized.'));
      this.workers.push(worker);
    }
  }

  private recordWorkerFailure(phase: WorkerFailurePhase, error: unknown): void {
    this.workerFailures += 1;
    if (phase === 'timeout') this.workerTimeouts += 1;
    this.lastWorkerError = `${phase}: ${workerErrorMessage(error)}`;
  }

  private detachWorker(worker: Worker): void {
    worker.onmessage = null;
    worker.onerror = null;
    worker.onmessageerror = null;
    worker.terminate();
  }

  /** A transport failure is recoverable until the actual CPU producer fails. */
  private retireWorker(worker: Worker, phase: WorkerFailurePhase, error: unknown): void {
    const index = this.workers.indexOf(worker);
    if (index < 0 || this.disposed) return;
    this.workers.splice(index, 1);
    const job = this.activeWorkers.get(worker);
    this.activeWorkers.delete(worker);
    this.workerSilenceMs.delete(worker);
    this.detachWorker(worker);
    this.recordWorkerFailure(phase, error);
    if (job && this.jobs.get(job.id) === job) {
      if (job.canceled || !job.callbacks.isCurrent()) this.discard(job);
      else {
        // Retain identity, priority, order, and the owner's generating state.
        // Admission reserves this waiting slot even while a worker owns it.
        job.state = 'queued';
        this.workerRetries += 1;
      }
    }
    // The pump is iterative; a synchronous postMessage failure cannot recurse.
    this.pump();
  }

  private receiveWorkerMessage(worker: Worker, value: unknown): void {
    if (this.disposed || !this.workers.includes(worker)) return;
    const job = this.activeWorkers.get(worker);
    if (!job) return;
    if (!matchesWorkerResponse(job, value)) {
      this.retireWorker(worker, 'response', new Error(`Terrain worker reply did not match its active ${job.kind} job.`));
      return;
    }
    this.activeWorkers.delete(worker);
    this.workerSilenceMs.delete(worker);
    if (job.kind === 'contact' && value.kind === 'contact') this.finish(job, value.generation);
    else if (job.kind === 'surface-patch' && value.kind === 'surface-patch') {
      this.finish(job, { key: value.key, token: value.token, buffers: value.buffers });
    } else if (job.kind === 'planet-proxy' && value.kind === 'planet-proxy') {
      this.finish(job, { key: value.key, token: value.token, buffers: value.buffers });
    } else if (job.kind === 'surface-scenery' && value.kind === 'surface-scenery') {
      this.finish(job, { key: value.key, token: value.token, buffers: value.buffers });
    } else if (job.kind === 'terrain' && (value.kind === undefined || value.kind === 'terrain')) {
      this.finish(job, { key: value.key, token: value.token, buffers: value.buffers });
    }
    this.pump();
  }

  private advanceWorkerWatchdog(): void {
    const now = this.options.now();
    if (!Number.isFinite(now)) return;
    const previous = this.lastPumpTime;
    this.lastPumpTime = now;
    if (previous === undefined) return;
    // A hidden/suspended tab can resume with a very large clock jump. Credit
    // only bounded observed pump time so a healthy worker can answer first.
    const delta = Math.max(0, Math.min(MAX_WATCHDOG_PUMP_DELTA_MS, now - previous));
    for (const worker of [...this.activeWorkers.keys()]) {
      if (this.disposed || !this.activeWorkers.has(worker)) continue;
      const silence = (this.workerSilenceMs.get(worker) ?? 0) + delta;
      this.workerSilenceMs.set(worker, silence);
      if (silence >= this.options.workerTimeoutMs) {
        this.retireWorker(worker, 'timeout', new Error(
          `Terrain worker did not reply within ${this.options.workerTimeoutMs} ms of accumulated active pump time.`,
        ));
      }
    }
  }

  beginFrame(frameKey?: number | string): void {
    const alreadyExplicit = this.explicitlyFramed;
    this.explicitlyFramed = true;
    this.implicitFrameActive = false;
    if (this.implicitCpuTimer !== undefined) {
      clearTimeout(this.implicitCpuTimer);
      this.implicitCpuTimer = undefined;
    }
    const next = frameKey ?? ++this.autoFrame;
    if (alreadyExplicit && this.frameKey === next) return;
    this.frameKey = next;
    this.resetFrameBudgets();
  }

  private resetFrameBudgets(): void {
    this.uploadsThisFrame = 0;
    this.publicationBytesThisFrame = 0;
    this.sceneryPublicationsThisFrame = 0;
    this.cpuGenerationMsThisFrame = 0;
    this.cpuGenerationStepsThisFrame = 0;
  }

  private ensureImplicitFrame(): void {
    if (this.explicitlyFramed || this.implicitFrameActive) return;
    this.implicitFrameActive = true;
    this.frameKey = ++this.autoFrame;
    this.resetFrameBudgets();
  }

  scheduleTerrain(owner: string, request: TerrainWorkerRequest, priority: number,
    callbacks: TerrainJobCallbacks<TerrainWorkerResponse>): boolean {
    let reservationBytes: number;
    try { reservationBytes = estimateTerrainTileBytes(request.options); }
    catch (error) { callbacks.onError?.(error); return false; }
    const id = terrainJobId(owner, request.key, request.token);
    return this.admit({ id, owner, priority, order: this.nextOrder++, state: 'queued', bytes: 0,
      reservationBytes, canceled: false, started: false, kind: 'terrain', request, callbacks });
  }

  /** Update an admitted orbital job without rebuilding or re-enqueuing its request. */
  reprioritizeTerrain(owner: string, key: TerrainWorkerRequest['key'], token: number, priority: number): boolean {
    const job = this.jobs.get(terrainJobId(owner, key, token));
    if (!job || job.canceled || job.state !== 'queued') return false;
    if (Number.isFinite(priority)) job.priority = priority;
    return true;
  }

  scheduleContact(owner: string, request: ContactWorkerRequest, priority: number,
    callbacks: TerrainJobCallbacks<ContactSurfaceGeneration>): boolean {
    const id = `${owner}:contact:${request.lease.id}:${request.lease.token}`;
    const radius = Math.max(CONTACT_SURFACE_LIMITS.minimumRadiusMeters,
      Math.min(CONTACT_SURFACE_LIMITS.maximumRadiusMeters, request.lease.radiusMeters));
    const segments = Math.max(2, Math.ceil(radius * 2 / request.lease.requiredCellMeters));
    const reservationBytes = (segments + 1) ** 2 * 24 + segments * segments * 24;
    return this.admit({ id, owner, priority, order: this.nextOrder++, state: 'queued', bytes: 0,
      reservationBytes, canceled: false, started: false, kind: 'contact', request, callbacks });
  }

  scheduleSurfacePatch(owner: string, request: SurfacePatchWorkerRequest, priority: number,
    callbacks: TerrainJobCallbacks<SurfacePatchWorkerResponse>): boolean {
    let reservationBytes: number;
    try { reservationBytes = estimateSurfacePatchGeometryBytes(request.options); }
    catch (error) { callbacks.onError?.(error); return false; }
    const id = `${owner}:surface-patch:${request.key}:${request.token}`;
    return this.admit({ id, owner, priority, order: this.nextOrder++, state: 'queued', bytes: 0,
      reservationBytes, canceled: false, started: false, kind: 'surface-patch', request, callbacks });
  }

  schedulePlanetProxy(owner: string, request: PlanetProxyWorkerRequest, priority: number,
    callbacks: TerrainJobCallbacks<PlanetProxyWorkerResponse>): boolean {
    let reservationBytes: number;
    try { reservationBytes = estimatePlanetProxyGeometryBytes(request.options); }
    catch (error) { callbacks.onError?.(error); return false; }
    const id = `${owner}:planet-proxy:${request.key}:${request.token}`;
    return this.admit({ id, owner, priority, order: this.nextOrder++, state: 'queued', bytes: 0,
      reservationBytes, canceled: false, started: false, kind: 'planet-proxy', request, callbacks });
  }

  scheduleSurfaceScenery(owner: string, request: SurfaceSceneryWorkerRequest, priority: number,
    callbacks: TerrainJobCallbacks<SurfaceSceneryWorkerResponse>): boolean {
    let reservationBytes: number;
    try { reservationBytes = estimateSurfaceSceneryBytes(request.options); }
    catch (error) { callbacks.onError?.(error); return false; }
    const id = `${owner}:surface-scenery:${request.key}:${request.token}`;
    return this.admit({ id, owner, priority, order: this.nextOrder++, state: 'queued', bytes: 0,
      reservationBytes, canceled: false, started: false, kind: 'surface-scenery', request, callbacks });
  }

  private admit(job: Job): boolean {
    if (this.disposed || this.jobs.has(job.id)) return false;
    if (!Number.isFinite(job.reservationBytes) || job.reservationBytes < 0 || job.reservationBytes > this.options.maxPendingBytes) {
      job.callbacks.onError?.(new RangeError('Terrain job exceeds the shared transferable-buffer budget.'));
      return false;
    }
    this.discardStale();
    // A running job may need its waiting slot back after a worker dies. Count
    // both states so recovery never exceeds the advertised admission bound or
    // evicts another owner's valid queued work.
    const unfinished = [...this.jobs.values()].filter((candidate) => candidate.state !== 'ready');
    const maximumBackgroundJobs = this.options.maxQueued - CONTACT_SURFACE_LIMITS.maximumLeases;
    if (jobPriorityClass(job) === 0 && unfinished.filter((candidate) => jobPriorityClass(candidate) === 0).length >= maximumBackgroundJobs) return false;
    if (unfinished.length >= this.options.maxQueued) {
      // Optional backlog must not refuse a newly needed contact/ground job.
      // Only an unstarted lower-class job can be displaced: running/retried
      // owners keep their generation state and reserved recovery slot.
      const victim = unfinished.filter((candidate) => candidate.state === 'queued' && !candidate.started &&
        jobPriorityClass(candidate) < jobPriorityClass(job)).sort(compareJobs).at(-1);
      if (!victim) return false;
      this.discard(victim);
      if (this.disposed || this.jobs.has(job.id) ||
        [...this.jobs.values()].filter((candidate) => candidate.state !== 'ready').length >= this.options.maxQueued) return false;
    }
    this.jobs.set(job.id, job);
    return true;
  }

  cancelOwner(owner: string): void {
    for (const job of [...this.jobs.values()]) {
      if (job.owner !== owner) continue;
      job.canceled = true;
      if (job.state !== 'generating' || this.cpuTask?.job === job) this.discard(job);
    }
  }

  private discardStale(): void {
    for (const job of [...this.jobs.values()]) {
      if (job.state !== 'generating' && (job.canceled || !job.callbacks.isCurrent())) this.discard(job);
    }
  }

  private discard(job: Job): void {
    if (this.jobs.get(job.id) !== job) return;
    this.jobs.delete(job.id);
    this.closeCpuTask(job);
    this.discarded += 1;
    job.callbacks.onDiscard?.();
  }

  private fail(job: Job, error: unknown): void {
    if (this.jobs.get(job.id) !== job) return;
    this.jobs.delete(job.id);
    this.closeCpuTask(job);
    job.callbacks.onError?.(error);
  }

  private finish(job: TerrainJob, result: TerrainWorkerResponse): void;
  private finish(job: ContactJob, result: ContactSurfaceGeneration): void;
  private finish(job: SurfacePatchJob, result: SurfacePatchWorkerResponse): void;
  private finish(job: PlanetProxyJob, result: PlanetProxyWorkerResponse): void;
  private finish(job: SurfaceSceneryJob, result: SurfaceSceneryWorkerResponse): void;
  private finish(job: Job, result: JobResult): void {
    if (this.jobs.get(job.id) !== job) return;
    if (job.canceled || !job.callbacks.isCurrent()) {
      this.discard(job);
      return;
    }
    job.state = 'ready';
    this.generated += 1;
    if (job.kind === 'contact') {
      job.result = result as ContactSurfaceGeneration;
      job.bytes = job.result.byteLength;
      job.callbacks.onGenerated?.(job.result);
    } else if (job.kind === 'surface-patch') {
      job.result = result as SurfacePatchWorkerResponse;
      job.bytes = job.result.buffers.byteLength;
      if (!Number.isFinite(job.bytes) || job.bytes < 0 || job.bytes > job.reservationBytes) {
        this.fail(job, new RangeError('Surface patch result exceeds its reserved transferable-buffer budget.'));
        return;
      }
      job.callbacks.onGenerated?.(job.result);
    } else if (job.kind === 'planet-proxy') {
      job.result = result as PlanetProxyWorkerResponse;
      job.bytes = job.result.buffers.byteLength;
      if (!Number.isFinite(job.bytes) || job.bytes < 0 || job.bytes > job.reservationBytes) {
        this.fail(job, new RangeError('Planet proxy result exceeds its reserved transferable-buffer budget.'));
        return;
      }
      job.callbacks.onGenerated?.(job.result);
    } else if (job.kind === 'surface-scenery') {
      job.result = result as SurfaceSceneryWorkerResponse;
      job.bytes = job.result.buffers.byteLength;
      if (!Number.isFinite(job.bytes) || job.bytes < 0 || job.bytes > job.reservationBytes) {
        this.fail(job, new RangeError('Surface scenery result exceeds its reserved transferable-buffer budget.'));
        return;
      }
      job.callbacks.onGenerated?.(job.result);
    } else {
      job.result = result as TerrainWorkerResponse;
      job.bytes = job.result.buffers.byteLength;
      if (job.bytes !== job.reservationBytes) {
        this.fail(job, new RangeError('Terrain tile result does not match its reserved transferable-buffer budget.'));
        return;
      }
      job.callbacks.onGenerated?.(job.result);
    }
  }

  private startJob(job: Job): boolean {
    job.state = 'generating';
    if (!job.started) {
      job.started = true;
      job.callbacks.onStart?.();
    }
    if (this.disposed || this.jobs.get(job.id) !== job) return false;
    if (job.canceled || !job.callbacks.isCurrent()) { this.discard(job); return false; }
    return true;
  }

  private createCpuTask(job: Job): CpuTask {
    if (job.kind === 'contact') return { job, iterator:
      createContactSurfaceGenerationTask(job.request.field, job.request.lease, job.request.options) };
    if (job.kind === 'terrain') return { job, iterator: mappedTask(
      createTerrainTileGeometryTask(job.request.field, job.request.key, job.request.options),
      (buffers) => ({ key: job.request.key, token: job.request.token, buffers })) };
    if (job.kind === 'surface-patch') return { job, iterator: mappedTask(
      createSurfacePatchGeometryTask(job.request.field, job.request.options),
      (buffers) => ({ key: job.request.key, token: job.request.token, buffers })) };
    if (job.kind === 'planet-proxy') return { job, iterator: mappedTask(
      generatePlanetProxyGeometryBuffers(job.request.field, job.request.options),
      (buffers) => ({ key: job.request.key, token: job.request.token, buffers })) };
    return { job, iterator: mappedTask(createSurfaceSceneryTask(job.request.field, job.request.options),
      (buffers) => ({ key: job.request.key, token: job.request.token, buffers })) };
  }

  private closeCpuTask(job?: Job): void {
    const task = this.cpuTask;
    if (!task || (job && task.job !== job)) return;
    this.cpuTask = undefined;
    // These pure iterators own temporary arrays/maps, never scene resources.
    // Closing a canceled/preempted task releases their retained references.
    try { task.iterator.return(undefined as never); } catch { /* Canceled producer cleanup is not a publishable result. */ }
  }

  private finishCpuTask(job: Job, result: JobResult): void {
    if (job.kind === 'contact') this.finish(job, result as ContactSurfaceGeneration);
    else if (job.kind === 'surface-patch') this.finish(job, result as SurfacePatchWorkerResponse);
    else if (job.kind === 'planet-proxy') this.finish(job, result as PlanetProxyWorkerResponse);
    else if (job.kind === 'surface-scenery') this.finish(job, result as SurfaceSceneryWorkerResponse);
    else this.finish(job, result as TerrainWorkerResponse);
  }

  private nextQueuedJob(reservedBytes: number): Job | undefined {
    return [...this.jobs.values()].filter((job) => job.state === 'queued').sort(compareJobs)
      .find((job) => reservedBytes + job.reservationBytes <= this.options.maxPendingBytes);
  }

  private preemptCpuTaskForUrgentWork(): void {
    const task = this.cpuTask;
    if (!task) return;
    const stats = this.stats;
    const availableReservation = stats.reservedBytes - task.job.reservationBytes;
    const urgent = [...this.jobs.values()].filter((job) => job.state === 'queued' &&
      jobPriorityClass(job) > jobPriorityClass(task.job)).sort(compareJobs)
      .find((job) => availableReservation + job.reservationBytes <= this.options.maxPendingBytes);
    if (!urgent || stats.pendingUploads + stats.generating - 1 >= this.options.maxUploadsPerFrame) return;
    this.closeCpuTask();
    task.job.state = 'queued';
    this.cpuPreemptions += 1;
  }

  private cpuClock(): number {
    const value = this.options.now();
    return Number.isFinite(value) ? value : 0;
  }

  /** All terrain producers advance through the same bounded, resumable CPU steps. */
  private pumpCpu(): void {
    const sliceStarted = this.cpuClock();
    const priorFrameMs = this.cpuGenerationMsThisFrame;
    const elapsed = (): number => Math.max(0, this.cpuClock() - sliceStarted);
    const synchronous = this.options.cpuExecution === 'synchronous';
    let remainingStarts = this.jobs.size + 1;
    try {
      // A pause/GC between clock reads cannot starve the first bounded step
      // forever. Any overshoot is included in the measured slice diagnostics.
      while (!this.disposed && (synchronous ||
        (this.cpuGenerationStepsThisFrame < this.options.maxCpuGenerationStepsPerFrame &&
          (this.cpuGenerationStepsThisFrame === 0 ||
            priorFrameMs + elapsed() < this.options.maxCpuGenerationMsPerFrame)))) {
        this.discardStale();
        const active = this.cpuTask;
        if (active && (active.job.canceled || !active.job.callbacks.isCurrent())) this.discard(active.job);
        this.preemptCpuTaskForUrgentWork();
        if (!this.cpuTask) {
          if (remainingStarts <= 0) break;
          const stats = this.stats;
          if (stats.pendingUploads + stats.generating >= this.options.maxUploadsPerFrame) break;
          const job = this.nextQueuedJob(stats.reservedBytes);
          if (!job) break;
          remainingStarts -= 1;
          if (!this.startJob(job)) continue;
          this.cpuTask = this.createCpuTask(job);
        }
        const task = this.cpuTask;
        if (!task) continue;
        const stepStarted = this.cpuClock();
        this.cpuGenerationStepsThisFrame += 1;
        try {
          const next = task.iterator.next();
          if (next.done) {
            this.cpuTask = undefined;
            this.finishCpuTask(task.job, next.value);
          }
        } catch (error) {
          this.fail(task.job, error);
        } finally {
          this.largestCpuStepMs = Math.max(this.largestCpuStepMs, Math.max(0, this.cpuClock() - stepStarted));
        }
      }
    } finally {
      const sliceMs = elapsed();
      this.cpuGenerationMsThisFrame += sliceMs;
      this.largestCpuSliceMs = Math.max(this.largestCpuSliceMs, sliceMs);
    }
  }

  private scheduleImplicitCpuContinuation(): void {
    if (this.disposed || this.explicitlyFramed || this.workers.length > 0 || this.implicitCpuTimer !== undefined) return;
    const stats = this.stats;
    const canStart = stats.pendingUploads + stats.generating < this.options.maxUploadsPerFrame &&
      this.nextQueuedJob(stats.reservedBytes) !== undefined;
    if (!this.cpuTask && !canStart) return;
    this.implicitCpuTimer = setTimeout(() => {
      this.implicitCpuTimer = undefined;
      if (this.disposed || this.explicitlyFramed) return;
      this.implicitFrameActive = false;
      this.pump();
      // Publication remains caller-owned: this continuation only makes the
      // immutable result ready and cannot bypass an atomic commit gate.
    }, IMPLICIT_CPU_FRAME_DELAY_MS);
  }

  /** Dispatch only within the shared in-flight, completion-count, and byte budgets. */
  pump(): void {
    if (this.disposed || this.pumping) return;
    this.ensureImplicitFrame();
    this.pumping = true;
    try {
      this.advanceWorkerWatchdog();
      // At most the initially admitted jobs plus one retry per retiring worker
      // may start in this call. Owner callbacks cannot create an unbounded
      // synchronous generation loop, and failed workers are never respawned.
      let remainingStarts = this.jobs.size + this.workers.length;
      while (!this.disposed && remainingStarts > 0) {
        this.discardStale();
        if (this.workers.length === 0) {
          this.pumpCpu();
          break;
        }
        const worker = this.workers.find((candidate) => !this.activeWorkers.has(candidate));
        if (!worker) break;
        const stats = this.stats;
        if (stats.pendingUploads + stats.generating >= this.options.maxPendingResults) break;
        const job = this.nextQueuedJob(stats.reservedBytes);
        if (!job) break;
        remainingStarts -= 1;
        if (!this.startJob(job)) continue;
        this.activeWorkers.set(worker, job);
        this.workerSilenceMs.set(worker, 0);
        const request = { kind: job.kind, jobId: job.id, ...job.request } as SharedTerrainWorkerRequest;
        try { worker.postMessage(request); }
        catch (error) { this.retireWorker(worker, 'postMessage', error); }
      }
    } finally {
      this.pumping = false;
      this.scheduleImplicitCpuContinuation();
    }
  }

  /** Actual upload/atomic-commit callbacks share one per-frame admission cap. */
  flushUploads(): number {
    if (this.disposed) return 0;
    this.ensureImplicitFrame();
    this.discardStale();
    let consumed = 0;
    const ready = [...this.jobs.values()].filter((job) => job.state === 'ready')
      .sort(compareJobs);
    for (const job of ready) {
      if (this.uploadsThisFrame >= this.options.maxUploadsPerFrame) break;
      // An earlier atomic publication can cancel/replace a later entry in
      // this snapshot (ground publication commonly replaces queued scenery).
      if (this.jobs.get(job.id) !== job) continue;
      if (job.canceled || !job.callbacks.isCurrent()) { this.discard(job); continue; }
      if (job.kind === 'surface-scenery' && this.sceneryPublicationsThisFrame >= 1) continue;
      // A single immutable result cannot be split during scene publication.
      // Admit an oversize result only when it is the first publication in the
      // frame, so a valid atomic result cannot wait forever behind this cap.
      if (this.uploadsThisFrame > 0 &&
        this.publicationBytesThisFrame + job.bytes > this.options.maxPublicationBytesPerFrame) continue;
      let uploaded = false;
      if (job.kind === 'contact' && job.result) uploaded = job.callbacks.upload(job.result);
      else if (job.kind === 'surface-patch' && job.result) uploaded = job.callbacks.upload(job.result);
      else if (job.kind === 'planet-proxy' && job.result) uploaded = job.callbacks.upload(job.result);
      else if (job.kind === 'surface-scenery' && job.result) uploaded = job.callbacks.upload(job.result);
      else if (job.kind === 'terrain' && job.result) uploaded = job.callbacks.upload(job.result);
      if (!uploaded) continue;
      this.jobs.delete(job.id);
      this.uploadsThisFrame += 1;
      this.publicationBytesThisFrame += job.bytes;
      if (job.kind === 'surface-scenery') this.sceneryPublicationsThisFrame += 1;
      this.totalPublicationBytes += job.bytes;
      this.largestPublicationBytes = Math.max(this.largestPublicationBytes, job.bytes);
      if (job.bytes > this.options.maxPublicationBytesPerFrame) this.oversizePublications += 1;
      this.uploaded += 1;
      consumed += 1;
    }
    this.pump();
    return consumed;
  }

  getOwnerStats(owner: string): TerrainJobOwnerStats {
    const stats: TerrainJobOwnerStats = { queued: 0, generating: 0, pendingUploads: 0, pendingBytes: 0 };
    for (const job of this.jobs.values()) {
      if (job.owner !== owner) continue;
      if (job.state === 'queued') stats.queued += 1;
      if (job.state === 'generating') stats.generating += 1;
      if (job.state === 'ready') { stats.pendingUploads += 1; stats.pendingBytes += job.bytes; }
    }
    return stats;
  }

  get stats(): TerrainJobSchedulerStats {
    let queued = 0;
    let generating = 0;
    let pendingUploads = 0;
    let pendingBytes = 0;
    let reservedBytes = 0;
    const empty = (): TerrainJobOwnerStats => ({ queued: 0, generating: 0, pendingUploads: 0, pendingBytes: 0 });
    const byKind: Record<TerrainJobKind, TerrainJobOwnerStats> = {
      terrain: empty(), contact: empty(), 'surface-patch': empty(), 'planet-proxy': empty(), 'surface-scenery': empty(),
    };
    for (const job of this.jobs.values()) {
      const kind = byKind[job.kind];
      if (job.state === 'queued') { queued += 1; kind.queued += 1; }
      if (job.state === 'generating') { generating += 1; kind.generating += 1; reservedBytes += job.reservationBytes; }
      if (job.state === 'ready') {
        pendingUploads += 1; pendingBytes += job.bytes; reservedBytes += job.bytes;
        kind.pendingUploads += 1; kind.pendingBytes += job.bytes;
      }
    }
    return { workers: this.workers.length, maxWorkers: this.options.maxWorkers,
      executionMode: this.workers.length > 0 ? 'workers' : 'cpu',
      cpuExecution: this.options.cpuExecution,
      workerFailures: this.workerFailures, workerTimeouts: this.workerTimeouts, workerRetries: this.workerRetries,
      lastWorkerError: this.lastWorkerError, workerTimeoutMs: this.options.workerTimeoutMs,
      oldestWorkerSilenceMs: Math.max(0, ...this.workerSilenceMs.values()),
      queued, generating,
      pendingUploads, pendingBytes, reservedBytes, maximumPendingBytes: this.options.maxPendingBytes,
      maximumQueued: this.options.maxQueued, maximumBackgroundJobs: this.options.maxQueued - CONTACT_SURFACE_LIMITS.maximumLeases,
      maximumUploadsPerFrame: this.options.maxUploadsPerFrame, uploadsThisFrame: this.uploadsThisFrame,
      publicationBytesThisFrame: this.publicationBytesThisFrame, sceneryPublicationsThisFrame: this.sceneryPublicationsThisFrame,
      maximumPublicationBytesPerFrame: this.options.maxPublicationBytesPerFrame, totalPublicationBytes: this.totalPublicationBytes,
      largestPublicationBytes: this.largestPublicationBytes, oversizePublications: this.oversizePublications,
      cpuGenerationMsThisFrame: this.cpuGenerationMsThisFrame, cpuGenerationStepsThisFrame: this.cpuGenerationStepsThisFrame,
      maximumCpuGenerationMsPerFrame: this.options.maxCpuGenerationMsPerFrame,
      maximumCpuGenerationStepsPerFrame: this.options.maxCpuGenerationStepsPerFrame, largestCpuSliceMs: this.largestCpuSliceMs,
      largestCpuStepMs: this.largestCpuStepMs, cpuPreemptions: this.cpuPreemptions, cpuActiveKind: this.cpuTask?.job.kind ?? null,
      byKind, generated: this.generated, uploaded: this.uploaded, discarded: this.discarded };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.implicitCpuTimer !== undefined) clearTimeout(this.implicitCpuTimer);
    this.implicitCpuTimer = undefined;
    this.closeCpuTask();
    for (const worker of this.workers) this.detachWorker(worker);
    this.workers.length = 0;
    this.activeWorkers.clear();
    this.workerSilenceMs.clear();
    for (const job of [...this.jobs.values()]) this.discard(job);
  }
}
