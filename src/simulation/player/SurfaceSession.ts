import {
  addVec3,
  bodyFixedToWorld,
  crossVec3,
  dotVec3,
  lengthVec3,
  lerpVec3,
  normalizeVec3,
  rotateAroundYAxis,
  scaleVec3,
  subVec3,
  vec3,
  type BodyFrame,
  type Vec3,
} from '../../core';
import type { ContactSurfaceGeneration } from '../../terrain/ContactGeometry';
import type { SurfaceContactAuthority } from '../../terrain/SurfaceContactAuthority';
import type { ParkedShipAnchor } from '../ship/ShipState';
import { shipLocalToBodyFixedOffset, type SurfaceCommandResult } from '../ship/SurfaceLifecycleController';
import {
  cloneSurfaceActorState,
  createSurfaceActorState,
  getSurfaceActorObserverPose,
  isValidSurfaceActorState,
  OnFootController,
  tangentHeading,
  type OnFootControllerOptions,
  type SurfaceActorObserverPose,
  type SurfaceActorState,
} from './OnFootController';
import {
  ACTOR_CAPSULE_HALF_HEIGHT_METERS,
  ACTOR_CAPSULE_RADIUS_METERS,
  ACTOR_COLLISION_SKIN_METERS,
  ACTOR_EYE_HEIGHT_METERS,
  ACTOR_MAXIMUM_SLOPE_DEGREES,
  SurfaceMotionSolver,
  type SurfaceMotionBox,
} from './SurfaceMotionSolver';

export type OccupancyPhase = 'inside' | 'exit-prewarm' | 'egressing' | 'outside' | 'boarding';
export type SurfaceViewMode = 'chase' | 'cockpit';
export type SurfaceOccupancyEvent = 'none' | 'exit-requested' | 'egress' | 'outside' | 'boarding' | 'inside' | 'footstep' | 'cancelled';

/** Plain authored metadata; simulation never reads a render Object3D or guesses sockets. */
export interface SurfaceEgressKit {
  readonly surfaceKitVersion: number;
  readonly pilotEyeMeters: Readonly<Vec3>;
  readonly egressRailMeters: readonly {
    readonly positionMeters: Readonly<Vec3>;
    readonly stage: 'interior-fade' | 'exterior';
  }[];
  readonly rampFootMeters: Readonly<Vec3>;
  /** Authored dry-ground standing point beyond the deployed ramp toe. */
  readonly egressStandMeters: Readonly<Vec3>;
  readonly rampSurfaceMeters: {
    readonly startMeters: Readonly<Vec3>;
    readonly endMeters: Readonly<Vec3>;
    readonly widthMeters: number;
    readonly thicknessMeters: number;
  };
  readonly boardingVolumeMeters: {
    readonly centerMeters: Readonly<Vec3>;
    readonly halfExtentsMeters: Readonly<Vec3>;
  };
  readonly collisionProxyMeters: readonly {
    readonly id: string;
    readonly centerMeters: Readonly<Vec3>;
    readonly halfExtentsMeters: Readonly<Vec3>;
  }[];
}

export interface SurfaceSessionOptions {
  contact: SurfaceContactAuthority;
  motion: SurfaceMotionSolver;
  getParkedAnchor: () => ParkedShipAnchor | undefined;
  isParkedAndSettled: () => boolean;
  getSystemId: () => string;
  /** Return undefined until the real kit GLB and manifest have passed validation. */
  getSurfaceKit: () => SurfaceEgressKit | undefined;
  getViewMode?: () => SurfaceViewMode;
  restoreViewMode?: (view: SurfaceViewMode) => void;
  gravityMetersPerSecondSquared?: OnFootControllerOptions['gravityMetersPerSecondSquared'];
}

export interface SurfaceTransitionPose {
  bodyId: string;
  eyeBodyFixedMeters: Vec3;
  forwardBodyFixed: Vec3;
  upBodyFixed: Vec3;
  rightBodyFixed: Vec3;
  railFraction: number;
  fadeOpacity: number;
}

