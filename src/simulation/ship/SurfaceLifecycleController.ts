import {
  addAddressOffset,
  addVec3,
  crossVec3,
  dotVec3,
  lengthVec3,
  lerpVec3,
  normalizeVec3,
  rotateAroundYAxis,
  scaleVec3,
  serializeAddress,
  subVec3,
  subtractAddresses,
  vec3,
  type Vec3,
} from '../../core';
import { CONTRAST_SYSTEM_ID, sampleAtmosphereDensity, type UniverseCatalog } from '../../universe';
import { createPlanetField, samplePlanetField } from '../../fields';
import type { ContactLease, ContactSolidDescriptor } from '../../terrain/ContactGeometry';
import type {
  SurfaceContactAuthority,
  SurfaceContactKind,
  SurfaceContactSample,
} from '../../terrain/SurfaceContactAuthority';
import { headingToTarget } from '../navigation/InterceptSolver';
import { FlightController } from './FlightController';
import { isFasterThanLight, moveToward } from './FlightModes';
import type {
  BodyFixedLandingAnchor,
  ParkedShipAnchor,
  SerializedFlightState,
  SurfacePadContact,
  SurfacePhase,
} from './ShipState';

/** A structural subset of the separately validated, renderer-independent kit manifest. */
export interface SurfaceLandingKit {
  readonly surfaceKitVersion: number;
  readonly physicalBoundsMeters: { readonly min: Readonly<Vec3>; readonly max: Readonly<Vec3> };
  readonly landingPadsMeters: readonly {
    readonly id: string;
    readonly positionMeters: Readonly<Vec3>;
    readonly radiusMeters: number;
  }[];
  readonly collisionProxyMeters: readonly {
    readonly id: string;
    readonly centerMeters: Readonly<Vec3>;
    readonly halfExtentsMeters: Readonly<Vec3>;
    readonly kind: 'pressure-body' | 'canopy' | 'wing' | 'engine' | 'fin' | 'gear';
  }[];
  readonly minimumBellyClearanceMeters: number;
  readonly maximumLandingSlopeDegrees: number;
  readonly maximumPadHeightSpreadMeters: number;
}

export type SurfaceContactSource = Pick<SurfaceContactAuthority,
  'acquireLease' | 'updateLease' | 'releaseLease' | 'getLease' | 'getGeneration' | 'sample' | 'sweepCapsule'>;

export type SurfaceTravelIntent =
  | { readonly kind: 'approach'; readonly targetId?: string }
  | { readonly kind: 'pulse' }
  | { readonly kind: 'hyperdrive'; readonly systemId?: string };

export interface SurfaceCommandResult {
  readonly accepted: boolean;
  readonly reason: string;
}

export type SurfaceStableCheckpoint =
  | { readonly kind: 'airborne'; readonly flight: SerializedFlightState }
  | { readonly kind: 'parked'; readonly flight: SerializedFlightState; readonly anchor: ParkedShipAnchor };

export interface SurfaceLifecycleSnapshot {
  readonly surfacePhase: SurfacePhase;
  readonly phaseProgress: number;
  readonly eventSerial: number;
  readonly bodyId?: string;
  readonly bodyFixedOriginMeters?: Readonly<Vec3>;
  readonly bodyFixedForward?: Readonly<Vec3>;
  readonly contactPointsBodyFixedMeters: readonly Readonly<Vec3>[];
  readonly contactNormalBodyFixed: Readonly<Vec3>;
  readonly contactGenerationId?: string;
  readonly contactReady: boolean;
  readonly contactSafe: boolean;
  /** Minimum actual deployed-pad clearance, not altitude above a reference sphere. */
  readonly clearanceMeters: number;
  readonly horizontalSpeedMetersPerSecond: number;
  readonly verticalSpeedMetersPerSecond: number;
  readonly relativeVelocityBodyFixedMetersPerSecond: Readonly<Vec3>;
  readonly surfaceThrust: number;
  readonly gearProgress: number;
  readonly touchdownImpulseMetersPerSecond: number;
  readonly surfaceKind: SurfaceContactKind;
  readonly atmosphereDensity: number;
  readonly anchorCommitted: boolean;
  readonly queuedTravel?: SurfaceTravelIntent;
  readonly lastReason: string;
}

export interface SurfaceLifecycleOptions {
  flight: FlightController;
  catalog: UniverseCatalog;
  contact: SurfaceContactSource;
  /** Missing / invalid metadata disables contact; it never invents landing feet. */
  kit?: SurfaceLandingKit | null;
  canDepart?: () => boolean;
}

export interface LandingFootprintAssessment {
  readonly safe: boolean;
  readonly ready: boolean;
  readonly reason: string;
  readonly bodyFixedOriginMeters: Vec3;
  readonly bodyFixedForward: Vec3;
  readonly supportNormalBodyFixed: Vec3;
  readonly padContacts: SurfacePadContact[];
  readonly clearanceMeters: number;
  readonly minimumBellyClearanceMeters: number;
  readonly padHeightSpreadMeters: number;
  readonly slopeDegrees: number;
  readonly surfaceKind: SurfaceContactKind;
  readonly generationId?: string;
}

interface SurfaceMotion {
  bodyId: string;
  origin: Vec3;
  forward: Vec3;
  up: Vec3;
  velocity: Vec3;
}

interface SafeAirborneFrame {
  bodyId: string;
  origin: Vec3;
  forward: Vec3;
  velocity: Vec3;
  state: SerializedFlightState;
}

const LANDING_MAXIMUM_ALTITUDE_METERS = 320;
const LANDING_MAXIMUM_HORIZONTAL_SPEED = 36;
const LANDING_MAXIMUM_VERTICAL_SPEED = 20;
const LANDING_BRAKING_ACCELERATION = 32;
const LANDING_ARM_SECONDS = 1.05;
const LANDING_SETTLE_SECONDS = 0.85;
const TAKEOFF_SPOOL_SECONDS = 1.15;
const TAKEOFF_RELEASE_CLEARANCE_METERS = 28;
const TAKEOFF_HANDOFF_CLEARANCE_METERS = 145;
const CONTACT_MARGIN_METERS = 0.008;
const CONTACT_TOLERANCE_METERS = 0.025;
const MAXIMUM_SURFACE_STEP_SECONDS = 1 / 60;
const WORLD_UP = Object.freeze(vec3(0, 1, 0));
const HULL_PROBE_CACHE = new WeakMap<SurfaceLandingKit, readonly Vec3[]>();

const clamp = (value: number, minimum: number, maximum: number): number => Math.max(minimum, Math.min(maximum, value));
const accepted = (reason: string): SurfaceCommandResult => ({ accepted: true, reason });
const rejected = (reason: string): SurfaceCommandResult => ({ accepted: false, reason });

function finiteVector(value: Readonly<Vec3> | undefined): value is Readonly<Vec3> {
  return Boolean(value && Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z));
}

function validKit(kit: SurfaceLandingKit | null | undefined): kit is SurfaceLandingKit {
  return Boolean(kit && Number.isInteger(kit.surfaceKitVersion) && kit.surfaceKitVersion > 0 &&
    finiteVector(kit.physicalBoundsMeters?.min) && finiteVector(kit.physicalBoundsMeters?.max) &&
    kit.landingPadsMeters?.length >= 3 && new Set(kit.landingPadsMeters.map((pad) => pad.id)).size === kit.landingPadsMeters.length &&
    kit.landingPadsMeters.every((pad) => Boolean(pad.id) && finiteVector(pad.positionMeters) && pad.radiusMeters > 0 && Number.isFinite(pad.radiusMeters)) &&
    kit.collisionProxyMeters?.some((proxy) => proxy.kind !== 'gear') &&
    kit.collisionProxyMeters.every((proxy) => finiteVector(proxy.centerMeters) && finiteVector(proxy.halfExtentsMeters) &&
      proxy.halfExtentsMeters.x > 0 && proxy.halfExtentsMeters.y > 0 && proxy.halfExtentsMeters.z > 0) &&
    Number.isFinite(kit.minimumBellyClearanceMeters) && kit.minimumBellyClearanceMeters >= 0 &&
    Number.isFinite(kit.maximumLandingSlopeDegrees) && kit.maximumLandingSlopeDegrees > 0 && kit.maximumLandingSlopeDegrees < 60 &&
    Number.isFinite(kit.maximumPadHeightSpreadMeters) && kit.maximumPadHeightSpreadMeters >= 0);
}

function tangentForward(forward: Readonly<Vec3>, up: Readonly<Vec3>): Vec3 {
  const projected = subVec3(forward, scaleVec3(up, dotVec3(forward, up)));
  if (lengthVec3(projected) > 1e-7) return normalizeVec3(projected);
  const reference = Math.abs(up.y) < 0.92 ? WORLD_UP : vec3(1, 0, 0);
  return normalizeVec3(crossVec3(reference, up));
}

