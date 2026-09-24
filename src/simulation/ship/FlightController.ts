import {
  addAddressOffset,
  addVec3,
  AU_METERS,
  cloneAddress,
  crossVec3,
  deserializeAddress,
  distanceBetweenAddresses,
  distanceVec3,
  dotVec3,
  lengthVec3,
  normalizeVec3,
  rotateAroundYAxis,
  scaleVec3,
  serializeAddress,
  SPEED_OF_LIGHT,
  subVec3,
  subtractAddresses,
  vec3,
  type GalacticAddress,
  type Vec3,
} from "../../core";
import { createPlanetField, samplePlanetField, type PlanetField } from "../../fields";
import {
  CONTRAST_SYSTEM_ID,
  HERO_PLANET_ID,
  supportsAtmosphericClouds,
  type BodyPose,
  type PlanetDescriptor,
  type StarSystem,
  type SystemSnapshot,
  UniverseCatalog,
} from "../../universe";
import { estimateArrivalSeconds as estimateRouteArrival, headingToTarget } from "../navigation/InterceptSolver";
import { isWithinPulseArrival, pulseArrivalRadiusMeters, pulseArrivalToleranceMeters } from "../travel/PulseDrive";
import {
  FLIGHT_MODE_PROFILES,
  isFasterThanLight,
  MANUAL_COAST_HALF_LIFE_SECONDS,
  MANUAL_COAST_STOP_SPEED_METERS_PER_SECOND,
  moveToward,
  type FlightMode,
} from "./FlightModes";
import {
  emptyFlightInput,
  type BodyFixedLandingAnchor,
  type FlightInputAction,
  type FlightInputState,
  type ParkedShipAnchor,
  type SerializedFlightState,
  type ShipState,
  type SurfacePhase,
} from "./ShipState";
import { findFirstSweptCollision, maximumSafeBrakingSpeed, type SafetySphere } from "./SafetyEnvelope";

const MAXIMUM_PITCH_RADIANS = Math.PI * 0.48;

/** Local-flight attitude assist; translation and guided travel use separate laws. */
export const MANUAL_STEERING_PROFILE = Object.freeze({
  maximumYawRadiansPerSecond: 1.05,
  maximumPitchRadiansPerSecond: 0.85,
  accelerationResponsePerSecond: 6,
  brakingResponsePerSecond: 8,
  nearSurfaceRateScale: 0.75,
  nearSurfaceClearanceMeters: 250,
  fullRateClearanceMeters: 3_000,
  pointerQueueLimitRadians: 0.18,
  pointerNaturalFrequency: 18,
  automaticBankRadians: 0.36,
  manualBankRadians: 0.68,
  rollResponsePerSecond: 6,
  maximumRollRadiansPerSecond: 1.35,
});

interface ManualPointerAxis {
  remainingRadians: number;
  velocityRadiansPerSecond: number;
}

interface ManualAngularStep {
  deltaRadians: number;
  velocityRadiansPerSecond: number;
}

export interface ManualSteeringDiagnostics {
  readonly rateScale: number;
  readonly yawRadiansPerSecond: number;
  readonly pitchRadiansPerSecond: number;
  readonly keyboardYawRadiansPerSecond: number;
  readonly keyboardPitchRadiansPerSecond: number;
  readonly pointerYawRemainingRadians: number;
  readonly pointerPitchRemainingRadians: number;
  readonly pointerYawRadiansPerSecond: number;
  readonly pointerPitchRadiansPerSecond: number;
}

const PULSE_PRESENTATION_MINIMUM_SECONDS = 1.25;
const HYPERDRIVE_PRESENTATION_MINIMUM_SECONDS = 1.8;
const AUTOPILOT_DEPARTURE_MAXIMUM_SPEED = 3_800_000;
const AUTOPILOT_DEPARTURE_ACCELERATION = 6_400_000;
const AUTOPILOT_DEPARTURE_ALIGNMENT = 0.995;
const WORLD_UP = Object.freeze(vec3(0, 1, 0));

type DeparturePhase = "launching" | "clearing" | "aligning";

interface DepartureAutopilot {
  bodyId: string;
  clearanceRadiusMeters: number;
  physicalBodyRadiusMeters: number;
  phase: DeparturePhase;
}

/** Physical KeyboardEvent.code keeps Z/Q/W/A layout differences predictable. */
export const DEFAULT_FLIGHT_KEY_BINDINGS: Readonly<Record<string, FlightInputAction>> = Object.freeze({
  KeyW: "pitchUp",
  KeyZ: "pitchUp",
  KeyS: "pitchDown",
  KeyA: "turnLeft",
  KeyD: "turnRight",
  ArrowLeft: "turnLeft",
  ArrowRight: "turnRight",
  ArrowUp: "pitchUp",
  ArrowDown: "pitchDown",
  KeyQ: "rollLeft",
  KeyE: "rollRight",
  Space: "accelerate",
  ControlLeft: "brake",
  ControlRight: "brake",
  KeyF: "ascend",
  PageUp: "ascend",
  KeyC: "descend",
  PageDown: "descend",
  ShiftLeft: "boost",
  ShiftRight: "boost",
});

export interface FlightControllerOptions {
  catalog: UniverseCatalog;
  system?: StarSystem;
  initialPosition?: Vec3;
  targetId?: string;
  /** Signed dry-ground or actual wet-surface flight envelope above the reference radius, in meters. */
  sampleSurfaceHeightMeters?: (planet: PlanetDescriptor, bodyFixedDirection: Vec3) => number;
  /** Signed dry-ground or known ocean-surface clearance, independent of coarse collision policy. */
  sampleManualSteeringClearanceMeters?: (planet: PlanetDescriptor, bodyFixedPositionMeters: Vec3) => number | undefined;
  onSystemChanged?: (system: StarSystem) => void;
}

export interface KeyboardBindingOptions {
  /** Applications commonly own drive/landing shortcuts so they can display notifications. */
  handleCommands?: boolean;
  /** Optional physical-key overrides, without mutating application/global defaults. */
  bindings?: Partial<Record<string, FlightInputAction>>;
}

/** Meter-space motion already swept against the active body's committed contact surface. */
export interface SurfaceFlightPose {
  bodyId: string;
  bodyFixedOriginMeters: Vec3;
  bodyFixedForward: Vec3;
  supportNormalBodyFixed: Vec3;
  bodyFixedVelocityMetersPerSecond: Vec3;
}

/** Navigation data is derived from the same canonical moving-body target as flight. */
export interface FlightGuidance {
  targetId: string;
  targetKind: "body" | "system";
  direction: Vec3;
  distanceMeters: number;
  surfaceDistanceMeters: number;
  captureRadiusMeters: number;
  alignment: number;
  angularErrorRadians: number;
  closingSpeedMetersPerSecond: number;
  etaSeconds: number;
  phase: ShipState["phase"];
  withinCapture: boolean;
  /** A blocked near-surface launch stays visible before normal FTL spool. */
  departurePhase?: DeparturePhase;
  /** The real solid body whose surface/exclusion the autopilot is clearing. */
  departureBodyId?: string;
  /** Required physical departure altitude above that body's reference radius. */
  departureClearanceMeters?: number;
}

export class FlightController {
  readonly state: ShipState;
  readonly input: FlightInputState = emptyFlightInput();
  private readonly catalog: UniverseCatalog;
  private readonly sampleSurfaceHeightMeters?: FlightControllerOptions["sampleSurfaceHeightMeters"];
  private readonly sampleManualSteeringClearanceMeters?: FlightControllerOptions["sampleManualSteeringClearanceMeters"];
  private readonly onSystemChanged?: FlightControllerOptions["onSystemChanged"];
  private keyboardTarget?: EventTarget;
  private keyboardHandlesCommands = false;
  private keyboardBindings: Record<string, FlightInputAction> = { ...DEFAULT_FLIGHT_KEY_BINDINGS };
  private lastSimulationTimeSeconds = 0;
  private travelInitialDistanceMeters = 0;
  private destinationSystemId?: string;
  private guidedInitialRemainingMeters = 0;
  private guidedElapsedSeconds = 0;
  private guidedDurationSeconds = 0;
  private previousGuidedTarget?: GalacticAddress;
  private yawVelocityRadiansPerSecond = 0;
  private pitchVelocityRadiansPerSecond = 0;
  private readonly pointerYaw: ManualPointerAxis = { remainingRadians: 0, velocityRadiansPerSecond: 0 };
  private readonly pointerPitch: ManualPointerAxis = { remainingRadians: 0, velocityRadiansPerSecond: 0 };
  private achievedYawRadiansPerSecond = 0;
  private achievedPitchRadiansPerSecond = 0;
  private steeringRateScale = 1;
  private manualSteeringFallbackField?: { bodyId: string; field: PlanetField };
  private heldThrottle: number | undefined;
  private departureAutopilot?: DepartureAutopilot;

  constructor(options: FlightControllerOptions) {
    this.catalog = options.catalog;
    this.sampleSurfaceHeightMeters = options.sampleSurfaceHeightMeters;
    this.sampleManualSteeringClearanceMeters = options.sampleManualSteeringClearanceMeters;
    this.onSystemChanged = options.onSystemChanged;
    const system = options.system ?? options.catalog.heroSystem;
    const snapshot = options.catalog.evaluateSystem(system, 0);
    const startingBody = snapshot.poses.get(options.targetId ?? HERO_PLANET_ID) ?? snapshot.planets[0];
    const body = startingBody ? options.catalog.getPlanet(startingBody.id) : undefined;
    const position = options.initialPosition ?? (
      startingBody && body
        ? addVec3(startingBody.localPositionMeters, vec3(body.radiusMeters * 2.4, body.radiusMeters * 0.8, body.radiusMeters * 3.4))
        : vec3(20_000_000, 5_000_000, 30_000_000)
    );
    const targetPosition = startingBody?.localPositionMeters ?? vec3();
    const heading = headingToTarget(position, targetPosition);

    this.state = {
      position: { ...position },
      address: addAddressOffset(system.position, position),
      velocity: vec3(),
      forward: forwardFromAngles(heading.yawRadians, heading.pitchRadians),
      referenceUp: { ...WORLD_UP },
      surfaceUp: { ...WORLD_UP },
      surfaceInfluence: 0,
      yaw: heading.yawRadians,
      pitch: heading.pitchRadians,
      roll: 0,
      speedMetersPerSecond: 0,
      mode: "cruise",
      phase: "idle",
      systemId: system.id,
      targetId: options.targetId ?? startingBody?.id,
      surfacePhase: "airborne",
      landed: false,
      throttle: 0,
      spoolProgress: 0,
      travelProgress: 0,
    };
    this.updateReferenceFrame(snapshot, 0, true);
  }

  get currentSystem(): StarSystem {
    return this.catalog.requireSystem(this.state.systemId);
  }

  /** The ephemeris epoch of the current canonical ship pose. */
  get simulationEpochSeconds(): number {
    return this.lastSimulationTimeSeconds;
  }

  get manualSteeringDiagnostics(): ManualSteeringDiagnostics {
    return {
      rateScale: this.steeringRateScale,
      yawRadiansPerSecond: this.achievedYawRadiansPerSecond,
      pitchRadiansPerSecond: this.achievedPitchRadiansPerSecond,
      keyboardYawRadiansPerSecond: this.yawVelocityRadiansPerSecond,
      keyboardPitchRadiansPerSecond: this.pitchVelocityRadiansPerSecond,
      pointerYawRemainingRadians: this.pointerYaw.remainingRadians,
      pointerPitchRemainingRadians: this.pointerPitch.remainingRadians,
      pointerYawRadiansPerSecond: this.pointerYaw.velocityRadiansPerSecond,
      pointerPitchRadiansPerSecond: this.pointerPitch.velocityRadiansPerSecond,
    };
  }

  /** Clear only attitude intent on an input-owner change; never discard real momentum. */
  clearManualSteering(): void {
    this.yawVelocityRadiansPerSecond = 0;
    this.pitchVelocityRadiansPerSecond = 0;
    this.pointerYaw.remainingRadians = 0;
    this.pointerYaw.velocityRadiansPerSecond = 0;
    this.pointerPitch.remainingRadians = 0;
    this.pointerPitch.velocityRadiansPerSecond = 0;
    this.achievedYawRadiansPerSecond = 0;
    this.achievedPitchRadiansPerSecond = 0;
  }

  /** Queue a finite manual mouse/gamepad look delta for the fixed-step attitude assist. */
  queueManualSteer(yawDeltaRadians: number, pitchDeltaRadians: number): boolean {
    if (!Number.isFinite(yawDeltaRadians) || !Number.isFinite(pitchDeltaRadians) ||
        this.state.landed || this.state.surfacePhase !== "airborne" || isFasterThanLight(this.state.mode)) return false;
    const limit = MANUAL_STEERING_PROFILE.pointerQueueLimitRadians;
    this.pointerYaw.remainingRadians = clampManualAngle(this.pointerYaw.remainingRadians + yawDeltaRadians, limit);
    this.pointerPitch.remainingRadians = clampManualAngle(this.pointerPitch.remainingRadians + pitchDeltaRadians, limit);
    return true;
  }

  /** Release controls when another input/motion owner takes the ship. */
  clearInput(): void {
    for (const action of Object.keys(this.input) as FlightInputAction[]) this.input[action] = false;
    this.heldThrottle = undefined;
    this.clearManualSteering();
    this.state.throttle = 0;
  }

