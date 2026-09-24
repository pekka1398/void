import {
  addAddressOffset,
  deserializeAddress,
  lengthVec3,
  normalizeVec3,
  rotateAroundYAxis,
  scaleVec3,
  serializeAddress,
  subtractAddresses,
  vec3,
  type Vec3,
} from "../../core";
import { createPlanetField, samplePlanetField } from "../../fields";
import {
  copySavedLandingAnchor,
  copySavedSurfaceCheckpoint,
  DiscoveryStore,
  getRestorableJourney,
  isSafeSavedShipState,
  normalizeCelestialTimeScale,
  normalizeSavedSurfaceCheckpoint,
  type SavedParkedShipAnchor,
  type SavedShipState,
  type SavedSurfaceCheckpoint,
  type StarSystem,
  UniverseCatalog,
} from "../../universe";
import { headingToTarget } from "../navigation/InterceptSolver";
import { FlightController } from "../ship/FlightController";
import type { SerializedFlightState } from "../ship/ShipState";

export const ACTIVE_WAYPOINT_ID = "active-destination";
const MIGRATED_AIRBORNE_COLLISION_CLEARANCE_METERS = 20;
const MIGRATED_AIRBORNE_SAFE_CLEARANCE_METERS = 64;
const MIGRATED_LANDING_CLEARANCE_METERS = 8;

export interface SurfacePersistenceCapture {
  /** Already selected by the surface lifecycle as a safe stable ship pose. */
  ship: SavedShipState;
  surface: SavedSurfaceCheckpoint;
}

export interface SurfacePersistenceAdapter {
  /** Undefined means no complete safe checkpoint is available yet. */
  captureCheckpoint(): SurfacePersistenceCapture | undefined;
  /** Return false to retain a pending restore while contact terrain prewarms. */
  restoreCheckpoint(checkpoint: SavedSurfaceCheckpoint, simulationEpochSeconds: number): boolean | void;
}

/** Translate the lifecycle's canonical checkpoint without reading a live renderer. */
export function savedShipFromFlightState(state: SerializedFlightState): SavedShipState {
  const horizontal = Math.cos(state.pitch);
  return {
    position: { cell: [...state.position.cell], localMeters: { ...state.position.localMeters } },
    velocityMetersPerSecond: { ...state.velocity },
    heading: normalizeVec3(vec3(-Math.sin(state.yaw) * horizontal, Math.sin(state.pitch), -Math.cos(state.yaw) * horizontal)),
    activeSystemId: state.systemId,
    yawRadians: state.yaw,
    pitchRadians: state.pitch,
    ...(state.targetId ? { targetId: state.targetId } : {}),
    ...(state.landedAnchor ? {
      landedBodyId: state.landedAnchor.bodyId,
      landedAnchor: copySavedLandingAnchor(state.landedAnchor),
    } : {}),
  };
}

export interface GamePersistenceOptions {
  flight: FlightController;
  discoveries: DiscoveryStore;
  catalog: UniverseCatalog;
  saveIntervalSeconds?: number;
  celestialTimeScale?: number;
  surface?: SurfacePersistenceAdapter;
}

export interface RestoredGameState {
  restored: boolean;
  simulationEpochSeconds: number;
  celestialTimeScale: number;
  localEffectsEpochSeconds: number;
  system?: StarSystem;
  targetId?: string;
  /** Safe candidate; outside ownership still waits for real contact readiness. */
  surfaceCheckpoint?: SavedSurfaceCheckpoint;
}

/** Owns version-safe game saves while keeping simulation truth out of rendering. */
export class GamePersistence {
  private readonly flight: FlightController;
  private readonly discoveries: DiscoveryStore;
  private readonly catalog: UniverseCatalog;
  private readonly saveIntervalMs: number;
  private lastSavedWallTimeMs = Number.NEGATIVE_INFINITY;
  private latestSimulationSeconds = 0;
  private latestLocalEffectsSeconds = 0;
  private celestialTimeScale: number;
  private surfaceAdapter?: SurfacePersistenceAdapter;
  private pendingSurfaceRestore?: SavedSurfaceCheckpoint;
  private pendingSurfaceRestoreEpoch = 0;
  private lifecycleTarget?: EventTarget;
  private visibilityTarget?: EventTarget;