/** The approved glTF uses +X starboard, +Y up, and -Z toward the bow. */
export function shipLocalToBodyFixedOffset(
  localMeters: Readonly<Vec3>,
  forward: Readonly<Vec3>,
  up: Readonly<Vec3>,
): Vec3 {
  const normalizedUp = normalizeVec3(up);
  const normalizedForward = tangentForward(forward, normalizedUp);
  const right = normalizeVec3(crossVec3(normalizedForward, normalizedUp));
  return addVec3(scaleVec3(right, localMeters.x), addVec3(
    scaleVec3(normalizedUp, localMeters.y),
    scaleVec3(normalizedForward, -localMeters.z),
  ));
}

function cloneAnchor(anchor: ParkedShipAnchor): ParkedShipAnchor {
  return {
    bodyId: anchor.bodyId,
    bodyFixedOriginMeters: { ...anchor.bodyFixedOriginMeters },
    bodyFixedForward: { ...anchor.bodyFixedForward },
    supportNormalBodyFixed: { ...anchor.supportNormalBodyFixed },
    padContacts: anchor.padContacts.map((pad) => ({
      ...pad,
      bodyFixedPointMeters: { ...pad.bodyFixedPointMeters },
      bodyFixedNormal: { ...pad.bodyFixedNormal },
    })),
    surfaceKitVersion: anchor.surfaceKitVersion,
  };
}

function cloneFlightState(state: SerializedFlightState): SerializedFlightState {
  return {
    ...state,
    position: { cell: [...state.position.cell], localMeters: { ...state.position.localMeters } },
    velocity: { ...state.velocity },
    ...(state.landedAnchor ? { landedAnchor: {
      ...state.landedAnchor,
      surfaceDirection: { ...state.landedAnchor.surfaceDirection },
    } } : {}),
  };
}

function padLocalProbes(pad: SurfaceLandingKit['landingPadsMeters'][number]): Vec3[] {
  const { x, y, z } = pad.positionMeters;
  const radius = pad.radiusMeters;
  return [vec3(x, y, z), vec3(x - radius, y, z), vec3(x + radius, y, z),
    vec3(x, y, z - radius), vec3(x, y, z + radius)];
}

function hullLocalProbes(kit: SurfaceLandingKit): readonly Vec3[] {
  const cached = HULL_PROBE_CACHE.get(kit);
  if (cached) return cached;
  const probes: Vec3[] = [];
  const seen = new Set<string>();
  for (const proxy of kit.collisionProxyMeters) {
    if (proxy.kind === 'gear' || proxy.kind === 'canopy' || proxy.kind === 'fin') continue;
    const c = proxy.centerMeters;
    const h = proxy.halfExtentsMeters;
    for (const [x, z] of [[0, 0], [-h.x, -h.z], [h.x, -h.z], [-h.x, h.z], [h.x, h.z]]) {
      const point = vec3(c.x + x!, c.y - h.y, c.z + z!);
      const key = `${point.x.toFixed(4)}:${point.y.toFixed(4)}:${point.z.toFixed(4)}`;
      if (!seen.has(key)) { seen.add(key); probes.push(point); }
    }
  }
  HULL_PROBE_CACHE.set(kit, probes);
  return probes;
}

function hazardReason(sample: SurfaceContactSample | null): string | undefined {
  if (!sample) return 'terrain-unavailable';
  if (sample.hazard === 'ocean' || sample.surfaceKind === 'ocean') return 'water';
  if (sample.hazard === 'river' || sample.surfaceKind === 'river') return 'water';
  if (sample.hazard === 'lava' || sample.surfaceKind === 'lava') return 'hazard';
  if (sample.hazard === 'solid') return 'solid-obstacle';
  if (sample.hazard === 'unlandable' || sample.surfaceKind === 'gas') return 'unlandable';
  return undefined;
}

/** Admission measures an ocean from its real mean sea surface, never its seabed. */
export function landingAdmissionClearanceMeters(
  origin: Readonly<Vec3>,
  bodyRadiusMeters: number,
  sample: SurfaceContactSample | null,
): number {
  if (sample && (sample.surface.ocean || sample.surfaceKind === 'ocean' || sample.hazard === 'ocean')) {
    // The shared envelope is the mean sea radius for known oceans. Dry
    // desert/volcanic depressions still use their actual signed ground below.
    return lengthVec3(origin) - sample.surface.radialMeters;
  }
  return sample?.altitudeMeters ?? lengthVec3(origin) - bodyRadiusMeters;
}

function planeNormal(points: readonly Readonly<Vec3>[], fallback: Readonly<Vec3>): Vec3 {
  if (points.length < 3) return normalizeVec3(fallback);
  let normal = vec3();
  for (let index = 1; index + 1 < points.length; index += 1) {
    normal = addVec3(normal, crossVec3(subVec3(points[index]!, points[0]!), subVec3(points[index + 1]!, points[0]!)));
  }
  if (lengthVec3(normal) < 1e-7) return normalizeVec3(fallback);
  normal = normalizeVec3(normal);
  return dotVec3(normal, fallback) < 0 ? scaleVec3(normal, -1) : normal;
}

/** Solve the authored feet against one immutable committed contact generation. */
export function assessLandingFootprint(options: {
  bodyId: string;
  bodyFixedOriginMeters: Readonly<Vec3>;
  bodyFixedForward: Readonly<Vec3>;
  contact: Pick<SurfaceContactSource, 'sample' | 'getGeneration'>;
  kit: SurfaceLandingKit;
  leaseId?: string;
  requireReady?: boolean;
}): LandingFootprintAssessment {
  const { bodyId, contact, kit, leaseId } = options;
  const radial = normalizeVec3(options.bodyFixedOriginMeters);
  let up = { ...radial };
  let forward = tangentForward(options.bodyFixedForward, up);
  let origin = { ...options.bodyFixedOriginMeters };
  let ready = true;
  let reason: string | undefined;
  let generationId: string | undefined;
  let surfaceKind: SurfaceContactKind = 'rock';
  let centers: SurfaceContactSample[] = [];
  const query = (position: Readonly<Vec3>, radiusMeters = 0, includeSolids = true) => {
    const sample = contact.sample(bodyId, position, {
      ...(leaseId ? { leaseId } : {}), radiusMeters, requireReady: options.requireReady ?? true, includeSolids,
    });
    if (!sample?.ready) ready = false;
    if (sample?.generationId) {
      if (generationId && generationId !== sample.generationId) { ready = false; reason ??= 'terrain-loading'; }
      generationId ??= sample.generationId;
    }
    reason ??= hazardReason(sample);
    if (sample) surfaceKind = sample.surfaceKind;
    return sample;
  };

  // Refit after rotating the feet into their actual support plane. This avoids
  // treating a perfectly planar 20-degree slope as several meters of bad gear
  // spread, and keeps the physical bow heading tangent to that same plane.
  for (let iteration = 0; iteration < 3; iteration += 1) {
    centers = [];
    const origins: Vec3[] = [];
    for (const pad of kit.landingPadsMeters) {
      const offset = shipLocalToBodyFixedOffset(pad.positionMeters, forward, up);
      const sample = query(addVec3(origin, offset), pad.radiusMeters);
      if (!sample) continue;
      centers.push(sample);
      origins.push(subVec3(sample.pointBodyFixedMeters, offset));
    }
    if (centers.length !== kit.landingPadsMeters.length) break;
    up = planeNormal(centers.map((sample) => sample.pointBodyFixedMeters), radial);
    forward = tangentForward(options.bodyFixedForward, up);
    origin = scaleVec3(origins.reduce(addVec3, vec3()), 1 / origins.length);
  }

  let requiredLift = 0;
  let minimumGap = Number.POSITIVE_INFINITY;
  let maximumGap = Number.NEGATIVE_INFINITY;
  const finalCenters: { pad: SurfaceLandingKit['landingPadsMeters'][number]; sample: SurfaceContactSample; offset: Vec3 }[] = [];
  for (const pad of kit.landingPadsMeters) {
    const offset = shipLocalToBodyFixedOffset(pad.positionMeters, forward, up);
    const sample = query(addVec3(origin, offset), pad.radiusMeters);
    if (!sample) continue;
    const gap = dotVec3(subVec3(addVec3(origin, offset), sample.pointBodyFixedMeters), up);
    minimumGap = Math.min(minimumGap, gap);
    maximumGap = Math.max(maximumGap, gap);
    requiredLift = Math.max(requiredLift, CONTACT_MARGIN_METERS - gap);
    finalCenters.push({ pad, sample, offset });
    // A foot's actual disk cannot straddle a narrow river, lava strip, or rock.
    for (const probe of padLocalProbes(pad).slice(1)) {
      const point = addVec3(origin, shipLocalToBodyFixedOffset(probe, forward, up));
      const rim = query(point);
      if (rim && rim.slopeDegrees > kit.maximumLandingSlopeDegrees + 0.2) reason ??= 'slope';
    }
  }
  origin = addVec3(origin, scaleVec3(up, requiredLift));
  const spread = Number.isFinite(minimumGap) ? Math.max(0, maximumGap - minimumGap) : Number.POSITIVE_INFINITY;
  const slope = Math.acos(clamp(dotVec3(up, radial), -1, 1)) * 180 / Math.PI;
  if (slope > kit.maximumLandingSlopeDegrees) reason ??= 'slope';
  if (spread > kit.maximumPadHeightSpreadMeters) reason ??= 'pad-height-spread';

  let minimumBellyClearance = Number.POSITIVE_INFINITY;
  for (const probe of hullLocalProbes(kit)) {
    const point = addVec3(origin, shipLocalToBodyFixedOffset(probe, forward, up));
    const sample = query(point, 0, false);
    if (!sample) continue;
    minimumBellyClearance = Math.min(minimumBellyClearance,
      dotVec3(subVec3(point, sample.pointBodyFixedMeters), sample.normalBodyFixed));
  }
  if (minimumBellyClearance < kit.minimumBellyClearanceMeters - 0.065) reason ??= 'belly-clearance';
  if (leaseId) {
    const generation = contact.getGeneration(leaseId);
    if (generation && shipIntersectsContactSolids(kit, origin, forward, up, generation.solids)) reason ??= 'solid-obstacle';
  }
  if (!ready && options.requireReady !== false) reason ??= 'terrain-loading';
  if (finalCenters.length !== kit.landingPadsMeters.length) reason ??= 'terrain-unavailable';

  let currentClearance = Number.POSITIVE_INFINITY;
  for (const { pad } of finalCenters) {
    const point = addVec3(options.bodyFixedOriginMeters, shipLocalToBodyFixedOffset(pad.positionMeters, forward, up));
    const sample = contact.sample(bodyId, point, { ...(leaseId ? { leaseId } : {}), requireReady: false, includeSolids: false });
    if (sample) currentClearance = Math.min(currentClearance,
      dotVec3(subVec3(point, sample.pointBodyFixedMeters), up));
  }
  return {
    safe: reason === undefined,
    ready,
    reason: reason ?? 'safe',
    bodyFixedOriginMeters: origin,
    bodyFixedForward: forward,
    supportNormalBodyFixed: up,
    padContacts: finalCenters.map(({ pad, sample, offset }) => ({
      padId: pad.id,
      bodyFixedPointMeters: { ...sample.pointBodyFixedMeters },
      bodyFixedNormal: { ...sample.normalBodyFixed },
      compressionMeters: clamp(maximumGap - dotVec3(subVec3(addVec3(origin, offset), sample.pointBodyFixedMeters), up),
        0, kit.maximumPadHeightSpreadMeters),
    })),
    clearanceMeters: Number.isFinite(currentClearance) ? currentClearance : 0,
    minimumBellyClearanceMeters: minimumBellyClearance,
    padHeightSpreadMeters: spread,
    slopeDegrees: slope,
    surfaceKind,
    ...(generationId ? { generationId } : {}),
  };
}