  beginSurfaceControl(phase: SurfacePhase): void {
    this.setMode("cruise");
    this.clearInput();
    this.state.surfacePhase = phase;
  }

  /**
   * Integrate an explicitly body-fixed surface pose. Only the named source
   * body's coarse 20 m flight sphere is replaced by the caller's exact pad /
   * hull sweep; every other real solid keeps normal swept-body protection.
   * Velocity remains the transport-relative propulsion velocity used by local
   * flight, while canonical position includes actual orbital and spin motion.
   */
  applySurfacePose(
    surface: SurfaceFlightPose,
    simulationEpochSeconds: number,
    options: { restoring?: boolean } = {},
  ): boolean {
    const body = this.catalog.getPlanet(surface.bodyId);
    const owner = this.catalog.getSystemForBody(surface.bodyId);
    if (!body?.isLandable || owner?.id !== this.state.systemId || !Number.isFinite(simulationEpochSeconds)) return false;
    const snapshot = this.catalog.evaluateSystem(this.currentSystem, simulationEpochSeconds);
    const pose = snapshot.poses.get(surface.bodyId);
    if (!pose) return false;
    const destinationAddress = addAddressOffset(
      pose.position,
      rotateAroundYAxis(surface.bodyFixedOriginMeters, pose.rotationRadians),
    );
    const destination = subtractAddresses(destinationAddress, snapshot.system.position);
    if (!options.restoring) {
      // Sweep at one ephemeris epoch. Otherwise orbital motion between steps
      // would look like a giant, fictitious movement through the source world.
      const previousPose = this.catalog.getBodyPose(surface.bodyId, this.lastSimulationTimeSeconds);
      const previousFixed = previousPose
        ? rotateAroundYAxis(subtractAddresses(this.state.address, previousPose.position), -previousPose.rotationRadians)
        : surface.bodyFixedOriginMeters;
      const carriedStart = subtractAddresses(addAddressOffset(
        pose.position,
        rotateAroundYAxis(previousFixed, pose.rotationRadians),
      ), snapshot.system.position);
      const collision = findFirstSweptCollision(
        carriedStart,
        destination,
        this.safetySpheres(snapshot).filter((sphere) => sphere.id !== surface.bodyId),
      );
      if (collision) {
        this.lastSimulationTimeSeconds = simulationEpochSeconds;
        this.setCanonicalAddress(addAddressOffset(snapshot.system.position, carriedStart));
        this.state.velocity = vec3();
        this.state.speedMetersPerSecond = 0;
        this.state.throttle = 0;
        this.updateProximity(snapshot);
        return false;
      }
    }
    this.lastSimulationTimeSeconds = simulationEpochSeconds;
    this.setCanonicalAddress(destinationAddress);
    this.state.forward = normalizeVec3(rotateAroundYAxis(surface.bodyFixedForward, pose.rotationRadians));
    this.state.referenceUp = normalizeVec3(rotateAroundYAxis(surface.supportNormalBodyFixed, pose.rotationRadians));
    this.state.surfaceUp = normalizeVec3(rotateAroundYAxis(surface.bodyFixedOriginMeters, pose.rotationRadians));
    this.state.surfaceInfluence = 1;
    this.state.velocity = rotateAroundYAxis(surface.bodyFixedVelocityMetersPerSecond, pose.rotationRadians);
    this.state.speedMetersPerSecond = lengthVec3(this.state.velocity);
    const orientation = headingToTarget(vec3(), this.state.forward);
    this.state.yaw = orientation.yawRadians;
    this.state.pitch = orientation.pitchRadians;
    this.state.roll = 0;
    this.updateProximity(snapshot);
    return true;
  }

  /** Commit only after real feet contact. This never adds an invented altitude. */
  commitParkedAnchor(anchor: ParkedShipAnchor, simulationEpochSeconds: number, restoring = false): boolean {
    const body = this.catalog.getPlanet(anchor.bodyId);
    if (!body) return false;
    if (!this.applySurfacePose({
      ...anchor,
      bodyFixedVelocityMetersPerSecond: vec3(),
    }, simulationEpochSeconds, { restoring })) return false;
    const direction = normalizeVec3(anchor.bodyFixedOriginMeters);
    this.state.parkedAnchor = cloneParkedAnchor(anchor);
    this.state.landedAnchor = {
      bodyId: anchor.bodyId,
      surfaceDirection: direction,
      altitudeMeters: lengthVec3(anchor.bodyFixedOriginMeters) - body.radiusMeters - this.surfaceHeight(body, direction),
      latitudeRadians: Math.asin(Math.max(-1, Math.min(1, direction.y))),
      longitudeRadians: Math.atan2(direction.z, direction.x),
    };
    this.state.landedBodyId = anchor.bodyId;
    this.state.landed = true;
    this.clearInput();
    return true;
  }

  /** Detach at the current canonical pose; ascent has already happened. */
  releaseParkedAnchor(): void {
    this.state.landed = false;
    this.state.landedBodyId = undefined;
    this.state.landedAnchor = undefined;
    this.state.parkedAnchor = undefined;
  }

  setInput(action: FlightInputAction, active: boolean): void {
    this.input[action] = active;
    if (action === "boost" && !isFasterThanLight(this.state.mode) && !this.state.landed) {
      this.setMode(active ? "boost" : "cruise");
    }
  }

  /** Exact body-relative radial up; the smoother camera frame is state.referenceUp. */
  getSurfaceUp(): Vec3 {
    return { ...this.state.surfaceUp };
  }

  /** Reconcile a deliberately repositioned ship without changing real continuous-flight smoothing. */
  snapReferenceFrame(simulationEpochSeconds = this.lastSimulationTimeSeconds): Vec3 {
    // Explicit restores/repositions already express their canonical ship position
    // at this epoch. Their next frame must inherit one real carrier step, not
    // replay all orbital/spin motion accumulated since construction at time zero.
    this.lastSimulationTimeSeconds = simulationEpochSeconds;
    const snapshot = this.catalog.evaluateSystem(this.currentSystem, simulationEpochSeconds);
    this.updateReferenceFrame(snapshot, 0, true);
    return { ...this.state.referenceUp };
  }

  /** Persistent cruise setting for mouse-wheel/gamepad controls. */
  setThrottle(value: number): boolean {
    if (!Number.isFinite(value) || this.state.landed || isFasterThanLight(this.state.mode)) return false;
    this.heldThrottle = Math.max(0, Math.min(1, value));
    this.state.throttle = this.heldThrottle;
    return true;
  }

  /** Signed fractional throttle adjustment; positive accelerates and negative brakes. */
  adjustThrottle(delta: number): boolean {
    return Number.isFinite(delta) && this.setThrottle((this.heldThrottle ?? this.state.throttle) + delta);
  }

  /**
   * Apply an immediate body-relative attitude delta for analytic integration
   * and explicit setup. Positive yaw turns left; positive pitch raises the
   * nose. Player pointer events use queueManualSteer with those same signs.
   */
  steer(yawDeltaRadians: number, pitchDeltaRadians: number): boolean {
    if (
      !Number.isFinite(yawDeltaRadians) ||
      !Number.isFinite(pitchDeltaRadians) ||
      isFasterThanLight(this.state.mode)
    ) return false;

    let direction = forwardFromAngles(this.state.yaw, this.state.pitch);
    if (Math.abs(yawDeltaRadians) > 1e-12) {
      direction = rotateAroundUnitAxis(direction, this.state.referenceUp, yawDeltaRadians);
    }
    if (Math.abs(pitchDeltaRadians) > 1e-12) {
      let right = crossVec3(direction, this.state.referenceUp);
      if (lengthVec3(right) < 1e-7) {
        right = crossVec3(direction, Math.abs(direction.x) < 0.8 ? vec3(1, 0, 0) : vec3(0, 0, 1));
      }
      const pitched = rotateAroundUnitAxis(direction, normalizeVec3(right), pitchDeltaRadians);
      const currentAlignment = Math.abs(dotVec3(direction, this.state.referenceUp));
      const candidateAlignment = Math.abs(dotVec3(pitched, this.state.referenceUp));
      if (candidateAlignment < 0.9996 || candidateAlignment < currentAlignment) direction = pitched;
    }

    const orientation = headingToTarget(vec3(), direction);
    this.state.yaw = orientation.yawRadians;
    this.state.pitch = Math.max(-MAXIMUM_PITCH_RADIANS, Math.min(MAXIMUM_PITCH_RADIANS, orientation.pitchRadians));
    this.state.forward = forwardFromAngles(this.state.yaw, this.state.pitch);
    return true;
  }

  setTarget(targetId: string | undefined): boolean {
    if (targetId !== undefined && !this.catalog.getSystem(targetId) && !this.catalog.getBody(targetId)) return false;
    this.state.targetId = targetId;
    return true;
  }

  setMode(mode: FlightMode): boolean {
    const previousMode = this.state.mode;
    if (mode === "hyperdrive") {
      const targetSystem = this.targetSystemId();
      if (!targetSystem || targetSystem === this.state.systemId) return false;
      this.destinationSystemId = targetSystem;
    }
    if (mode === "pulse") {
      const owner = this.state.targetId ? this.catalog.getSystemForBody(this.state.targetId) : undefined;
      if (!this.state.targetId || !owner || owner.id !== this.state.systemId) return false;
      const target = this.catalog.getBody(this.state.targetId);
      const targetAddress = this.catalog.getBodyAddress(this.state.targetId, this.lastSimulationTimeSeconds);
      const distance = targetAddress ? distanceBetweenAddresses(targetAddress, this.state.address) : undefined;
      if (distance !== undefined && isWithinPulseArrival(distance, pulseArrivalRadiusMeters(target))) {
        // A framing shell is an arrival boundary, not a demand to retreat.
        // Settle an already-reached command before the legacy landed/departure
        // path can launch the ship into an unnecessary outward-and-back arc.
        this.setMode("cruise");
        this.heldThrottle = undefined;
        this.clearManualSteering();
        this.completeGuidedTravel();
        return true;
      }
    }
    if (this.state.landed && mode !== "cruise") {
      if (!isFasterThanLight(mode) || !this.takeoff()) return false;
    }

    if (isFasterThanLight(previousMode) && !isFasterThanLight(mode)) {
      const maximumLocalSpeed = FLIGHT_MODE_PROFILES[mode].maximumSpeedMetersPerSecond;
      this.state.speedMetersPerSecond = Math.min(this.state.speedMetersPerSecond, maximumLocalSpeed);
      this.state.velocity = scaleVec3(this.state.forward, this.state.speedMetersPerSecond);
      this.state.throttle = Math.min(1, this.state.speedMetersPerSecond / maximumLocalSpeed);
    }
    this.state.mode = mode;
    this.state.spoolProgress = 0;
    this.state.travelProgress = 0;
    this.state.phase = isFasterThanLight(mode) ? "spooling" : "idle";
    this.travelInitialDistanceMeters = this.targetDistanceMeters() ?? 0;
    this.guidedElapsedSeconds = 0;
    this.previousGuidedTarget = undefined;
    this.guidedInitialRemainingMeters = Math.max(0, this.travelInitialDistanceMeters - this.captureRadiusMeters());
    this.guidedDurationSeconds = mode === "pulse"
      ? PULSE_PRESENTATION_MINIMUM_SECONDS + this.guidedInitialRemainingMeters / (220 * SPEED_OF_LIGHT)
      : mode === "hyperdrive"
        ? HYPERDRIVE_PRESENTATION_MINIMUM_SECONDS + this.guidedInitialRemainingMeters / (25_000_000 * SPEED_OF_LIGHT)
        : 0;
    if (!isFasterThanLight(mode)) this.destinationSystemId = undefined;
    if (!isFasterThanLight(mode)) this.departureAutopilot = undefined;
    if (isFasterThanLight(mode)) {
      this.heldThrottle = undefined;
      this.clearManualSteering();
    }
    if (isFasterThanLight(mode)) this.configureDepartureAutopilot();
    return true;
  }

  togglePulse(): boolean {
    return this.state.mode === "pulse" ? this.setMode("cruise") : this.setMode("pulse");
  }

  initiateHyperdrive(systemId: string): boolean {
    const system = this.catalog.getSystem(systemId);
    if (!system || system.id === this.state.systemId) return false;
    this.state.targetId = system.id;
    return this.setMode("hyperdrive");
  }

  /** One action locks a real local world or an actual interstellar destination. */
  engageTargetApproach(targetId = this.state.targetId): boolean {
    if (!targetId || !this.setTarget(targetId)) return false;
    const system = this.catalog.getSystem(targetId);
    if (system) return this.initiateHyperdrive(system.id);
    const owner = this.catalog.getSystemForBody(targetId);
    if (!owner) return false;
    return owner.id === this.state.systemId ? this.setMode("pulse") : this.initiateHyperdrive(owner.id);
  }