  constructor(options: GamePersistenceOptions) {
    this.flight = options.flight;
    this.discoveries = options.discoveries;
    this.catalog = options.catalog;
    this.surfaceAdapter = options.surface;
    this.saveIntervalMs = Math.max(250, (options.saveIntervalSeconds ?? 2) * 1000);
    this.celestialTimeScale = normalizeCelestialTimeScale(
      options.celestialTimeScale ?? this.discoveries.state.celestialTimeScale,
    );
  }

  restore(): RestoredGameState {
    this.pendingSurfaceRestore = undefined;
    const epoch = Number.isFinite(this.discoveries.state.simulationEpochSeconds)
      ? Math.max(0, this.discoveries.state.simulationEpochSeconds)
      : 0;
    const savedLocalEpoch = this.discoveries.state.localEffectsEpochSeconds;
    const localEffectsEpochSeconds = typeof savedLocalEpoch === "number" && Number.isFinite(savedLocalEpoch)
      ? Math.max(0, savedLocalEpoch)
      : epoch;
    this.celestialTimeScale = normalizeCelestialTimeScale(
      this.discoveries.state.celestialTimeScale ?? this.celestialTimeScale,
    );
    this.latestSimulationSeconds = epoch;
    this.latestLocalEffectsSeconds = localEffectsEpochSeconds;
    const restoredClocks = {
      simulationEpochSeconds: epoch,
      celestialTimeScale: this.celestialTimeScale,
      localEffectsEpochSeconds,
    };
    const journey = getRestorableJourney(this.discoveries.state, this.catalog);
    if (!journey) return { restored: false, ...restoredClocks };
    const { ship: saved, system, targetId } = journey;
    let surfaceCheckpoint = journey.surfaceCheckpoint;
    const orientation = headingToTarget(vec3(), saved.heading);
    let landedAnchor = surfaceCheckpoint.kind === "parked"
      ? surfaceCheckpoint.anchor
        ? saved.landedAnchor ?? this.legacyProjection(surfaceCheckpoint.anchor)
        : surfaceCheckpoint.legacyAnchor
      : undefined;
    let position = saved.position;
    if (this.discoveries.migratedFromPlanetGeneratorVersion !== undefined) {
      const reconciled = this.reconcileMigratedTerrain(saved, system, epoch, landedAnchor);
      position = reconciled.position;
      landedAnchor = reconciled.landedAnchor;
      if (landedAnchor) surfaceCheckpoint = { kind: "parked", occupancy: "inside", legacyAnchor: copySavedLandingAnchor(landedAnchor) };
    }

    const restored = this.flight.restoreState({
      position,
      velocity: saved.velocityMetersPerSecond,
      yaw: Number.isFinite(saved.yawRadians) ? saved.yawRadians! : orientation.yawRadians,
      pitch: Number.isFinite(saved.pitchRadians) ? saved.pitchRadians! : orientation.pitchRadians,
      systemId: system.id,
      ...(targetId ? { targetId } : {}),
      ...(landedAnchor ? { landedAnchor } : {}),
    });

    if (restored) {
      this.pendingSurfaceRestore = copySavedSurfaceCheckpoint(surfaceCheckpoint);
      this.pendingSurfaceRestoreEpoch = epoch;
    }

    return {
      restored,
      ...restoredClocks,
      ...(restored ? { system } : {}),
      ...(targetId ? { targetId } : {}),
      ...(restored ? { surfaceCheckpoint: copySavedSurfaceCheckpoint(surfaceCheckpoint) } : {}),
    };
  }

  /** Resources may initialize after the valid ship/clock restore. */
  setSurfaceAdapter(adapter: SurfacePersistenceAdapter | undefined): void {
    this.surfaceAdapter = adapter;
  }

  get pendingSurfaceCheckpoint(): SavedSurfaceCheckpoint | undefined {
    return this.pendingSurfaceRestore ? copySavedSurfaceCheckpoint(this.pendingSurfaceRestore) : undefined;
  }

  /** Only an explicit reset/QA teleport may supersede an unfinished restore. */
  discardPendingSurfaceRestore(): void {
    this.pendingSurfaceRestore = undefined;
    this.pendingSurfaceRestoreEpoch = 0;
  }

  restorePendingSurfaceCheckpoint(): boolean {
    if (!this.pendingSurfaceRestore) return true;
    if (!this.surfaceAdapter) return false;
    const accepted = this.surfaceAdapter.restoreCheckpoint(
      copySavedSurfaceCheckpoint(this.pendingSurfaceRestore),
      this.pendingSurfaceRestoreEpoch,
    );
    if (accepted === false) return false;
    this.pendingSurfaceRestore = undefined;
    return true;
  }