/**
 * Sole near-ground motion owner. The return value of update says whether this
 * controller consumed the complete fixed step; normal FlightController.update
 * must run only when it returns false.
 */
export class SurfaceLifecycleController {
  private readonly flight: FlightController;
  private readonly catalog: UniverseCatalog;
  private readonly contact: SurfaceContactSource;
  private readonly kit?: SurfaceLandingKit;
  private readonly canDepart: () => boolean;
  private currentPhase: SurfacePhase = 'airborne';
  private motion?: SurfaceMotion;
  private lease?: ContactLease;
  private footprint?: LandingFootprintAssessment;
  private targetAnchor?: ParkedShipAnchor;
  private takeoffBaseAnchor?: ParkedShipAnchor;
  private restoredAnchorCandidate?: ParkedShipAnchor;
  private safeAirborne?: SafeAirborneFrame;
  private pendingTravel?: SurfaceTravelIntent;
  private lastEpoch: number;
  private elapsed = 0;
  private gear = 0;
  private thrust = 0;
  private event = 0;
  private touchdownImpulse = 0;
  private reason = 'airborne';
  private releaseCommitted = false;
  private assessmentCache?: {
    origin: Vec3;
    forward: Vec3;
    generationId?: string;
    requireReady: boolean;
    value: LandingFootprintAssessment;
  };

  constructor(options: SurfaceLifecycleOptions) {
    this.flight = options.flight;
    this.catalog = options.catalog;
    this.contact = options.contact;
    this.kit = validKit(options.kit) ? options.kit : undefined;
    this.canDepart = options.canDepart ?? (() => true);
    this.lastEpoch = options.flight.simulationEpochSeconds;
  }

  get phase(): SurfacePhase { return this.currentPhase; }
  get ownsFlightMotion(): boolean { return this.currentPhase !== 'airborne'; }
  get parkedAnchor(): ParkedShipAnchor | undefined {
    return this.flight.state.parkedAnchor ? cloneAnchor(this.flight.state.parkedAnchor) : undefined;
  }

  isParkedAndSettled(): boolean {
    return this.currentPhase === 'parked' && Boolean(this.flight.state.parkedAnchor && this.footprint?.ready && this.footprint.safe);
  }

  /** Async mesh/collider readiness can change while the launch clocks are paused. */
  refreshContactReadiness(): void {
    if (!this.motion || !this.kit || !this.lease) return;
    const assessment = this.assess(true, true);
    if (!assessment) return;
    const parked = this.flight.state.parkedAnchor;
    const seatingError = parked ? lengthVec3(subVec3(assessment.bodyFixedOriginMeters, parked.bodyFixedOriginMeters)) : 0;
    this.footprint = parked && assessment.ready && seatingError > 0.12
      ? { ...assessment, safe: false, reason: 'surface-anchor-mismatch' }
      : assessment;
    if (!assessment.ready) this.reason = 'terrain-loading';
    else if (!this.footprint.safe) this.reason = this.footprint.reason;
    else if (this.currentPhase === 'parked') this.reason = 'parked';
  }

  /**
   * Explicit save-recovery boundary. A valid dry replacement is reseated by
   * the ordinary flare; a buried or unsafe saved pose is first recovered to a
   * genuinely clear airborne point. This is never used by normal landing.
   */
  recoverParkedContact(): SurfaceCommandResult {
    if (!this.canDepart()) return rejected('board-aurora-to-depart');
    if (this.currentPhase !== 'parked' || !this.motion || !this.kit || !this.flight.state.parkedAnchor) {
      return rejected('not-parked');
    }
    const assessment = this.assess(true);
    if (!assessment?.ready) return rejected('terrain-loading');
    const body = this.catalog.getPlanet(this.motion.bodyId);
    const sample = this.contact.sample(this.motion.bodyId, this.motion.origin, {
      ...(this.lease ? { leaseId: this.lease.id } : {}), requireReady: false, includeSolids: false,
    });
    if (!body || !sample) return rejected('terrain-unavailable');
    this.pendingTravel = undefined;
    const radial = normalizeVec3(this.motion.origin);
    const safeOrigin = scaleVec3(radial, Math.max(body.radiusMeters, sample.groundRadiusMeters) +
      TAKEOFF_HANDOFF_CLEARANCE_METERS + Math.max(...this.kit.landingPadsMeters.map((pad) => -pad.positionMeters.y)));
    const safeMotion: SurfaceMotion = {
      ...this.motion, origin: safeOrigin, forward: tangentForward(this.motion.forward, radial), up: radial, velocity: vec3(),
    };
    this.safeAirborne = this.captureSafeAirborne(safeMotion);
    this.flight.releaseParkedAnchor();
    this.footprint = assessment;
    this.targetAnchor = assessment.safe ? this.anchorFromFootprint() : undefined;
    this.releaseCommitted = false;
    this.motion.velocity = vec3();
    const buried = this.measureClearance(this.motion) < -CONTACT_TOLERANCE_METERS ||
      this.sweepMotion(this.motion, this.motion.origin, this.motion.forward, this.motion.up, true).blocked;
    if (!assessment.safe || buried) {
      // A corrupted/obsolete save can begin inside solid geometry. No sweep
      // can exit a starting penetration; this named recovery is the only
      // deliberate reposition, and it uses the real signed terrain/radius.
      this.motion = safeMotion;
      this.flight.applySurfacePose({
        bodyId: safeMotion.bodyId, bodyFixedOriginMeters: safeMotion.origin,
        bodyFixedForward: safeMotion.forward, supportNormalBodyFixed: safeMotion.up,
        bodyFixedVelocityMetersPerSecond: vec3(),
      }, this.lastEpoch, { restoring: true });
    }
    if (!assessment.safe) {
      this.finishAirborne('recovered-airborne');
      return accepted('recovered-airborne');
    }
    this.flight.beginSurfaceControl('flare');
    this.setPhase('flare', 'reseating-surface-contact');
    return accepted('reseating-surface-contact');
  }