  /** Player controls use real elapsed seconds; celestial poses may advance at an independent rate. */
  update(deltaSeconds: number, simulationTimeSeconds: number): ShipState {
    const delta = Math.min(Math.max(deltaSeconds, 0), 0.25);
    const previousSimulationTimeSeconds = this.lastSimulationTimeSeconds;
    this.lastSimulationTimeSeconds = simulationTimeSeconds;
    if (delta === 0) return this.state;

    const snapshot = this.catalog.evaluateSystem(this.currentSystem, simulationTimeSeconds);
    this.updateReferenceFrame(snapshot, delta);
    if (this.state.landed) {
      this.updateLandedPosition(snapshot);
      this.updateProximity(snapshot);
      return this.state;
    }

    if (isFasterThanLight(this.state.mode)) {
      if (this.departureAutopilot || this.state.phase === "spooling") {
        this.inheritNearbyOrbitalMotion(snapshot, previousSimulationTimeSeconds);
      }
      this.updateGuidedTravel(delta, snapshot);
    }
    else {
      this.inheritNearbyOrbitalMotion(snapshot, previousSimulationTimeSeconds);
      this.updateManualFlight(delta, snapshot);
    }

    const updatedSnapshot = this.state.systemId === snapshot.system.id
      ? snapshot
      : this.catalog.evaluateSystem(this.currentSystem, simulationTimeSeconds);
    this.updateProximity(updatedSnapshot);
    return this.state;
  }

  land(): boolean {
    if (this.state.landed) return true;
    const snapshot = this.catalog.evaluateSystem(this.currentSystem, this.lastSimulationTimeSeconds);
    const nearest = this.findNearestLandableBody(snapshot);
    if (!nearest) return false;
    const { descriptor, pose, direction, altitudeMeters } = nearest;
    if (altitudeMeters > 320 || this.state.speedMetersPerSecond > 95) return false;

    const bodyFixedDirection = rotateAroundYAxis(direction, -pose.rotationRadians);
    const anchor: BodyFixedLandingAnchor = {
      bodyId: descriptor.id,
      surfaceDirection: bodyFixedDirection,
      altitudeMeters: 8,
      latitudeRadians: Math.asin(Math.max(-1, Math.min(1, bodyFixedDirection.y))),
      longitudeRadians: Math.atan2(bodyFixedDirection.z, bodyFixedDirection.x),
    };
    this.state.landed = true;
    this.state.surfacePhase = "parked";
    this.state.parkedAnchor = undefined;
    this.state.landedBodyId = descriptor.id;
    this.state.landedAnchor = anchor;
    this.state.throttle = 0;
    this.state.speedMetersPerSecond = 0;
    this.state.velocity = vec3();
    this.setMode("cruise");
    this.updateLandedPosition(snapshot);
    return true;
  }

  takeoff(): boolean {
    if (!this.state.landed || !this.state.landedAnchor) return false;
    const anchor = this.state.landedAnchor;
    const snapshot = this.catalog.evaluateSystem(this.currentSystem, this.lastSimulationTimeSeconds);
    const pose = snapshot.poses.get(anchor.bodyId);
    const body = this.catalog.getPlanet(anchor.bodyId);
    if (!pose || !body) return false;

    const outward = rotateAroundYAxis(anchor.surfaceDirection, pose.rotationRadians);
    let departureTangent = subVec3(
      this.state.forward,
      scaleVec3(outward, dotVec3(this.state.forward, outward)),
    );
    if (lengthVec3(departureTangent) < 0.000_001) {
      const reference = Math.abs(outward.y) < 0.92 ? WORLD_UP : vec3(1, 0, 0);
      departureTangent = crossVec3(reference, outward);
    }
    const departureHeading = normalizeVec3(addVec3(
      normalizeVec3(departureTangent),
      scaleVec3(outward, 0.08),
    ));
    const surfaceHeight = this.surfaceHeight(body, anchor.surfaceDirection);
    this.setCanonicalAddress(addAddressOffset(pose.position, scaleVec3(outward, body.radiusMeters + surfaceHeight + 145)));
    this.state.landed = false;
    this.state.surfacePhase = "airborne";
    this.state.landedBodyId = undefined;
    this.state.landedAnchor = undefined;
    this.state.parkedAnchor = undefined;
    this.state.forward = departureHeading;
    const orientation = headingToTarget(vec3(), departureHeading);
    this.state.yaw = orientation.yawRadians;
    this.state.pitch = orientation.pitchRadians;
    this.state.speedMetersPerSecond = 75;
    this.state.throttle = 0.25;
    this.state.velocity = scaleVec3(outward, 75);
    return true;
  }

  targetDistanceMeters(): number | undefined {
    const target = this.resolveTargetAddress();
    return target ? lengthVec3(subtractAddresses(target, this.state.address)) : undefined;
  }

  getGuidance(): FlightGuidance | undefined {
    const targetId = this.state.targetId;
    const target = this.resolveTargetAddress();
    if (!targetId || !target) return undefined;

    const displacement = subtractAddresses(target, this.state.address);
    const distanceMeters = lengthVec3(displacement);
    const direction = normalizeVec3(displacement);
    const system = this.catalog.getSystem(targetId);
    const body = system ? undefined : this.catalog.getBody(targetId);
    const captureRadiusMeters = system
      ? FLIGHT_MODE_PROFILES.hyperdrive.minimumCaptureRadiusMeters
      : pulseArrivalRadiusMeters(body);
    const alignment = Math.max(-1, Math.min(1, dotVec3(this.state.forward, direction)));

    return {
      targetId,
      targetKind: system ? "system" : "body",
      direction,
      distanceMeters,
      surfaceDistanceMeters: Math.max(0, distanceMeters - (body?.radiusMeters ?? 0)),
      captureRadiusMeters,
      alignment,
      angularErrorRadians: Math.acos(alignment),
      closingSpeedMetersPerSecond: dotVec3(this.state.velocity, direction),
      etaSeconds: this.estimateArrivalSeconds(),
      phase: this.state.phase,
      withinCapture: system ? distanceMeters <= captureRadiusMeters : isWithinPulseArrival(distanceMeters, captureRadiusMeters),
      ...(this.departureAutopilot ? {
        departurePhase: this.departureAutopilot.phase,
        departureBodyId: this.departureAutopilot.bodyId,
        departureClearanceMeters:
          this.departureAutopilot.clearanceRadiusMeters - this.departureAutopilot.physicalBodyRadiusMeters,
      } : {}),
    };
  }

  estimateArrivalSeconds(): number {
    const distance = this.targetDistanceMeters();
    if (distance === undefined) return Number.POSITIVE_INFINITY;
    const profile = FLIGHT_MODE_PROFILES[this.state.mode];
    const base = estimateRouteArrival(
      Math.max(0, distance - this.arrivalRadiusMeters()),
      this.state.speedMetersPerSecond,
      profile.maximumSpeedMetersPerSecond,
      profile.accelerationMetersPerSecondSquared,
      profile.brakingMetersPerSecondSquared,
    );
    const scheduled = isFasterThanLight(this.state.mode)
      ? Math.max(0, this.guidedDurationSeconds - this.guidedElapsedSeconds)
      : 0;
    return Math.max(base, scheduled) + Math.max(0, profile.spoolSeconds * (1 - this.state.spoolProgress));
  }

  serializeState(): SerializedFlightState {
    return {
      position: serializeAddress(this.state.address),
      velocity: { ...this.state.velocity },
      yaw: this.state.yaw,
      pitch: this.state.pitch,
      systemId: this.state.systemId,
      ...(this.state.targetId ? { targetId: this.state.targetId } : {}),
      ...(this.state.landedAnchor ? { landedAnchor: this.state.landedAnchor } : {}),
    };
  }

  restoreState(saved: SerializedFlightState): boolean {
    const system = this.catalog.getSystem(saved.systemId);
    if (!system) return false;
    this.state.systemId = system.id;
    this.state.address = deserializeAddress(saved.position);
    this.state.position = subtractAddresses(this.state.address, system.position);
    this.state.velocity = { ...saved.velocity };
    this.state.speedMetersPerSecond = lengthVec3(saved.velocity);
    this.state.yaw = saved.yaw;
    this.state.pitch = saved.pitch;
    this.state.forward = forwardFromAngles(saved.yaw, saved.pitch);
    this.state.targetId = saved.targetId;
    this.state.landedAnchor = saved.landedAnchor;
    this.state.landedBodyId = saved.landedAnchor?.bodyId;
    this.state.landed = Boolean(saved.landedAnchor);
    this.state.surfacePhase = saved.landedAnchor ? "parked" : "airborne";
    this.state.parkedAnchor = undefined;
    this.state.mode = "cruise";
    this.state.phase = "idle";
    this.guidedElapsedSeconds = 0;
    this.guidedDurationSeconds = 0;
    this.clearManualSteering();
    this.heldThrottle = undefined;
    this.departureAutopilot = undefined;
    this.updateReferenceFrame(this.catalog.evaluateSystem(system, this.lastSimulationTimeSeconds), 0, true);
    return true;
  }

  attachKeyboard(target?: EventTarget, options: KeyboardBindingOptions = {}): void {
    const resolved = target ?? (typeof window === "undefined" ? undefined : window);
    if (!resolved) return;
    if (this.keyboardTarget === resolved) {
      this.keyboardHandlesCommands = options.handleCommands ?? false;
      this.keyboardBindings = createKeyBindings(options.bindings);
      return;
    }
    this.detachKeyboard();
    this.keyboardTarget = resolved;
    this.keyboardHandlesCommands = options.handleCommands ?? false;
    this.keyboardBindings = createKeyBindings(options.bindings);
    resolved.addEventListener("keydown", this.onKeyDown);
    resolved.addEventListener("keyup", this.onKeyUp);
    resolved.addEventListener("blur", this.onBlur);
  }

  detachKeyboard(): void {
    this.keyboardTarget?.removeEventListener("keydown", this.onKeyDown);
    this.keyboardTarget?.removeEventListener("keyup", this.onKeyUp);
    this.keyboardTarget?.removeEventListener("blur", this.onBlur);
    this.keyboardTarget = undefined;
    this.keyboardHandlesCommands = false;
    this.keyboardBindings = { ...DEFAULT_FLIGHT_KEY_BINDINGS };
  }

  dispose(): void {
    this.detachKeyboard();
  }

  private readonly onKeyDown = (event: Event): void => {
    const keyboardEvent = event as KeyboardEvent;
    const target = keyboardEvent.target;
    if (
      (typeof HTMLInputElement !== "undefined" && target instanceof HTMLInputElement) ||
      (typeof HTMLTextAreaElement !== "undefined" && target instanceof HTMLTextAreaElement)
    ) return;
    if (keyboardEvent.repeat && ["KeyP", "KeyH", "KeyL"].includes(keyboardEvent.code)) return;
    const action = this.keyboardBindings[keyboardEvent.code];
    if (action) {
      this.setInput(action, true);
      if (keyboardEvent.code.startsWith("Arrow") || keyboardEvent.code === "Space" || keyboardEvent.code.startsWith("Page")) {
        keyboardEvent.preventDefault();
      }
      return;
    }
    if (!this.keyboardHandlesCommands) return;
    if (keyboardEvent.code === "KeyP") this.togglePulse();
    if (keyboardEvent.code === "KeyH") this.initiateHyperdrive(this.targetSystemId() ?? CONTRAST_SYSTEM_ID);
    if (keyboardEvent.code === "KeyL") this.state.landed ? this.takeoff() : this.land();
  };

  private readonly onKeyUp = (event: Event): void => {
    const action = this.keyboardBindings[(event as KeyboardEvent).code];
    if (action) this.setInput(action, false);
  };

  private readonly onBlur = (): void => {
    for (const action of Object.keys(this.input) as FlightInputAction[]) this.setInput(action, false);
    this.clearManualSteering();
  };