export interface SurfaceSessionSnapshot {
  phase: OccupancyPhase;
  phaseProgress: number;
  eventSerial: number;
  lastEvent: SurfaceOccupancyEvent;
  previousView: SurfaceViewMode;
  actor?: SurfaceActorState;
  actorLeaseId?: string;
  contactGenerationId?: string;
  transition?: SurfaceTransitionPose;
  eyeHeightMeters: number;
  walkingSpeedMetersPerSecond: number;
  grounded: boolean;
  blockingReason?: string;
  canBoard: boolean;
  boardingDistanceMeters?: number;
  restoringOutside: boolean;
}

export interface StableSurfaceOccupancy {
  occupancy: 'inside' | 'outside';
  actor?: SurfaceActorState;
}

interface EgressAssessment {
  accepted: boolean;
  reason: string;
  actor?: SurfaceActorState;
  generation?: ContactSurfaceGeneration;
}

const EGRESS_DURATION_SECONDS = 1.35;
const BOARDING_DURATION_SECONDS = 1.15;
const EXIT_PREWARM_TIMEOUT_SECONDS = 20;
const MAXIMUM_RAMP_GROUND_GAP_METERS = 0.55;

/**
 * The player's occupancy is separate from flight/surface choreography. The
 * session owns only the actor and its contact lease; it never moves AURORA.
 */
export class SurfaceSession {
  readonly onFoot: OnFootController;
  private currentPhase: OccupancyPhase = 'inside';
  private elapsedSeconds = 0;
  private occupancyEventSerial = 0;
  private lastOccupancyEvent: SurfaceOccupancyEvent = 'none';
  private previousViewMode: SurfaceViewMode = 'chase';
  private actorLeaseId?: string;
  private pendingActor?: SurfaceActorState;
  private pendingRestore = false;
  private boardingStartActor?: SurfaceActorState;
  private blockingReason?: string;
  private obstacleBodyId?: string;
  private seenFootstepSerial = 0;
  private disposed = false;

  constructor(private readonly options: SurfaceSessionOptions) {
    this.onFoot = new OnFootController({
      contact: options.contact,
      motion: options.motion,
      gravityMetersPerSecondSquared: options.gravityMetersPerSecondSquared,
    });
  }

  get phase(): OccupancyPhase { return this.currentPhase; }
  get actor(): SurfaceActorState | undefined { return this.onFoot.state; }
  get eventSerial(): number { return this.occupancyEventSerial; }

  get snapshot(): SurfaceSessionSnapshot {
    const walking = this.onFoot.snapshot;
    const boarding = this.boardingStatus();
    const transition = this.transitionPose();
    return {
      phase: this.currentPhase,
      phaseProgress: this.phaseProgress(),
      eventSerial: this.occupancyEventSerial,
      lastEvent: this.lastOccupancyEvent,
      previousView: this.previousViewMode,
      ...(walking.actor ? { actor: walking.actor } : {}),
      ...(this.actorLeaseId ? { actorLeaseId: this.actorLeaseId } : {}),
      ...(this.actorLeaseId && this.options.contact.getGeneration(this.actorLeaseId)
        ? { contactGenerationId: this.options.contact.getGeneration(this.actorLeaseId)!.id } : {}),
      ...(transition ? { transition } : {}),
      eyeHeightMeters: ACTOR_EYE_HEIGHT_METERS,
      walkingSpeedMetersPerSecond: walking.speedMetersPerSecond,
      grounded: walking.grounded,
      ...(this.blockingReason ?? walking.blockingReason ? { blockingReason: this.blockingReason ?? walking.blockingReason } : {}),
      canBoard: boarding.eligible,
      ...(boarding.distanceMeters === undefined ? {} : { boardingDistanceMeters: boarding.distanceMeters }),
      restoringOutside: this.pendingRestore,
    };
  }

  canDepart(): boolean { return this.currentPhase === 'inside'; }