  /**
   * Explicit restore/failure recovery, never a normal flight command. The
   * coordinator returns occupancy inside before calling this if necessary.
   * Even an unready/failed contact worker cannot strand a saved ship: the
   * registered signed analytic ground remains available independently.
   */
  recoverToSafeAirborne(reason = 'surface-contact-recovery'): SurfaceCommandResult {
    const legacy = this.flight.state.landedAnchor;
    const rich = this.flight.state.parkedAnchor ?? this.restoredAnchorCandidate;
    const bodyId = this.motion?.bodyId ?? rich?.bodyId ?? legacy?.bodyId ?? this.flight.state.nearestBodyId;
    const body = bodyId ? this.catalog.getPlanet(bodyId) : undefined;
    const epoch = this.flight.simulationEpochSeconds;
    const pose = bodyId ? this.catalog.getBodyPose(bodyId, epoch) : undefined;
    if (!body?.isLandable || !pose || body.systemId !== this.flight.state.systemId) return rejected('terrain-unavailable');
    const currentFixed = rotateAroundYAxis(subtractAddresses(this.flight.state.address, pose.position), -pose.rotationRadians);
    const source = this.motion?.bodyId === body.id ? this.motion.origin
      : rich?.bodyId === body.id && finiteVector(rich.bodyFixedOriginMeters) ? rich.bodyFixedOriginMeters
        : legacy?.bodyId === body.id && finiteVector(legacy.surfaceDirection) ? legacy.surfaceDirection
          : currentFixed;
    const radial = normalizeVec3(source);
    if (!finiteVector(radial) || lengthVec3(radial) < 0.5) return rejected('invalid-surface-anchor');
    const registered = this.contact.sample(body.id, scaleVec3(radial, body.radiusMeters), {
      requireReady: false, includeSolids: false,
    });
    const groundRadius = registered?.groundRadiusMeters ?? body.radiusMeters +
      samplePlanetField(createPlanetField(body), radial).heightMeters;
    if (!Number.isFinite(groundRadius)) return rejected('terrain-unavailable');
    const originalHeading = {
      forward: { ...this.flight.state.forward }, yaw: this.flight.state.yaw,
      pitch: this.flight.state.pitch, roll: this.flight.state.roll,
    };
    const origin = scaleVec3(radial, Math.max(body.radiusMeters, groundRadius) +
      TAKEOFF_HANDOFF_CLEARANCE_METERS + 5);
    const applied = this.flight.applySurfacePose({
      bodyId: body.id, bodyFixedOriginMeters: origin,
      bodyFixedForward: rotateAroundYAxis(originalHeading.forward, -pose.rotationRadians),
      supportNormalBodyFixed: radial, bodyFixedVelocityMetersPerSecond: vec3(),
    }, epoch, { restoring: true });
    if (!applied) return rejected('terrain-unavailable');
    this.lastEpoch = epoch;
    this.pendingTravel = undefined;
    this.finishAirborne(reason);
    // Preserve the actual saved heading exactly, including wrapped yaw and
    // a legitimate pitched view. Recovery changes position, not pilot intent.
    this.flight.state.forward = originalHeading.forward;
    this.flight.state.yaw = originalHeading.yaw;
    this.flight.state.pitch = originalHeading.pitch;
    this.flight.state.roll = originalHeading.roll;
    return accepted(reason);
  }

  get snapshot(): SurfaceLifecycleSnapshot {
    const motion = this.motion;
    const normal = this.footprint?.supportNormalBodyFixed ?? motion?.up ?? WORLD_UP;
    const velocity = motion?.velocity ?? vec3();
    const vertical = dotVec3(velocity, normal);
    const horizontal = lengthVec3(subVec3(velocity, scaleVec3(normal, vertical)));
    const body = motion ? this.catalog.getPlanet(motion.bodyId) : undefined;
    const clearance = motion && this.kit ? this.measureClearance(motion) : Number.POSITIVE_INFINITY;
    return {
      surfacePhase: this.currentPhase,
      phaseProgress: this.phaseProgress(clearance),
      eventSerial: this.event,
      ...(motion ? { bodyId: motion.bodyId, bodyFixedOriginMeters: { ...motion.origin }, bodyFixedForward: { ...motion.forward } } : {}),
      contactPointsBodyFixedMeters: this.footprint?.padContacts.map((pad) => ({ ...pad.bodyFixedPointMeters })) ?? [],
      contactNormalBodyFixed: { ...normal },
      ...(this.footprint?.generationId ? { contactGenerationId: this.footprint.generationId } : {}),
      contactReady: this.footprint?.ready ?? false,
      contactSafe: this.footprint?.safe ?? false,
      clearanceMeters: clearance,
      horizontalSpeedMetersPerSecond: horizontal,
      verticalSpeedMetersPerSecond: vertical,
      relativeVelocityBodyFixedMetersPerSecond: { ...velocity },
      surfaceThrust: this.thrust,
      gearProgress: this.gear,
      touchdownImpulseMetersPerSecond: this.touchdownImpulse,
      surfaceKind: this.footprint?.surfaceKind ?? 'rock',
      atmosphereDensity: body && motion
        ? sampleAtmosphereDensity(body.atmosphere, lengthVec3(motion.origin) - body.radiusMeters)
        : 0,
      anchorCommitted: Boolean(this.flight.state.parkedAnchor),
      ...(this.pendingTravel ? { queuedTravel: { ...this.pendingTravel } } : {}),
      lastReason: this.reason,
    };
  }

  requestLanding(): SurfaceCommandResult {
    if (!this.canDepart()) return rejected('board-aurora-to-depart');
    if (!this.kit) return rejected('surface-kit-unavailable');
    if (this.currentPhase === 'parked') return accepted('already-parked');
    if (this.currentPhase !== 'airborne') return rejected('surface-transition-active');
    if (isFasterThanLight(this.flight.state.mode)) return rejected('drive-active');
    this.lastEpoch = this.flight.simulationEpochSeconds;
    const nearest = this.nearestBodyMotion();
    if (!nearest) return rejected('terrain-unavailable');
    const center = this.contact.sample(nearest.bodyId, nearest.origin, { requireReady: false, includeSolids: false });
    if (!center) return rejected('terrain-unavailable');
    const body = this.catalog.getPlanet(nearest.bodyId);
    if (!body) return rejected('terrain-unavailable');
    if (landingAdmissionClearanceMeters(nearest.origin, body.radiusMeters, center) > LANDING_MAXIMUM_ALTITUDE_METERS) return rejected('too-high');
    const initialHazard = hazardReason(center);
    if (initialHazard) return rejected(initialHazard);
    const vertical = dotVec3(nearest.velocity, center.normalBodyFixed);
    const horizontal = lengthVec3(subVec3(nearest.velocity, scaleVec3(center.normalBodyFixed, vertical)));
    if (horizontal > LANDING_MAXIMUM_HORIZONTAL_SPEED) return rejected('horizontal-speed');
    if (Math.abs(vertical) > LANDING_MAXIMUM_VERTICAL_SPEED) return rejected('vertical-speed');
    let lease: ContactLease;
    try { lease = this.contact.acquireLease({ kind: 'parked-ship', bodyId: nearest.bodyId, centerDirection: normalizeVec3(nearest.origin) }); }
    catch { return rejected('terrain-unavailable'); }
    const assessment = assessLandingFootprint({
      bodyId: nearest.bodyId, bodyFixedOriginMeters: nearest.origin, bodyFixedForward: nearest.forward,
      contact: this.contact, kit: this.kit, leaseId: lease.id, requireReady: false,
    });
    const stoppingDistance = Math.max(0, -vertical) ** 2 / (2 * LANDING_BRAKING_ACCELERATION);
    if (!assessment.safe || assessment.clearanceMeters < stoppingDistance + CONTACT_TOLERANCE_METERS) {
      this.contact.releaseLease(lease.id);
      return rejected(!assessment.safe ? assessment.reason : 'vertical-speed');
    }
    this.safeAirborne = this.captureSafeAirborne(nearest);
    this.motion = nearest;
    this.lease = lease;
    this.footprint = assessment;
    this.targetAnchor = undefined;
    this.takeoffBaseAnchor = undefined;
    this.restoredAnchorCandidate = undefined;
    this.pendingTravel = undefined;
    this.releaseCommitted = false;
    this.flight.beginSurfaceControl('landing-armed');
    this.setPhase('landing-armed', assessment.ready ? 'landing-armed' : 'terrain-loading');
    return accepted('landing-armed');
  }

  requestTakeoff(): SurfaceCommandResult {
    if (!this.canDepart()) return rejected('board-aurora-to-depart');
    if (!this.kit) return rejected('surface-kit-unavailable');
    if (this.currentPhase === 'takeoff-spool' || this.currentPhase === 'takeoff-rise' || this.currentPhase === 'takeoff-climb') {
      return accepted('takeoff-active');
    }
    if (this.currentPhase !== 'parked' || !this.motion || !this.flight.state.parkedAnchor) return rejected('not-parked');
    this.lastEpoch = this.flight.simulationEpochSeconds;
    this.takeoffBaseAnchor = cloneAnchor(this.flight.state.parkedAnchor);
    this.targetAnchor = undefined;
    this.releaseCommitted = false;
    this.motion.velocity = vec3();
    this.flight.beginSurfaceControl('takeoff-spool');
    this.setPhase('takeoff-spool', 'takeoff-spool');
    return accepted('takeoff-spool');
  }

  requestTravel(intent: SurfaceTravelIntent): SurfaceCommandResult {
    if (!this.canDepart()) return rejected('board-aurora-to-depart');
    if (!this.validTravelIntent(intent)) return rejected('invalid-destination');
    if (this.currentPhase === 'airborne') return this.executeTravel(intent) ? accepted('travel-engaged') : rejected('invalid-destination');
    if (intent.kind === 'pulse' && this.pendingTravel?.kind === 'pulse') {
      this.pendingTravel = undefined;
      return accepted('travel-cancelled');
    }
    if (intent.kind === 'approach' && intent.targetId) this.flight.setTarget(intent.targetId);
    if (intent.kind === 'hyperdrive') this.flight.setTarget(this.resolveHyperdriveSystem(intent.systemId));
    this.pendingTravel = { ...intent };
    if (this.currentPhase === 'parked') {
      const result = this.requestTakeoff();
      if (!result.accepted) { this.pendingTravel = undefined; return result; }
    }
    return accepted('travel-queued');
  }