  private updateManualSteering(delta: number, snapshot: SystemSnapshot): void {
    const profile = MANUAL_STEERING_PROFILE;
    const nearest = this.findNearestLandableBody(snapshot);
    let clearance = nearest?.altitudeMeters ?? Number.POSITIVE_INFINITY;
    if (nearest && this.sampleManualSteeringClearanceMeters) {
      const relative = subVec3(this.state.position, nearest.pose.localPositionMeters);
      const referenceClearance = lengthVec3(relative) - nearest.descriptor.radiusMeters;
      // Positive mountains are already represented by the coarse height
      // callback. The reference radius also bounds a known ocean's sea level.
      // If both are distant, another terrain/authority sample cannot change
      // the full-rate result. Negative dry basins still get exact near checks.
      if (Math.min(clearance, referenceClearance) < profile.fullRateClearanceMeters) {
        const bodyFixedPosition = rotateAroundYAxis(relative, -nearest.pose.rotationRadians);
        const sampled = this.sampleManualSteeringClearanceMeters(nearest.descriptor, bodyFixedPosition);
        if (sampled !== undefined && Number.isFinite(sampled)) clearance = sampled;
        else {
          // A newly built system can precede body registration. Keep the
          // fallback deterministic and signed without altering flight safety.
          if (this.manualSteeringFallbackField?.bodyId !== nearest.descriptor.id) {
            this.manualSteeringFallbackField = {
              bodyId: nearest.descriptor.id, field: createPlanetField(nearest.descriptor),
            };
          }
          const surface = samplePlanetField(this.manualSteeringFallbackField.field, normalizeVec3(bodyFixedPosition));
          clearance = lengthVec3(bodyFixedPosition) -
            (surface.ocean ? surface.radialMeters : surface.terrainRadiusMeters);
        }
      }
    }
    const distanceBlend = Number.isFinite(clearance)
      ? Math.max(0, Math.min(1, (clearance - profile.nearSurfaceClearanceMeters) /
        (profile.fullRateClearanceMeters - profile.nearSurfaceClearanceMeters)))
      : 1;
    const smoothBlend = distanceBlend * distanceBlend * (3 - 2 * distanceBlend);
    this.steeringRateScale = profile.nearSurfaceRateScale + (1 - profile.nearSurfaceRateScale) * smoothBlend;
    const maximumYaw = profile.maximumYawRadiansPerSecond * this.steeringRateScale;
    const maximumPitch = profile.maximumPitchRadiansPerSecond * this.steeringRateScale;
    const rightward = Number(this.input.turnRight) - Number(this.input.turnLeft);
    const pitch = Number(this.input.pitchUp) - Number(this.input.pitchDown);
    // A Three.js camera faces -Z: turning right decreases yaw rather than increasing it.
    const yaw = integrateManualAngularRate(
      clampManualAngle(this.yawVelocityRadiansPerSecond, maximumYaw), -rightward * maximumYaw, delta,
    );
    const nose = integrateManualAngularRate(
      clampManualAngle(this.pitchVelocityRadiansPerSecond, maximumPitch), pitch * maximumPitch, delta,
    );
    this.yawVelocityRadiansPerSecond = yaw.velocityRadiansPerSecond;
    this.pitchVelocityRadiansPerSecond = nose.velocityRadiansPerSecond;
    const keyboardYaw = clampManualAngle(yaw.deltaRadians, maximumYaw * delta);
    const keyboardPitch = clampManualAngle(nose.deltaRadians, maximumPitch * delta);
    const pointerYaw = integrateManualPointerAxis(this.pointerYaw, maximumYaw,
      keyboardYaw, yaw.velocityRadiansPerSecond, delta);
    const pointerPitch = integrateManualPointerAxis(this.pointerPitch, maximumPitch,
      keyboardPitch, nose.velocityRadiansPerSecond, delta);
    const yawDelta = keyboardYaw + pointerYaw;
    const pitchDelta = keyboardPitch + pointerPitch;
    this.achievedYawRadiansPerSecond = yawDelta / delta;
    this.achievedPitchRadiansPerSecond = pitchDelta / delta;

    // Keyboard and pointer share the same physical horizon and bounded rates.
    this.steer(yawDelta, pitchDelta);
    // Positive roll is about the native -Z bow: the starboard wing goes down.
    // Bank follows the turn actually delivered, so releasing/reversing a key
    // cannot instantly lean against the still-damped yaw response.
    const rollTarget = (Number(this.input.rollRight) - Number(this.input.rollLeft)) * profile.manualBankRadians -
      clampManualAngle(this.achievedYawRadiansPerSecond / profile.maximumYawRadiansPerSecond, 1) * profile.automaticBankRadians;
    const rollDelta = (rollTarget - this.state.roll) * -Math.expm1(-profile.rollResponsePerSecond * delta);
    this.state.roll += clampManualAngle(rollDelta, profile.maximumRollRadiansPerSecond * delta);
  }

