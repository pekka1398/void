import {
  addVec3,
  crossVec3,
  dotVec3,
  lengthVec3,
  lerpVec3,
  normalizeVec3,
  scaleVec3,
  subVec3,
  type Vec3,
} from '../core/Vec3';
import { createPlanetField, samplePlanetField, type PlanetField, type PlanetFieldInput, type PlanetSurfaceSample } from '../fields';
import {
  CONTACT_SURFACE_LIMITS,
  compareContactLeaseOwnership,
  contactGenerationContains,
  createContactTangentFrame,
  isValidContactGeneration,
  sampleContactGeneration,
  type ContactLease,
  type ContactLeaseRequest,
  type ContactSurfaceGeneration,
} from './ContactGeometry';
import { contactFlowContains, contactSolidContains } from './ContactFeatures';
import { freezeSurfaceFlowRegion, isValidSurfaceFlowRegion, type SurfaceFlowRegion } from './SurfaceFlowField';

export type SurfaceContactKind = 'soil' | 'rock' | 'sand' | 'ice' | 'ocean' | 'river' | 'lava' | 'gas';
export type SurfaceContactHazard = 'none' | 'ocean' | 'river' | 'lava' | 'solid' | 'unready' | 'unlandable';

export interface SurfaceContactQueryOptions {
  leaseId?: string;
  radiusMeters?: number;
  maximumCellMeters?: number;
  /** Camera-only broad-phase queries may use the signed analytic field before a lease exists. */
  requireReady?: boolean;
  includeSolids?: boolean;
}

export interface SurfaceContactSample {
  readonly bodyId: string;
  readonly generationId: string | null;
  readonly ready: boolean;
  readonly pointBodyFixedMeters: Readonly<Vec3>;
  readonly normalBodyFixed: Readonly<Vec3>;
  readonly groundHeightMeters: number;
  readonly groundRadiusMeters: number;
  /** Signed radial clearance of the query point above the actual ground triangle. */
  readonly altitudeMeters: number;
  readonly slopeDegrees: number;
  readonly surfaceKind: SurfaceContactKind;
  readonly hazard: SurfaceContactHazard;
  readonly solidId?: string;
  readonly triangleIndex?: number;
  readonly surface: PlanetSurfaceSample;
}

export interface SurfaceSweepOptions extends SurfaceContactQueryOptions {
  radiusMeters: number;
  /** Total center-to-tip half-height; zero/omitted means a sphere. */
  halfHeightMeters?: number;
  maximumSlopeDegrees?: number;
  /** Rapier already resolves the shared triangles; use false for a hazard/readiness-only sweep. */
  checkGround?: boolean;
  blockHazards?: boolean;
  groundToleranceMeters?: number;
}

export type SurfaceSweepReason = 'clear' | 'terrain' | 'slope' | Exclude<SurfaceContactHazard, 'none'>;

export interface SurfaceSweepResult {
  readonly safeFraction: number;
  readonly positionBodyFixedMeters: Readonly<Vec3>;
  readonly blocked: boolean;
  readonly reason: SurfaceSweepReason;
  readonly contact?: SurfaceContactSample;
}

export interface ContactGenerationReadiness {
  readonly renderGenerationId: string;
  readonly colliderGenerationId: string;
  readonly hazardGenerationId: string;
  readonly opaqueDepth: boolean;
}

export interface ContactLeaseStatus {
  readonly lease: ContactLease;
  readonly generationId: string | null;
  readonly generationToken: number | null;
  readonly ready: boolean;
  readonly current: boolean;
  readonly cellMeters: number | null;
  readonly readiness: ContactGenerationReadiness | null;
}

export interface SurfaceContactAuthorityOptions {
  quality?: 'high' | 'low';
  maximumLeases?: number;
}

interface CommittedContact {
  /** Immutable request that produced these triangles, not a pending replacement's dimensions. */
  lease: ContactLease;
  generation: ContactSurfaceGeneration;
  readiness: ContactGenerationReadiness;
}

const clamp = (value: number, minimum: number, maximum: number): number => Math.max(minimum, Math.min(maximum, value));

function isFiniteVector(value: Readonly<Vec3>): boolean {
  return Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);
}

function kindFor(field: PlanetField, sample: PlanetSurfaceSample): SurfaceContactKind {
  if (!field.landable) return 'gas';
  if (sample.ocean) return 'ocean';
  if (field.archetype === 'frozen' || field.archetype === 'ice-moon') return 'ice';
  if (field.archetype === 'desert' || sample.biome === 'shore') return 'sand';
  if (field.archetype === 'barren' || field.archetype === 'volcanic' || sample.biome === 'mountain') return 'rock';
  return 'soil';
}