  cancelSurfaceTransition(): SurfaceCommandResult {
    this.pendingTravel = undefined;
    if (this.currentPhase === 'airborne' || this.currentPhase === 'parked') return rejected('no-surface-transition');
    if (this.currentPhase === 'takeoff-spool' && this.flight.state.parkedAnchor) {
      this.thrust = 0;
      this.setPhase('parked', 'takeoff-cancelled');
      return accepted('takeoff-cancelled');
    }
    if (!this.motion || !this.kit) return rejected('surface-kit-unavailable');
    if (this.currentPhase === 'touchdown-settle') return rejected('touchdown-settling');
    if (this.currentPhase === 'takeoff-rise' && this.flight.state.parkedAnchor) {
      this.targetAnchor = cloneAnchor(this.flight.state.parkedAnchor);
      this.setPhase('flare', 'returning-to-contact');
      return accepted('returning-to-contact');
    }
    const clearance = this.measureClearance(this.motion);
    if (clearance >= TAKEOFF_RELEASE_CLEARANCE_METERS) {
      this.finishAirborne('surface-transition-cancelled');
      return accepted('surface-transition-cancelled');
    }
    // Below the ordinary flight exclusion, cancellation is a real safe rise,
    // not an immediate handoff that would make the coarse sphere snap us up.
    this.takeoffBaseAnchor = this.targetAnchor ?? this.anchorFromFootprint();
    this.targetAnchor = undefined;
    // A cancelled flare may never have had an anchor. Its precontact save
    // stays authoritative until the real rise reaches release clearance.
    this.releaseCommitted = false;
    this.setPhase('takeoff-rise', 'landing-cancelled-rising');
    return accepted('landing-cancelled-rising');
  }

  /** Explicit discontinuity hook for saves, QA teleports, reset, and demo states. */
  reconcileAfterRestore(simulationEpochSeconds: number, richAnchor?: ParkedShipAnchor): boolean {
    this.releaseLease();
    this.pendingTravel = undefined;
    this.targetAnchor = undefined;
    this.takeoffBaseAnchor = undefined;
    this.safeAirborne = undefined;
    this.motion = undefined;
    this.footprint = undefined;
    this.assessmentCache = undefined;
    this.lastEpoch = simulationEpochSeconds;
    this.elapsed = 0;
    this.thrust = 0;
    this.touchdownImpulse = 0;
    this.releaseCommitted = false;
    this.flight.snapReferenceFrame(simulationEpochSeconds);
    const anchor = richAnchor ?? this.flight.state.parkedAnchor;
    this.restoredAnchorCandidate = anchor;
    if (anchor && this.kit && validAnchor(anchor, this.kit, this.catalog, this.flight.state.systemId)) {
      this.motion = {
        bodyId: anchor.bodyId, origin: { ...anchor.bodyFixedOriginMeters },
        forward: { ...anchor.bodyFixedForward }, up: { ...anchor.supportNormalBodyFixed }, velocity: vec3(),
      };
      try { this.lease = this.contact.acquireLease({ kind: 'parked-ship', bodyId: anchor.bodyId, centerDirection: normalizeVec3(anchor.bodyFixedOriginMeters) }); }
      catch { this.motion = undefined; return this.reconcileLegacyOrAirborne(); }
      this.flight.beginSurfaceControl('parked');
      this.flight.commitParkedAnchor(anchor, simulationEpochSeconds, true);
      this.gear = 1;
      this.footprint = this.assess(true);
      this.setPhase('parked', this.footprint?.ready ? 'parked' : 'terrain-loading');
      this.refreshContactReadiness();
      return true;
    }
    return this.reconcileLegacyOrAirborne();
  }

  private reconcileLegacyOrAirborne(): boolean {
    const legacy = this.flight.state.landedAnchor;
    if (!this.kit && (legacy || this.flight.state.landed || this.restoredAnchorCandidate)) {
      return this.recoverToSafeAirborne('surface-kit-unavailable-recovered-airborne').accepted;
    }
    if (!legacy) {
      this.currentPhase = 'airborne';
      this.flight.state.surfacePhase = 'airborne';
      this.gear = 0;
      this.reason = 'airborne';
      return true;
    }
    const pose = this.catalog.getBodyPose(legacy.bodyId, this.lastEpoch);
    const body = this.catalog.getPlanet(legacy.bodyId);
    if (!pose || !body?.isLandable) {
      this.flight.releaseParkedAnchor();
      this.currentPhase = 'airborne';
      this.flight.state.surfacePhase = 'airborne';
      this.gear = 0;
      this.reason = 'invalid-surface-anchor';
      return false;
    }
    const origin = rotateAroundYAxis(subtractAddresses(this.flight.state.address, pose.position), -pose.rotationRadians);
    const up = normalizeVec3(origin);
    const motion: SurfaceMotion = {
      bodyId: body.id, origin, up,
      forward: tangentForward(rotateAroundYAxis(this.flight.state.forward, -pose.rotationRadians), up), velocity: vec3(),
    };
    try { this.lease = this.contact.acquireLease({ kind: 'parked-ship', bodyId: body.id, centerDirection: up }); }
    catch { this.currentPhase = 'airborne'; this.flight.state.surfacePhase = 'airborne'; this.reason = 'terrain-unavailable'; return false; }
    this.safeAirborne = this.captureSafeAirborne(motion);
    // A v1 anchor is a candidate, not proof that three actual feet are seated.
    // Hold its exact restored position until the committed contact generation is
    // ready, then perform the same continuous descent as a new landing.
    this.flight.releaseParkedAnchor();
    this.motion = motion;
    this.footprint = this.assess(false);
    this.gear = 1;
    this.flight.beginSurfaceControl('landing-armed');
    this.setPhase('landing-armed', 'restoring-surface-contact');
    return true;
  }

  /** True means the caller must not also advance FlightController this step. */
  update(deltaSeconds: number, simulationEpochSeconds: number): boolean {
    if (!Number.isFinite(simulationEpochSeconds)) return false;
    if (this.currentPhase === 'airborne' && this.flight.state.landed && this.kit) {
      this.reconcileAfterRestore(this.flight.simulationEpochSeconds, this.flight.state.parkedAnchor);
    } else if (this.currentPhase !== 'airborne' && this.flight.state.surfacePhase === 'airborne' &&
      !this.flight.state.landed && !this.flight.state.parkedAnchor) {
      this.reconcileAfterRestore(this.flight.simulationEpochSeconds);
    }
    if (this.currentPhase === 'airborne') { this.lastEpoch = simulationEpochSeconds; return false; }
    if (!this.motion || !this.kit) return false;
    const delta = clamp(deltaSeconds, 0, 0.25);
    if (delta <= 0) { this.refreshContactReadiness(); return true; }
    const startEpoch = this.lastEpoch;
    const count = Math.max(1, Math.ceil(delta / MAXIMUM_SURFACE_STEP_SECONDS));
    for (let index = 1; index <= count && this.ownsFlightMotion; index += 1) {
      const epoch = startEpoch + (simulationEpochSeconds - startEpoch) * index / count;
      this.step(delta / count, epoch);
      this.lastEpoch = epoch;
    }
    return true;
  }

  getStableCheckpoint(): SurfaceStableCheckpoint {
    const anchor = this.flight.state.parkedAnchor;
    if (anchor) return { kind: 'parked', flight: this.serializedAtAnchor(anchor), anchor: cloneAnchor(anchor) };
    if (this.currentPhase !== 'airborne' && !this.releaseCommitted && this.safeAirborne) {
      return { kind: 'airborne', flight: this.transportedSafeAirborne(this.safeAirborne) };
    }
    const state = cloneFlightState(this.flight.serializeState());
    delete state.landedAnchor;
    return { kind: 'airborne', flight: state };
  }

  dispose(): void { this.releaseLease(); }