  private updateManualFlight(delta: number, snapshot: SystemSnapshot): void {
    this.updateManualSteering(delta, snapshot);
    const passiveCoast = this.state.mode === "cruise" &&
      !this.input.accelerate && !this.input.forward && !this.input.brake && !this.input.backward &&
      !this.input.boost && !this.input.ascend && !this.input.descend && this.heldThrottle === undefined;
    if (this.input.accelerate || this.input.forward) {
      this.heldThrottle = undefined;
      this.state.throttle = Math.min(1, this.state.throttle + delta * 1.65);
    }
    else if (this.input.brake || this.input.backward) {
      this.heldThrottle = undefined;
      const minimumThrottle = this.input.backward ? -0.28 : 0;
      this.state.throttle = Math.max(minimumThrottle, this.state.throttle - delta * 2.15);
    }
    else if (this.heldThrottle !== undefined) {
      this.state.throttle = moveToward(this.state.throttle, this.heldThrottle, delta * 1.65);
    }
    else {
      const landingApproach = this.findNearestLandableBody(snapshot);
      const settlingTowardSurface = landingApproach &&
        landingApproach.altitudeMeters < 480 &&
        this.state.throttle > 0 &&
        dotVec3(this.state.forward, landingApproach.direction) < -0.72;
      const restingThrottle = settlingTowardSurface ? 0.14 : 0;
      this.state.throttle = moveToward(this.state.throttle, restingThrottle, delta * 0.58);
    }
    if (this.state.mode === "boost") this.state.throttle = Math.max(this.state.throttle, 0.76);

    const profile = FLIGHT_MODE_PROFILES[this.state.mode];
    // A released engine does not redirect real momentum when the pilot turns
    // the nose, or flip a restored reverse velocity as throttle reaches zero.
    // Radial controls remain on their existing powered path, so their velocity
    // is not accumulated a second time on successive frames.
    const retainedVelocitySpeed = passiveCoast ? lengthVec3(this.state.velocity) : 0;
    const coastDirection = passiveCoast
      ? retainedVelocitySpeed > 0
        ? scaleVec3(this.state.velocity, 1 / retainedVelocitySpeed)
        : scaleVec3(this.state.forward, this.state.throttle < 0 ? -1 : 1)
      : undefined;
    if (passiveCoast) this.state.speedMetersPerSecond = retainedVelocitySpeed;
    const localSpeedLimit = this.localSpeedLimit(
      snapshot,
      profile.maximumSpeedMetersPerSecond,
      coastDirection,
    );
    const throttleDirection = passiveCoast ? 1 : this.state.throttle < 0 ? -1 : 1;
    const nearby = this.findNearestPhysicalBody(snapshot);
    let movementDirection = coastDirection ?? this.state.forward;
    const requestedInwardAlignment = nearby
      ? Math.max(0, -dotVec3(movementDirection, nearby.direction) * throttleDirection)
      : 0;
    let inwardAlignment = requestedInwardAlignment;
    if (nearby && this.state.mode === "boost" && (this.input.accelerate || this.input.forward) &&
      requestedInwardAlignment > 0.36 && requestedInwardAlignment < 0.88 && nearby.altitudeMeters < 7_000) {
      // A pilot already descending obliquely wants to reach the real world,
      // not circle it for minutes. Tilt actual propulsion toward that same
      // body's radial while retaining its unchanged bounded speed magnitude.
      const approach = Math.max(0, Math.min(1, (7_000 - nearby.altitudeMeters) / 3_000));
      const smoothApproach = approach * approach * (3 - 2 * approach);
      const desiredAlignment = requestedInwardAlignment +
        (Math.max(requestedInwardAlignment, 0.86) - requestedInwardAlignment) * smoothApproach;
      const tangent = subVec3(
        this.state.forward,
        scaleVec3(nearby.direction, dotVec3(this.state.forward, nearby.direction)),
      );
      const tangentLength = lengthVec3(tangent);
      if (tangentLength > 1e-7) {
        movementDirection = addVec3(
          scaleVec3(tangent, Math.sqrt(Math.max(0, 1 - desiredAlignment * desiredAlignment)) / tangentLength),
          scaleVec3(nearby.direction, -desiredAlignment * throttleDirection),
        );
        inwardAlignment = desiredAlignment;
      }
    }
    const decayedCoastSpeed = this.state.speedMetersPerSecond *
      Math.exp(-Math.LN2 * delta / MANUAL_COAST_HALF_LIFE_SECONDS);
    const coastSpeed = decayedCoastSpeed < MANUAL_COAST_STOP_SPEED_METERS_PER_SECOND
      ? 0
      : decayedCoastSpeed;
    // The nominal cruise engine limit is not an emergency brake when boost is
    // released in open space. A real proximity/angular limit still is a bound.
    const proximityLimited = localSpeedLimit < profile.maximumSpeedMetersPerSecond - 0.000_001;
    let desiredSpeed = passiveCoast
      ? Math.min(coastSpeed, proximityLimited ? localSpeedLimit : Number.POSITIVE_INFINITY)
      : Math.abs(this.state.throttle) * localSpeedLimit;
    let protectedClearanceMeters = 0;
    let atmosphericTerminalSpeed = 0;
    let surfaceHoldMeters = 0;
    let grazingSpeedLimit = Number.POSITIVE_INFINITY;
    let enforceGrazingLimit = false;
    let physicalApproachClearanceMeters = nearby?.altitudeMeters ?? Number.POSITIVE_INFINITY;

    if (nearby) {
      const outwardAlignment = dotVec3(movementDirection, nearby.direction) * throttleDirection;
      const protectionAltitude = Math.max(
        95_000,
        nearby.descriptor.atmosphere.heightMeters * 1.4,
      );

      if (inwardAlignment <= 0.035 && outwardAlignment < 0.45 &&
        nearby.altitudeMeters < protectionAltitude) {
        const lookaheadDistance = Math.min(
          nearby.descriptor.radiusMeters * 0.018,
          Math.max(180, Math.max(this.state.speedMetersPerSecond, localSpeedLimit) *
            Math.max(delta * 2.5, 0.18)),
        );
        const bodyRelative = subVec3(this.state.position, nearby.pose.localPositionMeters);
        const predictedRelative = addVec3(
          bodyRelative,
          scaleVec3(movementDirection, lookaheadDistance * throttleDirection),
        );
        const predictedDirection = normalizeVec3(predictedRelative);
        const predictedBodyFixed = rotateAroundYAxis(
          predictedDirection,
          -nearby.pose.rotationRadians,
        );
        const predictedClearance = lengthVec3(predictedRelative) - nearby.descriptor.radiusMeters -
          this.surfaceHeight(nearby.descriptor, predictedBodyFixed);
        const risingTerrainMeters = Math.max(0, nearby.altitudeMeters - predictedClearance);
        const effectiveClosingAlignment = Math.max(
          inwardAlignment,
          Math.min(1, risingTerrainMeters / Math.max(1, lookaheadDistance)),
        );
        const protectedGroundMeters = this.state.mode === "boost" ? 62 : 48;
        const safeClearance = Math.max(
          0,
          Math.min(nearby.altitudeMeters, predictedClearance) - protectedGroundMeters,
        );
        const nearGroundSpeed = this.state.mode === "boost"
          ? 150 + Math.max(0, predictedClearance) * 0.48
          : 88 + Math.max(0, predictedClearance) * 0.26;
        const comfortableSkim = Math.sqrt(
          (this.state.mode === "boost" ? 850 : 600) ** 2 +
          2 * profile.brakingMetersPerSecondSquared * 0.52 * safeClearance,
        );
        desiredSpeed = Math.min(
          desiredSpeed,
          comfortableSkim / Math.max(0.16, effectiveClosingAlignment),
        );

        // A distant preview can legitimately cross a ridge while the next
        // actual frame remains safe; use present clearance for the per-frame
        // bound and validate that immediate field path before advancing.
        const immediateClearance = Math.max(0, nearby.altitudeMeters - protectedGroundMeters);
        const frameSafeSpeed = effectiveClosingAlignment > 0.012
          ? immediateClearance / Math.max(delta * 1.35 * effectiveClosingAlignment, 0.000_1)
          : Number.POSITIVE_INFINITY;
        grazingSpeedLimit = Math.min(
          Math.max(90, Math.min(localSpeedLimit * 1.2, nearGroundSpeed * 1.18)),
          frameSafeSpeed,
        );
        enforceGrazingLimit = nearby.altitudeMeters < Math.max(
          24_000,
          nearby.descriptor.atmosphere.heightMeters * 0.32,
        );
      }
    }

    if (nearby && inwardAlignment > 0.035) {
      // The current column is insufficient when a steep or diagonal approach
      // crosses an actual higher body-fixed mountain before reaching its old
      // radial sample. Inspect the same authoritative field along the real
      // heading early enough for ordinary finite braking; no render proxy or
      // decorative mountain participates in this safety decision.
      const currentSurfaceHeight = this.surfaceHeight(
        nearby.descriptor,
        rotateAroundYAxis(nearby.direction, -nearby.pose.rotationRadians),
      );
      const pathUntilCurrentSurface = Math.max(
        120,
        nearby.altitudeMeters / Math.max(inwardAlignment, 0.08),
      );
      const terrainPreviewDistance = Math.min(
        nearby.descriptor.radiusMeters * 0.025,
        pathUntilCurrentSurface * 1.2,
        Math.max(
          4_800,
          this.state.speedMetersPerSecond * Math.max(delta * 4, 0.48),
        ),
      );
      let highestForwardSurface = currentSurfaceHeight;
      const bodyRelative = subVec3(this.state.position, nearby.pose.localPositionMeters);

      for (const fraction of [0.2, 0.43, 0.7, 1]) {
        const predictedRelative = addVec3(
          bodyRelative,
          scaleVec3(movementDirection, terrainPreviewDistance * fraction * throttleDirection),
        );
        const predictedDirection = normalizeVec3(predictedRelative);
        const predictedBodyFixed = rotateAroundYAxis(
          predictedDirection,
          -nearby.pose.rotationRadians,
        );
        highestForwardSurface = Math.max(
          highestForwardSurface,
          this.surfaceHeight(nearby.descriptor, predictedBodyFixed),
        );
      }

      const forwardRise = highestForwardSurface - currentSurfaceHeight;
      // A shallow skimming ship can actually climb/slide over a distant ridge;
      // treating the entire long-range rise as an immediate vertical collision
      // used to force 1,300 km/h -> zero before its next real meter of travel.
      const shallowSurfaceSkim = inwardAlignment < 0.36 && nearby.altitudeMeters < 1_800;
      physicalApproachClearanceMeters = shallowSurfaceSkim
        ? Math.max(
          nearby.altitudeMeters * 0.82,
          nearby.altitudeMeters - forwardRise * 0.18,
          Math.min(nearby.altitudeMeters, this.state.mode === "boost" ? 76 : 62),
        )
        : Math.max(0, nearby.altitudeMeters - forwardRise);
      const atmosphere = nearby.descriptor.atmosphere;
      const hasTraversableClouds = supportsAtmosphericClouds(atmosphere);
      const cloudBaseMeters = hasTraversableClouds
        ? atmosphere.cloudBaseMeters
        : 0;
      protectedClearanceMeters = hasTraversableClouds
        ? atmosphere.cloudTopMeters + 900
        : 1_400;
      surfaceHoldMeters = this.state.mode === "boost" ? 62 : 48;
      const intentionalObliqueApproach = this.state.mode === "boost" &&
        requestedInwardAlignment > 0.36 && requestedInwardAlignment < 0.88;
      const outerCloudProgress = intentionalObliqueApproach
        ? Math.max(0, Math.min(1, (nearby.altitudeMeters - 1_200) / 4_800))
        : 0;
      const outerCloudApproach = outerCloudProgress * outerCloudProgress * (3 - 2 * outerCloudProgress);
      const cloudTerminalSpeed = this.state.mode === "boost"
        ? 750 + 900 * outerCloudApproach
        : 600;
      const landingTerminalSpeed = this.state.mode === "boost" ? 24 : 20;
      const surfaceTaperMeters = Math.max(1_200, cloudBaseMeters + 420);
      const landingProgress = Math.min(1, Math.max(
        0,
        (physicalApproachClearanceMeters - surfaceHoldMeters) /
          Math.max(1, surfaceTaperMeters - surfaceHoldMeters),
      ));
      const smoothLandingProgress = landingProgress * landingProgress * (3 - 2 * landingProgress);
      atmosphericTerminalSpeed = landingTerminalSpeed +
        (cloudTerminalSpeed - landingTerminalSpeed) * smoothLandingProgress;
      const currentRadialSpeed = this.state.speedMetersPerSecond * inwardAlignment;
      const lookaheadMeters = currentRadialSpeed * delta * 1.5;
      const availableBrakingDistance = Math.max(
        0,
        physicalApproachClearanceMeters - protectedClearanceMeters - lookaheadMeters,
      );
      // Start easing well before maximum emergency braking would be required.
      // Normal arrivals therefore follow the same progressive curve as takeoff
      // instead of remaining at orbital velocity until the atmosphere boundary.
      const comfortableBraking = profile.brakingMetersPerSecondSquared * 0.58;
      const safeInwardSpeed = Math.sqrt(
        atmosphericTerminalSpeed ** 2 +
        2 * comfortableBraking * availableBrakingDistance,
      );
      desiredSpeed = Math.min(desiredSpeed, safeInwardSpeed / inwardAlignment);

      if (this.state.mode === "boost") {
        // A hard stopping-distance bound alone still permits near-maximum
        // boost until very late. Shape the entire genuine orbital approach so
        // manual entry visibly sheds speed for hundreds of real kilometers;
        // the normal acceleration profile remains the only ordinary brake.
        const approachHorizon = Math.max(
          360_000,
          nearby.descriptor.radiusMeters * 0.2,
          atmosphere.heightMeters * 6,
        );
        const progress = Math.min(1, Math.max(
          0,
          (physicalApproachClearanceMeters - protectedClearanceMeters) /
            Math.max(1, approachHorizon - protectedClearanceMeters),
        ));
        const orbitalApproachSpeed = atmosphericTerminalSpeed +
          (profile.maximumSpeedMetersPerSecond - atmosphericTerminalSpeed) *
            Math.pow(progress, 0.85);
        desiredSpeed = Math.min(
          desiredSpeed,
          orbitalApproachSpeed / Math.max(inwardAlignment, 0.35),
        );
      }

      if (physicalApproachClearanceMeters <= surfaceHoldMeters) desiredSpeed = 0;
    }

    if (enforceGrazingLimit) desiredSpeed = Math.min(desiredSpeed, grazingSpeedLimit);
    const coastSafetyLimited = passiveCoast && desiredSpeed < coastSpeed;
    const recoveringExcessMomentum = this.state.mode === "cruise" &&
      (!passiveCoast || coastSafetyLimited) &&
      this.state.speedMetersPerSecond > localSpeedLimit * 1.08;
    const availableBraking = recoveringExcessMomentum
      ? FLIGHT_MODE_PROFILES.boost.brakingMetersPerSecondSquared
      : profile.brakingMetersPerSecondSquared;
    let acceleration = desiredSpeed > this.state.speedMetersPerSecond
      ? profile.accelerationMetersPerSecondSquared
      : availableBraking;
    if (nearby && nearby.altitudeMeters < 24_000) {
      const altitude = Math.max(0, nearby.altitudeMeters);
      const boosted = this.state.mode === "boost";
      const comfortableAcceleration = (boosted ? 240 : 200) + altitude * (boosted ? 0.16 : 0.13);
      const comfortableBraking = (boosted ? 330 : 260) + altitude * (boosted ? 0.28 : 0.22);
      const release = Math.max(0, Math.min(1, (altitude - 4_000) / 20_000));
      const releaseBlend = release * release * (3 - 2 * release);
      const comfortableRate = desiredSpeed > this.state.speedMetersPerSecond
        ? comfortableAcceleration
        : comfortableBraking;
      acceleration = comfortableRate + (acceleration - comfortableRate) * releaseBlend;

      // A retained boosted velocity, restored state, or steep actual descent
      // still receives enough finite real braking to stop above shared terrain.
      if (desiredSpeed < this.state.speedMetersPerSecond && inwardAlignment > 0.035) {
        const closingSpeed = this.state.speedMetersPerSecond * inwardAlignment;
        const remaining = Math.max(1, physicalApproachClearanceMeters - Math.max(36, surfaceHoldMeters));
        const requiredDeceleration = closingSpeed * closingSpeed /
          (2 * remaining * Math.max(inwardAlignment, 0.035));
        acceleration = Math.min(availableBraking, Math.max(acceleration, requiredDeceleration * 1.32));
      }
    }
    this.state.speedMetersPerSecond = passiveCoast && !coastSafetyLimited
      ? coastSpeed
      : moveToward(this.state.speedMetersPerSecond, desiredSpeed, acceleration * delta);
    // The anticipatory envelope normally reaches this bound through ordinary
    // finite braking. A restored/coarse-frame state can already be inside the
    // real cloud layer, so bound its inward component before advancing its
    // continuous canonical position rather than sweeping past the whole bank.
    if (nearby && inwardAlignment > 0.035 && physicalApproachClearanceMeters <= protectedClearanceMeters &&
      !(inwardAlignment < 0.36 && nearby.altitudeMeters < 1_800)) {
      const remainingAboveSurfaceHold = Math.max(0, physicalApproachClearanceMeters - surfaceHoldMeters);
      const safeFrameSpeed = remainingAboveSurfaceHold / Math.max(delta * 1.35, 0.000_1);
      this.state.speedMetersPerSecond = Math.min(
        this.state.speedMetersPerSecond,
        atmosphericTerminalSpeed / inwardAlignment,
        safeFrameSpeed / inwardAlignment,
      );
    }
    let velocity = scaleVec3(movementDirection, this.state.speedMetersPerSecond * throttleDirection);
    const verticalControl = Number(this.input.ascend) - Number(this.input.descend);
    if (verticalControl !== 0) {
      velocity = addVec3(velocity, scaleVec3(this.state.surfaceUp, verticalControl * Math.min(420, localSpeedLimit * 0.32)));
    }
    // Dedicated thrust remains forward in space, but a low-altitude tangent
    // departure receives a small physically radial anti-grounding assist.
    else if (this.input.accelerate && this.state.surfaceInfluence > 0) {
      if (nearby && nearby.altitudeMeters < 1_200) {
        const outwardAlignment = dotVec3(this.state.forward, nearby.direction);
        if (outwardAlignment < 0.2) {
          const lift = Math.min(65, localSpeedLimit * 0.22)
            * Math.max(0, 1 - nearby.altitudeMeters / 1_200)
            * Math.min(1, 0.2 - outwardAlignment);
          velocity = addVec3(velocity, scaleVec3(nearby.direction, lift));
        }
      }
    }
    if (nearby && nearby.altitudeMeters < 1_800 && inwardAlignment > 0.004 && inwardAlignment < 0.72) {
      velocity = this.deflectAcrossSurface(nearby, velocity, delta);
      this.state.speedMetersPerSecond = lengthVec3(velocity);
    }
    const movementSpeed = lengthVec3(velocity);
    const escapingSurface = nearby && movementSpeed > 0 &&
      dotVec3(velocity, nearby.direction) / movementSpeed > 0.45;
    if (nearby && nearby.altitudeMeters < 8_000 && movementSpeed > 0 && !escapingSurface) {
      // The swept sphere is conservatively centered on the current terrain
      // column; a real uphill face inside this very frame can rise above it.
      // Check the actual body-fixed field along the continuous proposed step
      // so surface boost eases to a safe hold instead of colliding next frame.
      const relative = subVec3(this.state.position, nearby.pose.localPositionMeters);
      const surfaceFloor = this.state.mode === "boost" ? 36 : 28;
      let permittedFraction = 1;

      for (const fraction of [0.3, 0.58, 0.82, 1]) {
        const projected = addVec3(relative, scaleVec3(velocity, delta * fraction));
        const projectedFixed = rotateAroundYAxis(
          normalizeVec3(projected),
          -nearby.pose.rotationRadians,
        );
        const projectedClearance = lengthVec3(projected) - nearby.descriptor.radiusMeters -
          this.surfaceHeight(nearby.descriptor, projectedFixed);
        const closingMeters = nearby.altitudeMeters - projectedClearance;
        if (projectedClearance >= surfaceFloor || closingMeters <= 0) continue;

        const remaining = Math.max(0, nearby.altitudeMeters - surfaceFloor);
        permittedFraction = Math.min(
          permittedFraction,
          Math.max(0, Math.min(1, fraction * remaining / Math.max(closingMeters, 0.000_001))),
        );
      }

      if (permittedFraction < 1) {
        velocity = scaleVec3(velocity, permittedFraction);
        this.state.speedMetersPerSecond *= permittedFraction;
      }
    }
    this.state.velocity = velocity;

    const destination = addVec3(this.state.position, scaleVec3(velocity, delta));
    this.advanceWithSafety(destination, snapshot);
  }

  /** FTL remains an explicit mode, but an obstructed near-ground departure is never a teleport. */
  private configureDepartureAutopilot(): void {
    this.departureAutopilot = undefined;
    const snapshot = this.catalog.evaluateSystem(this.currentSystem, this.lastSimulationTimeSeconds);
    const target = this.resolveTargetAddress();
    if (!target) return;

    const nearest = this.findNearestLandableBody(snapshot);
    const obstacle = this.findGuidedObstacle(snapshot, target);
    let source: SafetySphere | undefined;

    if (nearest) {
      const orbitalClearance = this.departureClearanceMeters(nearest.descriptor);
      if (nearest.altitudeMeters < orbitalClearance || obstacle?.id === nearest.descriptor.id) {
        source = this.safetySpheres(snapshot).find((sphere) => sphere.id === nearest.descriptor.id);
      }
    }

    if (!source && obstacle) {
      const sourceDistance = distanceVec3(this.state.position, obstacle.center);
      if (sourceDistance < obstacle.radiusMeters * 2.2) source = obstacle;
    }
    if (!source) return;

    const planet = this.catalog.getPlanet(source.id);
    const star = planet ? undefined : this.catalog.getStar(source.id);
    const bodyRadius = planet?.radiusMeters ?? star?.radiusMeters ?? source.radiusMeters;
    const physicalClearance = planet
      ? this.departureClearanceMeters(planet)
      : Math.max(bodyRadius * 0.32, source.radiusMeters * 0.12);
    let clearanceRadius = Math.max(source.radiusMeters + 120_000, bodyRadius + physicalClearance);
    if (source.id === this.state.targetId) {
      clearanceRadius = Math.max(clearanceRadius, this.captureRadiusMeters() + Math.max(75_000, bodyRadius * 0.032));
    }

    const distance = distanceVec3(this.state.position, source.center);
    const phase: DeparturePhase = distance < clearanceRadius - 80 ? "launching" : "clearing";
    this.departureAutopilot = {
      bodyId: source.id,
      clearanceRadiusMeters: clearanceRadius,
      physicalBodyRadiusMeters: bodyRadius,
      phase,
    };
    this.state.phase = phase;
    this.state.spoolProgress = 0;
  }

  private departureClearanceMeters(planet: PlanetDescriptor): number {
    return Math.max(
      240_000,
      Math.min(1_350_000, planet.radiusMeters * 0.155),
      planet.atmosphere.heightMeters * 1.42,
    );
  }