  saveActiveWaypoint(targetId: string | undefined, simulationSeconds = this.latestSimulationSeconds): boolean {
    if (!targetId) return this.discoveries.removeWaypoint(ACTIVE_WAYPOINT_ID);
    const system = this.catalog.getSystem(targetId);
    const body = system ? undefined : this.catalog.getBody(targetId);
    const owner = system ?? this.catalog.getSystemForBody(targetId);
    if (!owner || (!system && !body)) return false;

    this.discoveries.setWaypoint({
      id: ACTIVE_WAYPOINT_ID,
      targetId,
      label: system?.name ?? body!.name,
      systemId: owner.id,
      createdAtSeconds: simulationSeconds,
    });
    return true;
  }

  /** Throttle by wall time, not the independently accelerated universe clock. */
  update(
    simulationSeconds: number,
    wallTimeMs = Date.now(),
    localEffectsSeconds = simulationSeconds,
  ): boolean {
    this.latestSimulationSeconds = simulationSeconds;
    if (Number.isFinite(localEffectsSeconds)) {
      this.latestLocalEffectsSeconds = Math.max(0, localEffectsSeconds);
    }
    if (wallTimeMs - this.lastSavedWallTimeMs < this.saveIntervalMs) return false;
    return this.saveNow(simulationSeconds, wallTimeMs, this.latestLocalEffectsSeconds);
  }

  saveNow(
    simulationSeconds = this.latestSimulationSeconds,
    wallTimeMs = Date.now(),
    localEffectsSeconds?: number,
  ): boolean {
    if (!Number.isFinite(simulationSeconds)) return false;
    // A rich parked restore must survive even an early pagehide/dispose before
    // the asynchronous asset load installs its surface adapter. Legacy-only
    // callers can still round-trip their old radial or airborne checkpoints.
    const pending = this.pendingSurfaceRestore;
    if (pending && (this.surfaceAdapter || pending.kind === "parked" && pending.anchor)) return false;
    const capture = this.surfaceAdapter?.captureCheckpoint();
    if (this.surfaceAdapter && !capture) return false;
    const ship = capture?.ship ?? savedShipFromFlightState(this.flight.serializeState());
    if (!isSafeSavedShipState(ship) || !this.catalog.getSystem(ship.activeSystemId)) return false;
    const surface = normalizeSavedSurfaceCheckpoint(capture?.surface, ship);
    if (capture?.surface.kind === "parked" && surface.kind !== "parked") return false;
    const previousSimulationSeconds = this.latestSimulationSeconds;
    if (typeof localEffectsSeconds === "number" && Number.isFinite(localEffectsSeconds)) {
      this.latestLocalEffectsSeconds = Math.max(0, localEffectsSeconds);
    } else if (simulationSeconds !== previousSimulationSeconds) {
      // Historical callers had one clock, so their effects epoch remains
      // identical unless an explicit independent local clock was supplied.
      this.latestLocalEffectsSeconds = Math.max(0, simulationSeconds);
    }
    this.latestSimulationSeconds = simulationSeconds;
    this.discoveries.updateSimulationEpoch(simulationSeconds);
    this.discoveries.updateSimulationTiming(this.celestialTimeScale, this.latestLocalEffectsSeconds);
    const saved = this.discoveries.saveShip(ship, surface);
    if (saved) this.lastSavedWallTimeMs = wallTimeMs;
    return saved;
  }

  /** Persist a user-selected clock preference without waiting for an autosave. */
  setCelestialTimeScale(scale: number): number {
    this.celestialTimeScale = normalizeCelestialTimeScale(scale);
    // This preference-only write retains the clocks of the last complete
    // ship/actor checkpoint. The next saveNow advances both clocks together.
    const checkpointLocalEpoch = this.discoveries.state.localEffectsEpochSeconds ??
      this.discoveries.state.simulationEpochSeconds;
    this.discoveries.updateSimulationTiming(this.celestialTimeScale, checkpointLocalEpoch);
    this.discoveries.flush();
    return this.celestialTimeScale;
  }

  attachPagehide(target?: EventTarget): void {
    const resolved = target ?? (typeof window === "undefined" ? undefined : window);
    if (!resolved || this.lifecycleTarget === resolved) return;
    this.detachPagehide();
    this.lifecycleTarget = resolved;
    resolved.addEventListener("pagehide", this.onPagehide);

    if (typeof document !== "undefined") {
      this.visibilityTarget = document;
      document.addEventListener("visibilitychange", this.onVisibilityChange);
    }
  }