  departureBlockReason(): string | undefined {
    return this.canDepart() ? undefined : 'board-aurora-to-depart';
  }

  requestExit(): SurfaceCommandResult {
    if (this.disposed) return rejected('surface-session-unavailable');
    if (this.currentPhase !== 'inside') return rejected('occupancy-transition-active');
    const anchor = this.options.getParkedAnchor();
    const kit = this.options.getSurfaceKit();
    if (!anchor || !this.options.isParkedAndSettled()) return rejected('park-and-settle-before-exit');
    if (!validKitForAnchor(kit, anchor)) return rejected('surface-kit-unavailable');
    const stand = localPoint(anchor, kit.egressStandMeters);
    const lease = this.acquireActorLease(anchor.bodyId, normalizeVec3(stand));
    if (!lease) return rejected('terrain-loading');
    this.previousViewMode = this.options.getViewMode?.() ?? 'chase';
    this.installShipObstacles(anchor, kit);
    this.actorLeaseId = lease;
    this.pendingActor = undefined;
    this.pendingRestore = false;
    this.blockingReason = 'terrain-loading';
    this.transitionTo('exit-prewarm', 'exit-requested');
    return accepted('exit-prewarm');
  }

  requestBoard(): SurfaceCommandResult {
    if (this.disposed) return rejected('surface-session-unavailable');
    const status = this.boardingStatus();
    if (!status.eligible) return rejected(status.reason);
    const anchor = this.options.getParkedAnchor()!;
    const kit = this.options.getSurfaceKit()!;
    const assessment = this.assessEgress(anchor, kit);
    if (!assessment.accepted || !assessment.actor || !assessment.generation || !this.onFoot.state) {
      this.blockingReason = assessment.reason;
      return rejected(assessment.reason);
    }
    if (!this.exteriorPathClear(assessment.generation, this.onFoot.state.bodyFixedCenterMeters,
      assessment.actor.bodyFixedCenterMeters)) {
      this.blockingReason = 'boarding-path-blocked';
      return rejected('boarding-path-blocked');
    }
    this.boardingStartActor = cloneSurfaceActorState(this.onFoot.state);
    this.pendingActor = assessment.actor;
    this.onFoot.clearInput();
    this.blockingReason = undefined;
    this.transitionTo('boarding', 'boarding');
    return accepted('boarding');
  }

  /** X uses one command in both stable occupancy states. */
  interact(): SurfaceCommandResult {
    return this.currentPhase === 'outside' ? this.requestBoard() : this.requestExit();
  }

  cancelTransition(): SurfaceCommandResult {
    if (this.currentPhase === 'exit-prewarm' || this.currentPhase === 'egressing') {
      this.returnInside(false);
      this.recordEvent('cancelled');
      return accepted('inside');
    }
    if (this.currentPhase === 'boarding') {
      this.boardingStartActor = undefined;
      this.pendingActor = undefined;
      this.blockingReason = undefined;
      this.transitionTo('outside', 'cancelled');
      return accepted('outside');
    }
    return rejected('no-occupancy-transition');
  }