  /** Check only the real route to capture, excluding the intended destination. */
  private findGuidedObstacle(snapshot: SystemSnapshot, target: GalacticAddress): SafetySphere | undefined {
    const displacement = subtractAddresses(target, this.state.address);
    const distance = lengthVec3(displacement);
    if (distance < 1) return undefined;

    const direction = scaleVec3(displacement, 1 / distance);
    // A solid between the capture shell and the target center is not on the
    // traveled segment. This matters for moon/giant systems and wide rings.
    const reach = Math.min(Math.max(0, distance - this.captureRadiusMeters()), 8 * AU_METERS);
    if (reach < 1) return undefined;
    const destination = addVec3(this.state.position, scaleVec3(direction, reach));
    const buffered = this.safetySpheres(snapshot)
      .filter((sphere) => sphere.id !== this.state.targetId)
      .map((sphere) => ({
        ...sphere,
        radiusMeters: sphere.radiusMeters + (
          sphere.kind === "star"
            ? Math.max(160_000, sphere.radiusMeters * 0.035)
            : Math.max(95_000, Math.min(280_000, sphere.radiusMeters * 0.045))
        ),
      }));
    return findFirstSweptCollision(this.state.position, destination, buffered)?.sphere;
  }

  /** Lift radially, follow a safe exterior arc, then align before engaging FTL. */
  private updateDepartureAutopilot(delta: number, snapshot: SystemSnapshot): void {
    const departure = this.departureAutopilot;
    if (!departure) return;
    const source = snapshot.poses.get(departure.bodyId);
    const target = this.resolveTargetAddress();
    if (!source || !target) {
      this.abortGuidedTravel();
      return;
    }

    const relative = subVec3(this.state.position, source.localPositionMeters);
    const radius = lengthVec3(relative);
    const radial = radius > 0 ? scaleVec3(relative, 1 / radius) : { ...this.state.surfaceUp };
    const targetDirection = normalizeVec3(subtractAddresses(target, this.state.address));

    if (departure.phase === "launching") {
      const remaining = Math.max(0, departure.clearanceRadiusMeters - radius);
      if (remaining <= 80) {
        departure.phase = "clearing";
        this.state.phase = departure.phase;
        return;
      }

      const departureSpeed = Math.min(
        AUTOPILOT_DEPARTURE_MAXIMUM_SPEED,
        Math.max(8_000, maximumSafeBrakingSpeed(remaining, AUTOPILOT_DEPARTURE_ACCELERATION)),
      );
      this.state.speedMetersPerSecond = moveToward(
        this.state.speedMetersPerSecond,
        departureSpeed,
        AUTOPILOT_DEPARTURE_ACCELERATION * delta,
      );
      const step = Math.min(remaining, this.state.speedMetersPerSecond * delta);
      this.orientAlong(radial);
      this.state.velocity = scaleVec3(radial, this.state.speedMetersPerSecond);
      this.state.throttle = Math.max(0.42, Math.min(1, this.state.speedMetersPerSecond / AUTOPILOT_DEPARTURE_MAXIMUM_SPEED));
      this.advanceWithSafety(addVec3(this.state.position, scaleVec3(radial, step)), snapshot);
      return;
    }

    if (departure.phase === "clearing") {
      if (!this.findGuidedObstacle(snapshot, target)) {
        departure.phase = "aligning";
        this.state.phase = departure.phase;
        return;
      }

      const targetRadial = normalizeVec3(subtractAddresses(target, source.position));
      const angularDistance = Math.acos(Math.max(-1, Math.min(1, dotVec3(radial, targetRadial))));
      const orbitalSpeed = Math.min(AUTOPILOT_DEPARTURE_MAXIMUM_SPEED, departure.clearanceRadiusMeters * 0.68);
      this.state.speedMetersPerSecond = moveToward(
        this.state.speedMetersPerSecond,
        orbitalSpeed,
        AUTOPILOT_DEPARTURE_ACCELERATION * delta,
      );
      const angularStep = Math.min(
        angularDistance,
        0.11,
        Math.max(0.000_01, this.state.speedMetersPerSecond * delta / Math.max(1, radius)),
      );
      const nextRadial = angularDistance > 1e-8
        ? sphericalInterpolateUnit(radial, targetRadial, Math.min(1, angularStep / angularDistance))
        : radial;
      const nextRadius = Math.max(departure.clearanceRadiusMeters, radius);
      const destination = addVec3(source.localPositionMeters, scaleVec3(nextRadial, nextRadius));
      const displacement = subVec3(destination, this.state.position);
      if (lengthVec3(displacement) > 1e-8) this.orientAlong(normalizeVec3(displacement));
      this.state.velocity = scaleVec3(displacement, 1 / Math.max(delta, 1e-6));
      this.state.throttle = 0.82;
      this.advanceWithSafety(destination, snapshot);
      return;
    }

    const aligned = sphericalInterpolateUnit(
      this.state.forward,
      targetDirection,
      1 - Math.exp(-delta * 12),
    );
    this.orientAlong(aligned);
    this.state.speedMetersPerSecond = moveToward(
      this.state.speedMetersPerSecond,
      0,
      AUTOPILOT_DEPARTURE_ACCELERATION * delta,
    );
    this.state.velocity = vec3();
    this.state.throttle = 0.35;
    if (dotVec3(this.state.forward, targetDirection) < AUTOPILOT_DEPARTURE_ALIGNMENT) return;

    this.departureAutopilot = undefined;
    this.state.phase = "spooling";
    this.state.spoolProgress = 0;
    this.state.speedMetersPerSecond = 0;
    this.travelInitialDistanceMeters = this.targetDistanceMeters() ?? 0;
    this.guidedInitialRemainingMeters = Math.max(0, this.travelInitialDistanceMeters - this.captureRadiusMeters());
    this.guidedElapsedSeconds = 0;
    this.guidedDurationSeconds = this.state.mode === "pulse"
      ? PULSE_PRESENTATION_MINIMUM_SECONDS + this.guidedInitialRemainingMeters / (220 * SPEED_OF_LIGHT)
      : HYPERDRIVE_PRESENTATION_MINIMUM_SECONDS + this.guidedInitialRemainingMeters / (25_000_000 * SPEED_OF_LIGHT);
    this.previousGuidedTarget = undefined;
  }

  private orientAlong(direction: Vec3): void {
    const orientation = headingToTarget(vec3(), direction);
    this.state.yaw = orientation.yawRadians;
    this.state.pitch = orientation.pitchRadians;
    this.state.forward = direction;
    this.state.roll = moveToward(this.state.roll, 0, 0.12);
  }

  /** A remote intersecting body receives a genuine tangent rather than a through-solid pulse. */
  private obstacleAvoidanceDirection(snapshot: SystemSnapshot, target: GalacticAddress, desired: Vec3): Vec3 {
    const obstacle = this.findGuidedObstacle(snapshot, target);
    if (!obstacle) return desired;

    const towardCenter = subVec3(obstacle.center, this.state.position);
    const centerDistance = lengthVec3(towardCenter);
    if (centerDistance <= obstacle.radiusMeters * 1.001) return normalizeVec3(scaleVec3(towardCenter, -1));

    const centerDirection = scaleVec3(towardCenter, 1 / centerDistance);
    let tangent = subVec3(desired, scaleVec3(centerDirection, dotVec3(desired, centerDirection)));
    if (lengthVec3(tangent) < 1e-7) {
      const basis = Math.abs(centerDirection.y) < 0.82 ? WORLD_UP : vec3(1, 0, 0);
      tangent = crossVec3(centerDirection, basis);
    }
    tangent = normalizeVec3(tangent);
    const angle = Math.asin(Math.min(0.985, obstacle.radiusMeters / centerDistance)) + 0.045;
    return normalizeVec3(addVec3(
      scaleVec3(centerDirection, Math.cos(angle)),
      scaleVec3(tangent, Math.sin(angle)),
    ));
  }

  private updateGuidedTravel(delta: number, snapshot: SystemSnapshot): void {
    if (this.departureAutopilot) {
      this.updateDepartureAutopilot(delta, snapshot);
      return;
    }
    const profile = FLIGHT_MODE_PROFILES[this.state.mode];
    if (this.state.phase === "spooling") {
      this.state.spoolProgress = Math.min(1, this.state.spoolProgress + delta / profile.spoolSeconds);
      this.state.throttle = Math.max(0.2, this.state.spoolProgress * 0.8);
      if (this.state.spoolProgress < 1) return;
      this.state.phase = "cruising";
    }

    const target = this.resolveTargetAddress();
    if (!target) {
      this.abortGuidedTravel();
      return;
    }
    const toTarget = subtractAddresses(target, this.state.address);
    const distance = lengthVec3(toTarget);
    const capture = this.captureRadiusMeters();
    const remaining = Math.max(0, distance - capture);
    const previousTarget = this.previousGuidedTarget;
    const targetDrift = previousTarget
      ? distanceBetweenAddresses(target, previousTarget)
      : 0;
    this.previousGuidedTarget = cloneAddress(target);
    if (remaining <= Math.max(pulseArrivalToleranceMeters(capture), targetDrift * 1.35)) {
      // Match the actual body's final orbital displacement instead of leaving a
      // one-frame range increase at handoff from intercept to local flight.
      if (this.state.mode === "pulse" && previousTarget) {
        const arrivalAddress = addAddressOffset(this.state.address, subtractAddresses(target, previousTarget));
        this.advanceWithSafety(
          subtractAddresses(arrivalAddress, this.currentSystem.position),
          snapshot,
          arrivalAddress,
        );
      }
      this.completeGuidedTravel();
      return;
    }

    const desiredDirection = normalizeVec3(toTarget);
    const direction = this.obstacleAvoidanceDirection(snapshot, target, desiredDirection);
    this.orientAlong(direction);
    this.state.roll = moveToward(this.state.roll, 0, delta * 2);

    this.guidedElapsedSeconds += delta;
    const journeyProgress = Math.min(1, this.guidedElapsedSeconds / Math.max(delta, this.guidedDurationSeconds));
    const easedProgress = journeyProgress * journeyProgress * (3 - 2 * journeyProgress);
    const alreadyCovered = Math.max(0, this.guidedInitialRemainingMeters - remaining);
    const scheduleGap = Math.max(0, this.guidedInitialRemainingMeters * easedProgress - alreadyCovered);
    const scheduleSpeed = Math.max(0, scheduleGap / delta);
    const safeSpeed = maximumSafeBrakingSpeed(remaining, profile.brakingMetersPerSecondSquared);
    const speedLimit = Math.min(profile.maximumSpeedMetersPerSecond, safeSpeed, scheduleSpeed);
    this.state.phase = journeyProgress > 0.67 || safeSpeed < this.state.speedMetersPerSecond * 1.12
      ? "braking"
      : "cruising";
    const acceleration = speedLimit < this.state.speedMetersPerSecond
      ? profile.brakingMetersPerSecondSquared
      : profile.accelerationMetersPerSecondSquared;
    this.state.speedMetersPerSecond = moveToward(this.state.speedMetersPerSecond, speedLimit, acceleration * delta);
    this.state.throttle = Math.max(0.72, Math.min(1, this.state.speedMetersPerSecond / profile.maximumSpeedMetersPerSecond));

    const stepMeters = Math.min(this.state.speedMetersPerSecond * delta, remaining);
    this.state.velocity = scaleVec3(direction, this.state.speedMetersPerSecond);
    const destinationAddress = addAddressOffset(this.state.address, scaleVec3(direction, stepMeters));
    const destinationLocal = subtractAddresses(destinationAddress, this.currentSystem.position);
    this.advanceWithSafety(destinationLocal, snapshot, destinationAddress);

    if (this.travelInitialDistanceMeters > 0) {
      this.state.travelProgress = Math.max(0, Math.min(1, 1 - distance / this.travelInitialDistanceMeters));
    }
    if (this.state.mode === "hyperdrive") this.switchDestinationFrameWhenNearby();
  }

  private advanceWithSafety(destination: Vec3, snapshot: SystemSnapshot, destinationAddress?: GalacticAddress): void {
    const collision = findFirstSweptCollision(this.state.position, destination, this.safetySpheres(snapshot));
    if (collision) {
      const outward = normalizeVec3(subVec3(collision.position, collision.sphere.center));
      const safePosition = addVec3(collision.sphere.center, scaleVec3(outward, collision.sphere.radiusMeters + 4));
      this.setCanonicalAddress(addAddressOffset(snapshot.system.position, safePosition));
      this.state.speedMetersPerSecond = 0;
      this.state.velocity = vec3();
      this.state.throttle = 0;
      if (isFasterThanLight(this.state.mode)) this.abortGuidedTravel();
      return;
    }
    this.setCanonicalAddress(destinationAddress ?? addAddressOffset(snapshot.system.position, destination));
  }

  private safetySpheres(snapshot: SystemSnapshot): SafetySphere[] {
    const spheres: SafetySphere[] = [];
    for (const pose of snapshot.stars) {
      const descriptor = this.catalog.getStar(pose.id);
      if (!descriptor) continue;
      spheres.push({ id: pose.id, center: pose.localPositionMeters, radiusMeters: descriptor.radiusMeters * 1.13, kind: "star", landable: false });
    }
    for (const pose of [...snapshot.planets, ...snapshot.moons]) {
      const descriptor = this.catalog.getPlanet(pose.id);
      if (!descriptor) continue;
      const towardShip = normalizeVec3(subVec3(this.state.position, pose.localPositionMeters));
      const bodyFixedDirection = rotateAroundYAxis(towardShip, -pose.rotationRadians);
      const surfaceHeight = this.surfaceHeight(descriptor, bodyFixedDirection);
      spheres.push({
        id: pose.id,
        center: pose.localPositionMeters,
        radiusMeters: descriptor.radiusMeters + surfaceHeight + 20,
        kind: pose.kind === "moon" ? "moon" : "planet",
        landable: descriptor.isLandable,
      });
    }
    return spheres;
  }