  detachPagehide(): void {
    this.lifecycleTarget?.removeEventListener("pagehide", this.onPagehide);
    this.visibilityTarget?.removeEventListener("visibilitychange", this.onVisibilityChange);
    this.lifecycleTarget = undefined;
    this.visibilityTarget = undefined;
  }

  dispose(): void {
    this.saveNow();
    this.detachPagehide();
  }

  private readonly onPagehide = (): void => {
    this.saveNow();
  };

  private readonly onVisibilityChange = (): void => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") this.saveNow();
  };

  /** Keep old expeditions on the same moving world when its real heightfield evolves. */
  private reconcileMigratedTerrain(
    saved: SavedShipState,
    system: StarSystem,
    simulationEpochSeconds: number,
    landedAnchor: SavedShipState["landedAnchor"],
  ): { position: SavedShipState["position"]; landedAnchor: SavedShipState["landedAnchor"] } {
    const snapshot = this.catalog.evaluateSystem(system, simulationEpochSeconds);

    if (landedAnchor) {
      const body = this.catalog.getPlanet(landedAnchor.bodyId);
      const pose = snapshot.poses.get(landedAnchor.bodyId);
      if (!body || !pose) return { position: saved.position, landedAnchor };

      const direction = normalizeVec3(landedAnchor.surfaceDirection);
      if (lengthVec3(direction) === 0) return { position: saved.position, landedAnchor };
      const groundRadiusMeters = samplePlanetField(createPlanetField(body), direction).radialMeters;
      const altitudeMeters = Math.max(MIGRATED_LANDING_CLEARANCE_METERS, landedAnchor.altitudeMeters);
      const outward = rotateAroundYAxis(direction, pose.rotationRadians);
      const address = addAddressOffset(
        pose.position,
        scaleVec3(outward, groundRadiusMeters + altitudeMeters),
      );
      return {
        position: serializeAddress(address),
        landedAnchor: { ...landedAnchor, altitudeMeters },
      };
    }

    const savedAddress = deserializeAddress(saved.position);
    let closest:
      | {
        pose: (typeof snapshot.planets)[number];
        direction: Vec3;
        groundRadiusMeters: number;
        clearanceMeters: number;
      }
      | undefined;

    for (const pose of [...snapshot.planets, ...snapshot.moons]) {
      const body = this.catalog.getPlanet(pose.id);
      if (!body?.isLandable) continue;
      const offset = subtractAddresses(savedAddress, pose.position);
      const radiusMeters = lengthVec3(offset);
      if (radiusMeters === 0) continue;
      const direction = scaleVec3(offset, 1 / radiusMeters);
      const bodyFixed = rotateAroundYAxis(direction, -pose.rotationRadians);
      const groundRadiusMeters = samplePlanetField(createPlanetField(body), bodyFixed).radialMeters;
      const clearanceMeters = radiusMeters - groundRadiusMeters;
      if (!closest || clearanceMeters < closest.clearanceMeters) {
        closest = { pose, direction, groundRadiusMeters, clearanceMeters };
      }
    }

    if (!closest || closest.clearanceMeters >= MIGRATED_AIRBORNE_COLLISION_CLEARANCE_METERS) {
      return { position: saved.position, landedAnchor: undefined };
    }

    const address = addAddressOffset(
      closest.pose.position,
      scaleVec3(
        closest.direction,
        closest.groundRadiusMeters + MIGRATED_AIRBORNE_SAFE_CLEARANCE_METERS,
      ),
    );
    return { position: serializeAddress(address), landedAnchor: undefined };
  }

  private legacyProjection(anchor: SavedParkedShipAnchor): SavedShipState["landedAnchor"] {
    const body = this.catalog.getPlanet(anchor.bodyId);
    if (!body) return undefined;
    const direction = normalizeVec3(anchor.bodyFixedOriginMeters);
    const groundRadiusMeters = samplePlanetField(createPlanetField(body), direction).radialMeters;
    return {
      bodyId: body.id,
      surfaceDirection: direction,
      altitudeMeters: lengthVec3(anchor.bodyFixedOriginMeters) - groundRadiusMeters,
      latitudeRadians: Math.asin(Math.max(-1, Math.min(1, direction.y))),
      longitudeRadians: Math.atan2(direction.z, direction.x),
    };
  }
}