  private step(delta: number, epoch: number): void {
    const motion = this.motion!;
    const kit = this.kit!;
    this.elapsed += delta;
    this.touchdownImpulse *= Math.exp(-delta * 5);
    this.gear = moveToward(this.gear,
      this.currentPhase === 'takeoff-climb' ? 0 : 1, delta / LANDING_ARM_SECONDS);

    if (this.currentPhase === 'parked' || this.currentPhase === 'touchdown-settle') {
      const anchor = this.flight.state.parkedAnchor;
      if (!anchor) { this.finishAirborne('invalid-surface-anchor'); return; }
      motion.origin = { ...anchor.bodyFixedOriginMeters };
      motion.forward = { ...anchor.bodyFixedForward };
      motion.up = { ...anchor.supportNormalBodyFixed };
      motion.velocity = vec3();
      this.applyMotion(epoch);
      if (!this.footprint?.ready || this.footprint.generationId !== this.contact.getGeneration(this.lease?.id ?? '')?.id) {
        this.refreshContactReadiness();
      }
      this.thrust = this.currentPhase === 'touchdown-settle' ? 0.36 * (1 - clamp(this.elapsed / LANDING_SETTLE_SECONDS, 0, 1)) : 0;
      if (this.currentPhase === 'touchdown-settle' && this.elapsed >= LANDING_SETTLE_SECONDS) this.setPhase('parked', 'parked');
      if (this.currentPhase === 'parked' && this.pendingTravel && this.canDepart()) this.requestTakeoff();
      return;
    }

    if (this.currentPhase === 'landing-armed') {
      const assessment = this.assess(true);
      if (assessment) this.footprint = assessment;
      const previousVelocity = motion.velocity;
      motion.velocity = vectorMoveToward(motion.velocity, vec3(), LANDING_BRAKING_ACCELERATION * delta);
      const destination = addVec3(motion.origin, scaleVec3(addVec3(previousVelocity, motion.velocity), delta * 0.5));
      const desiredUp = assessment?.supportNormalBodyFixed ?? normalizeVec3(motion.origin);
      const nextUp = normalizeVec3(lerpVec3(motion.up, desiredUp, 1 - Math.exp(-delta * 3)));
      const nextForward = tangentForward(motion.forward, nextUp);
      const movement = this.sweepMotion(motion, destination, nextForward, nextUp, assessment?.ready ?? false);
      motion.origin = movement.position;
      motion.up = nextUp;
      motion.forward = nextForward;
      if (movement.blocked) motion.velocity = vec3();
      this.applyMotion(epoch);
      this.thrust = 0.48;
      if (!assessment?.ready) { this.reason = 'terrain-loading'; return; }
      if (!assessment.safe) { this.reason = assessment.reason; return; }
      if (this.elapsed < LANDING_ARM_SECONDS || lengthVec3(motion.velocity) > 0.12) return;
      const final = this.assess(true);
      if (!final?.safe || !final.ready) { this.reason = final?.reason ?? 'terrain-loading'; return; }
      this.footprint = final;
      this.targetAnchor = this.anchorFromFootprint();
      this.setPhase('flare', 'flare');
      return;
    }

    if (this.currentPhase === 'flare') {
      const target = this.targetAnchor;
      if (!target) { this.setPhase('landing-armed', 'terrain-loading'); return; }
      const currentGenerationId = this.lease ? this.contact.getGeneration(this.lease.id)?.id : undefined;
      // Contact generations and their hazards are immutable. A fixed landing
      // target need not refit the entire authored hull sixty times per second.
      const check = this.footprint?.ready && this.footprint.safe && currentGenerationId === this.footprint.generationId &&
        lengthVec3(subVec3(this.footprint.bodyFixedOriginMeters, target.bodyFixedOriginMeters)) < 0.03
        ? this.footprint
        : assessLandingFootprint({
          bodyId: motion.bodyId, bodyFixedOriginMeters: target.bodyFixedOriginMeters,
          bodyFixedForward: target.bodyFixedForward, contact: this.contact, kit, leaseId: this.lease?.id,
        });
      if (!check.ready) { motion.velocity = vec3(); this.applyMotion(epoch); this.setPhase('landing-armed', 'terrain-loading'); return; }
      if (!check.safe) { this.reason = check.reason; this.cancelSurfaceTransition(); this.applyMotion(epoch); return; }
      this.footprint = check;
      const displacement = subVec3(target.bodyFixedOriginMeters, motion.origin);
      const distance = lengthVec3(displacement);
      const alongUp = dotVec3(displacement, target.supportNormalBodyFixed);
      const tangent = subVec3(displacement, scaleVec3(target.supportNormalBodyFixed, alongUp));
      const desiredVertical = Math.sign(alongUp) * Math.min(12, Math.sqrt(Math.abs(alongUp) * 8), Math.abs(alongUp) * 1.65 + 0.025);
      const desiredTangent = limitLength(scaleVec3(tangent, 1.8), 5);
      const desiredVelocity = addVec3(desiredTangent, scaleVec3(target.supportNormalBodyFixed, desiredVertical));
      const previousVelocity = motion.velocity;
      motion.velocity = vectorMoveToward(motion.velocity, desiredVelocity, 8 * delta);
      let movement = scaleVec3(addVec3(previousVelocity, motion.velocity), delta * 0.5);
      if (dotVec3(movement, displacement) > distance * distance) movement = displacement;
      const nextUp = normalizeVec3(lerpVec3(motion.up, target.supportNormalBodyFixed, 1 - Math.exp(-delta * 4.5)));
      const nextForward = tangentForward(normalizeVec3(lerpVec3(motion.forward, target.bodyFixedForward, 1 - Math.exp(-delta * 4.5))), nextUp);
      const sweep = this.sweepMotion(motion, addVec3(motion.origin, movement), nextForward, nextUp, true);
      const touchdownSpeed = Math.max(0, -dotVec3(motion.velocity, target.supportNormalBodyFixed));
      motion.origin = sweep.position;
      motion.forward = nextForward;
      motion.up = nextUp;
      if (sweep.blocked) motion.velocity = vec3();
      this.applyMotion(epoch);
      this.thrust = clamp(0.4 + touchdownSpeed * 0.018, 0.35, 0.65);
      const remaining = lengthVec3(subVec3(target.bodyFixedOriginMeters, motion.origin));
      if (remaining <= CONTACT_TOLERANCE_METERS && lengthVec3(motion.velocity) <= 0.35) {
        // The final sub-centimeter integration is still swept; no fixed 8 m
        // placement or camera-space substitute participates in touchdown.
        const last = this.sweepMotion(motion, target.bodyFixedOriginMeters, target.bodyFixedForward, target.supportNormalBodyFixed, true);
        if (!last.blocked || lengthVec3(subVec3(last.position, target.bodyFixedOriginMeters)) < CONTACT_TOLERANCE_METERS) {
          motion.origin = { ...target.bodyFixedOriginMeters };
          motion.forward = { ...target.bodyFixedForward };
          motion.up = { ...target.supportNormalBodyFixed };
          motion.velocity = vec3();
          if (this.flight.commitParkedAnchor(target, epoch)) {
            this.touchdownImpulse = Math.max(0.18, touchdownSpeed);
            this.setPhase('touchdown-settle', 'touchdown');
          }
        }
      }
      return;
    }

    if (this.currentPhase === 'takeoff-spool') {
      const anchor = this.takeoffBaseAnchor;
      if (!anchor) { this.finishAirborne('invalid-surface-anchor'); return; }
      motion.origin = { ...anchor.bodyFixedOriginMeters };
      motion.forward = { ...anchor.bodyFixedForward };
      motion.up = { ...anchor.supportNormalBodyFixed };
      motion.velocity = vec3();
      this.thrust = 0.72 * clamp(this.elapsed / TAKEOFF_SPOOL_SECONDS, 0, 1);
      this.applyMotion(epoch);
      if (this.elapsed >= TAKEOFF_SPOOL_SECONDS) this.setPhase('takeoff-rise', 'takeoff-rise');
      return;
    }

    const base = this.takeoffBaseAnchor ?? this.anchorFromFootprint();
    if (!base) { this.finishAirborne('invalid-surface-anchor'); return; }
    const radial = normalizeVec3(base.bodyFixedOriginMeters);
    const clearance = this.measureClearance(motion);
    const rising = this.currentPhase === 'takeoff-rise';
    const desiredSpeed = rising ? 9.5 : 43;
    const verticalSpeed = dotVec3(motion.velocity, radial);
    const nextSpeed = moveToward(verticalSpeed, desiredSpeed, (rising ? 4.6 : 12) * delta);
    const destination = addVec3(motion.origin, scaleVec3(radial, (verticalSpeed + nextSpeed) * delta * 0.5));
    const nextUp = normalizeVec3(lerpVec3(motion.up, radial, 1 - Math.exp(-delta * 2.2)));
    const nextForward = tangentForward(base.bodyFixedForward, nextUp);
    const sweep = this.sweepMotion(motion, destination, nextForward, nextUp, true);
    motion.origin = sweep.position;
    motion.up = nextUp;
    motion.forward = nextForward;
    motion.velocity = sweep.blocked ? vec3() : scaleVec3(radial, nextSpeed);
    this.thrust = rising ? 0.84 : 0.7;
    if (sweep.blocked) this.reason = sweep.reason;
    this.applyMotion(epoch);
    const nextClearance = this.measureClearance(motion);
    if (rising && nextClearance >= TAKEOFF_RELEASE_CLEARANCE_METERS) {
      this.flight.releaseParkedAnchor();
      this.releaseCommitted = true;
      this.safeAirborne = this.captureSafeAirborne(motion);
      this.setPhase('takeoff-climb', 'takeoff-climb');
    } else if (!rising && nextClearance >= TAKEOFF_HANDOFF_CLEARANCE_METERS) {
      this.finishAirborne('airborne');
    } else if (clearance < -CONTACT_TOLERANCE_METERS && sweep.blocked) {
      this.reason = 'surface-obstructed';
    }
  }