function analyticNormal(field: PlanetField, direction: Readonly<Vec3>): Vec3 {
  const frame = createContactTangentFrame(direction, field.radius);
  const distance = 0.5;
  const offset = (axis: Readonly<Vec3>, sign: number): Vec3 => normalizeVec3(addVec3(direction, scaleVec3(axis, sign * distance / field.radius)));
  const dx = samplePlanetField(field, offset(frame.eastBodyFixed, 1)).heightMeters
    - samplePlanetField(field, offset(frame.eastBodyFixed, -1)).heightMeters;
  const dz = samplePlanetField(field, offset(frame.northBodyFixed, 1)).heightMeters
    - samplePlanetField(field, offset(frame.northBodyFixed, -1)).heightMeters;
  return normalizeVec3(addVec3(direction, addVec3(
    scaleVec3(frame.eastBodyFixed, -dx / (distance * 2)),
    scaleVec3(frame.northBodyFixed, -dz / (distance * 2)),
  )));
}

/**
 * Sole owner of physical near-surface readiness and collision generations.
 * It has no scene/camera dependency and never changes a ship or actor pose.
 */
export class SurfaceContactAuthority {
  readonly quality: 'high' | 'low';
  private readonly maximumLeases: number;
  private readonly bodies = new Map<string, PlanetField>();
  private readonly flowRegions = new Map<string, SurfaceFlowRegion>();
  private readonly leases = new Map<string, ContactLease>();
  private readonly committed = new Map<string, CommittedContact>();
  private readonly listeners = new Set<(generation: ContactSurfaceGeneration | null, leaseId: string) => void>();
  private nextLease = 1;
  private nextToken = 1;

  constructor(options: SurfaceContactAuthorityOptions = {}) {
    this.quality = options.quality ?? 'high';
    this.maximumLeases = Math.max(1, Math.min(CONTACT_SURFACE_LIMITS.maximumLeases, options.maximumLeases ?? CONTACT_SURFACE_LIMITS.maximumLeases));
  }

  registerBody(bodyId: string, input: PlanetField | PlanetFieldInput): PlanetField {
    if (!bodyId) throw new RangeError('A contact body needs its actual catalog body ID.');
    const field = 'landable' in input ? input : createPlanetField(input);
    const previous = this.bodies.get(bodyId);
    if (previous && (previous.seed !== field.seed || previous.generatorVersion !== field.generatorVersion || previous.radius !== field.radius)) {
      for (const lease of this.leases.values()) if (lease.bodyId === bodyId) this.releaseLease(lease.id);
      this.flowRegions.delete(bodyId);
    }
    this.bodies.set(bodyId, field);
    return field;
  }

  getField(bodyId: string): PlanetField | null {
    return this.bodies.get(bodyId) ?? null;
  }

  unregisterBody(bodyId: string): void {
    for (const lease of [...this.leases.values()]) if (lease.bodyId === bodyId) this.releaseLease(lease.id);
    this.bodies.delete(bodyId);
    this.flowRegions.delete(bodyId);
  }

  /** Pin the same pure liquid region used by distant presentation while a body has contact leases. */
  setFlowRegion(bodyId: string, region: SurfaceFlowRegion): SurfaceFlowRegion {
    const field = this.bodies.get(bodyId);
    if (!field || !region || field.seed !== region.fieldSeed || field.generatorVersion !== region.fieldVersion ||
      !Number.isFinite(region.bodyRadiusMeters) ||
      Math.abs(field.radius - region.bodyRadiusMeters) > 1e-6) throw new RangeError('Liquid region belongs to another body field.');
    // A committed/pinned region was fully checked at its ownership handoff.
    // Readiness adapters may offer that same immutable object every frame.
    const current = this.flowRegions.get(bodyId);
    if (current === region) return current;
    if (!isValidSurfaceFlowRegion(region, field)) {
      throw new RangeError('Liquid region is not a complete immutable surface-flow result.');
    }
    if (current && [...this.leases.values()].some((lease) => lease.bodyId === bodyId)) return current;
    const immutable = freezeSurfaceFlowRegion(region);
    this.flowRegions.set(bodyId, immutable);
    return immutable;
  }

  getFlowRegion(bodyId: string): SurfaceFlowRegion | null {
    return this.flowRegions.get(bodyId) ?? null;
  }