  update(deltaSeconds: number, _simulationEpochSeconds?: number): void {
    this.serviceReadiness();
    if (this.disposed || !Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return;
    if (this.currentPhase === 'inside') return;
    const anchor = this.options.getParkedAnchor();
    const kit = this.options.getSurfaceKit();
    if (!anchor || !this.options.isParkedAndSettled() || !validKitForAnchor(kit, anchor)) {
      this.returnInside(false);
      this.blockingReason = 'parked-ship-unavailable';
      return;
    }
    const delta = Math.min(0.1, deltaSeconds);
    this.elapsedSeconds += delta;
    if (this.currentPhase === 'exit-prewarm') {
      if (this.elapsedSeconds > EXIT_PREWARM_TIMEOUT_SECONDS) {
        this.returnInside(false);
        this.blockingReason = 'terrain-loading-timeout';
        return;
      }
      if (this.pendingRestore) {
        this.tryRestoreActor(anchor);
        return;
      }
      const assessment = this.assessEgress(anchor, kit);
      this.blockingReason = assessment.reason;
      if (!assessment.accepted || !assessment.actor) {
        if (assessment.reason !== 'terrain-loading') {
          this.returnInside(false);
          this.blockingReason = assessment.reason;
        }
        return;
      }
      this.pendingActor = assessment.actor;
      this.blockingReason = undefined;
      this.transitionTo('egressing', 'egress');
      return;
    }
    if (this.currentPhase === 'egressing' && this.elapsedSeconds >= EGRESS_DURATION_SECONDS) {
      if (!this.pendingActor || !this.actorLeaseId || !this.onFoot.attach(this.pendingActor, this.actorLeaseId)) {
        this.returnInside(false);
        this.blockingReason = 'egress-path-blocked';
        return;
      }
      this.pendingActor = undefined;
      this.seenFootstepSerial = 0;
      this.transitionTo('outside', 'outside');
      return;
    }
    if (this.currentPhase === 'boarding' && this.elapsedSeconds >= BOARDING_DURATION_SECONDS) {
      this.returnInside(true);
      this.recordEvent('inside');
      return;
    }
    if (this.currentPhase === 'outside') {
      this.onFoot.update(delta);
      const walking = this.onFoot.snapshot;
      this.blockingReason = undefined;
      if (walking.footstepSerial !== this.seenFootstepSerial) {
        this.seenFootstepSerial = walking.footstepSerial;
        this.recordEvent('footstep');
      }
    }
  }

  /** Resolve a saved outside pose while launch/settings keep both clocks paused. */
  serviceReadiness(): void {
    if (this.disposed || this.currentPhase !== 'exit-prewarm' || !this.pendingRestore) return;
    const anchor = this.options.getParkedAnchor();
    const kit = this.options.getSurfaceKit();
    if (!anchor || !this.options.isParkedAndSettled() || !validKitForAnchor(kit, anchor)) {
      this.returnInside(false);
      this.blockingReason = 'parked-ship-unavailable';
      return;
    }
    this.tryRestoreActor(anchor);
  }

  getStableCheckpoint(): StableSurfaceOccupancy {
    return this.currentPhase === 'outside' && this.onFoot.state
      ? { occupancy: 'outside', actor: cloneSurfaceActorState(this.onFoot.state) }
      : { occupancy: 'inside' };
  }

  /**
   * A saved outside pose is never exposed before its real collider is ready.
   * Restore is silent: no ramp, gear or footstep event is replayed.
   */
  restoreOutside(actor: SurfaceActorState): boolean {
    this.returnInside(false);
    const anchor = this.options.getParkedAnchor();
    const kit = this.options.getSurfaceKit();
    if (!isValidSurfaceActorState(actor) || !anchor || !this.options.isParkedAndSettled() ||
        !validKitForAnchor(kit, anchor) || actor.bodyId !== anchor.bodyId ||
        actor.systemId !== this.options.getSystemId()) return false;
    const lease = this.acquireActorLease(actor.bodyId, normalizeVec3(actor.bodyFixedCenterMeters));
    if (!lease) return false;
    this.actorLeaseId = lease;
    this.pendingActor = cloneSurfaceActorState(actor);
    this.pendingRestore = true;
    this.installShipObstacles(anchor, kit);
    this.currentPhase = 'exit-prewarm';
    this.elapsedSeconds = 0;
    this.lastOccupancyEvent = 'none';
    this.blockingReason = 'terrain-loading';
    return true;
  }

  resetInside(): void {
    this.returnInside(false);
    this.lastOccupancyEvent = 'none';
    this.blockingReason = undefined;
  }

  getObserverPose(frame: BodyFrame): SurfaceActorObserverPose | undefined {
    if (this.currentPhase === 'outside') return this.onFoot.getObserverPose(frame);
    const transition = this.transitionPose();
    if (!transition || transition.bodyId !== frame.id) return undefined;
    return {
      address: bodyFixedToWorld(frame, transition.eyeBodyFixedMeters),
      forward: rotateAroundYAxis(transition.forwardBodyFixed, frame.rotationRadians),
      up: rotateAroundYAxis(transition.upBodyFixed, frame.rotationRadians),
      right: rotateAroundYAxis(transition.rightBodyFixed, frame.rotationRadians),
    };
  }

  private acquireActorLease(bodyId: string, centerDirection: Vec3): string | undefined {
    try {
      return this.options.contact.acquireLease({ kind: 'actor', bodyId, centerDirection }).id;
    } catch {
      return undefined;
    }
  }

  private assessEgress(anchor: ParkedShipAnchor, kit: SurfaceEgressKit): EgressAssessment {
    const leaseId = this.actorLeaseId;
    const generation = leaseId ? this.options.contact.getGeneration(leaseId) : null;
    if (!leaseId || !generation || !this.options.motion.isReady(generation.id)) return failedAssessment('terrain-loading');
    const ramp = localPoint(anchor, kit.rampFootMeters);
    const rampSample = this.options.contact.sample(anchor.bodyId, ramp, {
      leaseId, radiusMeters: ACTOR_CAPSULE_RADIUS_METERS, includeSolids: true,
    });
    if (!rampSample?.ready || rampSample.generationId !== generation.id) return failedAssessment('terrain-loading');
    if (rampSample.hazard !== 'none') return failedAssessment(`egress-${rampSample.hazard}`);
    if (Math.abs(rampSample.altitudeMeters) > MAXIMUM_RAMP_GROUND_GAP_METERS) return failedAssessment('ramp-ground-gap');
    const sample = this.options.contact.sample(anchor.bodyId, localPoint(anchor, kit.egressStandMeters), {
      leaseId, radiusMeters: ACTOR_CAPSULE_RADIUS_METERS, includeSolids: true,
    });
    if (!sample?.ready || sample.generationId !== generation.id) return failedAssessment('terrain-loading');
    if (sample.hazard !== 'none') return failedAssessment(`egress-${sample.hazard}`);
    if (sample.slopeDegrees > ACTOR_MAXIMUM_SLOPE_DEGREES) return failedAssessment('egress-slope');
    const actor = createSurfaceActorState(this.options.getSystemId(), anchor.bodyId,
      sample.pointBodyFixedMeters, scaleVec3(anchor.bodyFixedForward, -1), sample.normalBodyFixed);
    if (!this.options.motion.canOccupy(generation, actor.bodyFixedCenterMeters)) return failedAssessment('egress-path-blocked');
    const exterior = kit.egressRailMeters.filter((point) => point.stage === 'exterior')
      .map((point) => localPoint(anchor, point.positionMeters));
    if (exterior.length === 0) return failedAssessment('surface-kit-unavailable');
    exterior[exterior.length - 1] = actorEyeBodyFixed(actor);
    const centers = exterior.map(eyeToCapsuleCenter);
    for (let index = 0; index < centers.length; index += 1) {
      const from = centers[index]!;
      const to = centers[index + 1] ?? actor.bodyFixedCenterMeters;
      if (!this.exteriorPathClear(generation, from, to)) return failedAssessment('egress-path-blocked');
    }
    return { accepted: true, reason: 'ready', actor, generation };
  }

  private exteriorPathClear(generation: ContactSurfaceGeneration, from: Readonly<Vec3>, to: Readonly<Vec3>): boolean {
    const safe = this.options.contact.sweepCapsule(generation.bodyId, from, to, {
      leaseId: generation.leaseId,
      radiusMeters: ACTOR_CAPSULE_RADIUS_METERS,
      halfHeightMeters: ACTOR_CAPSULE_HALF_HEIGHT_METERS,
      maximumSlopeDegrees: ACTOR_MAXIMUM_SLOPE_DEGREES,
      checkGround: true,
      includeSolids: true,
    });
    return !safe.blocked && this.options.motion.sweepCapsule(generation, from, to).clear;
  }

  private tryRestoreActor(anchor: ParkedShipAnchor): void {
    const actor = this.pendingActor;
    const leaseId = this.actorLeaseId;
    const generation = leaseId ? this.options.contact.getGeneration(leaseId) : null;
    if (!actor || actor.bodyId !== anchor.bodyId || !leaseId) {
      this.returnInside(false);
      return;
    }
    if (!generation || !this.options.motion.isReady(generation.id)) return;
    const support = this.options.contact.sample(actor.bodyId, actor.bodyFixedCenterMeters, {
      leaseId, radiusMeters: ACTOR_CAPSULE_RADIUS_METERS, includeSolids: false,
    });
    if (!support?.ready || support.generationId !== generation.id) return;
    if (support.hazard !== 'none' || support.slopeDegrees > ACTOR_MAXIMUM_SLOPE_DEGREES ||
        support.altitudeMeters < ACTOR_CAPSULE_HALF_HEIGHT_METERS - 0.025 ||
        support.altitudeMeters > 8 || !this.options.motion.canOccupy(generation, actor.bodyFixedCenterMeters) ||
        !this.onFoot.attach(actor, leaseId)) {
      this.returnInside(false);
      this.blockingReason = 'saved-surface-position-unsafe';
      return;
    }
    this.pendingActor = undefined;
    this.pendingRestore = false;
    this.currentPhase = 'outside';
    this.elapsedSeconds = 0;
    this.lastOccupancyEvent = 'none';
    this.blockingReason = undefined;
    this.seenFootstepSerial = 0;
  }

  private boardingStatus(): { eligible: boolean; reason: string; distanceMeters?: number } {
    if (this.currentPhase !== 'outside') return { eligible: false, reason: 'not-outside' };
    const actor = this.onFoot.state;
    const anchor = this.options.getParkedAnchor();
    const kit = this.options.getSurfaceKit();
    if (!actor || !anchor || !this.options.isParkedAndSettled() || !validKitForAnchor(kit, anchor) ||
        actor.bodyId !== anchor.bodyId) return { eligible: false, reason: 'parked-ship-unavailable' };
    const local = bodyFixedPointToShipLocal(anchor, actor.bodyFixedCenterMeters);
    const delta = subVec3(local, kit.boardingVolumeMeters.centerMeters);
    const half = kit.boardingVolumeMeters.halfExtentsMeters;
    const distanceMeters = lengthVec3(delta);
    const inside = Math.abs(delta.x) <= half.x && Math.abs(delta.y) <= half.y && Math.abs(delta.z) <= half.z;
    if (!inside) return { eligible: false, reason: 'return-to-boarding-ramp', distanceMeters };
    if (!actor.grounded) return { eligible: false, reason: 'stand-on-safe-ground', distanceMeters };
    return { eligible: true, reason: 'ready', distanceMeters };
  }

  private installShipObstacles(anchor: ParkedShipAnchor, kit: SurfaceEgressKit): void {
    if (this.obstacleBodyId && this.obstacleBodyId !== anchor.bodyId) {
      this.options.motion.clearAdditionalObstacles(this.obstacleBodyId);
    }
    const up = normalizeVec3(anchor.supportNormalBodyFixed);
    const forward = tangentHeading(anchor.bodyFixedForward, up);
    const right = normalizeVec3(crossVec3(forward, up));
    const aft = scaleVec3(forward, -1);
    const boxes: SurfaceMotionBox[] = kit.collisionProxyMeters.map((box) => ({
      id: `aurora:${box.id}`,
      centerBodyFixedMeters: localPoint(anchor, box.centerMeters),
      halfExtentsMeters: box.halfExtentsMeters,
      rightBodyFixed: right,
      upBodyFixed: up,
      forwardBodyFixed: aft,
    }));
    const rampStart = localPoint(anchor, kit.rampSurfaceMeters.startMeters);
    const rampEnd = localPoint(anchor, kit.rampSurfaceMeters.endMeters);
    const rampAlong = normalizeVec3(subVec3(rampEnd, rampStart));
    const rampNormal = normalizeVec3(crossVec3(rampAlong, right));
    const rampThickness = kit.rampSurfaceMeters.thicknessMeters;
    boxes.push({
      id: 'aurora:deployed-ramp',
      centerBodyFixedMeters: addVec3(lerpVec3(rampStart, rampEnd, 0.5), scaleVec3(rampNormal, -rampThickness * 0.5)),
      halfExtentsMeters: vec3(kit.rampSurfaceMeters.widthMeters * 0.5, rampThickness * 0.5,
        lengthVec3(subVec3(rampEnd, rampStart)) * 0.5),
      rightBodyFixed: right,
      upBodyFixed: rampNormal,
      forwardBodyFixed: rampAlong,
    });
    this.options.motion.setAdditionalObstacles(anchor.bodyId, boxes);
    this.obstacleBodyId = anchor.bodyId;
  }

  private transitionPose(): SurfaceTransitionPose | undefined {
    if (this.currentPhase !== 'egressing' && this.currentPhase !== 'boarding') return undefined;
    const anchor = this.options.getParkedAnchor();
    const kit = this.options.getSurfaceKit();
    if (!anchor || !validKitForAnchor(kit, anchor) || !this.pendingActor) return undefined;
    const progress = smoothstep(this.phaseProgress());
    const railFraction = this.currentPhase === 'boarding' ? 1 - progress : progress;
    const points = kit.egressRailMeters.map((point) => localPoint(anchor, point.positionMeters));
    if (points.length < 2) return undefined;
    points[0] = localPoint(anchor, kit.pilotEyeMeters);
    points[points.length - 1] = actorEyeBodyFixed(this.pendingActor);
    let eye = sampleRail(points, railFraction);
    if (this.currentPhase === 'boarding' && this.boardingStartActor && progress < 0.25) {
      eye = lerpVec3(actorEyeBodyFixed(this.boardingStartActor), eye, smoothstep(progress / 0.25));
    }
    const radialUp = normalizeVec3(eye);
    let forward = tangentHeading(rotateAroundAxis(anchor.bodyFixedForward, radialUp, Math.PI * railFraction), radialUp);
    if (this.currentPhase === 'boarding' && this.boardingStartActor && progress < 0.25) {
      forward = tangentHeading(lerpVec3(this.boardingStartActor.tangentForwardBodyFixed, forward,
        smoothstep(progress / 0.25)), radialUp);
    }
    const right = normalizeVec3(crossVec3(forward, radialUp));
    const up = normalizeVec3(crossVec3(right, forward));
    const firstExterior = Math.max(1, kit.egressRailMeters.findIndex((point) => point.stage === 'exterior'));
    const exteriorFraction = firstExterior / (kit.egressRailMeters.length - 1);
    const fadeOpacity = railFraction < exteriorFraction
      ? smoothstep(railFraction / Math.max(0.01, exteriorFraction * 0.45))
      : 1 - smoothstep((railFraction - exteriorFraction) / Math.max(0.1, (1 - exteriorFraction) * 0.55));
    return {
      bodyId: anchor.bodyId,
      eyeBodyFixedMeters: eye,
      forwardBodyFixed: forward,
      upBodyFixed: up,
      rightBodyFixed: right,
      railFraction,
      fadeOpacity,
    };
  }

  private phaseProgress(): number {
    if (this.currentPhase === 'egressing') return Math.min(1, this.elapsedSeconds / EGRESS_DURATION_SECONDS);
    if (this.currentPhase === 'boarding') return Math.min(1, this.elapsedSeconds / BOARDING_DURATION_SECONDS);
    return this.currentPhase === 'exit-prewarm' ? 0 : 1;
  }

  private transitionTo(phase: OccupancyPhase, event: SurfaceOccupancyEvent): void {
    this.currentPhase = phase;
    this.elapsedSeconds = 0;
    this.recordEvent(event);
  }

  private recordEvent(event: SurfaceOccupancyEvent): void {
    this.lastOccupancyEvent = event;
    this.occupancyEventSerial += 1;
  }

  private returnInside(restoreView: boolean): void {
    const leaseId = this.actorLeaseId;
    this.onFoot.detach();
    this.actorLeaseId = undefined;
    if (leaseId) this.options.contact.releaseLease(leaseId);
    if (this.obstacleBodyId) this.options.motion.clearAdditionalObstacles(this.obstacleBodyId);
    this.obstacleBodyId = undefined;
    this.pendingActor = undefined;
    this.pendingRestore = false;
    this.boardingStartActor = undefined;
    this.currentPhase = 'inside';
    this.elapsedSeconds = 0;
    this.blockingReason = undefined;
    this.seenFootstepSerial = 0;
    if (restoreView) this.options.restoreViewMode?.(this.previousViewMode);
  }

  dispose(): void {
    if (this.disposed) return;
    this.returnInside(false);
    this.disposed = true;
  }
}

function validKitForAnchor(kit: SurfaceEgressKit | undefined, anchor: ParkedShipAnchor): kit is SurfaceEgressKit {
  return Boolean(kit && kit.surfaceKitVersion === anchor.surfaceKitVersion &&
    kit.egressRailMeters.length >= 2 && kit.egressRailMeters.some((point) => point.stage === 'exterior'));
}

function localPoint(anchor: ParkedShipAnchor, local: Readonly<Vec3>): Vec3 {
  return addVec3(anchor.bodyFixedOriginMeters,
    shipLocalToBodyFixedOffset(local, anchor.bodyFixedForward, anchor.supportNormalBodyFixed));
}

export function bodyFixedPointToShipLocal(anchor: ParkedShipAnchor, point: Readonly<Vec3>): Vec3 {
  const up = normalizeVec3(anchor.supportNormalBodyFixed);
  const forward = tangentHeading(anchor.bodyFixedForward, up);
  const right = normalizeVec3(crossVec3(forward, up));
  const relative = subVec3(point, anchor.bodyFixedOriginMeters);
  return vec3(dotVec3(relative, right), dotVec3(relative, up), -dotVec3(relative, forward));
}

function actorEyeBodyFixed(actor: SurfaceActorState): Vec3 {
  return addVec3(actor.bodyFixedCenterMeters, scaleVec3(normalizeVec3(actor.bodyFixedCenterMeters),
    ACTOR_EYE_HEIGHT_METERS - ACTOR_CAPSULE_HALF_HEIGHT_METERS));
}

function eyeToCapsuleCenter(eye: Readonly<Vec3>): Vec3 {
  return addVec3(eye, scaleVec3(normalizeVec3(eye),
    ACTOR_CAPSULE_HALF_HEIGHT_METERS - ACTOR_EYE_HEIGHT_METERS));
}

function sampleRail(points: readonly Vec3[], fraction: number): Vec3 {
  const scaled = Math.max(0, Math.min(1, fraction)) * (points.length - 1);
  const index = Math.min(points.length - 2, Math.floor(scaled));
  return lerpVec3(points[index]!, points[index + 1]!, scaled - index);
}

function rotateAroundAxis(value: Readonly<Vec3>, axis: Readonly<Vec3>, angle: number): Vec3 {
  return addVec3(scaleVec3(value, Math.cos(angle)), addVec3(
    scaleVec3(crossVec3(axis, value), Math.sin(angle)),
    scaleVec3(axis, dotVec3(axis, value) * (1 - Math.cos(angle))),
  ));
}

function smoothstep(value: number): number {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
}

function accepted(reason: string): SurfaceCommandResult { return { accepted: true, reason }; }
function rejected(reason: string): SurfaceCommandResult { return { accepted: false, reason }; }
function failedAssessment(reason: string): EgressAssessment { return { accepted: false, reason }; }

export { getSurfaceActorObserverPose };