  private nearestBodyMotion(): SurfaceMotion | undefined {
    const snapshot = this.catalog.evaluateSystem(this.flight.currentSystem, this.lastEpoch);
    let nearest: { altitude: number; motion: SurfaceMotion } | undefined;
    for (const pose of [...snapshot.planets, ...snapshot.moons]) {
      const body = this.catalog.getPlanet(pose.id);
      if (!body?.isLandable) continue;
      const origin = rotateAroundYAxis(subtractAddresses(this.flight.state.address, pose.position), -pose.rotationRadians);
      const sample = this.contact.sample(body.id, origin, { requireReady: false, includeSolids: false });
      const altitude = landingAdmissionClearanceMeters(origin, body.radiusMeters, sample);
      if (nearest && nearest.altitude <= altitude) continue;
      const up = normalizeVec3(origin);
      nearest = { altitude, motion: {
        bodyId: body.id, origin, up,
        forward: tangentForward(rotateAroundYAxis(this.flight.state.forward, -pose.rotationRadians), up),
        // Local flight already carries the source orbit/spin separately from
        // propulsion. Transforming this transport-relative velocity is exactly
        // world ship velocity minus the moving, rotating surface velocity.
        velocity: rotateAroundYAxis(this.flight.state.velocity, -pose.rotationRadians),
      } };
    }
    return nearest?.motion;
  }

  private assess(requireReady: boolean, force = false): LandingFootprintAssessment | undefined {
    if (!this.motion || !this.kit) return undefined;
    const generationId = this.lease ? this.contact.getGeneration(this.lease.id)?.id : undefined;
    const cached = this.assessmentCache;
    if (!force && cached && cached.requireReady === requireReady && cached.generationId === generationId &&
      lengthVec3(subVec3(cached.origin, this.motion.origin)) < 0.015 &&
      dotVec3(cached.forward, this.motion.forward) > 0.999999) return cached.value;
    const value = assessLandingFootprint({
      bodyId: this.motion.bodyId, bodyFixedOriginMeters: this.motion.origin,
      bodyFixedForward: this.motion.forward, contact: this.contact, kit: this.kit,
      ...(this.lease ? { leaseId: this.lease.id } : {}), requireReady,
    });
    this.assessmentCache = { origin: { ...this.motion.origin }, forward: { ...this.motion.forward }, generationId, requireReady, value };
    return value;
  }

  private anchorFromFootprint(): ParkedShipAnchor | undefined {
    if (!this.motion || !this.footprint || !this.kit) return undefined;
    return {
      bodyId: this.motion.bodyId,
      bodyFixedOriginMeters: { ...this.footprint.bodyFixedOriginMeters },
      bodyFixedForward: { ...this.footprint.bodyFixedForward },
      supportNormalBodyFixed: { ...this.footprint.supportNormalBodyFixed },
      padContacts: this.footprint.padContacts.map((pad) => ({ ...pad,
        bodyFixedPointMeters: { ...pad.bodyFixedPointMeters }, bodyFixedNormal: { ...pad.bodyFixedNormal } })),
      surfaceKitVersion: this.kit.surfaceKitVersion,
    };
  }

  private measureClearance(motion: SurfaceMotion): number {
    if (!this.kit) return Number.POSITIVE_INFINITY;
    let clearance = Number.POSITIVE_INFINITY;
    for (const pad of this.kit.landingPadsMeters) {
      const point = addVec3(motion.origin, shipLocalToBodyFixedOffset(pad.positionMeters, motion.forward, motion.up));
      const sample = this.contact.sample(motion.bodyId, point, {
        ...(this.lease ? { leaseId: this.lease.id } : {}), requireReady: false, includeSolids: false,
      });
      if (sample) clearance = Math.min(clearance, dotVec3(subVec3(point, sample.pointBodyFixedMeters), sample.normalBodyFixed));
    }
    return clearance;
  }

  private sweepMotion(start: SurfaceMotion, destination: Vec3, forward: Vec3, up: Vec3, requireReady: boolean): {
    position: Vec3; blocked: boolean; reason: string;
  } {
    const kit = this.kit!;
    const source = { ...start.origin };
    const probes = [
      ...kit.landingPadsMeters.map((pad) => ({ point: pad.positionMeters, foot: true })),
      ...hullLocalProbes(kit).map((point) => ({ point, foot: false })),
    ];
    let fraction = 1;
    let reason = 'clear';
    for (const probe of probes) {
      const from = addVec3(source, shipLocalToBodyFixedOffset(probe.point, start.forward, start.up));
      const to = addVec3(destination, shipLocalToBodyFixedOffset(probe.point, forward, up));
      const result = this.contact.sweepCapsule(start.bodyId, from, to, {
        ...(this.lease ? { leaseId: this.lease.id } : {}), radiusMeters: 0, halfHeightMeters: 0,
        requireReady, includeSolids: false, checkGround: true, blockHazards: false,
        groundToleranceMeters: probe.foot ? CONTACT_TOLERANCE_METERS : 0.002,
      });
      if (result.blocked && result.safeFraction < fraction) { fraction = result.safeFraction; reason = result.reason; }
    }
    const solids = this.lease ? this.contact.getGeneration(this.lease.id)?.solids ?? [] : [];
    if (solids.length) {
      const distance = lengthVec3(subVec3(destination, source));
      const steps = Math.max(1, Math.min(256, Math.ceil(distance / 0.3)));
      for (let index = 0; index <= steps; index += 1) {
        const t = Math.min(fraction, index / steps);
        const position = lerpVec3(source, destination, t);
        const sampleUp = normalizeVec3(lerpVec3(start.up, up, t));
        const sampleForward = tangentForward(lerpVec3(start.forward, forward, t), sampleUp);
        if (shipIntersectsContactSolids(kit, position, sampleForward, sampleUp, solids)) {
          fraction = Math.min(fraction, Math.max(0, (index - 1) / steps));
          reason = 'solid';
          break;
        }
        if (t >= fraction) break;
      }
    }
    return { position: lerpVec3(source, destination, fraction), blocked: fraction < 1, reason };
  }

  private applyMotion(epoch: number): boolean {
    if (!this.motion) return false;
    const applied = this.flight.applySurfacePose({
      bodyId: this.motion.bodyId, bodyFixedOriginMeters: this.motion.origin,
      bodyFixedForward: this.motion.forward, supportNormalBodyFixed: this.motion.up,
      bodyFixedVelocityMetersPerSecond: this.motion.velocity,
    }, epoch);
    if (!applied) {
      const pose = this.catalog.getBodyPose(this.motion.bodyId, epoch);
      if (pose) this.motion.origin = rotateAroundYAxis(
        subtractAddresses(this.flight.state.address, pose.position), -pose.rotationRadians,
      );
      this.motion.velocity = vec3();
      this.reason = 'body-collision';
    }
    return applied;
  }

  private captureSafeAirborne(motion: SurfaceMotion): SafeAirborneFrame {
    const state = cloneFlightState(this.flight.serializeState());
    delete state.landedAnchor;
    return { bodyId: motion.bodyId, origin: { ...motion.origin }, forward: { ...motion.forward }, velocity: { ...motion.velocity }, state };
  }

  private transportedSafeAirborne(safe: SafeAirborneFrame): SerializedFlightState {
    const pose = this.catalog.getBodyPose(safe.bodyId, this.lastEpoch);
    const state = cloneFlightState(safe.state);
    if (!pose) return state;
    state.position = serializeAddress(addAddressOffset(pose.position, rotateAroundYAxis(safe.origin, pose.rotationRadians)));
    const orientation = headingToTarget(vec3(), rotateAroundYAxis(safe.forward, pose.rotationRadians));
    state.yaw = orientation.yawRadians;
    state.pitch = orientation.pitchRadians;
    state.velocity = rotateAroundYAxis(safe.velocity, pose.rotationRadians);
    state.targetId = this.flight.state.targetId;
    delete state.landedAnchor;
    return state;
  }

  private serializedAtAnchor(anchor: ParkedShipAnchor): SerializedFlightState {
    const state = cloneFlightState(this.flight.serializeState());
    const pose = this.catalog.getBodyPose(anchor.bodyId, this.lastEpoch);
    const body = this.catalog.getPlanet(anchor.bodyId);
    if (!pose || !body) return state;
    const direction = normalizeVec3(anchor.bodyFixedOriginMeters);
    const sample = this.contact.sample(anchor.bodyId, anchor.bodyFixedOriginMeters, { requireReady: false, includeSolids: false });
    const legacy: BodyFixedLandingAnchor = {
      bodyId: anchor.bodyId, surfaceDirection: direction,
      altitudeMeters: lengthVec3(anchor.bodyFixedOriginMeters) - body.radiusMeters - (sample?.groundHeightMeters ?? 0),
      latitudeRadians: Math.asin(clamp(direction.y, -1, 1)),
      longitudeRadians: Math.atan2(direction.z, direction.x),
    };
    state.position = serializeAddress(addAddressOffset(pose.position, rotateAroundYAxis(anchor.bodyFixedOriginMeters, pose.rotationRadians)));
    state.velocity = vec3();
    const orientation = headingToTarget(vec3(), rotateAroundYAxis(anchor.bodyFixedForward, pose.rotationRadians));
    state.yaw = orientation.yawRadians;
    state.pitch = orientation.pitchRadians;
    state.landedAnchor = legacy;
    return state;
  }