  private updateProximity(snapshot: SystemSnapshot): void {
    let nearestBody: BodyPose | undefined;
    let nearestAltitude = Number.POSITIVE_INFINITY;
    for (const pose of [...snapshot.planets, ...snapshot.moons]) {
      const body = this.catalog.getPlanet(pose.id);
      if (!body) continue;
      const altitude = distanceVec3(this.state.position, pose.localPositionMeters) - body.radiusMeters;
      if (altitude < nearestAltitude) {
        nearestAltitude = altitude;
        nearestBody = pose;
      }
    }
    this.state.nearestBodyId = nearestBody?.id;
    this.state.altitudeMeters = nearestBody ? nearestAltitude : undefined;
  }

  /** Near-surface hover shares the genuine moving/rotating body frame; orbit remains inertial. */
  private inheritNearbyOrbitalMotion(snapshot: SystemSnapshot, previousTimeSeconds: number): void {
    if (previousTimeSeconds === this.lastSimulationTimeSeconds) return;
    const previous = this.catalog.evaluateSystem(snapshot.system, previousTimeSeconds);
    let carrier: { previous: BodyPose; current: BodyPose; relativeDistance: number } | undefined;

    for (const current of [...snapshot.planets, ...snapshot.moons]) {
      const descriptor = this.catalog.getPlanet(current.id);
      const earlier = previous.poses.get(current.id);
      if (!descriptor || !earlier) continue;
      const relativeDistance = distanceVec3(this.state.position, earlier.localPositionMeters) / descriptor.radiusMeters;
      if (relativeDistance > 12 || (carrier && relativeDistance >= carrier.relativeDistance)) continue;
      carrier = { previous: earlier, current, relativeDistance };
    }

    if (!carrier) return;
    const previousOffset = subVec3(this.state.position, carrier.previous.localPositionMeters);
    const angularDifference = carrier.current.rotationRadians - carrier.previous.rotationRadians;
    const wrappedRotation = Math.atan2(Math.sin(angularDifference), Math.cos(angularDifference));
    // Surface influence belongs to its actual landable body, not necessarily
    // whichever giant/moon currently wins the legacy normalized carrier test.
    const sharesSurfaceFrame = this.state.surfaceInfluence > 0 &&
      this.findNearestLandableBody(snapshot)?.pose.id === carrier.current.id;
    const carriedOffset = sharesSurfaceFrame
      ? rotateAroundYAxis(previousOffset, wrappedRotation * this.state.surfaceInfluence)
      : previousOffset;
    const carriedPosition = addVec3(carrier.current.localPositionMeters, carriedOffset);
    this.setCanonicalAddress(addAddressOffset(snapshot.system.position, carriedPosition));
  }

  private updateLandedPosition(snapshot: SystemSnapshot): void {
    const anchor = this.state.landedAnchor;
    if (!anchor) return;
    const pose = snapshot.poses.get(anchor.bodyId);
    const body = this.catalog.getPlanet(anchor.bodyId);
    if (!pose || !body) return;
    const physicalAnchor = this.state.parkedAnchor;
    if (physicalAnchor?.bodyId === anchor.bodyId) {
      this.setCanonicalAddress(addAddressOffset(
        pose.position,
        rotateAroundYAxis(physicalAnchor.bodyFixedOriginMeters, pose.rotationRadians),
      ));
      this.state.forward = normalizeVec3(rotateAroundYAxis(physicalAnchor.bodyFixedForward, pose.rotationRadians));
      this.state.referenceUp = normalizeVec3(rotateAroundYAxis(physicalAnchor.supportNormalBodyFixed, pose.rotationRadians));
      const orientation = headingToTarget(vec3(), this.state.forward);
      this.state.yaw = orientation.yawRadians;
      this.state.pitch = orientation.pitchRadians;
      this.state.roll = 0;
      this.state.velocity = vec3();
      this.state.speedMetersPerSecond = 0;
      return;
    }
    const outward = rotateAroundYAxis(anchor.surfaceDirection, pose.rotationRadians);
    const radius = body.radiusMeters + this.surfaceHeight(body, anchor.surfaceDirection) + anchor.altitudeMeters;
    this.setCanonicalAddress(addAddressOffset(pose.position, scaleVec3(outward, radius)));
    this.state.velocity = vec3();
    this.state.speedMetersPerSecond = 0;
  }

  private updateReferenceFrame(snapshot: SystemSnapshot, deltaSeconds: number, snap = false): void {
    const nearest = this.findNearestLandableBody(snapshot);
    let influence = 0;
    let radial: Vec3 = { ...WORLD_UP };

    if (nearest) {
      const altitude = Math.max(0, nearest.altitudeMeters);
      const inner = Math.max(18_000, nearest.descriptor.atmosphere.heightMeters * 0.35);
      const outer = Math.max(inner + 40_000, nearest.descriptor.radiusMeters * 0.085, nearest.descriptor.atmosphere.heightMeters * 2.4);
      const linear = Math.max(0, Math.min(1, (outer - altitude) / Math.max(1, outer - inner)));
      influence = linear * linear * (3 - 2 * linear);
      if (influence > 0) radial = nearest.direction;
    }

    this.state.surfaceUp = { ...radial };
    this.state.surfaceInfluence = influence;
    const desiredUp = sphericalInterpolateUnit(WORLD_UP, radial, influence);
    this.state.referenceUp = snap
      ? desiredUp
      : sphericalInterpolateUnit(this.state.referenceUp, desiredUp, 1 - Math.exp(-deltaSeconds * 5.2));
  }

  private findNearestLandableBody(snapshot: SystemSnapshot):
    | { descriptor: PlanetDescriptor; pose: BodyPose; direction: Vec3; altitudeMeters: number }
    | undefined {
    return this.findNearestBody(snapshot, true);
  }

  /** Solid gas giants and all moons deserve the same approach protection as landing worlds. */
  private findNearestPhysicalBody(snapshot: SystemSnapshot):
    | { descriptor: PlanetDescriptor; pose: BodyPose; direction: Vec3; altitudeMeters: number }
    | undefined {
    return this.findNearestBody(snapshot, false);
  }

  private findNearestBody(snapshot: SystemSnapshot, requireLandable: boolean):
    | { descriptor: PlanetDescriptor; pose: BodyPose; direction: Vec3; altitudeMeters: number }
    | undefined {
    let nearest: { descriptor: PlanetDescriptor; pose: BodyPose; direction: Vec3; altitudeMeters: number } | undefined;
    for (const pose of [...snapshot.planets, ...snapshot.moons]) {
      const descriptor = this.catalog.getPlanet(pose.id);
      if (!descriptor || (requireLandable && !descriptor.isLandable)) continue;
      const relative = subVec3(this.state.position, pose.localPositionMeters);
      const direction = normalizeVec3(relative);
      const bodyFixed = rotateAroundYAxis(direction, -pose.rotationRadians);
      const sampledHeight = this.surfaceHeight(descriptor, bodyFixed);
      // The callback already supplies the actual wet-surface envelope. Dry
      // basins must not acquire an invisible barrier at the reference datum.
      const altitudeMeters = lengthVec3(relative) - descriptor.radiusMeters - sampledHeight;
      if (!nearest || altitudeMeters < nearest.altitudeMeters) nearest = { descriptor, pose, direction, altitudeMeters };
    }
    return nearest;
  }

  private surfaceHeight(planet: PlanetDescriptor, bodyFixedDirection: Vec3): number {
    const result = this.sampleSurfaceHeightMeters?.(planet, bodyFixedDirection) ?? 0;
    return Number.isFinite(result) ? result : 0;
  }

  /** Preserve real lateral propulsion while easing a shallow approach over actual rising terrain. */
  private deflectAcrossSurface(
    nearby: { descriptor: PlanetDescriptor; pose: BodyPose; direction: Vec3; altitudeMeters: number },
    velocity: Vec3,
    deltaSeconds: number,
  ): Vec3 {
    const radialSpeed = dotVec3(velocity, nearby.direction);
    const inwardSpeed = Math.max(0, -radialSpeed);
    const tangent = subVec3(velocity, scaleVec3(nearby.direction, radialSpeed));
    const tangentSpeed = lengthVec3(tangent);
    if (tangentSpeed < 12) return velocity;

    const tangentDirection = scaleVec3(tangent, 1 / tangentSpeed);
    const relative = subVec3(this.state.position, nearby.pose.localPositionMeters);
    const currentFixed = rotateAroundYAxis(nearby.direction, -nearby.pose.rotationRadians);
    const currentGround = this.surfaceHeight(nearby.descriptor, currentFixed);
    const lookahead = Math.min(
      1_600,
      Math.max(45, tangentSpeed * Math.max(0.35, deltaSeconds * 4)),
    );
    let highestRise = 0;
    for (const fraction of [0.25, 0.55, 0.8, 1]) {
      const projected = addVec3(relative, scaleVec3(tangentDirection, lookahead * fraction));
      const projectedFixed = rotateAroundYAxis(normalizeVec3(projected), -nearby.pose.rotationRadians);
      const projectedGround = this.surfaceHeight(nearby.descriptor, projectedFixed);
      highestRise = Math.max(highestRise, projectedGround - currentGround);
    }

    const protectedFloor = this.state.mode === "boost" ? 68 : 54;
    const slopeClearance = Math.max(0, nearby.altitudeMeters - protectedFloor - highestRise);
    const maximumInwardSpeed = slopeClearance * 0.72;
    const requiredClimb = highestRise > Math.max(0, nearby.altitudeMeters - protectedFloor)
      ? Math.min(tangentSpeed * 0.32, (highestRise - Math.max(0, nearby.altitudeMeters - protectedFloor)) * 1.4)
      : 0;
    // Existing lift can already point outward while a real uphill ridge rises
    // faster. Preserve that lift, but still supply the bounded terrain-following
    // climb; a radial sign alone does not establish increasing ground clearance.
    const safeRadialSpeed = requiredClimb > 0
      ? Math.max(radialSpeed, requiredClimb)
      : radialSpeed >= 0 ? radialSpeed : -Math.min(inwardSpeed, maximumInwardSpeed);
    return addVec3(tangent, scaleVec3(nearby.direction, safeRadialSpeed));
  }