  /** An abandoned preparation may be forgotten, but a live contact session keeps its exact hazards. */
  clearUnleasedFlowRegion(bodyId: string): boolean {
    if ([...this.leases.values()].some((lease) => lease.bodyId === bodyId)) return false;
    return this.flowRegions.delete(bodyId);
  }

  acquireLease(request: ContactLeaseRequest): ContactLease {
    const field = this.bodies.get(request.bodyId);
    if (!field?.landable) throw new RangeError('Contact leases require a registered landable body.');
    const id = request.id ?? `contact-${request.kind}-${this.nextLease++}`;
    if (this.leases.has(id)) throw new RangeError(`Contact lease already exists: ${id}`);
    if (this.leases.size >= this.maximumLeases) throw new RangeError('The contact lease residency budget is full.');
    const lease = this.makeLease({ ...request, id }, this.nextToken++);
    this.leases.set(id, lease);
    return lease;
  }

  updateLease(
    id: string,
    changes: { centerDirection?: Readonly<Vec3>; radiusMeters?: number; requiredCellMeters?: number },
  ): ContactLease | null {
    const previous = this.leases.get(id);
    if (!previous) return null;
    const next = this.makeLease({ ...previous, ...changes }, previous.token);
    const field = this.bodies.get(previous.bodyId)!;
    const movedMeters = lengthVec3(subVec3(next.centerDirection, previous.centerDirection)) * field.radius;
    const sameDimensions = next.radiusMeters === previous.radiusMeters && next.requiredCellMeters === previous.requiredCellMeters;
    // Keep the current stable patch while the actor remains in its inner safe
    // square; streaming never recenters beneath each individual footstep.
    if (sameDimensions && movedMeters < Math.max(0.001, previous.radiusMeters * 0.34)) return previous;
    const updated = Object.freeze({ ...next, token: this.nextToken++ });
    this.leases.set(id, updated);
    return updated;
  }

  private makeLease(request: ContactLeaseRequest & { id: string }, token: number): ContactLease {
    if (!isFiniteVector(request.centerDirection) || lengthVec3(request.centerDirection) < 1e-9) {
      throw new RangeError('Contact coverage needs a finite nonzero body-fixed direction.');
    }
    const defaults = CONTACT_SURFACE_LIMITS[this.quality];
    const radiusMeters = clamp(request.radiusMeters ?? defaults.radiusMeters,
      CONTACT_SURFACE_LIMITS.minimumRadiusMeters, CONTACT_SURFACE_LIMITS.maximumRadiusMeters);
    const requiredCellMeters = request.requiredCellMeters ?? defaults.cellMeters;
    if (!Number.isFinite(radiusMeters) || !Number.isFinite(requiredCellMeters) || requiredCellMeters <= 0 ||
        Math.ceil(radiusMeters * 2 / requiredCellMeters) > CONTACT_SURFACE_LIMITS.maximumSegments) {
      throw new RangeError('Contact lease resolution exceeds the bounded geometry budget.');
    }
    return Object.freeze({
      id: request.id,
      kind: request.kind,
      bodyId: request.bodyId,
      centerDirection: Object.freeze(normalizeVec3(request.centerDirection)),
      radiusMeters,
      requiredCellMeters,
      token,
    });
  }

  releaseLease(id: string): void {
    const lease = this.leases.get(id);
    const existed = this.leases.delete(id);
    this.committed.delete(id);
    // Clear before notifying listeners: a listener may begin a new contact
    // session, and its newly selected region must not be removed afterwards.
    if (lease) this.clearUnleasedFlowRegion(lease.bodyId);
    if (existed) for (const listener of this.listeners) listener(null, id);
  }

  getLease(id: string): ContactLease | null {
    return this.leases.get(id) ?? null;
  }

  getGeneration(leaseId: string): ContactSurfaceGeneration | null {
    return this.committed.get(leaseId)?.generation ?? null;
  }

  /** Highest ownership first; generic collision and presentation consume this same order. */
  getActiveGenerations(bodyId?: string): readonly ContactSurfaceGeneration[] {
    return [...this.committed.values()]
      .filter((value) => bodyId === undefined || value.generation.bodyId === bodyId)
      .sort((left, right) => compareContactLeaseOwnership(left.lease, right.lease))
      .map((value) => value.generation);
  }

  getPendingLeases(): readonly ContactLease[] {
    return [...this.leases.values()].filter((lease) => this.committed.get(lease.id)?.generation.token !== lease.token);
  }