  private validTravelIntent(intent: SurfaceTravelIntent): boolean {
    if (intent.kind === 'approach') {
      const id = intent.targetId ?? this.flight.state.targetId;
      return Boolean(id && (this.catalog.getBody(id) || (id !== this.flight.state.systemId && this.catalog.getSystem(id))));
    }
    if (intent.kind === 'pulse') {
      if (this.flight.state.mode === 'pulse') return true;
      const owner = this.flight.state.targetId ? this.catalog.getSystemForBody(this.flight.state.targetId) : undefined;
      return Boolean(owner?.id === this.flight.state.systemId);
    }
    const id = this.resolveHyperdriveSystem(intent.systemId);
    return Boolean(id && id !== this.flight.state.systemId && this.catalog.getSystem(id));
  }

  private resolveHyperdriveSystem(explicit?: string): string | undefined {
    if (explicit) return explicit;
    const target = this.flight.state.targetId;
    const resolved = target ? this.catalog.getSystem(target)?.id ?? this.catalog.getSystemForBody(target)?.id : undefined;
    return resolved && resolved !== this.flight.state.systemId ? resolved : CONTRAST_SYSTEM_ID;
  }

  private executeTravel(intent: SurfaceTravelIntent): boolean {
    if (intent.kind === 'approach') return this.flight.engageTargetApproach(intent.targetId);
    if (intent.kind === 'pulse') return this.flight.togglePulse();
    const systemId = this.resolveHyperdriveSystem(intent.systemId);
    return Boolean(systemId && this.flight.initiateHyperdrive(systemId));
  }

  private finishAirborne(reason: string): void {
    const pending = this.pendingTravel;
    this.pendingTravel = undefined;
    this.flight.releaseParkedAnchor();
    this.flight.beginSurfaceControl('airborne');
    this.releaseCommitted = true;
    this.thrust = 0;
    this.gear = 0;
    this.setPhase('airborne', reason);
    this.releaseLease();
    this.motion = undefined;
    this.footprint = undefined;
    this.assessmentCache = undefined;
    this.targetAnchor = undefined;
    this.takeoffBaseAnchor = undefined;
    this.restoredAnchorCandidate = undefined;
    this.safeAirborne = undefined;
    if (pending && this.canDepart() && !this.executeTravel(pending)) this.reason = 'invalid-destination';
  }

  private setPhase(phase: SurfacePhase, reason: string): void {
    if (this.currentPhase !== phase) this.event += 1;
    this.currentPhase = phase;
    this.flight.state.surfacePhase = phase;
    this.elapsed = 0;
    this.reason = reason;
  }

  private phaseProgress(clearance: number): number {
    if (this.currentPhase === 'landing-armed') return clamp(this.elapsed / LANDING_ARM_SECONDS, 0, 1);
    if (this.currentPhase === 'touchdown-settle') return clamp(this.elapsed / LANDING_SETTLE_SECONDS, 0, 1);
    if (this.currentPhase === 'takeoff-spool') return clamp(this.elapsed / TAKEOFF_SPOOL_SECONDS, 0, 1);
    if (this.currentPhase === 'takeoff-rise') return clamp(clearance / TAKEOFF_RELEASE_CLEARANCE_METERS, 0, 1);
    if (this.currentPhase === 'takeoff-climb') return clamp((clearance - TAKEOFF_RELEASE_CLEARANCE_METERS) /
      (TAKEOFF_HANDOFF_CLEARANCE_METERS - TAKEOFF_RELEASE_CLEARANCE_METERS), 0, 1);
    if (this.currentPhase === 'flare') return 1 - clamp(clearance / Math.max(1, this.safeAirborne ?
      lengthVec3(subVec3(this.safeAirborne.origin, this.targetAnchor?.bodyFixedOriginMeters ?? this.safeAirborne.origin)) : 1), 0, 1);
    return this.currentPhase === 'parked' ? 1 : 0;
  }

  private releaseLease(): void {
    if (this.lease) this.contact.releaseLease(this.lease.id);
    this.lease = undefined;
  }
}

function vectorMoveToward(current: Readonly<Vec3>, target: Readonly<Vec3>, maximumChange: number): Vec3 {
  const difference = subVec3(target, current);
  const distance = lengthVec3(difference);
  return distance <= maximumChange || distance < 1e-12 ? { ...target } : addVec3(current, scaleVec3(difference, maximumChange / distance));
}

function limitLength(value: Vec3, maximum: number): Vec3 {
  const length = lengthVec3(value);
  return length <= maximum || length === 0 ? value : scaleVec3(value, maximum / length);
}

function validAnchor(anchor: ParkedShipAnchor, kit: SurfaceLandingKit, catalog: UniverseCatalog, systemId: string): boolean {
  const body = catalog.getPlanet(anchor.bodyId);
  const maximumFootReach = Math.max(...kit.landingPadsMeters.map((pad) => lengthVec3(pad.positionMeters))) + kit.maximumPadHeightSpreadMeters + 1;
  return anchor.surfaceKitVersion === kit.surfaceKitVersion && catalog.getSystemForBody(anchor.bodyId)?.id === systemId &&
    Boolean(body?.isLandable) && finiteVector(anchor.bodyFixedOriginMeters) &&
    lengthVec3(anchor.bodyFixedOriginMeters) > (body?.radiusMeters ?? 0) * 0.9 &&
    finiteVector(anchor.bodyFixedForward) && lengthVec3(anchor.bodyFixedForward) > 0.5 &&
    finiteVector(anchor.supportNormalBodyFixed) && lengthVec3(anchor.supportNormalBodyFixed) > 0.5 &&
    dotVec3(normalizeVec3(anchor.bodyFixedOriginMeters), normalizeVec3(anchor.supportNormalBodyFixed)) >
      Math.cos((kit.maximumLandingSlopeDegrees + 1) * Math.PI / 180) &&
    anchor.padContacts.length === kit.landingPadsMeters.length &&
    new Set(anchor.padContacts.map((contact) => contact.padId)).size === anchor.padContacts.length &&
    kit.landingPadsMeters.every((pad) => anchor.padContacts.some((contact) => contact.padId === pad.id &&
      finiteVector(contact.bodyFixedPointMeters) && finiteVector(contact.bodyFixedNormal) && Number.isFinite(contact.compressionMeters) &&
      contact.compressionMeters >= 0 && contact.compressionMeters <= kit.maximumPadHeightSpreadMeters + 0.01 &&
      lengthVec3(subVec3(contact.bodyFixedPointMeters, anchor.bodyFixedOriginMeters)) <= maximumFootReach));
}

/** Full 15-axis OBB SAT; ground props cannot hide between sampled hull corners. */
function boxesIntersect(
  centerA: Readonly<Vec3>, axesA: readonly Vec3[], halfA: Readonly<Vec3>,
  centerB: Readonly<Vec3>, axesB: readonly Readonly<Vec3>[], halfB: Readonly<Vec3>,
): boolean {
  const displacement = subVec3(centerB, centerA);
  const a = [halfA.x, halfA.y, halfA.z];
  const b = [halfB.x, halfB.y, halfB.z];
  const axes = [...axesA, ...axesB];
  for (const left of axesA) for (const right of axesB) axes.push(crossVec3(left, right));
  for (const axis of axes) {
    if (lengthVec3(axis) < 1e-8) continue;
    const radiusA = axesA.reduce((sum, basis, index) => sum + a[index]! * Math.abs(dotVec3(basis, axis)), 0);
    const radiusB = axesB.reduce((sum, basis, index) => sum + b[index]! * Math.abs(dotVec3(basis, axis)), 0);
    if (Math.abs(dotVec3(displacement, axis)) > radiusA + radiusB + 0.005) return false;
  }
  return true;
}

function shipIntersectsContactSolids(
  kit: SurfaceLandingKit, origin: Readonly<Vec3>, forward: Readonly<Vec3>, up: Readonly<Vec3>,
  solids: readonly ContactSolidDescriptor[],
): boolean {
  const normalizedUp = normalizeVec3(up);
  const normalizedForward = tangentForward(forward, normalizedUp);
  const right = normalizeVec3(crossVec3(normalizedForward, normalizedUp));
  const axes = [right, normalizedUp, scaleVec3(normalizedForward, -1)];
  for (const proxy of kit.collisionProxyMeters) {
    if (proxy.kind === 'gear') continue;
    const center = addVec3(origin, shipLocalToBodyFixedOffset(proxy.centerMeters, normalizedForward, normalizedUp));
    const broadRadius = lengthVec3(proxy.halfExtentsMeters);
    for (const solid of solids) {
      if (lengthVec3(subVec3(center, solid.centerBodyFixedMeters)) > broadRadius + lengthVec3(solid.halfExtentsMeters) + 0.01) continue;
      if (boxesIntersect(center, axes, proxy.halfExtentsMeters, solid.centerBodyFixedMeters,
        [solid.rightBodyFixed, solid.upBodyFixed, solid.forwardBodyFixed], solid.halfExtentsMeters)) return true;
    }
  }
  return false;
}