  /** High orbital speeds stay playful; proximity automatically restores precise surface handling. */
  private localSpeedLimit(
    snapshot: SystemSnapshot,
    maximumSpeedMetersPerSecond: number,
    actualCoastDirection?: Vec3,
  ): number {
    const nearby = this.findNearestPhysicalBody(snapshot);
    if (!nearby) return maximumSpeedMetersPerSecond;
    const altitude = Math.max(0, nearby.altitudeMeters);
    const approachDistance = Math.max(
      180_000,
      nearby.descriptor.radiusMeters * 0.14,
      nearby.descriptor.atmosphere.heightMeters * 4.6,
    );
    const boosted = this.state.mode === "boost";
    const progress = Math.min(1, altitude / approachDistance);
    const smoothProgress = progress * progress * (3 - 2 * progress);
    const cruiseProtectedSpeed = 88 + altitude * 0.26;
    const cruiseMaximumSpeed = FLIGHT_MODE_PROFILES.cruise.maximumSpeedMetersPerSecond;
    const cruiseSurfaceSpeed = Math.min(
      cruiseMaximumSpeed,
      cruiseProtectedSpeed + Math.max(0, cruiseMaximumSpeed - cruiseProtectedSpeed) * smoothProgress,
    );
    let modeLimit = cruiseSurfaceSpeed;
    if (boosted) {
      const legacyBoostProtectedSpeed = 150 + altitude * 0.48;
      const fullBoostSpeed = Math.min(
        maximumSpeedMetersPerSecond,
        legacyBoostProtectedSpeed +
          Math.max(0, maximumSpeedMetersPerSecond - legacyBoostProtectedSpeed) * smoothProgress,
      );
      modeLimit = fullBoostSpeed;
      if (altitude < 24_000) {
        const surfaceProgress = Math.min(1, altitude / 4_000);
        const smoothSurfaceProgress = surfaceProgress * surfaceProgress * (3 - 2 * surfaceProgress);
        const nearSurfaceBoost = cruiseSurfaceSpeed * (1.18 + smoothSurfaceProgress * 0.07);
        if (altitude <= 4_000) modeLimit = Math.min(fullBoostSpeed, nearSurfaceBoost);
        else {
          const releaseProgress = Math.min(1, (altitude - 4_000) / 20_000);
          const smoothRelease = releaseProgress * releaseProgress * (3 - 2 * releaseProgress);
          modeLimit = Math.min(
            fullBoostSpeed,
            nearSurfaceBoost + (fullBoostSpeed - nearSurfaceBoost) * smoothRelease,
          );
          const requestedInward = Math.max(0, -dotVec3(actualCoastDirection ?? this.state.forward, nearby.direction));
          if (requestedInward > 0.36 && requestedInward < 0.88) {
            const entryProgress = Math.min(1, (altitude - 4_000) / 3_000);
            const smoothEntry = entryProgress * entryProgress * (3 - 2 * entryProgress);
            modeLimit += (fullBoostSpeed - modeLimit) * smoothEntry * 0.82;
          }
        }
      }
      const requestedInward = Math.max(0, -dotVec3(actualCoastDirection ?? this.state.forward, nearby.direction));
      if (requestedInward > 0.36 && requestedInward < 0.88 && altitude > 4_000 && altitude < 95_000) {
        // An intentionally descending pilot should pass through the outer
        // atmosphere promptly; pure tangential orbit keeps its gravity cap,
        // and the exact <=4 km close-surface handling envelope is untouched.
        const directedEntry = cruiseSurfaceSpeed * 1.25 + (altitude - 4_000) * 2.6;
        modeLimit = Math.min(maximumSpeedMetersPerSecond, Math.max(modeLimit, directedEntry));
      }
    }

    // Use the world's authentic gravity and radius rather than letting a
    // player circle an Earth-scale planet in seconds at medium orbital height.
    // Genuine radial departures and steep approaches retain their own envelopes.
    const radialAlignment = dotVec3(actualCoastDirection ?? this.state.forward, nearby.direction) *
      (actualCoastDirection ? 1 : this.state.throttle < 0 ? -1 : 1);
    if (radialAlignment > 0.45 || radialAlignment < -0.36) return modeLimit;
    const tangentialAlignment = Math.sqrt(Math.max(0, 1 - radialAlignment * radialAlignment));
    if (tangentialAlignment < 0.08) return modeLimit;

    const radius = nearby.descriptor.radiusMeters;
    const orbitalSpeed = Math.sqrt(
      Math.max(0.05, nearby.descriptor.surfaceGravity) * radius * radius / (radius + altitude),
    );
    const localOrbitalLimit = orbitalSpeed * (1.05 + altitude / Math.max(1, radius) * 58) *
      (boosted ? 1 : 0.82);
    const releaseStart = Math.max(radius * 0.55, nearby.descriptor.atmosphere.heightMeters * 2.2);
    const releaseEnd = Math.max(releaseStart + radius * 0.35, radius * 1.7);
    const release = Math.max(0, Math.min(1, (altitude - releaseStart) / (releaseEnd - releaseStart)));
    const smoothRelease = release * release * (3 - 2 * release);
    const angularSpeedLimit = localOrbitalLimit +
      (maximumSpeedMetersPerSecond - localOrbitalLimit) * smoothRelease;
    const tangentLimit = Math.min(modeLimit, angularSpeedLimit / tangentialAlignment);
    const approachBlend = Math.max(0, Math.min(1, (Math.abs(radialAlignment) - 0.12) / 0.24));
    const smoothApproachBlend = approachBlend * approachBlend * (3 - 2 * approachBlend);
    return tangentLimit + (modeLimit - tangentLimit) * smoothApproachBlend;
  }

  /** Local-flight ETA ends at the real safe surface; FTL ends at its orbital capture point. */
  private arrivalRadiusMeters(): number {
    if (isFasterThanLight(this.state.mode)) return this.captureRadiusMeters();

    const targetId = this.state.targetId;
    if (!targetId) return 0;

    const body = this.catalog.getPlanet(targetId);
    if (body) {
      const pose = this.catalog.getBodyPose(targetId, this.lastSimulationTimeSeconds);
      const radial = pose ? normalizeVec3(subVec3(this.state.position, pose.localPositionMeters)) : vec3(0, 1, 0);
      const bodyFixed = pose ? rotateAroundYAxis(radial, -pose.rotationRadians) : radial;
      const surfaceHeight = this.surfaceHeight(body, bodyFixed);
      return body.radiusMeters + surfaceHeight + FLIGHT_MODE_PROFILES[this.state.mode].minimumCaptureRadiusMeters;
    }

    const star = this.catalog.getStar(targetId);
    return star ? star.radiusMeters * 1.13 : 0;
  }

  private captureRadiusMeters(): number {
    const profile = FLIGHT_MODE_PROFILES[this.state.mode];
    if (this.state.mode === "hyperdrive") return profile.minimumCaptureRadiusMeters;
    const target = this.state.targetId ? this.catalog.getBody(this.state.targetId) : undefined;
    if (!target) return profile.minimumCaptureRadiusMeters;
    return this.state.mode === "pulse"
      ? pulseArrivalRadiusMeters(target)
      : Math.max(profile.minimumCaptureRadiusMeters, target.radiusMeters * 3.15);
  }

  private resolveTargetAddress(): GalacticAddress | undefined {
    if (this.state.mode === "hyperdrive" && this.destinationSystemId) {
      return this.catalog.getSystem(this.destinationSystemId)?.position;
    }
    if (!this.state.targetId) return undefined;
    return this.catalog.getBodyAddress(this.state.targetId, this.lastSimulationTimeSeconds);
  }

  private targetSystemId(): string | undefined {
    if (!this.state.targetId) return undefined;
    return this.catalog.getSystem(this.state.targetId)?.id ?? this.catalog.getSystemForBody(this.state.targetId)?.id;
  }

  private switchDestinationFrameWhenNearby(): void {
    if (!this.destinationSystemId || this.state.systemId === this.destinationSystemId) return;
    const targetSystem = this.catalog.requireSystem(this.destinationSystemId);
    const distance = lengthVec3(subtractAddresses(targetSystem.position, this.state.address));
    if (distance > FLIGHT_MODE_PROFILES.hyperdrive.minimumCaptureRadiusMeters * 4) return;
    this.state.systemId = targetSystem.id;
    this.state.position = subtractAddresses(this.state.address, targetSystem.position);
    this.onSystemChanged?.(targetSystem);
  }

  private completeGuidedTravel(): void {
    if (this.state.mode === "hyperdrive" && this.destinationSystemId && this.state.systemId !== this.destinationSystemId) {
      const destination = this.catalog.requireSystem(this.destinationSystemId);
      this.state.systemId = destination.id;
      this.state.position = subtractAddresses(this.state.address, destination.position);
      this.onSystemChanged?.(destination);
    }
    this.state.speedMetersPerSecond = 0;
    this.state.velocity = vec3();
    this.state.throttle = 0;
    this.state.travelProgress = 1;
    this.state.mode = "cruise";
    this.state.phase = "idle";
    this.state.spoolProgress = 0;
    this.destinationSystemId = undefined;
    this.departureAutopilot = undefined;
  }

  private abortGuidedTravel(): void {
    this.state.mode = "cruise";
    this.state.phase = "idle";
    this.state.spoolProgress = 0;
    this.state.speedMetersPerSecond = 0;
    this.state.velocity = vec3();
    this.destinationSystemId = undefined;
    this.departureAutopilot = undefined;
  }

  private setCanonicalAddress(address: GalacticAddress): void {
    this.state.address = cloneAddress(address);
    this.state.position = subtractAddresses(address, this.currentSystem.position);
  }
}

function cloneParkedAnchor(anchor: ParkedShipAnchor): ParkedShipAnchor {
  return {
    bodyId: anchor.bodyId,
    bodyFixedOriginMeters: { ...anchor.bodyFixedOriginMeters },
    bodyFixedForward: { ...anchor.bodyFixedForward },
    supportNormalBodyFixed: { ...anchor.supportNormalBodyFixed },
    padContacts: anchor.padContacts.map((contact) => ({
      ...contact,
      bodyFixedPointMeters: { ...contact.bodyFixedPointMeters },
      bodyFixedNormal: { ...contact.bodyFixedNormal },
    })),
    surfaceKitVersion: anchor.surfaceKitVersion,
  };
}

function forwardFromAngles(yaw: number, pitch: number): Vec3 {
  const horizontal = Math.cos(pitch);
  return normalizeVec3(vec3(-Math.sin(yaw) * horizontal, Math.sin(pitch), -Math.cos(yaw) * horizontal));
}

function clampManualAngle(value: number, maximumMagnitude: number): number {
  return Math.max(-maximumMagnitude, Math.min(maximumMagnitude, value));
}

/** Integrate v' = response * (target - v), including its exact angle integral. */
function constantManualRateStep(current: number, target: number, response: number, delta: number): ManualAngularStep {
  const change = -Math.expm1(-response * delta);
  return {
    deltaRadians: target * delta + (current - target) * change / response,
    velocityRadiansPerSecond: target + (current - target) * (1 - change),
  };
}

function integrateManualAngularRate(current: number, target: number, delta: number): ManualAngularStep {
  const { accelerationResponsePerSecond: accelerate, brakingResponsePerSecond: brake } = MANUAL_STEERING_PROFILE;
  if (current * target < 0) {
    // Stop the old turn before easing into the opposite one. Splitting at the
    // analytic zero crossing keeps reversal independent of the caller's Hz.
    const crossing = Math.log((current - target) / -target) / brake;
    if (crossing < delta) {
      const first = constantManualRateStep(current, target, brake, crossing);
      const second = constantManualRateStep(0, target, accelerate, delta - crossing);
      return {
        deltaRadians: first.deltaRadians + second.deltaRadians,
        velocityRadiansPerSecond: second.velocityRadiansPerSecond,
      };
    }
    return constantManualRateStep(current, target, brake, delta);
  }
  const response = target === 0 || Math.abs(target) < Math.abs(current) ? brake : accelerate;
  return constantManualRateStep(current, target, response, delta);
}

/** A finite-angle critically damped pointer spring; it cannot overrun its request. */
function integrateManualPointerAxis(
  axis: ManualPointerAxis,
  maximumRate: number,
  keyboardDelta: number,
  keyboardVelocity: number,
  delta: number,
): number {
  const error = axis.remainingRadians;
  if (Math.abs(error) < 1e-7) {
    axis.remainingRadians = 0;
    axis.velocityRadiansPerSecond = 0;
    return 0;
  }
  const omega = MANUAL_STEERING_PROFILE.pointerNaturalFrequency;
  const velocity = error * axis.velocityRadiansPerSecond < 0
    ? 0 : clampManualAngle(axis.velocityRadiansPerSecond, maximumRate);
  const coupling = velocity - omega * error;
  const decay = Math.exp(-omega * delta);
  const requested = error - (error - coupling * delta) * decay;
  const maximumStep = maximumRate * delta;
  const minimumPointerStep = Math.max(-maximumStep, -maximumStep - keyboardDelta);
  const maximumPointerStep = Math.min(maximumStep, maximumStep - keyboardDelta);
  let delivered = Math.max(minimumPointerStep, Math.min(maximumPointerStep, requested));
  delivered = error > 0 ? Math.max(0, Math.min(error, delivered)) : Math.min(0, Math.max(error, delivered));
  axis.remainingRadians = clampManualAngle(error - delivered, MANUAL_STEERING_PROFILE.pointerQueueLimitRadians);

  const minimumPointerRate = Math.max(-maximumRate, -maximumRate - keyboardVelocity);
  const maximumPointerRate = Math.min(maximumRate, maximumRate - keyboardVelocity);
  axis.velocityRadiansPerSecond = Math.max(minimumPointerRate, Math.min(maximumPointerRate,
    (velocity - omega * coupling * delta) * decay));
  if (axis.remainingRadians * axis.velocityRadiansPerSecond < 0 || Math.abs(axis.remainingRadians) < 1e-7) {
    axis.velocityRadiansPerSecond = 0;
  }
  if (Math.abs(axis.remainingRadians) < 1e-7) axis.remainingRadians = 0;
  return delivered;
}

function createKeyBindings(overrides?: Partial<Record<string, FlightInputAction>>): Record<string, FlightInputAction> {
  const bindings = { ...DEFAULT_FLIGHT_KEY_BINDINGS };
  for (const [code, action] of Object.entries(overrides ?? {})) {
    if (action !== undefined) bindings[code] = action;
  }
  return bindings;
}

function rotateAroundUnitAxis(vector: Vec3, axis: Vec3, radians: number): Vec3 {
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return normalizeVec3(addVec3(
    addVec3(scaleVec3(vector, cosine), scaleVec3(crossVec3(axis, vector), sine)),
    scaleVec3(axis, dotVec3(axis, vector) * (1 - cosine)),
  ));
}

/** Stable shortest-arc interpolation, including antipodal south-pole normals. */
function sphericalInterpolateUnit(start: Vec3, end: Vec3, amount: number): Vec3 {
  const progress = Math.max(0, Math.min(1, amount));
  if (progress === 0) return { ...start };
  if (progress === 1) return { ...end };
  const alignment = Math.max(-1, Math.min(1, dotVec3(start, end)));

  if (alignment > 0.9995) {
    return normalizeVec3(addVec3(scaleVec3(start, 1 - progress), scaleVec3(end, progress)));
  }
  if (alignment < -0.9995) {
    const basis = Math.abs(start.x) < 0.8 ? vec3(1, 0, 0) : vec3(0, 0, 1);
    const tangent = normalizeVec3(crossVec3(start, basis));
    return normalizeVec3(addVec3(
      scaleVec3(start, Math.cos(Math.PI * progress)),
      scaleVec3(tangent, Math.sin(Math.PI * progress)),
    ));
  }

  const angle = Math.acos(alignment);
  const divisor = Math.sin(angle);
  return normalizeVec3(addVec3(
    scaleVec3(start, Math.sin((1 - progress) * angle) / divisor),
    scaleVec3(end, Math.sin(progress * angle) / divisor),
  ));
}