  get statuses(): readonly ContactLeaseStatus[] {
    return [...this.leases.values()].map((lease) => {
      const value = this.committed.get(lease.id);
      return {
        lease,
        generationId: value?.generation.id ?? null,
        generationToken: value?.generation.token ?? null,
        ready: value !== undefined,
        current: value?.generation.token === lease.token,
        cellMeters: value?.generation.cellMeters ?? null,
        readiness: value?.readiness ?? null,
      };
    });
  }

  onGenerationChanged(listener: (generation: ContactSurfaceGeneration | null, leaseId: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Only a same-token, same-field, complete render/collider/hazard handoff may become authoritative. */
  commitGeneration(generation: ContactSurfaceGeneration, readiness: ContactGenerationReadiness): boolean {
    const lease = this.leases.get(generation.leaseId);
    const field = this.bodies.get(generation.bodyId);
    if (!lease || lease.token !== generation.token || lease.bodyId !== generation.bodyId || !field ||
      field.seed !== generation.fieldSeed || field.generatorVersion !== generation.fieldVersion ||
      Math.abs(field.radius - generation.bodyRadiusMeters) > 1e-6 ||
      generation.cellMeters > lease.requiredCellMeters + 1e-7 || !isValidContactGeneration(generation) || !readiness.opaqueDepth ||
      readiness.renderGenerationId !== generation.id || readiness.colliderGenerationId !== generation.id ||
      readiness.hazardGenerationId !== generation.id) return false;
    this.committed.set(lease.id, { lease, generation, readiness: Object.freeze({ ...readiness }) });
    for (const listener of this.listeners) listener(generation, lease.id);
    return true;
  }

  private generationAt(bodyId: string, position: Readonly<Vec3>, options: SurfaceContactQueryOptions): ContactSurfaceGeneration | null {
    const radius = Math.max(0, options.radiusMeters ?? 0);
    const candidates = options.leaseId
      ? [this.committed.get(options.leaseId)?.generation].filter((generation): generation is ContactSurfaceGeneration => generation !== undefined)
      : this.getActiveGenerations(bodyId);
    for (const generation of candidates) {
      if (generation.bodyId !== bodyId || generation.cellMeters > (options.maximumCellMeters ?? Number.POSITIVE_INFINITY) ||
        !contactGenerationContains(generation, position, radius)) continue;
      return generation;
    }
    return null;
  }

  isReadyAt(bodyId: string, bodyFixedPositionMeters: Readonly<Vec3>, options: SurfaceContactQueryOptions = {}): boolean {
    return this.generationAt(bodyId, bodyFixedPositionMeters, options) !== null;
  }

  sample(bodyId: string, bodyFixedPositionMeters: Readonly<Vec3>, options: SurfaceContactQueryOptions = {}): SurfaceContactSample | null {
    const field = this.bodies.get(bodyId);
    if (!field || !isFiniteVector(bodyFixedPositionMeters) || lengthVec3(bodyFixedPositionMeters) < 1e-9) return null;
    const direction = normalizeVec3(bodyFixedPositionMeters);
    const surface = samplePlanetField(field, direction);
    const generation = this.generationAt(bodyId, bodyFixedPositionMeters, options);
    const triangle = generation ? sampleContactGeneration(generation, direction) : null;
    const ready = triangle !== null;
    const groundRadiusMeters = triangle?.groundRadiusMeters ?? field.radius + surface.heightMeters;
    const pointBodyFixedMeters = triangle?.pointBodyFixedMeters ?? scaleVec3(direction, groundRadiusMeters);
    const normalBodyFixed = triangle?.normalBodyFixed ?? analyticNormal(field, direction);
    let surfaceKind = kindFor(field, surface);
    let hazard: SurfaceContactHazard = !field.landable ? 'unlandable' : surface.ocean ? 'ocean' : 'none';
    let solidId: string | undefined;
    const margin = Math.max(0, options.radiusMeters ?? 0);
    if (generation && hazard === 'none') {
      const flow = generation.flows.find((candidate) => contactFlowContains(field.radius, candidate, direction, margin));
      if (flow) {
        surfaceKind = flow.kind;
        hazard = flow.kind;
      } else if (options.includeSolids !== false) {
        const solid = generation.solids.find((candidate) => contactSolidContains(candidate, pointBodyFixedMeters, margin, 0.035));
        if (solid) {
          hazard = 'solid';
          solidId = solid.id;
        }
      }
    }
    if (hazard === 'none' && !ready && options.requireReady !== false) hazard = 'unready';
    return {
      bodyId,
      generationId: ready ? generation!.id : null,
      ready,
      pointBodyFixedMeters,
      normalBodyFixed,
      groundHeightMeters: groundRadiusMeters - field.radius,
      groundRadiusMeters,
      altitudeMeters: lengthVec3(bodyFixedPositionMeters) - groundRadiusMeters,
      slopeDegrees: Math.acos(clamp(dotVec3(normalBodyFixed, direction), -1, 1)) * 180 / Math.PI,
      surfaceKind,
      hazard,
      ...(solidId ? { solidId } : {}),
      ...(triangle ? { triangleIndex: triangle.triangleIndex } : {}),
      surface,
    };
  }

  sweepCapsule(bodyId: string, from: Readonly<Vec3>, to: Readonly<Vec3>, options: SurfaceSweepOptions): SurfaceSweepResult {
    const field = this.bodies.get(bodyId);
    if (!field || !isFiniteVector(from) || !isFiniteVector(to)) {
      return { safeFraction: 0, positionBodyFixedMeters: { ...from }, blocked: true, reason: 'unready' };
    }
    const radius = Math.max(0, options.radiusMeters);
    const halfHeight = Math.max(radius, options.halfHeightMeters ?? radius);
    const tolerance = Math.max(0, options.groundToleranceMeters ?? 0.035);
    const queryOptions: SurfaceContactQueryOptions = { ...options, radiusMeters: radius, includeSolids: false };
    const at = (position: Readonly<Vec3>): { reason: SurfaceSweepReason; contact?: SurfaceContactSample } => {
      const sample = this.sample(bodyId, position, queryOptions);
      if (!sample) return { reason: 'unready' };
      if (!sample.ready && options.requireReady !== false) return { reason: 'unready', contact: sample };
      if (sample.hazard === 'unlandable') return { reason: 'unlandable', contact: sample };
      if (options.blockHazards !== false && sample.hazard !== 'none' && sample.hazard !== 'unready') {
        return { reason: sample.hazard, contact: sample };
      }
      if (sample.slopeDegrees > (options.maximumSlopeDegrees ?? 90)) return { reason: 'slope', contact: sample };
      if (options.checkGround !== false && sample.altitudeMeters < halfHeight - tolerance) {
        return { reason: 'terrain', contact: sample };
      }
      const generation = this.generationAt(bodyId, position, queryOptions);
      const solid = options.includeSolids === false ? undefined
        : generation?.solids.find((candidate) => contactSolidContains(candidate, position, radius, halfHeight));
      if (solid) return { reason: 'solid', contact: { ...sample, hazard: 'solid', solidId: solid.id } };
      return { reason: 'clear', contact: sample };
    };
    const distance = lengthVec3(subVec3(to, from));
    const steps = Math.max(1, Math.min(2_048, Math.ceil(distance / Math.max(0.12, radius * 0.6))));
    let previousFraction = 0;
    const initial = at(from);
    if (initial.reason !== 'clear') return {
      safeFraction: 0, positionBodyFixedMeters: { ...from }, blocked: true, reason: initial.reason, contact: initial.contact,
    };
    for (let step = 1; step <= steps; step += 1) {
      const fraction = step / steps;
      const result = at(lerpVec3(from, to, fraction));
      if (result.reason === 'clear') {
        previousFraction = fraction;
        continue;
      }
      let safe = previousFraction;
      let blocked = fraction;
      let contact = result.contact;
      for (let iteration = 0; iteration < 10; iteration += 1) {
        const middle = (safe + blocked) * 0.5;
        const middleResult = at(lerpVec3(from, to, middle));
        if (middleResult.reason === 'clear') safe = middle;
        else {
          blocked = middle;
          contact = middleResult.contact ?? contact;
        }
      }
      return { safeFraction: safe, positionBodyFixedMeters: lerpVec3(from, to, safe), blocked: true, reason: result.reason, ...(contact ? { contact } : {}) };
    }
    return { safeFraction: 1, positionBodyFixedMeters: { ...to }, blocked: false, reason: 'clear' };
  }

  dispose(): void {
    for (const id of [...this.leases.keys()]) this.releaseLease(id);
    this.listeners.clear();
    this.bodies.clear();
    this.flowRegions.clear();
  }
}

export type { ContactLease, ContactLeaseRequest, ContactSurfaceGeneration } from './ContactGeometry';
